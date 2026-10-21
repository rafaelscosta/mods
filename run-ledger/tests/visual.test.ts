import { describe, expect, test } from 'claude-code/testing'

import type { LedgerContextItem, LedgerHistoryEntry } from '../types'
import { Canvas, cellsToText, fromBase64, toBase64 } from '../hooks/canvas'
import { contextOf, drawContext } from '../hooks/context'
import { drawGraph, edgeWidth, graphSvg, layoutTree } from '../hooks/graph'
import { LiveRates, heartbeat, rolling, sparkline } from '../hooks/live'
import type { GraphNode } from '../hooks/graph'
import { emptyLedger } from '../hooks/ledger'
import { localDecision, profileFor, rankModels } from '../hooks/router'
import { mix, shortModel } from '../hooks/theme'

const MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']

describe('canvas', () => {
  test('base64 round-trips', () => {
    const bytes = Uint8Array.of(0, 1, 2, 250, 251, 252, 7)
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes])
  })

  test('draws braille lines and text into Raster cells', () => {
    const c = new Canvas(6, 2)
    c.line(0, 0, 11, 0, 0xff0000)
    c.text(0, 1, 'hi', 0x00ff00)
    const [top = '', bottom = ''] = cellsToText(c.encode(), 6)
    expect(top).toBe('⠉⠉⠉⠉⠉⠉')
    expect(bottom.startsWith('hi')).toBe(true)
  })

  test('a character that may be two cells wide is replaced', () => {
    const c = new Canvas(3, 1)
    c.text(0, 0, '界a', 0xffffff)
    expect(cellsToText(c.encode(), 3)[0]).toBe('?a ')
  })
})

describe('local router', () => {
  test('weighs roles differently: planning to Opus, execution to Haiku', () => {
    const pick = (role: string) => localDecision({ agentType: `run-ledger:${role}`, models: MODELS, history: [], contextTokens: null }).model
    expect(pick('orchestrator')).toBe('claude-opus-5-5')
    expect(pick('implementer')).toBe('claude-sonnet-5-5')
    expect(pick('executor')).toBe('claude-haiku-4-5')
  })

  test('built-in types borrow the closest role', () => {
    expect(profileFor('Plan').weights).toEqual(profileFor('run-ledger:orchestrator').weights)
    expect(profileFor('Explore').weights).toEqual(profileFor('run-ledger:executor').weights)
  })

  test('latency counts only where this machine has results', () => {
    const ranked = rankModels({ agentType: 'Explore', models: MODELS, history: [], contextTokens: null })
    expect(ranked.every(c => c.criteria.latency === null)).toBe(true)
    const history: LedgerHistoryEntry[] = [
      { agentType: 'Explore', model: 'claude-haiku-4-5', outcome: 'completed', costUsd: 0.01, durationMs: 4000, at: 0 },
      { agentType: 'Explore', model: 'claude-sonnet-5-5', outcome: 'completed', costUsd: 0.02, durationMs: 9000, at: 0 },
    ]
    const timed = rankModels({ agentType: 'Explore', models: MODELS, history, contextTokens: null })
    expect(timed.find(c => c.model === 'claude-haiku-4-5')?.criteria.latency).toBe(1)
    expect(timed.find(c => c.model === 'claude-sonnet-5-5')?.criteria.latency).toBe(0)
  })

  test('a context larger than a window lowers that model fit', () => {
    const ranked = rankModels({ agentType: 'Explore', models: MODELS, history: [], contextTokens: 400_000 })
    expect(ranked.find(c => c.model === 'claude-haiku-4-5')?.criteria.fit).toBeLessThan(0.5)
    expect(ranked.find(c => c.model === 'claude-opus-5-5')?.criteria.fit).toBe(1)
  })

  test('repeated failures pull a model down for that role', () => {
    const fails: LedgerHistoryEntry[] = Array.from({ length: 6 }, () => ({
      agentType: 'run-ledger:executor', model: 'claude-haiku-4-5', outcome: 'failed', costUsd: null, durationMs: null, at: 0,
    }))
    const before = rankModels({ agentType: 'run-ledger:executor', models: MODELS, history: [], contextTokens: null })
    const after = rankModels({ agentType: 'run-ledger:executor', models: MODELS, history: fails, contextTokens: null })
    const score = (list: typeof before) => list.find(c => c.model === 'claude-haiku-4-5')?.score ?? 0
    expect(score(after)).toBeLessThan(score(before))
  })
})

