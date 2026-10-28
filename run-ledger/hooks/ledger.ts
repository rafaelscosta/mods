// Pure ledger logic: no `$`, no I/O. Everything here is unit-tested.

import type {
  Ledger,
  LedgerAgent,
  LedgerCandidate,
  LedgerContextItem,
  LedgerCost,
  LedgerHistoryEntry,
  LedgerPulse,
  LedgerRecommendation,
  LedgerRequest,
  LedgerRun,
  LedgerUsage,
} from '../types'
import { ALIASES, DEFAULT_JEV_MODELS, PRICES, PRICES_AS_OF } from './prices'
import type { PriceRow } from './prices'

const MAX_RUNS = 200
const MAX_REQUESTS = 4000
const MAX_AGENTS = 400
const MAX_RECOMMENDATIONS = 400
const MAX_ATTEMPTS = 4000
const MAX_ITEMS = 600
const MAX_PULSES = 40

export const UNATTRIBUTED = 'unattributed'

export const emptyLedger = (): Ledger => ({
  runs: [],
  requests: [],
  agents: [],
  recommendations: [],
  items: [],
  pulses: [],
  attempts: [],
  currentRunId: null,
  counter: 0,
  costBaselineUsd: null,
})

/**
 * A ledger kept in `$.state` by an older run-ledger (0.1.x has no `items` or `pulses`):
 * every field it lacks takes its empty value, every field it has is kept.
 */
export const normalizeLedger = (stored: Partial<Ledger>): Ledger => ({ ...emptyLedger(), ...stored })

// ---------------------------------------------------------------- pricing

/** `us.anthropic.claude-haiku-4-5-20251001-v1:0`, `claude-opus-5-5[1m]` -> base id. */
export function normalizeModel(model: string): string {
  let id = model.trim().toLowerCase()
  const at = id.indexOf('claude-')
  if (at > 0) id = id.slice(at)
  id = id.replace(/\[.*\]$/, '').replace(/@.*$/, '').replace(/-v\d+(:\d+)?$/, '')
  id = id.replace(/-\d{8}$/, '')
  return id
}

export type PriceMatch = { row: PriceRow; isAlias: boolean }

export function priceFor(model: string | null): PriceMatch | undefined {
  if (model === null) return undefined
  const id = normalizeModel(model)
  const direct = PRICES.find(p => p.id === id)
  if (direct) return { row: direct, isAlias: false }
  const alias = ALIASES.find(a => a.alias === id)
  const aliased = alias && PRICES.find(p => p.id === alias.id)
  return aliased ? { row: aliased, isAlias: true } : undefined
}

export function estimateCost(model: string | null, usage: LedgerUsage | null): LedgerCost {
  if (usage === null) return { usd: null, basis: 'no-usage', pricesAsOf: null }
  const match = priceFor(model)
  if (!match) return { usd: null, basis: 'unpriced-model', pricesAsOf: null }
  const p = match.row
  const usd =
    (usage.input * p.input +
      usage.output * p.output +
      usage.cacheWrite * p.cacheWrite +
      usage.cacheRead * p.cacheRead) /
    1_000_000
  return { usd, basis: match.isAlias ? 'alias-assumed' : 'priced', pricesAsOf: PRICES_AS_OF }
}

/** The engine's `ModelUsage`, in the ledger's buckets. */
export type ApiUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export const fromApiUsage = (u: ApiUsage | null | undefined): LedgerUsage | null =>
  u
    ? {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens,
      }
    : null

// ---------------------------------------------------------------- mutation

const cap = <T>(list: readonly T[], max: number): T[] =>
  list.length > max ? list.slice(list.length - max) : [...list]

export function upsertRun(ledger: Ledger, run: LedgerRun): Ledger {
  const has = ledger.runs.some(r => r.id === run.id)
  const runs = has ? ledger.runs.map(r => (r.id === run.id ? { ...r, ...run } : r)) : [...ledger.runs, run]
  return { ...ledger, runs: cap(runs, MAX_RUNS) }
}

export function patchRun(ledger: Ledger, id: string, patch: Partial<LedgerRun>): Ledger {
  return { ...ledger, runs: ledger.runs.map(r => (r.id === id ? { ...r, ...patch } : r)) }
}

