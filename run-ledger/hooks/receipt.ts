// The receipt a run leaves in the transcript when it ends: what ran on which model, what it
// cost at API rates, and what routing saved. Dim system lines, never sent to the model.

import type { Ledger } from '../types'
import { formatElapsed, formatSavings, formatTotal, formatUsd, savingsVs, totals } from './ledger'
import { shortModel } from './theme'

const fit = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** The receipt of run `runId`, one string per line; empty when the ledger does not know the run. */
export function receiptLines(ledger: Ledger, runId: string, baselineModel: string, at: number, prefix = ''): string[] {
  const run = ledger.runs.find(r => r.id === runId)
  if (!run) return []
  const t = totals(ledger, runId)
  const agents = ledger.agents.filter(a => a.runId === runId)
  const running = agents.filter(a => a.status === 'running').length
  const failed = agents.filter(a => a.status !== 'running' && a.status !== 'completed').length
  const models = new Set(agents.map(a => a.actualModel ?? a.requestedModel).filter((m): m is string => m !== null))
  const tokensIn = t.usage.input + t.usage.cacheRead + t.usage.cacheWrite
  const cacheHit = tokensIn > 0 ? `cache hit ${Math.round((t.usage.cacheRead / tokensIn) * 100)}%` : null
  const byModel = [...t.byModel].sort((a, b) => b.usd - a.usd).map(m => `${shortModel(m.model)} ${formatTotal(m.usd, m.unknown, m.requests)}`)
  const saved = formatSavings(savingsVs(ledger, baselineModel, runId), shortModel)
  const facts = [
    `${agents.length} subagent${agents.length === 1 ? '' : 's'}${models.size > 0 ? ` on ${models.size} model${models.size === 1 ? '' : 's'}` : ''}`,
    `${t.requests} request${t.requests === 1 ? '' : 's'}`,
    t.retries > 0 ? `${t.retries} retr${t.retries === 1 ? 'y' : 'ies'} seen` : null,
    cacheHit,
    failed > 0 ? `${failed} failed` : null,
    running > 0 ? `${running} still running in the background` : null,
  ].filter((x): x is string => x !== null)
  const jev = t.jevUsd > 0 || t.jevUnknown > 0 ? `Jev's own cost ${t.jevUnknown > 0 ? `${formatUsd(t.jevUsd)} + ${t.jevUnknown} unknown` : formatUsd(t.jevUsd)}` : null
  // The run lasts until its last subagent ended, past the main turn's own end when one ran in the background.
  const end = Math.max(run.endedAt ?? at, ...agents.map(a => a.endedAt ?? (a.status === 'running' ? at : 0)))
  return [
    `${prefix}◆ run-ledger receipt · "${fit(run.label, 48)}" · ${formatElapsed(end - run.startedAt)} · ${run.status}`,
    `  ${facts.join(' · ')}`,
    ...(byModel.length > 0 ? [`  ${[...byModel, ...(jev ? [jev] : [])].join(' · ')}`] : []),
    `  total ${formatTotal(t.knownUsd, t.unknownCost, t.requests)} API est., not a subscription charge${saved ? ` · ${saved}` : ''}`,
  ]
}
