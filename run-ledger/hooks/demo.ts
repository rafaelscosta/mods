// `/run-ledger demo`: a scripted orchestration with sample data, drawn by the same views, so the
// pane can be seen moving without spending a token. A pure function of time: nothing of it
// enters the session's ledger, its totals, the status line or the routers' history.

import type { Ledger, LedgerAgent, LedgerContextItem, LedgerPulse, LedgerRecommendation, LedgerRequest, LedgerUsage } from '../types'
import { estimateCost } from './ledger'
import { localDecision } from './router'

/** How long the scripted run lasts. */
export const DEMO_MS = 35_000
export const DEMO_RUN = 'demo-run'

const MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']
const ROLES = ['orchestrator', 'builder', 'implementer', 'executor', 'iterator'] as const

type Spec = { id: string; parent: string | null; role: (typeof ROLES)[number]; task: string; start: number; end: number; context: number }

const AGENTS: Spec[] = [
  { id: 'demo-o1', parent: null, role: 'orchestrator', task: 'plan the auth page', start: 1_200, end: 34_000, context: 62_000 },
  { id: 'demo-b1', parent: 'demo-o1', role: 'builder', task: 'scaffold /auth route', start: 3_000, end: 11_000, context: 14_000 },
  { id: 'demo-i1', parent: 'demo-o1', role: 'implementer', task: 'login + signup flow', start: 4_500, end: 22_000, context: 21_000 },
  { id: 'demo-i2', parent: 'demo-i1', role: 'implementer', task: 'POST /api/auth', start: 9_000, end: 17_000, context: 3_800 },
  { id: 'demo-b2', parent: 'demo-o1', role: 'builder', task: 'session middleware', start: 12_000, end: 24_500, context: 9_000 },
  { id: 'demo-e1', parent: 'demo-o1', role: 'executor', task: 'run the tests', start: 23_000, end: 28_000, context: 2_500 },
  { id: 'demo-t1', parent: 'demo-e1', role: 'iterator', task: 'fix the CSRF test', start: 26_500, end: 32_500, context: 1_900 },
  { id: 'demo-e2', parent: 'demo-o1', role: 'executor', task: 'run the tests again', start: 32_600, end: 33_800, context: 2_400 },
]

type Act = { agent: string | null; at: number; kind: 'read' | 'write' | 'run'; label: string; from?: string }

const ACTS: Act[] = [
  { agent: null, at: 400, kind: 'read', label: 'repo map' },
  { agent: 'demo-o1', at: 2_200, kind: 'read', label: 'package.json' },
  { agent: 'demo-b1', at: 6_000, kind: 'write', label: 'page.tsx' },
  { agent: 'demo-b1', at: 8_500, kind: 'write', label: 'layout.tsx' },
  { agent: 'demo-i2', at: 12_000, kind: 'write', label: 'route.ts' },
  { agent: 'demo-i1', at: 12_500, kind: 'read', label: 'page.tsx', from: 'demo-b1' },
  { agent: 'demo-i1', at: 15_000, kind: 'write', label: 'AuthForm.tsx' },
  { agent: 'demo-b2', at: 16_000, kind: 'write', label: 'middleware.ts' },
  { agent: 'demo-i1', at: 19_000, kind: 'write', label: 'AuthForm.test.tsx' },
  { agent: 'demo-e1', at: 24_500, kind: 'run', label: '$ npm test' },
  { agent: 'demo-t1', at: 27_500, kind: 'read', label: 'route.ts', from: 'demo-i2' },
  { agent: 'demo-t1', at: 30_000, kind: 'write', label: 'route.ts' },
  { agent: 'demo-e2', at: 33_000, kind: 'run', label: '$ npm test' },
]

const RESULTS: { [id: string]: string } = {
  'demo-b1': 'route and page scaffolded',
  'demo-i1': 'login and signup working, tests written',
  'demo-i2': 'POST /api/auth with session cookie',
  'demo-b2': 'middleware guards /dashboard',
  'demo-e1': '13 passed, 1 failed (CSRF token)',
  'demo-t1': 'CSRF token checked on POST',
  'demo-e2': '14 passed',
  'demo-o1': 'auth page done, 14 tests passing',
}

const use = (input: number, output: number, cacheRead: number): LedgerUsage => ({ input, output, cacheRead, cacheWrite: Math.round(input * 0.1) })

const decisions = (() => {
  const out = new Map<string, ReturnType<typeof localDecision>>()
  for (const role of ROLES) out.set(role, localDecision({ agentType: `run-ledger:${role}`, models: MODELS, history: [], contextTokens: null }))
  return out
})()

const modelOf = (role: string): string => decisions.get(role)?.model ?? 'claude-sonnet-5-5'