/** A run for an id the ledger has not seen (a mod loaded mid-turn, a plugin's call between turns). */
export function ensureRun(ledger: Ledger, id: string, label: string, source: string, at: number): Ledger {
  if (ledger.runs.some(r => r.id === id)) return ledger
  return upsertRun(ledger, { id, label, source, startedAt: at, endedAt: null, status: 'running', model: null })
}

/** Counts a send of the step `baseKey`; the answer's `attempt` is 0 the first time. */
export function bumpAttempt(ledger: Ledger, baseKey: string): { ledger: Ledger; attempt: number } {
  const found = ledger.attempts.find(a => a.key === baseKey)
  const attempt = found ? found.count : 0
  const attempts = found
    ? ledger.attempts.map(a => (a.key === baseKey ? { key: a.key, count: a.count + 1 } : a))
    : [...ledger.attempts, { key: baseKey, count: 1 }]
  return { ledger: { ...ledger, attempts: cap(attempts, MAX_ATTEMPTS) }, attempt }
}

/** Adds a request once: a key already recorded leaves the ledger as it is. */
export function recordRequest(ledger: Ledger, request: LedgerRequest): Ledger {
  if (ledger.requests.some(r => r.key === request.key)) return ledger
  return { ...ledger, requests: cap([...ledger.requests, request], MAX_REQUESTS) }
}

export function upsertAgent(ledger: Ledger, agent: LedgerAgent): Ledger {
  const has = ledger.agents.some(a => a.id === agent.id)
  const agents = has ? ledger.agents.map(a => (a.id === agent.id ? agent : a)) : [...ledger.agents, agent]
  return { ...ledger, agents: cap(agents, MAX_AGENTS) }
}

export function patchAgent(ledger: Ledger, id: string, patch: Partial<LedgerAgent>): Ledger {
  return { ...ledger, agents: ledger.agents.map(a => (a.id === id ? { ...a, ...patch } : a)) }
}

export function addRecommendation(ledger: Ledger, rec: LedgerRecommendation): Ledger {
  return { ...ledger, recommendations: cap([...ledger.recommendations, rec], MAX_RECOMMENDATIONS) }
}

export function patchRecommendation(ledger: Ledger, id: string, patch: Partial<LedgerRecommendation>): Ledger {
  return { ...ledger, recommendations: ledger.recommendations.map(r => (r.id === id ? { ...r, ...patch } : r)) }
}

/** The latest decision for `agentType` in `runId`. */
export const decisionFor = (ledger: Ledger, runId: string, agentType: string): LedgerRecommendation | undefined =>
  [...ledger.recommendations].reverse().find(r => r.runId === runId && r.agentType === agentType)

export function addItem(ledger: Ledger, item: LedgerContextItem): Ledger {
  return { ...ledger, items: cap([...ledger.items, item], MAX_ITEMS) }
}

export function patchItem(ledger: Ledger, id: string, patch: Partial<LedgerContextItem>): Ledger {
  return { ...ledger, items: ledger.items.map(i => (i.id === id ? { ...i, ...patch } : i)) }
}

export function addPulse(ledger: Ledger, pulse: LedgerPulse): Ledger {
  return { ...ledger, pulses: cap([...ledger.pulses, pulse], MAX_PULSES) }
}

/** About how many tokens a text is: characters / 4. */
export const approxTokens = (text: string): number => Math.ceil(text.length / 4)

/** The loop that last wrote `path` before `at`, when it is not `agentId`'s own. */
export function producerOf(ledger: Ledger, path: string, agentId: string | null, at: number): string | null | undefined {
  const write = [...ledger.items].reverse().find(i => i.kind === 'write' && i.path === path && i.at <= at)
  if (!write || write.agentId === agentId) return undefined
  return write.agentId
}

/** Which run a request of loop `agentId` belongs to: its spawn's run, forever. */
export function runOfAgent(ledger: Ledger, agentId: string | null): string | undefined {
  if (agentId === null) return undefined
  return ledger.agents.find(a => a.id === agentId)?.runId
}

export function nextId(ledger: Ledger, prefix: string): { ledger: Ledger; id: string } {
  const counter = ledger.counter + 1
  return { ledger: { ...ledger, counter }, id: `${prefix}-${counter}` }
}