const node = (patch: Partial<GraphNode> & Pick<GraphNode, 'id' | 'parentId' | 'label' | 'model' | 'status'>): GraphNode => ({
  startedAt: null, endedAt: null, contextTokens: null, rate: 0, ...patch,
})
const nodes: GraphNode[] = [
  node({ id: 'main', parentId: null, label: 'main', model: 'claude-opus-5-5', status: 'running' }),
  node({ id: 'o', parentId: 'main', label: 'orchestrator', model: 'claude-opus-5-5', status: 'running' }),
  node({ id: 'b', parentId: 'o', label: 'builder', model: 'claude-sonnet-5-5', status: 'done' }),
  node({ id: 'x', parentId: 'o', label: 'executor', model: 'claude-haiku-4-5', status: 'failed' }),
]

/** How many Raster cells are drawn in `color`. */
function cellsIn(cells: string, color: number): number {
  const b = fromBase64(cells)
  const w = new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4)
  let n = 0
  for (let i = 1; i < w.length; i += 3) if (w[i] === color) n++
  return n
}

/** How many braille dots a Raster's cells hold. */
function dots(cells: string): number {
  const b = fromBase64(cells)
  const w = new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4)
  let n = 0
  for (let i = 0; i < w.length; i += 3) {
    const cp = w[i] ?? 0
    if (cp >= 0x2800 && cp <= 0x28ff) for (let bits = cp - 0x2800; bits > 0; bits >>= 1) n += bits & 1
  }
  return n
}

