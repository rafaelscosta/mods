import { describe, expect, test } from 'claude-code/testing'

import type { Ledger, LedgerAgent } from '../types'
import { CARD_WIDTH, agentCard, mainCard, trimLines, wrapCard, wrapText } from '../hooks/cards'
import { cellsToText } from '../hooks/canvas'
import { DEMO_MS, DEMO_RUN, demoLedger } from '../hooks/demo'
import { INTRO_MS, cellHitboxes, drawGraph, graphNodes } from '../hooks/graph'
import { emptyLedger, estimateCost } from '../hooks/ledger'
import { drawGraphPixels, pixelHitboxes } from '../hooks/pixels'
import { receiptLines } from '../hooks/receipt'
import { REPLAY_SPEED, advanceReplay, clock, ledgerAt, replayEvents, stepReplay } from '../hooks/replay'
import { COLOR, applyTheme, currentTheme, modelColor, themeFrom } from '../hooks/theme'
import { axisStep, lanesOf } from '../hooks/timeline'

const T0 = 1_000_000
const SONNET = 'claude-sonnet-5-5'
const HAIKU = 'claude-haiku-4-5'

const agent = (patch: Partial<LedgerAgent> & Pick<LedgerAgent, 'id'>): LedgerAgent => ({
  runId: 'r1', parentId: null, type: 'run-ledger:builder', description: 'scaffold', spawnedBy: null, provider: null, background: false,
  requestedModel: null, recommendationId: null, recommendedModel: SONNET, routed: true, actualModel: SONNET, status: 'completed',
  lastAction: null, contextTokens: 12_000, startedAt: T0 + 1000, endedAt: T0 + 9000, result: 'route scaffolded', ...patch,
})

/** A finished run: main, a builder that ended at 9 s and an executor under it that ended at 7 s. */
function sample(): Ledger {
  const usage = { input: 4000, output: 1000, cacheRead: 20_000, cacheWrite: 0 }
  return {
    ...emptyLedger(),
    runs: [{ id: 'r1', label: 'build the page', source: 'session', startedAt: T0, endedAt: T0 + 10_000, status: 'completed', model: 'claude-opus-5-5' }],
    agents: [
      agent({ id: 'a1', recommendationId: 'rec-1' }),
      agent({ id: 'a2', parentId: 'a1', type: 'run-ledger:executor', description: 'run tests', actualModel: HAIKU, recommendedModel: HAIKU, startedAt: T0 + 3000, endedAt: T0 + 7000, result: '3 passed' }),
    ],
    requests: [
      { key: 'k0', runId: 'r1', agentId: null, turnId: 'r1', index: 0, attempt: 0, requestedModel: 'claude-opus-5-5', model: 'claude-opus-5-5', sourceKind: 'main', sourcePlugin: null, usage, cost: estimateCost('claude-opus-5-5', usage), stopReason: 'end_turn', at: T0 + 200 },
      { key: 'k1', runId: 'r1', agentId: 'a1', turnId: 'r1', index: 0, attempt: 0, requestedModel: SONNET, model: SONNET, sourceKind: 'subagent', sourcePlugin: null, usage, cost: estimateCost(SONNET, usage), stopReason: 'end_turn', at: T0 + 1500 },
      { key: 'k2', runId: 'r1', agentId: 'a2', turnId: 'r1', index: 0, attempt: 0, requestedModel: HAIKU, model: HAIKU, sourceKind: 'subagent', sourcePlugin: null, usage, cost: estimateCost(HAIKU, usage), stopReason: 'end_turn', at: T0 + 3500 },
    ],
    recommendations: [
      { id: 'rec-1', runId: 'r1', agentType: 'run-ledger:builder', router: 'local', status: 'ok', model: SONNET, reason: 'local heuristic weighing cost and quality', confidence: 0.4, score: 0.71, ranking: [], validated: true, jevCost: { usd: null, basis: 'no-usage', pricesAsOf: null }, mode: 'auto', applied: true, at: T0 + 500 },
    ],
    items: [
      { id: 'c1', runId: 'r1', agentId: 'a1', kind: 'write', label: 'page.tsx', path: null, tokens: 100, fromAgentId: null, at: T0 + 2000 },
      { id: 'c2', runId: 'r1', agentId: 'a2', kind: 'run', label: '$ npm test', path: null, tokens: 100, fromAgentId: null, at: T0 + 5000 },
      { id: 'c3', runId: 'r1', agentId: 'a1', kind: 'read', label: 'layout.tsx', path: null, tokens: 100, fromAgentId: null, at: T0 + 8000 },
    ],
    pulses: [
      { id: 'p1', from: 'main', to: 'a1', kind: 'route', at: T0 + 1000 },
      { id: 'p2', from: 'a2', to: 'a1', kind: 'result', at: T0 + 7000 },
    ],
  }
}