/** `answer` -> completed, and the engine's other ends. */
export function statusFromReason(reason: string): string {
  if (reason === 'answer') return 'completed'
  if (reason === 'aborted') return 'killed'
  if (reason === 'error') return 'failed'
  if (reason === 'refusal') return 'refused'
  return reason
}

// ---------------------------------------------------------------- totals

export type Totals = {
  requests: number
  usage: LedgerUsage
  /** Requests with no reported usage: their tokens are unknown, not zero. */
  usageUnknown: number
  knownUsd: number
  unknownCost: number
  retries: number
  jevUsd: number
  jevUnknown: number
  byModel: { model: string; requests: number; usd: number; unknown: number }[]
  bySource: { source: string; requests: number; usd: number; unknown: number }[]
}

const sourceLabel = (r: LedgerRequest): string =>
  r.sourcePlugin ? `${r.sourceKind}:${r.sourcePlugin}` : r.sourceKind

function bump(
  list: { key: string; requests: number; usd: number; unknown: number }[],
  key: string,
  usd: number | null,
): void {
  let entry = list.find(e => e.key === key)
  if (!entry) {
    entry = { key, requests: 0, usd: 0, unknown: 0 }
    list.push(entry)
  }
  entry.requests += 1
  if (usd === null) entry.unknown += 1
  else entry.usd += usd
}

export function totals(ledger: Ledger, runId?: string): Totals {
  const requests = ledger.requests.filter(r => runId === undefined || r.runId === runId)
  const usage: LedgerUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const models: { key: string; requests: number; usd: number; unknown: number }[] = []
  const sources: { key: string; requests: number; usd: number; unknown: number }[] = []
  let usageUnknown = 0
  let knownUsd = 0
  let unknownCost = 0
  let retries = 0
  for (const r of requests) {
    if (r.usage) {
      usage.input += r.usage.input
      usage.output += r.usage.output
      usage.cacheRead += r.usage.cacheRead
      usage.cacheWrite += r.usage.cacheWrite
    } else usageUnknown += 1
    if (r.cost.usd === null) unknownCost += 1
    else knownUsd += r.cost.usd
    if (r.attempt > 0) retries += 1
    bump(models, r.model ?? r.requestedModel ?? 'unknown', r.cost.usd)
    bump(sources, sourceLabel(r), r.cost.usd)
  }
  let jevUsd = 0
  let jevUnknown = 0
  for (const rec of ledger.recommendations) {
    if (runId !== undefined && rec.runId !== runId) continue
    if (rec.router !== 'jev' || (rec.status !== 'ok' && rec.status !== 'error')) continue
    if (rec.jevCost.usd === null) jevUnknown += 1
    else jevUsd += rec.jevCost.usd
  }
  return {
    requests: requests.length,
    usage,
    usageUnknown,
    knownUsd,
    unknownCost,
    retries,
    jevUsd,
    jevUnknown,
    byModel: models.map(m => ({ model: m.key, requests: m.requests, usd: m.usd, unknown: m.unknown })),
    bySource: sources.map(s => ({ source: s.key, requests: s.requests, usd: s.usd, unknown: s.unknown })),
  }
}

export type Savings = {
  baselineModel: string
  /** What the priced requests cost, at API rates. */
  actual: number
  /** What the same tokens would have cost on `baselineModel`. */
  baseline: number
  /** Jev's own known cost, charged against the routing. */
  router: number
  /** baseline - actual - router: positive is money routing saved. */
  saved: number
  /** saved / baseline, or null with nothing priced. */
  pct: number | null
  counted: number
  /** Requests with unknown tokens or price, left out of both sides. */
  skipped: number
}

/**
 * What routing saved: every request whose tokens and price are known, priced again as if it
 * had run on `baselineModel` with the same tokens (an estimate: another model may have used
 * a different number of them), minus Jev's own cost.
 */
export function savingsVs(ledger: Ledger, baselineModel: string, runId?: string): Savings {
  let actual = 0
  let baseline = 0
  let counted = 0
  let skipped = 0
  for (const r of ledger.requests) {
    if (runId !== undefined && r.runId !== runId) continue
    if (r.usage === null || r.cost.usd === null) {
      skipped += 1
      continue
    }
    const base = estimateCost(baselineModel, r.usage).usd
    actual += r.cost.usd
    baseline += base ?? r.cost.usd
    counted += 1
  }
  const router = totals(ledger, runId).jevUsd
  const saved = baseline - actual - router
  return { baselineModel, actual, baseline, router, saved, pct: baseline > 0 ? saved / baseline : null, counted, skipped }
}

