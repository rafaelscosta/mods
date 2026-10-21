import { describe, expect, test } from 'claude-code/testing'

import type { LedgerRequest } from '../types'
import {
  addItem,
  addPulse,
  bumpAttempt,
  cleanLabel,
  clockLocal,
  closedByPerson,
  emptyLedger,
  estimateCost,
  normalizeLedger,
  parseHandback,
  reconcile,
  exportCsv,
  formatTotal,
  formatUsd,
  isEligibleForAuto,
  normalizeModel,
  parseJevAnswer,
  formatSavings,
  recordRequest,
  savingsVs,
  totals,
} from '../hooks/ledger'
import { PRICES_AS_OF } from '../hooks/prices'

const usage = { input: 1000, output: 500, cacheRead: 10_000, cacheWrite: 2000 }

const request = (key: string, patch: Partial<LedgerRequest> = {}): LedgerRequest => ({
  key,
  runId: 'r1',
  agentId: null,
  turnId: 't1',
  index: 0,
  attempt: 0,
  requestedModel: 'claude-opus-5-5',
  model: 'claude-opus-5-5',
  sourceKind: 'main',
  sourcePlugin: null,
  usage,
  cost: estimateCost('claude-opus-5-5', usage),
  stopReason: 'end_turn',
  at: 0,
  ...patch,
})

