// The card a node shows under the pointer: its model and why, what it spent, what it did last.
// Plain data, so a Client can draw it on the surface without calling back.

import type { Ledger } from '../types'
import { agentCost, formatElapsed, formatTokens, formatTotal } from './ledger'
import { agentLabel, agentModel, roleName } from './graph'
import { COLOR, hex, modelColor, shortModel } from './theme'

export const CARD_WIDTH = 46
const INNER = CARD_WIDTH - 4

export type CardLine = { text: string; color: string | null; bold: boolean }
export type Card = { title: string; color: string; lines: CardLine[] }

/** A line is kept whole up to this many characters; where it is drawn, `wrapCard` wraps it to the card. */
const MAX_LINE_CHARS = 600

const fit = (text: string, max: number = INNER): string => {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}
const line = (text: string, color: number | null = null, bold = false): CardLine => ({
  text: fit(text, MAX_LINE_CHARS),
  color: color === null ? null : hex(color),
  bold,
})

/**
 * Word-wraps `text` to rows of at most `width` cells. A continuation row keeps the line's own indent
 * plus two spaces; a word longer than a row (a path, a URL) is cut across rows, never dropped.
 */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(8, width)
  const indent = /^ */.exec(text)?.[0] ?? ''
  const cont = `${indent}  `
  const words = text.slice(indent.length).split(/ +/).filter(x => x !== '')
  const size = (s: string): number => [...s].length
  const rows: string[] = []
  let row = indent
  let hasWord = false
  for (const whole of words) {
    let word = whole
    while (word !== '') {
      const sep = hasWord ? ' ' : ''
      if (size(row) + size(sep) + size(word) <= w) {
        row += sep + word
        hasWord = true
        word = ''
      } else if (hasWord) {
        rows.push(row)
        row = cont
        hasWord = false
      } else {
        const room = Math.max(1, w - size(row))
        const chars = [...word]
        rows.push(row + chars.slice(0, room).join(''))
        row = cont
        word = chars.slice(room).join('')
      }
    }
  }
  if (hasWord || rows.length === 0) rows.push(row)
  return rows
}

/** The card as drawn `inner` cells wide: the title on one row, every line wrapped, nothing cut. */
export function wrapCard(card: Card, inner: number): Card {
  return {
    ...card,
    title: fit(card.title, inner),
    lines: card.lines.flatMap(l => wrapText(l.text, inner).map(text => ({ ...l, text }))),
  }
}

/** At most `max` lines: past that, the last row shown says how many were left out. */
export function trimLines(lines: readonly CardLine[], max: number, mutedColor: string): CardLine[] {
  if (lines.length <= max) return [...lines]
  const keep = Math.max(0, max - 1)
  return [...lines.slice(0, keep), { text: `… +${lines.length - keep} more lines`, color: mutedColor, bold: false }]
}

/** Tokens a loop's requests carried, and how many requests left them unknown. */
function usageOf(ledger: Ledger, agentId: string | null, runId: string | null) {
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, unknown: 0 }
  for (const r of ledger.requests) {
    if (r.agentId !== agentId || (agentId === null && r.runId !== runId)) continue
    sum.requests += 1
    if (!r.usage) {
      sum.unknown += 1
      continue
    }
    sum.input += r.usage.input
    sum.output += r.usage.output
    sum.cacheRead += r.usage.cacheRead
    sum.cacheWrite += r.usage.cacheWrite
  }
  return sum
}

const tokensLine = (u: ReturnType<typeof usageOf>): CardLine =>
  u.requests === 0
    ? line('no requests yet', COLOR.muted)
    : line(
        `in ${formatTokens(u.input)} · out ${formatTokens(u.output)} · cache ${formatTokens(u.cacheRead)} · ${u.requests} req${u.unknown > 0 ? ` (${u.unknown} unknown)` : ''}`,
        COLOR.muted,
      )

/** What the last few tool calls of a loop touched, newest first. */
function recentTools(ledger: Ledger, agentId: string | null, runId: string | null): CardLine[] {
  const done = ledger.items.filter(i => i.agentId === agentId && i.runId === runId && (i.kind === 'read' || i.kind === 'write' || i.kind === 'run'))
  return done
    .slice(-5)
    .reverse()
    .map(i => line(`  ${i.kind === 'run' ? '' : `${i.kind} `}${i.label}`, i.kind === 'write' ? COLOR.text : COLOR.muted))
}