/** "routing saved ≈$0.84 (62%) vs all opus-5.5", or what it cost over that. */
export function formatSavings(s: Savings, short: (model: string) => string): string | null {
  if (s.counted === 0 || Math.abs(s.saved) < 0.00005) return null
  const pct = s.pct === null ? '' : ` (${Math.round(Math.abs(s.pct) * 100)}%)`
  const vs = `vs all ${short(s.baselineModel)}`
  return s.saved > 0 ? `routing saved ≈${formatUsd(s.saved)}${pct} ${vs}` : `routing cost +${formatUsd(-s.saved)}${pct} ${vs}`
}

/** Cost of what one subagent's loop requested. */
export function agentCost(ledger: Ledger, agentId: string): { usd: number; unknown: number; requests: number } {
  let usd = 0
  let unknown = 0
  let requests = 0
  for (const r of ledger.requests) {
    if (r.agentId !== agentId) continue
    requests += 1
    if (r.cost.usd === null) unknown += 1
    else usd += r.cost.usd
  }
  return { usd, unknown, requests }
}

// ---------------------------------------------------------------- format

export function formatUsd(usd: number | null): string {
  if (usd === null) return 'unknown'
  if (usd === 0) return '$0'
  // Two significant figures under a hundredth of a cent (a Jev decision is about $0.00005): never `$0.0000`.
  if (usd < 0.0001) return `$${usd.toPrecision(2)}`
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

/** "~$0.42", "~$0.42 + 2 unknown", "unknown". */
export function formatTotal(knownUsd: number, unknown: number, count: number): string {
  if (count === 0) return '$0'
  if (unknown === count) return 'unknown'
  const base = `~${formatUsd(knownUsd)}`
  return unknown > 0 ? `${base} + ${unknown} unknown` : base
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export const clockUtc = (ms: number): string => new Date(ms).toISOString().slice(11, 16)

/** HH:MM in the machine's own time zone, as the person reads the clock. */
export function clockLocal(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** A one-line run label: markup tags dropped, whitespace collapsed, at most 60 characters. */
export function cleanLabel(text: string): string {
  const flat = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return '(continuation)'
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat
}

/**
 * A background subagent's report as it reaches the main loop:
 * `<agent-message from="ID">` followed by the report. null for any other text.
 */
export function parseHandback(text: string): { agentId: string; report: string | null } | null {
  const found = /<agent-message from="([^"]+)">/.exec(text)
  if (!found || found[1] === undefined) return null
  const after = text.slice(found.index + found[0].length).replace(/<\/agent-message>[\s\S]*$/, '')
  const marker = after.indexOf('The report follows:')
  const body = (marker >= 0 ? after.slice(marker + 'The report follows:'.length) : after).replace(/\s+/g, ' ').trim()
  return { agentId: found[1], report: body.length > 0 ? body : null }
}

/** One line of a subagent's result, as the pane shows it. */
export const resultLine = (text: string): string | null => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 0 ? flat.slice(0, 160) : null
}

/** Whether a close ends the session's auto-opens: the person's own close of this pane, nothing else. */
export const closedByPerson = (paneId: string, e: { id: string; origin: { kind: string } }): boolean =>
  e.id === paneId && e.origin.kind === 'person'

/**
 * The ledger beside /cost: what /cost added since the ledger began counting,
 * and how much of it no hook saw (engine calls outside the turn loop). `unseenUsd`
 * is null where it cannot be told: /cost unread, or a counted request unpriced.
 */
export function reconcile(
  sessionUsd: number | null,
  baselineUsd: number | null,
  counted: Totals,
): { engineUsd: number | null; unseenUsd: number | null } {
  if (sessionUsd === null) return { engineUsd: null, unseenUsd: null }
  const engineUsd = Math.max(0, sessionUsd - (baselineUsd ?? 0))
  if (counted.unknownCost > 0) return { engineUsd, unseenUsd: null }
  return { engineUsd, unseenUsd: Math.max(0, engineUsd - counted.knownUsd) }
}

