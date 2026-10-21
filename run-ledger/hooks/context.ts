// Context exchange: the pieces of context a run moved (files read and written, commands run,
// tasks handed to subagents, results handed back) as a timeline in two lanes. A pink link
// joins a piece to the loop that produced it when another loop took it in.

import type { Ledger, LedgerAgent, LedgerContextItem } from '../types'
import { Canvas } from './canvas'
import { COLOR, mix, modelColor } from './theme'

export const FRESH_MS = 2500

export type ContextSummary = {
  items: LedgerContextItem[]
  /** Tokens (about) carried by pieces that crossed from one loop to another. */
  moved: number
  /** Tokens (about) across every measured piece. */
  total: number
  unmeasured: number
}

export function contextOf(ledger: Ledger, runId: string | null): ContextSummary {
  const items = ledger.items.filter(i => i.runId === runId)
  let moved = 0
  let total = 0
  let unmeasured = 0
  for (const i of items) {
    if (i.tokens === null) {
      unmeasured += 1
      continue
    }
    total += i.tokens
    if (i.fromAgentId !== null) moved += i.tokens
  }
  return { items, moved, total, unmeasured }
}

const loopModel = (agents: readonly LedgerAgent[], agentId: string | null, mainModel: string | null): string | null =>
  agentId === null ? mainModel : (agents.find(a => a.id === agentId)?.actualModel ?? mainModel)

const truncate = (text: string, max: number): string =>
  max <= 0 ? '' : text.length <= max ? text : max === 1 ? text.slice(0, 1) : `${text.slice(0, max - 1)}…`

export type Spot = { item: LedgerContextItem; x: number; y: number; lane: 0 | 1; color: number }

export function place(items: readonly LedgerContextItem[], agents: readonly LedgerAgent[], mainModel: string | null, width: number, laneY: [number, number], minGap: number, margin: number): Spot[] {
  const fit = Math.max(1, Math.floor((width - 2 * margin) / minGap) + 1)
  const shown = items.slice(-fit)
  const step = shown.length > 1 ? (width - 2 * margin) / (shown.length - 1) : 0
  return shown.map((item, i) => {
    const lane: 0 | 1 = i % 2 === 0 ? 0 : 1
    return { item, x: margin + i * step, y: laneY[lane], lane, color: modelColor(loopModel(agents, item.agentId, mainModel)) }
  })
}

/** The producer's latest piece before `i`, for a pink cross-loop link. */
export function producerSpot(spots: readonly Spot[], i: number): Spot | undefined {
  const s = spots[i]
  if (!s || s.item.fromAgentId === null) return undefined
  const from = s.item.fromAgentId === 'main' ? null : s.item.fromAgentId
  for (let j = i - 1; j >= 0; j--) {
    const o = spots[j]
    if (o && o.item.agentId === from) return o
  }
  return undefined
}

/** The timeline as a braille canvas: labels above the upper lane and below the lower one. */
export function drawContext(items: readonly LedgerContextItem[], agents: readonly LedgerAgent[], mainModel: string | null, at: number, columns: number, rows: number): Canvas {
  const canvas = new Canvas(columns, rows)
  const upper = 1
  const lower = Math.max(upper + 1, rows - 2)
  const spots = place(items, agents, mainModel, canvas.width, [upper * 4 + 2, lower * 4 + 1], 12, 6)
  for (let i = 1; i < spots.length; i++) {
    const a = spots[i - 1]
    const b = spots[i]
    if (a && b) canvas.line(a.x, a.y, b.x, b.y, mix(COLOR.dim, COLOR.bg, 0.2), 1)
  }
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i]
    const from = producerSpot(spots, i)
    // Context crossing from one loop to another: pink dashes flow from producer to receiver.
    if (s && from) canvas.flow(from.x, from.y, s.x, s.y, mix(COLOR.accent, COLOR.bg, 0.6), COLOR.accent, at / 70, 3, 2, 6)
  }
  const room = Math.max(3, Math.floor(spots.length > 1 ? canvas.width / (spots.length - 1) : columns) - 2)
  for (const s of spots) {
    const age = at - s.item.at
    const isFresh = age >= 0 && age < FRESH_MS
    if (isFresh) {
      // A new piece lands with a ripple.
      const t = Math.min(1, age / 900)
      canvas.ring(s.x, s.y, 2.5 + 4 * t, mix(s.color, COLOR.bg, 0.25 + 0.6 * t), 2)
    }
    canvas.disk(s.x, s.y, 2, s.color, 5)
    const label = truncate(s.item.label, room)
    const col = Math.max(0, Math.min(columns - label.length, Math.round(s.x / 2) - Math.floor(label.length / 2)))
    canvas.text(col, s.lane === 0 ? upper - 1 : lower + 1, label, isFresh ? COLOR.text : COLOR.muted)
  }
  return canvas
}

const esc = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const css = (c: number): string => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`

export function contextSvg(items: readonly LedgerContextItem[], agents: readonly LedgerAgent[], mainModel: string | null, at: number, width: number, height: number): string {
  const spots = place(items, agents, mainModel, width, [height * 0.38, height * 0.66], 70, 56)
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">`,
  ]
  for (let i = 1; i < spots.length; i++) {
    const a = spots[i - 1]
    const b = spots[i]
    if (a && b) parts.push(`<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${css(COLOR.dim)}" stroke-width="1"/>`)
  }
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i]
    const from = producerSpot(spots, i)
    if (s && from) {
      parts.push(`<line x1="${from.x.toFixed(1)}" y1="${from.y.toFixed(1)}" x2="${s.x.toFixed(1)}" y2="${s.y.toFixed(1)}" stroke="${css(COLOR.accent)}" stroke-width="1.2" stroke-dasharray="3 3"><animate attributeName="stroke-dashoffset" from="6" to="0" dur="0.5s" repeatCount="indefinite"/></line>`)
    }
  }
  for (const s of spots) {
    const isFresh = at - s.item.at >= 0 && at - s.item.at < FRESH_MS
    if (isFresh) {
      parts.push(`<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="5" fill="none" stroke="${css(s.color)}"><animate attributeName="r" values="4;10" dur="1.2s" repeatCount="indefinite"/><animate attributeName="stroke-opacity" values="0.8;0" dur="1.2s" repeatCount="indefinite"/></circle>`)
    }
    parts.push(`<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="4" fill="${css(s.color)}"/>`)
    const ly = s.lane === 0 ? s.y - 9 : s.y + 16
    parts.push(`<text x="${s.x.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="10" stroke="#1e1f22" stroke-width="3" paint-order="stroke" fill="${css(isFresh ? COLOR.text : COLOR.muted)}">${esc(truncate(s.item.label, 18))}</text>`)
  }
  parts.push('</svg>')
  return parts.join('')
}

/** One short label for a piece of context. */
export function contextLabel(kind: LedgerContextItem['kind'], text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (kind === 'read' || kind === 'write') {
    const parts = flat.split('/').filter(p => p.length > 0)
    return parts.slice(-1)[0] ?? flat
  }
  return flat
}