/** The card of subagent `agentId` at time `at`, or null when the ledger does not know it. */
export function agentCard(ledger: Ledger, agentId: string, at: number): Card | null {
  const a = ledger.agents.find(x => x.id === agentId)
  if (!a) return null
  const model = agentModel(a)
  const color = a.status === 'running' || a.status === 'completed' ? modelColor(model) : COLOR.bad
  const spent = agentCost(ledger, a.id)
  const elapsed = formatElapsed((a.endedAt ?? at) - a.startedAt)
  const status =
    a.status === 'running' ? `running ${elapsed}` : a.status === 'completed' ? `done in ${elapsed}` : `${a.status} after ${elapsed}`
  const rec = ledger.recommendations.find(r => r.id === a.recommendationId)
  const lines: CardLine[] = [
    line(`${status} · ${formatTotal(spent.usd, spent.unknown, spent.requests)} API est.`, a.status === 'running' ? COLOR.sonnet : a.status === 'completed' ? COLOR.ok : COLOR.bad),
    line(
      `model ${shortModel(model)}${a.routed ? ' · routed ✓' : ''}${a.recommendedModel && a.recommendedModel !== model ? ` · rec ${shortModel(a.recommendedModel)}` : ''}`,
      modelColor(model),
    ),
    tokensLine(usageOf(ledger, a.id, a.runId)),
  ]
  if (a.contextTokens !== null) lines.push(line(`handed ≈${formatTokens(a.contextTokens)} tokens of context`, COLOR.muted))
  if (rec && rec.model !== null) {
    const stats = [rec.score === null ? null : `score ${rec.score.toFixed(2)}`, rec.confidence === null ? null : `p ${rec.confidence.toFixed(2)}`].filter(x => x !== null).join(' · ')
    lines.push(line(`why (${rec.router === 'jev' ? 'Jev' : 'local router'}${stats ? `, ${stats}` : ''}):`, COLOR.accent))
    lines.push(line(`  ${rec.reason}`, COLOR.muted))
  }
  const tools = recentTools(ledger, a.id, a.runId)
  if (tools.length > 0) lines.push(line('last tools:', COLOR.text), ...tools)
  else if (a.lastAction) lines.push(line(`last: ${a.lastAction}`, COLOR.muted))
  if (a.result) lines.push(line(`→ ${a.result}`, a.status === 'completed' ? COLOR.ok : COLOR.bad))
  return { title: `${agentLabel(a)} · ${roleName(a.type) === agentLabel(a) ? '' : `${roleName(a.type)} · `}${shortModel(model)}`, color: hex(color), lines }
}

/** The main loop's card for run `runId`. */
export function mainCard(ledger: Ledger, runId: string | null, mainModel: string | null, at: number): Card {
  const run = ledger.runs.find(r => r.id === runId)
  const agents = ledger.agents.filter(a => a.runId === runId)
  const running = agents.filter(a => a.status === 'running').length
  const u = usageOf(ledger, null, runId)
  let usd = 0
  let unknown = 0
  for (const r of ledger.requests) {
    if (r.runId !== runId || r.agentId !== null) continue
    if (r.cost.usd === null) unknown += 1
    else usd += r.cost.usd
  }
  const lines: CardLine[] = [
    line(run ? `"${run.label}"` : 'no run yet', COLOR.text),
    line(
      run ? `${run.status === 'running' ? 'running' : run.status} ${formatElapsed((run.endedAt ?? at) - run.startedAt)} · main ${formatTotal(usd, unknown, u.requests)} API est.` : '',
      COLOR.muted,
    ),
    tokensLine(u),
    line(`${agents.length} subagent${agents.length === 1 ? '' : 's'}${running > 0 ? ` · ${running} running` : ''}`, running > 0 ? COLOR.ok : COLOR.muted),
    ...recentTools(ledger, null, runId).slice(0, 3),
  ].filter(l => l.text !== '')
  return { title: `main · ${shortModel(mainModel)}`, color: hex(modelColor(mainModel)), lines }
}

/** Cards for every node: `main` and each subagent. */
export function cardsFor(ledger: Ledger, ids: readonly string[], runId: string | null, mainModel: string | null, at: number): { [id: string]: Card } {
  const out: { [id: string]: Card } = {}
  for (const id of ids) {
    const card = id === 'main' ? mainCard(ledger, runId, mainModel, at) : agentCard(ledger, id, at)
    if (card) out[id] = card
  }
  return out
}