describe('costs', () => {
  test('prices every bucket at the dated rates', () => {
    // opus-5-5: in 4, out 20, cache write 5 (1.25x), cache read 0.20 per MTok
    const cost = estimateCost('claude-opus-5-5', usage)
    expect(cost.basis).toBe('priced')
    expect(cost.pricesAsOf).toBe(PRICES_AS_OF)
    expect(cost.usd).toBeGreaterThan(0.025999)
    expect(cost.usd).toBeLessThan(0.026001)
  })

  test('recognises provider spellings of a model id', () => {
    expect(normalizeModel('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('claude-haiku-4-5')
    expect(normalizeModel('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
    expect(estimateCost('claude-sonnet-5-5[1m]', usage).basis).toBe('priced')
  })

  test('an alias is priced but marked assumed', () => {
    expect(estimateCost('haiku', usage).basis).toBe('alias-assumed')
  })

  test('missing data is unknown, never zero', () => {
    expect(estimateCost('some-other-model', usage)).toEqual({ usd: null, basis: 'unpriced-model', pricesAsOf: null })
    expect(estimateCost('claude-opus-5-5', null)).toEqual({ usd: null, basis: 'no-usage', pricesAsOf: null })
    expect(formatUsd(null)).toBe('unknown')
    // A Jev decision costs about $0.00005: shown as such, never as `$0.0000`.
    expect(formatUsd(0.0000483)).toBe('$0.000048')
    expect(formatUsd(0.006)).toBe('$0.0060')
    expect(formatTotal(0, 2, 2)).toBe('unknown')
    expect(formatTotal(0.5, 1, 3)).toBe('~$0.50 + 1 unknown')
  })
})

describe('counting', () => {
  test('a request key is counted once', () => {
    let ledger = emptyLedger()
    ledger = recordRequest(ledger, request('main|t1|0|0'))
    ledger = recordRequest(ledger, request('main|t1|0|0'))
    expect(ledger.requests).toHaveLength(1)
  })

  test('a re-send of the same step is a retry, counted as its own request', () => {
    let ledger = emptyLedger()
    const first = bumpAttempt(ledger, 'main|t1|0')
    const second = bumpAttempt(first.ledger, 'main|t1|0')
    expect(first.attempt).toBe(0)
    expect(second.attempt).toBe(1)
    ledger = recordRequest(second.ledger, request('main|t1|0|0'))
    ledger = recordRequest(ledger, request('main|t1|0|1', { attempt: 1 }))
    const t = totals(ledger)
    expect(t.requests).toBe(2)
    expect(t.retries).toBe(1)
  })

  test('totals keep unknown costs and tokens out of the sums and count them', () => {
    let ledger = emptyLedger()
    ledger = recordRequest(ledger, request('a'))
    ledger = recordRequest(ledger, request('b', { model: 'mystery', cost: estimateCost('mystery', usage) }))
    ledger = recordRequest(ledger, request('c', { usage: null, cost: estimateCost('claude-opus-5-5', null) }))
    const t = totals(ledger)
    expect(t.requests).toBe(3)
    expect(t.unknownCost).toBe(2)
    expect(t.usageUnknown).toBe(1)
    expect(t.usage.input).toBe(2000)
    expect(t.knownUsd).toBeLessThan(0.026001)
    expect(t.byModel.find(m => m.model === 'mystery')?.unknown).toBe(1)
  })

  test('the CSV writes unknown where a value is missing', () => {
    const ledger = recordRequest(emptyLedger(), request('c', { usage: null, cost: estimateCost('claude-opus-5-5', null) }))
    const [header, line] = exportCsv(ledger).trim().split('\n')
    expect(header).toContain('cost_usd_estimate')
    expect(line).toContain('unknown')
  })
})

describe('savings', () => {
  const haiku = (key: string) => request(key, { model: 'claude-haiku-4-5', cost: estimateCost('claude-haiku-4-5', usage) })
  const short = (m: string) => m.replace('claude-', '')

  test('prices the same tokens on the baseline and reports what routing saved', () => {
    let ledger = emptyLedger()
    ledger = recordRequest(ledger, request('a'))
    ledger = recordRequest(ledger, haiku('b'))
    const s = savingsVs(ledger, 'claude-opus-5-5')
    // opus 0.026 twice as the baseline; actual 0.026 + haiku (1000 + 2500 + 2500 + 1000) / 1e6 = 0.007
    expect(s.baseline).toBeGreaterThan(0.051999)
    expect(s.actual).toBeGreaterThan(0.032999)
    expect(s.saved).toBeGreaterThan(0.018999)
    expect(formatSavings(s, short)).toBe('routing saved ≈$0.02 (37%) vs all opus-5-5')
  })

  test('requests with unknown tokens or price stay out of both sides', () => {
    let ledger = emptyLedger()
    ledger = recordRequest(ledger, haiku('a'))
    ledger = recordRequest(ledger, request('b', { usage: null, cost: estimateCost('claude-opus-5-5', null) }))
    ledger = recordRequest(ledger, request('c', { model: 'mystery', cost: estimateCost('mystery', usage) }))
    const s = savingsVs(ledger, 'claude-opus-5-5')
    expect(s.counted).toBe(1)
    expect(s.skipped).toBe(2)
  })

  test("Jev's own cost counts against the routing, and a pricier route shows what it cost", () => {
    let ledger = emptyLedger()
    ledger = recordRequest(ledger, request('a', { model: 'claude-fable-5-1', cost: estimateCost('claude-fable-5-1', usage) }))
    const s = savingsVs(ledger, 'claude-opus-5-5')
    expect(s.saved).toBeLessThan(0)
    expect(formatSavings(s, short)).toMatch(/^routing cost \+\$0\.\d+ \(\d+%\) vs all opus-5-5$/)
    expect(formatSavings(savingsVs(emptyLedger(), 'claude-opus-5-5'), short)).toBeNull()
  })
})

describe('Jev answers', () => {
  const offered = ['claude-opus-5-5', 'claude-haiku-4-5']

  test('accepts an offered model with its reason and reported cost', () => {
    const answer = parseJevAnswer(
      JSON.stringify({ model: 'claude-haiku-4-5', reason: 'file search', confidence: 0.8, cost: { usd: 0.0004 } }),
      offered,
    )
    expect(answer).toEqual({
      isValid: true,
      model: 'claude-haiku-4-5',
      reason: 'file search',
      confidence: 0.8,
      cost: { usd: 0.0004, basis: 'reported', pricesAsOf: null },
      ranking: [],
    })
  })

  test("reads Jev's optional ranking, offered models only, best first", () => {
    const answer = parseJevAnswer(
      JSON.stringify({
        model: 'claude-haiku-4-5',
        reason: 'cheap',
        ranking: [
          { model: 'claude-opus-5-5', score: 0.6, criteria: { cost: 0.2, quality: 0.9 } },
          { model: 'gpt-x', score: 0.99 },
          { model: 'claude-haiku-4-5', score: 0.8, criteria: { cost: 1, latency: 2 } },
        ],
      }),
      offered,
    )
    expect(answer.isValid).toBe(true)
    if (!answer.isValid) return
    expect(answer.ranking.map(c => c.model)).toEqual(['claude-haiku-4-5', 'claude-opus-5-5'])
    expect(answer.ranking[0]?.criteria).toEqual({ cost: 1, latency: null, quality: null, fit: null })
  })

  test("prices Jev's own call from usage when it reports no dollars", () => {
    const answer = parseJevAnswer(
      JSON.stringify({
        model: 'claude-opus-5-5',
        reason: 'hard',
        cost: { model: 'claude-haiku-4-5', usage: { input_tokens: 1000, output_tokens: 100 } },
      }),
      offered,
    )
    expect(answer.cost.basis).toBe('priced')
    expect(answer.cost.usd).toBeGreaterThan(0.001499)
  })

  test('refuses a model that was not offered, and a non-JSON body', () => {
    expect(parseJevAnswer(JSON.stringify({ model: 'gpt-x', reason: 'r' }), offered).isValid).toBe(false)
    expect(parseJevAnswer('not json', offered).isValid).toBe(false)
  })

  test('auto routing only where nothing else chose', () => {
    const base = { mode: 'auto', agentType: 'Explore', fork: false, requestedModel: undefined, allowedTypes: ['Explore'] }
    expect(isEligibleForAuto(base)).toBe(true)
    expect(isEligibleForAuto({ ...base, mode: 'recommend' })).toBe(false)
    expect(isEligibleForAuto({ ...base, fork: true })).toBe(false)
    expect(isEligibleForAuto({ ...base, requestedModel: 'opus' })).toBe(false)
    expect(isEligibleForAuto({ ...base, agentType: 'Plan' })).toBe(false)
  })
})

describe('carried over from the 0.1.x fixes', () => {
  test('a label drops markup and stays one short line', () => {
    expect(cleanLabel('<synapse-rules>\n  fix   the\nbug </synapse-rules>')).toBe('fix the bug')
    expect(cleanLabel('   ')).toBe('(continuation)')
    expect(cleanLabel('x'.repeat(80))).toHaveLength(60)
  })

  test("a subagent's report is read from its agent-message, framing dropped", () => {
    const text =
      'Another Claude session sent a message:\n<agent-message from="ac2eb680">\n[Subagent hand-back] The text below is the final report. The report follows:\n  Three files, all text.\n</agent-message>\nThat "other Claude session" is an agent.'
    expect(parseHandback(text)).toEqual({ agentId: 'ac2eb680', report: 'Three files, all text.' })
    expect(parseHandback('an ordinary prompt')).toBeNull()
  })

  test('the clock reads HH:MM in local time', () => {
    expect(clockLocal(new Date(2026, 9, 19, 9, 5).getTime())).toBe('09:05')
  })

  test("only the person's close of this pane ends the session's auto-opens", () => {
    expect(closedByPerson('run-ledger', { id: 'run-ledger', origin: { kind: 'person' } })).toBe(true)
    expect(closedByPerson('run-ledger', { id: 'run-ledger', origin: { kind: 'plugin' } })).toBe(false)
    expect(closedByPerson('run-ledger', { id: 'run-ledger', origin: { kind: 'unload' } })).toBe(false)
    expect(closedByPerson('run-ledger', { id: 'other-pane', origin: { kind: 'person' } })).toBe(false)
  })

  test('what /cost added since the baseline, less what was counted, is outside the hooks', () => {
    const counted = (usd: number | null) =>
      totals(recordRequest(emptyLedger(), request('k1', { cost: { usd, basis: usd === null ? 'unpriced-model' : 'priced', pricesAsOf: null } })))
    const seen = reconcile(1.5, 1.0, counted(0.3))
    expect(seen.engineUsd).toBeGreaterThan(0.499999)
    expect(seen.engineUsd).toBeLessThan(0.500001)
    expect(seen.unseenUsd).toBeGreaterThan(0.199999)
    expect(seen.unseenUsd).toBeLessThan(0.200001)
    expect(reconcile(null, 0, counted(0.3))).toEqual({ engineUsd: null, unseenUsd: null })
    expect(reconcile(1, 0, counted(null)).unseenUsd).toBeNull()
  })

  test('a 0.1.x ledger left in state takes the fields this version adds, and keeps its own', () => {
    // What 0.1.x kept: no items, no pulses, no baseline.
    const old = {
      runs: [{ id: 't1', label: 'old run', source: 'session', startedAt: 0, endedAt: 1, status: 'completed', model: 'claude-opus-5-5' }],
      requests: [request('main|t1|0|0')],
      agents: [],
      recommendations: [],
      attempts: [{ key: 'main|t1|0', count: 1 }],
      currentRunId: null,
      counter: 7,
    }
    const ledger = normalizeLedger(old)
    expect(ledger.items).toEqual([])
    expect(ledger.pulses).toEqual([])
    expect(ledger.costBaselineUsd).toBeNull()
    expect(ledger.runs).toEqual(old.runs)
    expect(ledger.counter).toBe(7)
    // The calls that fail on a raw 0.1.x ledger work on the normalized one.
    const grown = addPulse(
      addItem(ledger, { id: 'ctx-1', runId: 't1', agentId: null, kind: 'read', label: 'a', path: null, tokens: null, fromAgentId: null, at: 2 }),
      { id: 'pulse-1', from: 'main', to: 'agent-1', kind: 'route', at: 2 },
    )
    expect(grown.items).toHaveLength(1)
    expect(grown.pulses).toHaveLength(1)
  })
})