describe('replay', () => {
  test("a run's events come in order, each once", () => {
    const events = replayEvents(sample(), 'r1')
    expect(events[0]).toBe(T0)
    expect(events[events.length - 1]).toBe(T0 + 10_000)
    expect(events.every((t, i) => i === 0 || t > (events[i - 1] ?? 0))).toBe(true)
  })

  test('the ledger as of a moment: later events left out, what had not ended running', () => {
    const at = ledgerAt(sample(), 'r1', T0 + 4000)
    expect(at.agents.map(a => [a.id, a.status, a.endedAt])).toEqual([
      ['a1', 'running', null],
      ['a2', 'running', null],
    ])
    expect(at.agents.find(a => a.id === 'a1')?.lastAction).toBe('write page.tsx')
    expect(at.items.map(i => i.id)).toEqual(['c1'])
    expect(at.requests.map(r => r.key)).toEqual(['k0', 'k1', 'k2'])
    expect(at.runs[0]?.status).toBe('running')
    expect(at.currentRunId).toBe('r1')
    const before = ledgerAt(sample(), 'r1', T0 + 2500)
    expect(before.agents.map(a => a.id)).toEqual(['a1'])
    expect(before.pulses.map(p => p.id)).toEqual(['p1'])
  })

  test('steps go event to event, and stop at the ends', () => {
    const events = [10, 20, 30]
    expect(stepReplay(events, 20, 1)).toBe(30)
    expect(stepReplay(events, 30, 1)).toBe(null)
    expect(stepReplay(events, 20, -1)).toBe(10)
    expect(stepReplay(events, 10, -1)).toBe(10)
    expect(stepReplay(events, 25, -1)).toBe(20)
  })

  test('playback runs faster than the run did, skips quiet stretches, and ends after the last motion', () => {
    expect(advanceReplay([0, 100, 200], 0, 10).at).toBe(10 * REPLAY_SPEED)
    // 10 s of nothing between two events: it lands just before the next one.
    expect(advanceReplay([0, 10_000], 0, 100).at).toBe(10_000 - 400)
    const end = advanceReplay([0, 1000], 900, 10_000)
    expect(end.isOver).toBe(true)
    expect(clock(61_000)).toBe('1:01')
  })
})