/** A short, single-line label of what a tool call does. */
export function describeToolCall(tool: string, input: { [field: string]: unknown }): string {
  const pick = (field: string): string | undefined => {
    const v = input[field]
    return typeof v === 'string' && v.length > 0 ? v : undefined
  }
  const detail =
    pick('description') ?? pick('command') ?? pick('file_path') ?? pick('pattern') ?? pick('url') ?? pick('query') ?? pick('prompt')
  if (detail === undefined) return tool
  const flat = detail.replace(/\s+/g, ' ').trim()
  return `${tool}: ${flat.length > 48 ? `${flat.slice(0, 47)}…` : flat}`
}

// ---------------------------------------------------------------- export

export function exportDocument(ledger: Ledger, exportedAt: number): {
  schema: string
  exportedAt: string
  note: string
  pricesAsOf: string
  totals: Totals
  runs: { run: LedgerRun; totals: Totals }[]
  requests: LedgerRequest[]
  agents: LedgerAgent[]
  recommendations: LedgerRecommendation[]
  context: LedgerContextItem[]
} {
  return {
    schema: 'run-ledger.export/2',
    exportedAt: new Date(exportedAt).toISOString(),
    note: 'Costs are API-rate estimates from dated list prices, not subscription charges. null = unknown.',
    pricesAsOf: PRICES_AS_OF,
    totals: totals(ledger),
    runs: ledger.runs.map(run => ({ run, totals: totals(ledger, run.id) })),
    requests: ledger.requests,
    agents: ledger.agents,
    recommendations: ledger.recommendations,
    context: ledger.items,
  }
}