describe('agent graph', () => {
  test('lays a parent over its children', () => {
    const { at, depth } = layoutTree(nodes)
    expect(depth).toBe(2)
    expect(at.get('o')?.x).toBe(((at.get('b')?.x ?? 0) + (at.get('x')?.x ?? 0)) / 2)
  })

  test('draws names, models, a check and a cross', () => {
    const text = cellsToText(drawGraph(nodes, [], 0, 50, 14).encode(), 50).join('\n')
    for (const word of ['main', 'orchestrator', 'builder', 'executor', 'sonnet-5.5', 'haiku-4.5']) expect(text).toContain(word)
    expect(text).toContain('✓')
    expect(text).toContain('✗')
  })

  test('a route packet is drawn mid-flight and gone once it lands', () => {
    const pulse = { id: 'p', from: 'o', to: 'b', kind: 'route' as const, at: 1000 }
    const accent = (cells: string) => {
      const b = fromBase64(cells)
      const w = new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4)
      let n = 0
      for (let i = 1; i < w.length; i += 3) if (w[i] === 0xe0559f) n++
      return n
    }
    expect(accent(drawGraph(nodes, [pulse], 1700, 50, 14).encode())).toBeGreaterThan(0)
    expect(accent(drawGraph(nodes, [pulse], 4000, 50, 14).encode())).toBe(0)
  })

  test('the SVG animates packets and running halos', () => {
    const svg = graphSvg(nodes, [{ id: 'p', from: 'o', to: 'b', kind: 'route', at: 0 }], 500, 400, 260)
    expect(svg).toContain('<animateMotion')
    expect(svg).toContain('repeatCount="indefinite"')
    expect(svg).toContain('orchestrator')
  })

  test('model names shorten the same everywhere', () => {
    expect(shortModel('claude-opus-5-5')).toBe('opus-5.5')
    expect(shortModel('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('haiku-4.5')
    expect(shortModel(null)).toBe('unknown')
  })
})

describe('motion', () => {
  const pair = (child: Partial<GraphNode>): GraphNode[] => [
    node({ id: 'main', parentId: null, label: 'main', model: 'claude-opus-5-5', status: 'main' }),
    node({ id: 'a', parentId: 'main', label: 'agent', model: 'claude-haiku-4-5', status: 'done', ...child }),
  ]

  test('a packet leaves a fading trail behind it', () => {
    const pulse = { id: 'p', from: 'main', to: 'a', kind: 'route' as const, at: 0 }
    const cells = drawGraph(pair({}), [pulse], 800, 40, 16).encode()
    const head = cellsIn(cells, 0xe0559f)
    let trail = 0
    for (const k of [1, 2, 3, 4]) trail += cellsIn(cells, mix(0xe0559f, 0x1e1f22, k * 0.18))
    expect(head).toBeGreaterThan(0)
    expect(trail).toBeGreaterThan(0)
  })

  test('an edge widens with the context handed over', () => {
    const thin = dots(drawGraph(pair({ contextTokens: 1_000 }), [], 0, 40, 16).encode())
    const wide = dots(drawGraph(pair({ contextTokens: 200_000 }), [], 0, 40, 16).encode())
    expect(wide).toBeGreaterThan(thin)
    expect(edgeWidth(null)).toBe(1)
    expect(edgeWidth(20_000)).toBe(2)
    expect(edgeWidth(80_000)).toBe(3)
  })

  test('dashes flow down the edge into a running agent', () => {
    const running = pair({ status: 'running' })
    expect(drawGraph(running, [], 0, 40, 16).encode()).not.toBe(drawGraph(running, [], 210, 40, 16).encode())
  })

  test('an agent that ends bursts green, one that fails bursts red, then it settles', () => {
    const done = pair({ status: 'done', endedAt: 1000 })
    const burst = drawGraph(done, [], 1150, 40, 16).encode()
    const settled = drawGraph(done, [], 3000, 40, 16).encode()
    expect(burst).not.toBe(settled)
    const failed = drawGraph(pair({ status: 'failed', endedAt: 1000 }), [], 1150, 40, 16).encode()
    expect(failed).not.toBe(drawGraph(pair({ status: 'failed', endedAt: 1000 }), [], 3000, 40, 16).encode())
  })

  test('a new agent arrives with a ripple', () => {
    const fresh = pair({ status: 'running', startedAt: 1000 })
    expect(dots(drawGraph(fresh, [], 1300, 40, 16).encode())).not.toBe(dots(drawGraph(fresh, [], 2400, 40, 16).encode()))
  })

  test('the halo beats faster as output speeds up', () => {
    expect(heartbeat(0)).toBe(1600)
    expect(heartbeat(40)).toBeLessThan(1600)
    expect(heartbeat(200)).toBe(300)
  })

  test('live rates, the per-second series and the braille sparkline', () => {
    const live = new LiveRates()
    live.add('a', 10_000, 40)
    live.add('a', 10_100, 20)
    live.add('a', 12_000, 30)
    expect(live.rate('a', 12_100)).toBe(30)
    expect(live.rate('a', 12_100, 1000)).toBe(30)
    expect(live.series('a', 12_100, 4)).toEqual([0, 60, 0, 30])
    expect(live.rate('nobody', 12_100)).toBe(0)
    expect(sparkline([0, 4, 2, 0])).toBe('⢸⡄')
    expect(sparkline([])).toBe('')
  })

  test('the odometer rolls from the old value to the new one', () => {
    expect(rolling(1, 2, 0)).toBe(1)
    expect(rolling(1, 2, 350)).toBeGreaterThan(1.49)
    expect(rolling(1, 2, 2000)).toBe(2)
  })
})

describe('context exchange', () => {
  const item = (i: number, patch: Partial<LedgerContextItem>): LedgerContextItem => ({
    id: `c${i}`, runId: 'r', agentId: null, kind: 'read', label: `piece${i}`, path: null, tokens: 100, fromAgentId: null, at: i * 10, ...patch,
  })

  test('counts what crossed between loops apart from the rest', () => {
    const ledger = {
      ...emptyLedger(),
      items: [item(0, {}), item(1, { agentId: 'a', fromAgentId: 'main', tokens: 300 }), item(2, { tokens: null }), item(3, { runId: 'other' })],
    }
    const ctx = contextOf(ledger, 'r')
    expect(ctx.items).toHaveLength(3)
    expect(ctx.moved).toBe(300)
    expect(ctx.total).toBe(400)
    expect(ctx.unmeasured).toBe(1)
  })

  test('draws every label in two lanes', () => {
    const items = [item(0, { label: 'repo map' }), item(1, { label: 'route.ts' }), item(2, { label: 'npm test' })]
    const text = cellsToText(drawContext(items, [], 'claude-opus-5-5', 0, 60, 4).encode(), 60).join('\n')
    for (const word of ['repo map', 'route.ts', 'npm test']) expect(text).toContain(word)
  })
})