describe('cards', () => {
  test("a subagent's card: status, routing, tokens, context, why, last tools and result", () => {
    const card = agentCard(sample(), 'a1', T0 + 10_000)
    const text = card?.lines.map(l => l.text) ?? []
    expect(card?.title).toBe('builder · sonnet-5.5')
    expect(text[0]).toMatch(/^done in 8s · ~\$0\.0\d+ API est\.$/)
    expect(text).toContain('model sonnet-5.5 · routed ✓')
    expect(text).toContain('in 4.0k · out 1.0k · cache 20.0k · 1 req')
    expect(text).toContain('handed ≈12.0k tokens of context')
    expect(text).toContain('why (local router, score 0.71 · p 0.40):')
    expect(text).toContain('  read layout.tsx')
    expect(text.indexOf('  read layout.tsx')).toBeLessThan(text.indexOf('  write page.tsx'))
    expect(text[text.length - 1]).toBe('→ route scaffolded')
    expect(card?.color).toBe(`#${modelColor(SONNET).toString(16).padStart(6, '0')}`)
  })

  test('a long reason, result or tool is kept whole and wrapped to the card, never cut', () => {
    const reason =
      'JEV jev-1.13.0 chose claude-haiku-4-5 (p 0.99) over claude-opus-5-5 (p 0.01) · reading two small files needs no reasoning'
    const result = 'util.py defines soma(a, b), which returns a + b; notas.txt holds the words alpha and beta, one per line'
    const path = '/Users/someone/Projects/a-very-long-repository-name/src/components/deeply/nested/page.tsx'
    const base = sample()
    const ledger: Ledger = {
      ...base,
      agents: base.agents.map(a => (a.id === 'a1' ? { ...a, result } : a)),
      recommendations: base.recommendations.map(r => ({ ...r, reason })),
      items: [...base.items, { id: 'c9', runId: 'r1', agentId: 'a1', kind: 'read', label: path, path, tokens: 10, fromAgentId: null, at: T0 + 8500 }],
    }
    const card = agentCard(ledger, 'a1', T0 + 10_000)
    expect(card).not.toBeNull()
    const inner = CARD_WIDTH - 4
    const drawn = card ? wrapCard(card, inner) : null
    const rows = drawn?.lines.map(l => l.text) ?? []
    expect(rows.every(r => [...r].length <= inner)).toBe(true)
    expect(rows.some(r => r.includes('…'))).toBe(false)
    // Every word of the reason and the result is drawn, in order.
    const flat = rows.map(r => r.trim()).join(' ')
    expect(flat).toContain(reason)
    expect(flat).toContain(`→ ${result}`)
    // A path longer than a row is cut across rows, not dropped.
    expect(rows.join('').replace(/\s+/g, '')).toContain(`read${path}`)
  })

  test('wrapping keeps the indent and splits only between words', () => {
    expect(wrapText('  read layout.tsx', 42)).toEqual(['  read layout.tsx'])
    expect(wrapText('one two three four five six', 12)).toEqual(['one two', '  three four', '  five six'])
    expect(wrapText('  abcdefghijklmnop', 10)).toEqual(['  abcdefgh', '    ijklmn', '    op'])
    expect(wrapText('', 20)).toEqual([''])
  })

  test('a card taller than its box says how many lines were left out', () => {
    const lines = Array.from({ length: 9 }, (_, i) => ({ text: `line ${i}`, color: null, bold: false }))
    const shown = trimLines(lines, 4, '#888888')
    expect(shown.map(l => l.text)).toEqual(['line 0', 'line 1', 'line 2', '… +6 more lines'])
    expect(trimLines(lines.slice(0, 3), 4, '#888888')).toHaveLength(3)
  })

  test("main's card: the prompt, its own spend, the subagents", () => {
    const text = mainCard(sample(), 'r1', 'claude-opus-5-5', T0 + 10_000).lines.map(l => l.text)
    expect(text[0]).toBe('"build the page"')
    expect(text).toContain('2 subagents')
  })
})

describe('receipt', () => {
  test('a finished run: subagents and models, requests, cache, cost per model, total and savings', () => {
    const lines = receiptLines(sample(), 'r1', 'claude-opus-5-5', T0 + 10_000)
    expect(lines[0]).toBe('◆ run-ledger receipt · "build the page" · 10s · completed')
    expect(lines[1]).toBe('  2 subagents on 2 models · 3 requests · cache hit 83%')
    expect(lines[2]).toMatch(/^ {2}opus-5\.5 ~\$[\d.]+ · sonnet-5\.5 ~\$[\d.]+ · haiku-4\.5 ~\$[\d.]+$/)
    expect(lines[3]).toMatch(/^ {2}total ~\$[\d.]+ API est\., not a subscription charge · routing saved ≈\$[\d.]+ \(\d+%\) vs all opus-5\.5$/)
    expect(receiptLines(sample(), 'nope', 'claude-opus-5-5', T0)).toEqual([])
  })

  test('a run whose background subagent outlived its main turn lasts until that subagent ended', () => {
    const ledger = sample()
    const late = { ...ledger, agents: ledger.agents.map(a => (a.id === 'a1' ? { ...a, endedAt: T0 + 15_000 } : a)) }
    expect(receiptLines(late, 'r1', 'claude-opus-5-5', T0 + 20_000)[0]).toBe('◆ run-ledger receipt · "build the page" · 15s · completed')
  })
})

