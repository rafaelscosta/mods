/** Token counts of one request, in the API's four buckets. */
export type LedgerUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * An API-rate estimate. `usd` is null when it cannot be priced (no usage
 * reported, or a model missing from the dated price table): unknown, never 0.
 */
export type LedgerCost = {
  usd: number | null
  basis: 'priced' | 'alias-assumed' | 'reported' | 'unpriced-model' | 'no-usage'
  pricesAsOf: string | null
}

export type LedgerSourceKind = 'main' | 'subagent' | 'plugin-model-call' | 'jev'

export type LedgerRequest = {
  /** Dedup key: one entry per key, ever. */
  key: string
  runId: string
  agentId: string | null
  turnId: string | null
  index: number | null
  /** 0 for the first send of a step; n for the nth re-send of the same step. */
  attempt: number
  requestedModel: string | null
  model: string | null
  sourceKind: LedgerSourceKind
  /** The plugin that caused it, where known. */
  sourcePlugin: string | null
  usage: LedgerUsage | null
  cost: LedgerCost
  stopReason: string | null
  at: number
}

export type LedgerAgent = {
  id: string
  runId: string
  /** The loop that spawned it; null for the main loop. */
  parentId: string | null
  type: string
  description: string
  spawnedBy: string | null
  provider: string | null
  background: boolean
  requestedModel: string | null
  recommendationId: string | null
  recommendedModel: string | null
  routed: boolean
  actualModel: string | null
  status: string
  lastAction: string | null
  /** Tokens its first request carried: the context it was handed. */
  contextTokens: number | null
  startedAt: number
  endedAt: number | null
  result: string | null
}

/** One model a router weighed for a role, with each criterion from 0 to 1 (null: no data). */
export type LedgerCandidate = {
  model: string
  score: number
  criteria: { cost: number | null; latency: number | null; quality: number | null; fit: number | null }
}

/** A routing decision for one role in one run: the local heuristic's or Jev's. */
export type LedgerRecommendation = {
  id: string
  runId: string
  agentType: string
  router: 'local' | 'jev'
  status: 'deciding' | 'ok' | 'unavailable' | 'error'
  model: string | null
  reason: string
  /** The winner's share of the ranking (softmax), or Jev's stated confidence. */
  confidence: number | null
  score: number | null
  ranking: LedgerCandidate[]
  /** The chosen model is one this host offers and prices. */
  validated: boolean
  jevCost: LedgerCost
  mode: 'recommend' | 'auto'
  applied: boolean
  at: number
}

/** A piece of context that moved: a file read or written, a command run, a task handed over, a result returned. */
export type LedgerContextItem = {
  id: string
  runId: string
  agentId: string | null
  kind: 'read' | 'write' | 'run' | 'handoff' | 'result'
  label: string
  path: string | null
  /** About how many tokens it carried (characters / 4); null when not measured. */
  tokens: number | null
  /** The loop that produced it, when another loop then took it in. */
  fromAgentId: string | null
  at: number
}

/** A packet drawn travelling along an edge of the agent graph. */
export type LedgerPulse = {
  id: string
  from: string
  to: string
  kind: 'route' | 'result'
  at: number
}

export type LedgerRun = {
  id: string
  label: string
  source: string
  startedAt: number
  endedAt: number | null
  status: string
  model: string | null
}

export type LedgerAttempt = { key: string; count: number }

export type Ledger = {
  runs: LedgerRun[]
  requests: LedgerRequest[]
  agents: LedgerAgent[]
  recommendations: LedgerRecommendation[]
  items: LedgerContextItem[]
  pulses: LedgerPulse[]
  attempts: LedgerAttempt[]
  currentRunId: string | null
  counter: number
  /**
   * The session's /cost total (`$.session.usage().cost.usd`) when this ledger
   * started counting: at load with nothing counted yet, or at reset. What /cost
   * adds after it, less what the ledger counted, is spend the hooks never saw.
   * null until read.
   */
  costBaselineUsd: number | null
}

/** One finished subagent, kept across sessions in $.store for the routers. */
export type LedgerHistoryEntry = {
  agentType: string
  model: string | null
  outcome: string
  costUsd: number | null
  durationMs: number | null
  at: number
}

/** The session's context window, as the status line reports it. */
export type LedgerContextFill = { tokens: number | null; window: number; percent: number | null }

/** A replay: which run, the moment shown (null: live), and whether it is playing. */
export type LedgerReplay = { runId: string | null; at: number | null; isPlaying: boolean }

/** `/run-ledger demo`: when the scripted run started, and whether its end was announced. */
export type LedgerDemo = { startedAt: number; isAnnounced: boolean }

declare module 'claude-code' {
  interface PluginState {
    'run-ledger': {
      ledger: Ledger
      selected: string | null
      now: number
      view: 'live' | 'ledger' | 'timeline'
      fill: LedgerContextFill | null
      replay: LedgerReplay
      demo: LedgerDemo | null
      /** True once the pane opened by itself this session, or the person closed it by hand: no more auto-opens. */
      autoOpenSpent: boolean
      /** Runs whose main turn ended while a subagent of theirs still ran: their receipt waits for it. */
      pendingReceipts: string[]
    }
  }
}
