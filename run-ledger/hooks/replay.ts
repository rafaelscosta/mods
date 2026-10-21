// Replay: a run seen again as it stood at any moment. Every event carries a timestamp, so the
// ledger as of `at` is the same ledger with what came later left out and what had not ended yet
// shown running.

import type { Ledger, LedgerAgent } from '../types'
import { PULSE_MS } from './graph'

/** Replayed time runs this many times faster than the run did. */
export const REPLAY_SPEED = 3
/** A quiet stretch longer than this is skipped, landing just before the next event. */
const IDLE_SKIP_MS = 1500
const LEAD_MS = 400

/** Every moment something happened in run `runId`, in order, each once. */
export function replayEvents(ledger: Ledger, runId: string): number[] {
  const times = new Set<number>()
  const run = ledger.runs.find(r => r.id === runId)
  if (run) {
    times.add(run.startedAt)
    if (run.endedAt !== null) times.add(run.endedAt)
  }
  for (const a of ledger.agents) {
    if (a.runId !== runId) continue
    times.add(a.startedAt)
    if (a.endedAt !== null) times.add(a.endedAt)
  }
  for (const i of ledger.items) if (i.runId === runId) times.add(i.at)
  for (const r of ledger.recommendations) if (r.runId === runId) times.add(r.at)
  for (const q of ledger.requests) if (q.runId === runId) times.add(q.at)
  return [...times].sort((x, y) => x - y)
}

const ACTIONS = new Set(['read', 'write', 'run'])

/** Run `runId` as it stood at `at`: later events left out, what had not ended yet running. */
export function ledgerAt(ledger: Ledger, runId: string, at: number): Ledger {
  const items = ledger.items.filter(i => i.runId === runId && i.at <= at)
  const lastAction = (id: string): string | null => {
    const last = [...items].reverse().find(i => i.agentId === id && ACTIONS.has(i.kind))
    return last ? `${last.kind === 'run' ? '' : `${last.kind} `}${last.label}` : null
  }
  const agents: LedgerAgent[] = ledger.agents
    .filter(a => a.runId === runId && a.startedAt <= at)
    .map(a => (a.endedAt !== null && a.endedAt <= at ? a : { ...a, status: 'running', endedAt: null, result: null, lastAction: lastAction(a.id) }))
  const ids = new Set(agents.map(a => a.id))
  return {
    runs: ledger.runs
      .filter(r => r.id === runId)
      .map(r => (r.endedAt !== null && r.endedAt <= at ? r : { ...r, endedAt: null, status: 'running' })),
    requests: ledger.requests.filter(r => r.runId === runId && r.at <= at),
    agents,
    recommendations: ledger.recommendations.filter(r => r.runId === runId && r.at <= at),
    items,
    pulses: ledger.pulses.filter(p => p.at <= at && (ids.has(p.from) || ids.has(p.to))),
    attempts: [],
    currentRunId: runId,
    counter: ledger.counter,
    costBaselineUsd: ledger.costBaselineUsd,
  }
}

/** The next event after `at` (null: past the last), or the one before it (the first at most). */
export function stepReplay(events: readonly number[], at: number, dir: -1 | 1): number | null {
  if (dir > 0) return events.find(t => t > at) ?? null
  return [...events].reverse().find(t => t < at) ?? events[0] ?? null
}

/**
 * Replayed time `elapsed` ms of wall clock after `at`: REPLAY_SPEED times as fast, quiet
 * stretches skipped. `isOver` once the last event and its motion have played.
 */
export function advanceReplay(events: readonly number[], at: number, elapsed: number): { at: number; isOver: boolean } {
  const last = events[events.length - 1] ?? at
  let next = at + elapsed * REPLAY_SPEED
  const coming = events.find(t => t > at)
  if (coming !== undefined && coming - at > IDLE_SKIP_MS && next < coming - LEAD_MS) next = coming - LEAD_MS
  const end = last + PULSE_MS
  return next >= end ? { at: end, isOver: true } : { at: next, isOver: false }
}

/** "0:41", "12:05": a position in a replay. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