describe('timeline', () => {
  test('lanes: main, then each subagent under its parent', () => {
    const lanes = lanesOf(sample(), 'r1', 'claude-opus-5-5', T0 + 10_000)
    expect(lanes.map(l => [l.id, l.depth, l.status])).toEqual([
      ['main', 0, 'done'],
      ['a1', 1, 'done'],
      ['a2', 2, 'done'],
    ])
    expect(lanes[1]?.ticks).toEqual([T0 + 2000, T0 + 8000])
  })

  test('the axis takes a round step, labels about ten cells apart', () => {
    expect(axisStep(35_000, 60)).toBe(10_000)
    expect(axisStep(10 * 60_000, 60)).toBe(120_000)
  })
})

describe('themes', () => {
  test('auto picks light where the terminal reports a light background', () => {
    expect(themeFrom('auto', '0;15')).toBe('light')
    expect(themeFrom('auto', '15;0')).toBe('neon')
    expect(themeFrom('auto', undefined)).toBe('neon')
    expect(themeFrom('contrast', '0;15')).toBe('contrast')
  })

  test('a theme recolours every drawing in place', () => {
    applyTheme('light')
    expect(currentTheme()).toBe('light')
    expect(COLOR.text).toBe(0x1f2328)
    expect(COLOR.bg).toBe(0xffffff)
    applyTheme('neon')
    expect(COLOR.text).toBe(0xdcdfe4)
  })
})

describe('opening', () => {
  const nodes = graphNodes(sample(), 'r1', 'claude-opus-5-5', false)
  const marks = (introMs: number | null) => cellsToText(drawGraph(nodes, [], T0 + 60_000, 40, 14, introMs).encode(), 40).join('').split('▐').length - 1

  test('nodes appear level by level as the pane opens', () => {
    expect(marks(0)).toBe(0)
    expect(marks(300)).toBe(1)
    expect(marks(INTRO_MS)).toBe(3)
    expect(marks(null)).toBe(3)
  })

  test('in pixels, nodes pop in and their light follows', () => {
    const lit = (introMs: number | null) => {
      const rgba = drawGraphPixels(nodes, [], T0 + 60_000, 40, 14, 1, introMs).rgba()
      let n = 0
      for (let i = 3; i < rgba.length; i += 4) if ((rgba[i] ?? 0) > 200) n++
      return n
    }
    expect(lit(0)).toBe(0)
    expect(lit(250)).toBeGreaterThan(0)
    expect(lit(250)).toBeLessThan(lit(null))
  })
})

describe('demo', () => {
  test('the scripted run grows over time and ends completed, all of it sample data', () => {
    expect(demoLedger(T0, T0).agents).toEqual([])
    const mid = demoLedger(T0, T0 + 5_000)
    expect(mid.agents.map(a => a.id)).toEqual(['demo-o1', 'demo-b1', 'demo-i1'])
    expect(mid.runs[0]?.status).toBe('running')
    const end = demoLedger(T0, T0 + DEMO_MS + 1000)
    expect(end.agents.every(a => a.status === 'completed')).toBe(true)
    expect(end.runs[0]).toMatchObject({ id: DEMO_RUN, status: 'completed', source: 'demo' })
    expect(end.requests.every(r => r.key.startsWith('demo|'))).toBe(true)
  })
})

describe('pointer targets', () => {
  const nodes = graphNodes(sample(), 'r1', 'claude-opus-5-5', false)

  test('each node has a box on the braille graph, over its mark and its labels', () => {
    const boxes = cellHitboxes(nodes, 40, 14)
    expect(boxes.map(b => b.id)).toEqual(['main', 'a1', 'a2'])
    const lines = cellsToText(drawGraph(nodes, [], T0 + 60_000, 40, 14).encode(), 40)
    for (const b of boxes) {
      const covered = lines.slice(b.y, b.y + b.h).map(l => l.slice(b.x, b.x + b.w)).join('')
      expect(covered, b.id).toContain('▐')
    }
  })

  test('and on the picture, inside its cells', () => {
    for (const b of pixelHitboxes(nodes, 40, 14, 2)) {
      expect(b.x >= 0 && b.y >= 0 && b.x + b.w <= 40 && b.y + b.h <= 14, b.id).toBe(true)
    }
  })
})