const csvCell = (v: string | number | null): string => {
  if (v === null) return 'unknown'
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function exportCsv(ledger: Ledger): string {
  const header = [
    'key', 'run', 'source', 'plugin', 'agent', 'model', 'attempt', 'input', 'output',
    'cache_read', 'cache_write', 'cost_usd_estimate', 'cost_basis', 'prices_as_of', 'stop_reason', 'at',
  ]
  const lines = ledger.requests.map(r =>
    [
      r.key, r.runId, r.sourceKind, r.sourcePlugin, r.agentId, r.model ?? r.requestedModel, r.attempt,
      r.usage?.input ?? null, r.usage?.output ?? null, r.usage?.cacheRead ?? null, r.usage?.cacheWrite ?? null,
      r.cost.usd, r.cost.basis, r.cost.pricesAsOf, r.stopReason, new Date(r.at).toISOString(),
    ]
      .map(csvCell)
      .join(','),
  )
  return [header.join(','), ...lines].join('\n') + '\n'
}

// ---------------------------------------------------------------- Jev adapter

/** Comma-separated config -> list; empty -> fallback. */
export const listOption = (value: string | undefined, fallback: readonly string[]): string[] => {
  const items = (value ?? '').split(',').map(s => s.trim()).filter(s => s.length > 0)
  return items.length > 0 ? items : [...fallback]
}

export const availableModels = (configured: string | undefined): string[] =>
  listOption(configured, DEFAULT_JEV_MODELS)

export type JevRequest = {
  schema: 'run-ledger.jev-request/1'
  task: {
    prompt: string
    description: string
    agentType: string
    requestedModel: string | null
    parentModel: string
  }
  availableModels: {
    id: string
    usdPerMTok: { input: number; output: number; cacheWrite: number; cacheRead: number } | null
    pricesAsOf: string
  }[]
  budget: { limitUsd: number | null; spentUsdEstimate: number; spentHasUnknown: boolean }
  pastResults: LedgerHistoryEntry[]
}

export function buildJevRequest(args: {
  prompt: string
  description: string
  agentType: string
  requestedModel: string | null
  parentModel: string
  models: readonly string[]
  budgetUsd: number
  ledger: Ledger
  history: readonly LedgerHistoryEntry[]
}): JevRequest {
  const t = totals(args.ledger)
  return {
    schema: 'run-ledger.jev-request/1',
    task: {
      prompt: args.prompt.length > 4000 ? `${args.prompt.slice(0, 4000)}…` : args.prompt,
      description: args.description,
      agentType: args.agentType,
      requestedModel: args.requestedModel,
      parentModel: args.parentModel,
    },
    availableModels: args.models.map(id => {
      const p = priceFor(id)?.row
      return {
        id,
        usdPerMTok: p ? { input: p.input, output: p.output, cacheWrite: p.cacheWrite, cacheRead: p.cacheRead } : null,
        pricesAsOf: PRICES_AS_OF,
      }
    }),
    budget: {
      limitUsd: args.budgetUsd > 0 ? args.budgetUsd : null,
      spentUsdEstimate: t.knownUsd + t.jevUsd,
      spentHasUnknown: t.unknownCost + t.jevUnknown > 0,
    },
    pastResults: args.history.filter(h => h.agentType === args.agentType).slice(-20),
  }
}

export type JevAnswer =
  | { isValid: true; model: string; reason: string; confidence: number | null; cost: LedgerCost; ranking: LedgerCandidate[] }
  | { isValid: false; problem: string; cost: LedgerCost }

const isRecord = (v: unknown): v is { [field: string]: unknown } =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** Jev's own cost, from what its answer reports: dollars, or usage and a model. */
function jevCostOf(body: { [field: string]: unknown }): LedgerCost {
  const cost = body.cost
  if (!isRecord(cost)) return { usd: null, basis: 'no-usage', pricesAsOf: null }
  if (isCount(cost.usd)) return { usd: cost.usd, basis: 'reported', pricesAsOf: null }
  const u = cost.usage
  if (
    isRecord(u) &&
    isCount(u.input_tokens) &&
    isCount(u.output_tokens) &&
    typeof cost.model === 'string'
  ) {
    return estimateCost(cost.model, {
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: isCount(u.cache_read_input_tokens) ? u.cache_read_input_tokens : 0,
      cacheWrite: isCount(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0,
    })
  }
  return { usd: null, basis: 'no-usage', pricesAsOf: null }
}

/** Reads the adapter's answer; a model outside the offered set is refused. */
export function parseJevAnswer(text: string, offered: readonly string[]): JevAnswer {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { isValid: false, problem: 'answer is not JSON', cost: { usd: null, basis: 'no-usage', pricesAsOf: null } }
  }
  if (!isRecord(body)) {
    return { isValid: false, problem: 'answer is not an object', cost: { usd: null, basis: 'no-usage', pricesAsOf: null } }
  }
  const cost = jevCostOf(body)
  const model = body.model
  if (typeof model !== 'string' || model.length === 0) return { isValid: false, problem: 'answer names no model', cost }
  const offeredIds = offered.map(normalizeModel)
  if (!offeredIds.includes(normalizeModel(model))) {
    return { isValid: false, problem: `model ${model} was not among the offered models`, cost }
  }
  const reason = typeof body.reason === 'string' && body.reason.length > 0 ? body.reason : 'no reason given'
  const c = body.confidence
  const confidence = typeof c === 'number' && c >= 0 && c <= 1 ? c : null
  return { isValid: true, model, reason, confidence, cost, ranking: rankingOf(body.ranking, offeredIds) }
}

const unit = (v: unknown): number | null => (typeof v === 'number' && v >= 0 && v <= 1 ? v : null)

/** Jev's optional `ranking`: offered models only, scores 0..1, best first. */
function rankingOf(value: unknown, offeredIds: readonly string[]): LedgerCandidate[] {
  if (!Array.isArray(value)) return []
  const out: LedgerCandidate[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.model !== 'string') continue
    if (!offeredIds.includes(normalizeModel(entry.model))) continue
    const score = unit(entry.score)
    if (score === null) continue
    const c = isRecord(entry.criteria) ? entry.criteria : {}
    out.push({
      model: entry.model,
      score,
      criteria: { cost: unit(c.cost), latency: unit(c.latency), quality: unit(c.quality), fit: unit(c.fit) },
    })
  }
  return out.sort((a, b) => b.score - a.score)
}

/** Auto routing applies only where nothing else chose: not a fork, no explicit model, an allowed type (`*`: any). */
export function isEligibleForAuto(args: {
  mode: string
  agentType: string
  fork: boolean
  requestedModel: string | undefined
  allowedTypes: readonly string[]
}): boolean {
  return (
    args.mode === 'auto' &&
    !args.fork &&
    args.requestedModel === undefined &&
    (args.allowedTypes.includes('*') || args.allowedTypes.includes(args.agentType))
  )
}

export function parseHistory(value: unknown): LedgerHistoryEntry[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (h): h is LedgerHistoryEntry => isRecord(h) && typeof h.agentType === 'string' && typeof h.outcome === 'string',
  )
}
