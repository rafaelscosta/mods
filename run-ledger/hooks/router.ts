// The local router: a transparent heuristic that ranks models for a subagent role while
// Jev is not connected. Every number comes from the dated price table, the model lines'
// capability order, the context window, or this machine's own past results.

import type { LedgerCandidate, LedgerHistoryEntry } from '../types'
import { priceFor } from './ledger'
import { FAMILY_TIER, familyOf, windowOf } from './theme'

export type Weights = { quality: number; cost: number; latency: number; fit: number }

export type RoleProfile = {
  role: string
  /** When the model should delegate to it (the agent listing's line). */
  description: string
  /** Its system prompt, when run-ledger registers it. */
  prompt: string
  weights: Weights
}

export const ROLE_PREFIX = 'run-ledger:'

export const ROLES: readonly RoleProfile[] = [
  {
    role: 'orchestrator',
    description: 'Plans a multi-step task, splits it into parts and delegates each part to the other run-ledger roles. Use for work spanning several files or steps.',
    prompt:
      'You are the orchestrator. Read just enough of the code to plan. Split the task into small parts and delegate each with the Agent tool: run-ledger:builder for new files and wiring, run-ledger:implementer for one focused change, run-ledger:executor to run tests or builds, run-ledger:iterator to fix one failure. Give each part a precise spec. Finish with a short summary of what was done and what failed.',
    weights: { quality: 0.6, cost: 0.25, latency: 0, fit: 0.15 },
  },
  {
    role: 'builder',
    description: 'Scaffolds new files, routes, modules and their wiring from a short spec.',
    prompt: 'You are the builder. Create the files and wiring the spec asks for, following the project conventions you find. Keep to the spec. Report the files you created.',
    weights: { quality: 0.35, cost: 0.4, latency: 0.15, fit: 0.1 },
  },
  {
    role: 'implementer',
    description: 'Implements one focused change (a component, an endpoint, a function) to a spec.',
    prompt: 'You are the implementer. Make the one change the spec describes, in the files it names or the obvious ones. Do not refactor beyond it. Report the change.',
    weights: { quality: 0.35, cost: 0.45, latency: 0.1, fit: 0.1 },
  },
  {
    role: 'executor',
    description: 'Runs commands, tests, type checks and builds, and reports the results without editing code.',
    prompt: 'You are the executor. Run the commands asked for (tests, type checks, builds). Do not edit files. Report pass or fail counts and the exact failing names and messages.',
    weights: { quality: 0.15, cost: 0.55, latency: 0.2, fit: 0.1 },
  },
  {
    role: 'iterator',
    description: 'Fixes one failing test or error reported by the executor, with the smallest change.',
    prompt: 'You are the iterator. Fix the one failure you are given with the smallest correct change, then rerun that test. Report what you changed and the result.',
    weights: { quality: 0.2, cost: 0.5, latency: 0.2, fit: 0.1 },
  },
]