/** The demo run as it stands `at`, `startedAt` being when `/run-ledger demo` was typed. */
export function demoLedger(startedAt: number, at: number): Ledger {
  const t = (ms: number) => startedAt + ms
  const now = at - startedAt
  const recs: LedgerRecommendation[] = ROLES.map((role, i) => {
    const d = decisions.get(role)
    return {
      id: `demo-rec-${i}`, runId: DEMO_RUN, agentType: `run-ledger:${role}`, router: 'local', status: 'ok', model: d?.model ?? null,
      reason: d?.reason ?? '', confidence: d?.confidence ?? null, score: d?.score ?? null, ranking: d?.ranking ?? [], validated: d?.validated ?? false,
      jevCost: { usd: null, basis: 'no-usage', pricesAsOf: null }, mode: 'auto', applied: true, at: t(600 + i * 60),
    }
  })
  const agents: LedgerAgent[] = AGENTS.filter(a => a.start <= now).map(a => {
    const isOver = a.end <= now
    const last = [...ACTS].reverse().find(x => x.agent === a.id && x.at <= now)
    return {
      id: a.id, runId: DEMO_RUN, parentId: a.parent, type: `run-ledger:${a.role}`, description: a.task, spawnedBy: null, provider: null, background: false,
      requestedModel: null, recommendationId: `demo-rec-${ROLES.indexOf(a.role)}`, recommendedModel: modelOf(a.role), routed: true, actualModel: modelOf(a.role),
      status: isOver ? 'completed' : 'running', lastAction: last ? `${last.kind === 'run' ? 'Bash' : last.kind === 'write' ? 'Write' : 'Read'}: ${last.label}` : null,
      contextTokens: a.context, startedAt: t(a.start), endedAt: isOver ? t(a.end) : null, result: isOver ? (RESULTS[a.id] ?? null) : null,
    }
  })
  const requests: LedgerRequest[] = []
  const ask = (key: string, agentId: string | null, model: string, usage: LedgerUsage, when: number) => {
    if (when > now) return
    requests.push({
      key: `demo|${key}`, runId: DEMO_RUN, agentId, turnId: DEMO_RUN, index: requests.length, attempt: 0, requestedModel: model, model,
      sourceKind: agentId === null ? 'main' : 'subagent', sourcePlugin: null, usage, cost: estimateCost(model, usage), stopReason: 'end_turn', at: t(when),
    })
  }
  ask('main-0', null, 'claude-opus-5-5', use(42_000, 3_200, 180_000), 300)
  ask('main-1', null, 'claude-opus-5-5', use(8_000, 1_400, 220_000), 34_400)
  for (const a of AGENTS) {
    const model = modelOf(a.role)
    const steps = Math.max(1, Math.round((a.end - a.start) / 3_500))
    for (let k = 0; k < steps; k++) ask(`${a.id}-${k}`, a.id, model, use(Math.round(a.context / (k + 1)), 1_800 + k * 400, 60_000 + k * 20_000), a.start + 400 + k * 3_500)
  }
  const items: LedgerContextItem[] = []
  const pulses: LedgerPulse[] = []
  for (const a of AGENTS) {
    const parent = a.parent ?? 'main'
    if (a.start <= now) {
      items.push({ id: `demo-h-${a.id}`, runId: DEMO_RUN, agentId: a.id, kind: 'handoff', label: `→ ${a.role}: ${a.task}`, path: null, tokens: Math.round(a.context / 6), fromAgentId: parent, at: t(a.start) })
      pulses.push({ id: `demo-p-${a.id}`, from: parent, to: a.id, kind: 'route', at: t(a.start) })
    }
    if (a.end <= now) {
      items.push({ id: `demo-r-${a.id}`, runId: DEMO_RUN, agentId: a.parent, kind: 'result', label: `← ${a.role}: ${RESULTS[a.id] ?? 'done'}`, path: null, tokens: 600, fromAgentId: a.id, at: t(a.end) })
      pulses.push({ id: `demo-q-${a.id}`, from: a.id, to: parent, kind: 'result', at: t(a.end) })
    }
  }
  for (const [i, x] of ACTS.entries()) {
    if (x.at > now) continue
    items.push({ id: `demo-a-${i}`, runId: DEMO_RUN, agentId: x.agent, kind: x.kind, label: x.label, path: null, tokens: 900, fromAgentId: x.from ?? null, at: t(x.at) })
  }
  items.sort((x, y) => x.at - y.at)
  return {
    runs: [{ id: DEMO_RUN, label: 'DEMO: build an auth page with tests', source: 'demo', startedAt: startedAt, endedAt: now >= DEMO_MS ? t(DEMO_MS) : null, status: now >= DEMO_MS ? 'completed' : 'running', model: 'claude-opus-5-5' }],
    requests,
    agents,
    recommendations: recs.filter(r => r.at <= at),
    items,
    pulses,
    attempts: [],
    currentRunId: now >= DEMO_MS ? null : DEMO_RUN,
    counter: requests.length * 1000 + items.length,
    costBaselineUsd: null,
  }
}

/** A made-up but steady output speed for a demo loop at `at`, tokens per second. */
export function demoRate(id: string, at: number): number {
  let seed = 0
  for (const ch of id) seed = (seed * 31 + ch.charCodeAt(0)) % 997
  return Math.max(0, Math.round(18 + 40 * Math.abs(Math.sin(at / 1700 + seed))))
}