/** The profile a subagent type is weighed by: its run-ledger role, or the closest one. */
export function profileFor(agentType: string): RoleProfile {
  const name = agentType.startsWith(ROLE_PREFIX) ? agentType.slice(ROLE_PREFIX.length) : agentType
  const own = ROLES.find(r => r.role === name)
  if (own) return own
  const alike = (role: string): RoleProfile => ROLES.find(r => r.role === role) ?? (ROLES[2] as RoleProfile)
  const lower = name.toLowerCase()
  if (lower === 'plan' || lower.includes('architect') || lower.includes('orchestr') || lower.includes('chief')) return { ...alike('orchestrator'), role: name }
  if (lower === 'explore' || lower.includes('search') || lower.includes('qa') || lower.includes('test')) return { ...alike('executor'), role: name }
  return { ...alike('implementer'), role: name }
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

const sameModel = (a: string | null, b: string): boolean => a !== null && priceFor(a)?.row.id === priceFor(b)?.row.id

/**
 * Ranks `models` for `agentType`, best first. Criteria, each 0..1:
 * cost (blended list price, cheapest 1), quality (capability order, nudged by this
 * machine's success rate for the role), latency (median past duration, fastest 1;
 * null without data) and fit (context window against the context handed over).
 * Score is the weighted mean over the criteria that have data.
 */
export function rankModels(args: {
  agentType: string
  models: readonly string[]
  history: readonly LedgerHistoryEntry[]
  contextTokens: number | null
}): LedgerCandidate[] {
  const profile = profileFor(args.agentType)
  const blended = args.models.map(m => {
    const p = priceFor(m)?.row
    return p ? p.input * 0.75 + p.output * 0.25 : null
  })
  const known = blended.filter((b): b is number => b !== null)
  const lo = Math.min(...known)
  const hi = Math.max(...known)
  const latencies = args.models.map(m =>
    median(args.history.filter(h => sameModel(h.model, m) && h.durationMs !== null).map(h => h.durationMs ?? 0)),
  )
  const knownLat = latencies.filter((l): l is number => l !== null)
  const fast = Math.min(...knownLat)
  const slow = Math.max(...knownLat)

  const ranked = args.models.map((model, i): LedgerCandidate => {
    const b = blended[i] ?? null
    const cost = b === null ? null : hi === lo ? 1 : 1 - (b - lo) / (hi - lo)
    const tier = FAMILY_TIER[familyOf(model)] / 4
    const runs = args.history.filter(h => sameModel(h.model, model) && profileFor(h.agentType).role === profile.role)
    const wins = runs.filter(h => h.outcome === 'completed').length
    const quality = runs.length > 0 ? 0.7 * tier + 0.3 * ((wins + 1) / (runs.length + 2)) : tier
    const lat = latencies[i] ?? null
    const latency = lat === null ? null : slow === fast ? 1 : 1 - (lat - fast) / (slow - fast)
    const window = windowOf(model)
    const fit =
      args.contextTokens === null || window === null ? null : Math.min(1, window / Math.max(1, args.contextTokens * 1.1))
    const criteria = { cost, latency, quality, fit }
    let sum = 0
    let weight = 0
    for (const key of ['quality', 'cost', 'latency', 'fit'] as const) {
      const value = criteria[key]
      const w = profile.weights[key]
      if (value === null || w === 0) continue
      sum += value * w
      weight += w
    }
    return { model, score: weight === 0 ? 0 : sum / weight, criteria }
  })
  return ranked.sort((a, b) => b.score - a.score)
}

/** The softmax share of each candidate: how clearly the winner wins. */
export function shares(ranking: readonly LedgerCandidate[], temperature = 0.08): number[] {
  const top = Math.max(...ranking.map(c => c.score))
  const exps = ranking.map(c => Math.exp((c.score - top) / temperature))
  const total = exps.reduce((a, b) => a + b, 0)
  return exps.map(x => x / total)
}

/** A model this host can run and price. */
export const isHostModel = (model: string, offered: readonly string[]): boolean =>
  priceFor(model) !== undefined && offered.some(m => sameModel(model, m))

export function localDecision(args: {
  agentType: string
  models: readonly string[]
  history: readonly LedgerHistoryEntry[]
  contextTokens: number | null
}): { model: string | null; score: number | null; confidence: number | null; ranking: LedgerCandidate[]; reason: string; validated: boolean } {
  const ranking = rankModels(args)
  const top = ranking[0]
  if (!top) return { model: null, score: null, confidence: null, ranking, reason: 'no models to choose from', validated: false }
  const share = shares(ranking)[0] ?? null
  const profile = profileFor(args.agentType)
  const lead = Object.entries(profile.weights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k]) => k)
    .join(' and ')
  return {
    model: top.model,
    score: top.score,
    confidence: share,
    ranking,
    reason: `local heuristic weighing ${lead} for ${profile.role}`,
    validated: isHostModel(top.model, args.models),
  }
}
