// The agent graph: main, its subagents and theirs, as a tree laid out top-down.
// Drawn in braille on the terminal (a Raster, repainted ~16 times a second while it moves)
// and as an animated SVG elsewhere. Every motion is a function of the time `at`.

import type { Ledger, LedgerAgent, LedgerPulse } from '../types'
import { Canvas } from './canvas'
import { ease, heartbeat } from './live'
import { ROLE_PREFIX } from './router'
import { COLOR, mix, modelColor, shortModel } from './theme'

export const PULSE_MS = 1600
export const SPAWN_MS = 700
export const BURST_MS = 900
const TRAIL = 4
/** The pane's opening: nodes appear level by level and their edges grow out of the parent. */
export const INTRO_MS = 1100
const INTRO_STAGGER = 170
const INTRO_GROW = 420

/** How far a node at `depth` has grown `introMs` into the opening: 0 not yet, 1 grown; null, no opening. */
export const introGrowth = (introMs: number | null, depth: number): number =>
  introMs === null ? 1 : Math.max(0, Math.min(1, (introMs - depth * INTRO_STAGGER) / INTRO_GROW))

export type GraphNode = {
  id: string
  parentId: string | null
  label: string
  model: string | null
  status: 'main' | 'running' | 'done' | 'failed'
  startedAt: number | null
  endedAt: number | null
  /** Tokens the node's loop was handed (its first request's input); the edge into it widens with it. */
  contextTokens: number | null
  /** Live output speed, tokens per second; the halo beats faster with it. */
  rate: number
}

export const roleName = (type: string): string => (type.startsWith(ROLE_PREFIX) ? type.slice(ROLE_PREFIX.length) : type)

/** The name a node shows: its role, or its task when the type says nothing. */
export function agentLabel(a: Pick<LedgerAgent, 'type' | 'description'>): string {
  const role = roleName(a.type)
  return role === 'general-purpose' || role === 'fork' || role === '' ? a.description || role : role
}

export const agentModel = (a: LedgerAgent): string | null => a.actualModel ?? a.requestedModel ?? null

/** Nodes of run `runId`, plus background agents still running from earlier runs. */
export function graphNodes(
  ledger: Ledger,
  runId: string | null,
  mainModel: string | null,
  isMainRunning: boolean,
  rateOf: (loop: string) => number = () => 0,
): GraphNode[] {
  const agents = ledger.agents.filter(a => a.runId === runId || a.status === 'running')
  const ids = new Set(agents.map(a => a.id))
  const status = (a: LedgerAgent): GraphNode['status'] =>
    a.status === 'running' ? 'running' : a.status === 'completed' ? 'done' : 'failed'
  return [
    { id: 'main', parentId: null, label: 'main', model: mainModel, status: isMainRunning ? 'running' : 'main', startedAt: null, endedAt: null, contextTokens: null, rate: rateOf('main') },
    ...agents.map(a => ({
      id: a.id,
      parentId: a.parentId !== null && ids.has(a.parentId) ? a.parentId : 'main',
      label: agentLabel(a),
      model: agentModel(a),
      status: status(a),
      startedAt: a.startedAt,
      endedAt: a.endedAt,
      contextTokens: a.contextTokens,
      rate: rateOf(a.id),
    })),
  ]
}

export type Placed = { x: number; depth: number; leaves: number }

/** A tidy tree: leaves spread evenly across 0..1, a parent centred over its children. */
export function layoutTree(nodes: readonly GraphNode[]): { at: Map<string, Placed>; depth: number; leaves: number } {
  const kids = new Map<string, GraphNode[]>()
  for (const n of nodes) if (n.parentId !== null) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n])
  const at = new Map<string, Placed>()
  let leaf = 0
  let maxDepth = 0
  const walk = (n: GraphNode, depth: number, seen: Set<string>): { first: number; last: number } => {
    maxDepth = Math.max(maxDepth, depth)
    const children = (kids.get(n.id) ?? []).filter(c => !seen.has(c.id))
    if (children.length === 0) {
      const x = leaf++
      at.set(n.id, { x, depth, leaves: 1 })
      return { first: x, last: x }
    }
    const spans = children.map(c => walk(c, depth + 1, new Set([...seen, c.id])))
    const first = spans[0]?.first ?? 0
    const last = spans[spans.length - 1]?.last ?? 0
    at.set(n.id, { x: (first + last) / 2, depth, leaves: last - first + 1 })
    return { first, last }
  }
  for (const root of nodes.filter(n => n.parentId === null)) walk(root, 0, new Set([root.id]))
  const leaves = Math.max(1, leaf)
  for (const [id, p] of at) at.set(id, { ...p, x: (p.x + 0.5) / leaves })
  return { at, depth: maxDepth, leaves }
}

export const activePulses = (pulses: readonly LedgerPulse[], at: number): { pulse: LedgerPulse; t: number }[] =>
  pulses
    .filter(p => at - p.at >= 0 && at - p.at < PULSE_MS)
    .map(pulse => ({ pulse, t: (at - pulse.at) / PULSE_MS }))

export const within = (since: number | null, at: number, ms: number): boolean => since !== null && at - since >= 0 && at - since < ms

/** Something on the graph moves at `at`: a packet, a running agent, a spawn ripple, a finish burst. */
export const isAnimating = (ledger: Ledger, at: number): boolean =>
  ledger.pulses.some(p => at - p.at >= 0 && at - p.at < PULSE_MS + 200) ||
  ledger.agents.some(a => a.status === 'running' || within(a.startedAt, at, SPAWN_MS + 100) || within(a.endedAt, at, BURST_MS + 100))

/** Edge width from the context handed over: 1 dot under 5k tokens, 2 under 50k, 3 above. */
export const edgeWidth = (tokens: number | null): number => (tokens === null || tokens < 5_000 ? 1 : tokens < 50_000 ? 2 : 3)

export const truncate = (text: string, max: number): string =>
  max <= 0 ? '' : text.length <= max ? text : max === 1 ? text.slice(0, 1) : `${text.slice(0, max - 1)}…`

export const smooth = (t: number): number => t * t * (3 - 2 * t)

export type CellSpot = { x: number; y: number; row: number; column: number; depth: number }

/** Where each node sits on a cell canvas `columns` by `rows`: its cell, its canvas dot, its depth. */
export function cellLayout(nodes: readonly GraphNode[], columns: number, rows: number): { pos: Map<string, CellSpot>; twoLines: boolean; labelMax: number } {
  const { at: placed, depth, leaves } = layoutTree(nodes)
  const levels = depth + 1
  // A node takes one row; its name and model the two below it.
  const firstRow = 1
  const spacingTwo = levels > 1 ? (rows - 3 - firstRow) / (levels - 1) : 0
  const twoLines = levels === 1 ? rows >= 4 : spacingTwo >= 3.5
  const lastRow = twoLines ? rows - 3 : rows - 2
  const spacing = levels > 1 ? (lastRow - firstRow) / (levels - 1) : 0
  const pos = new Map<string, CellSpot>()
  for (const n of nodes) {
    const p = placed.get(n.id)
    if (!p) continue
    const row = Math.max(0, Math.min(lastRow, firstRow + Math.round(p.depth * spacing)))
    const column = Math.max(1, Math.min(columns - 2, Math.round(2 + p.x * (columns - 4))))
    pos.set(n.id, { x: column * 2 + 1, y: row * 4 + 2, row, column, depth: p.depth })
  }
  return { pos, twoLines, labelMax: Math.max(4, Math.min(16, Math.floor(columns / Math.max(1, leaves)) - 1)) }
}

/** Where the pointer finds each node, in cells: the node and its name and model under it. */
export type Hitbox = { id: string; x: number; y: number; w: number; h: number }

export function cellHitboxes(nodes: readonly GraphNode[], columns: number, rows: number): Hitbox[] {
  const { pos, twoLines, labelMax } = cellLayout(nodes, columns, rows)
  return nodes.flatMap(n => {
    const p = pos.get(n.id)
    if (!p) return []
    const w = Math.max(3, Math.min(labelMax, Math.max(n.label.length, shortModel(n.model ?? 'inherit').length)))
    return [{ id: n.id, x: Math.max(0, Math.min(columns - w, p.column - Math.floor(w / 2))), y: p.row, w, h: twoLines ? 3 : 2 }]
  })
}

/**
 * The graph on a cell canvas `columns` by `rows`, at time `at`: solid nodes, edges as wide as
 * the context they carried with dashes flowing into running agents, halos that beat with each
 * agent's output speed, a ripple as an agent starts and a burst as it ends, packets with trails.
 * `introMs` into the pane's opening, nodes appear level by level, edges growing out of the parent.
 */
export function drawGraph(nodes: readonly GraphNode[], pulses: readonly LedgerPulse[], at: number, columns: number, rows: number, introMs: number | null = null): Canvas {
  const canvas = new Canvas(columns, rows)
  const { pos, twoLines, labelMax } = cellLayout(nodes, columns, rows)
  const grown = (id: string): number => introGrowth(introMs, pos.get(id)?.depth ?? 0)
  const phase = at / 70

  // Edges: as wide as the context they carried; into a running agent, dashes flow down them.
  for (const n of nodes) {
    if (n.parentId === null) continue
    const a = pos.get(n.parentId)
    const full = pos.get(n.id)
    const g = grown(n.id)
    if (!a || !full || g <= 0) continue
    const e = smooth(g)
    const b = { x: a.x + (full.x - a.x) * e, y: a.y + (full.y - a.y) * e }
    const color = modelColor(n.model)
    const width = edgeWidth(n.contextTokens)
    if (n.status === 'running') {
      canvas.thickLine(a.x, a.y, b.x, b.y, mix(color, COLOR.bg, 0.55), width, 1)
      canvas.flow(a.x, a.y, b.x, b.y, mix(color, COLOR.bg, 0.55), color, phase, 1)
    } else {
      canvas.thickLine(a.x, a.y, b.x, b.y, mix(color, COLOR.bg, 0.5), width, 1)
    }
  }

  // Halos: two rings ripple out of each running node, at the pace of its output.
  for (const n of nodes) {
    const p = pos.get(n.id)
    if (!p || n.status !== 'running' || grown(n.id) < 1) continue
    const color = modelColor(n.model)
    const period = heartbeat(n.rate)
    for (const offset of [0, 0.5]) {
      const ph = ((at / period + offset) % 1 + 1) % 1
      canvas.ring(p.x, p.y, 3.5 + 3.5 * ph, mix(color, COLOR.bg, 0.2 + 0.7 * ph), 2)
    }
  }
  // A ripple as an agent starts; a burst, green or red, as it ends.
  for (const n of nodes) {
    const p = pos.get(n.id)
    if (!p) continue
    if (n.startedAt !== null && within(n.startedAt, at, SPAWN_MS)) {
      const t = ease(at - n.startedAt, SPAWN_MS)
      canvas.ring(p.x, p.y, 2 + 9 * t, mix(modelColor(n.model), COLOR.bg, t * 0.85), 3)
    }
    if (n.endedAt !== null && within(n.endedAt, at, BURST_MS) && (n.status === 'done' || n.status === 'failed')) {
      const t = ease(at - n.endedAt, BURST_MS)
      const color = n.status === 'done' ? COLOR.ok : COLOR.bad
      if (t < 0.3) canvas.disk(p.x, p.y, 4 + 6 * t, mix(color, COLOR.bg, 0.35 + t), 3)
      canvas.ring(p.x, p.y, 3 + 11 * t, mix(color, COLOR.bg, t * 0.55), 4)
      if (t < 0.7) canvas.ring(p.x, p.y, 2.5 + 7 * t, mix(color, COLOR.bg, 0.15 + t * 0.6), 4)
    }
  }

  // Names and models.
  for (const n of nodes) {
    const p = pos.get(n.id)
    if (!p || grown(n.id) < 0.6) continue
    const color = modelColor(n.model)
    const name = truncate(n.label, labelMax)
    const model = truncate(shortModel(n.model ?? 'inherit'), labelMax)
    const place = (text: string) => Math.max(0, Math.min(columns - text.length, p.column - Math.floor(text.length / 2)))
    if (twoLines) {
      canvas.text(place(name), p.row + 1, name, n.status === 'done' ? COLOR.muted : COLOR.text)
      canvas.text(place(model), p.row + 2, model, n.model === null ? COLOR.muted : color)
    } else {
      canvas.text(place(name), p.row + 1, name, n.model === null ? COLOR.text : color)
    }
  }

  // Nodes: solid, over everything but the packets. A node that just ended flashes in full colour.
  for (const n of nodes) {
    const p = pos.get(n.id)
    if (!p || grown(n.id) < 0.35) continue
    const base = n.status === 'failed' ? COLOR.bad : modelColor(n.model)
    const isFresh = n.endedAt !== null && within(n.endedAt, at, BURST_MS / 2)
    const color = (n.status === 'done' || n.status === 'failed') && !isFresh ? mix(base, COLOR.bg, 0.3) : base
    const mark = n.status === 'done' ? '✓' : n.status === 'failed' ? '✗' : ' '
    canvas.cell(p.column - 1, p.row, '▐', color)
    canvas.cell(p.column, p.row, mark, COLOR.bg, color)
    canvas.cell(p.column + 1, p.row, '▌', color)
  }

  // Packets with a fading trail: a route travels parent -> child as a subagent starts, a result child -> parent as it ends.
  const nodeCells = [...pos.values()]
  for (const { pulse, t } of activePulses(pulses, at)) {
    const a = pos.get(pulse.from)
    const b = pos.get(pulse.to)
    if (!a || !b) continue
    const toNode = nodes.find(n => n.id === (pulse.kind === 'route' ? pulse.to : pulse.from))
    const color = pulse.kind === 'route' ? COLOR.accent : modelColor(toNode?.model ?? null)
    for (let k = TRAIL; k >= 0; k--) {
      const tk = t - k * 0.045
      if (tk <= 0) continue
      const e = smooth(tk)
      const x = a.x + (b.x - a.x) * e
      const y = a.y + (b.y - a.y) * e
      const cell = canvas.cellOf(x, y)
      if (nodeCells.some(q => q.row === cell.row && Math.abs(q.column - cell.column) <= 1)) continue
      const shade = mix(color, COLOR.bg, k * 0.18)
      if (k === 0 && canvas.hasGlyph(cell.column, cell.row)) canvas.cell(cell.column, cell.row, '█', color)
      else canvas.disk(x, y, k === 0 ? 1.6 : Math.max(0.5, 1.2 - k * 0.2), shade, 9 - k)
    }
  }
  return canvas
}

const esc = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const css = (c: number): string => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`

/** The graph as an SVG document, `width` by `height` CSS pixels, its motion in SMIL. */
export function graphSvg(nodes: readonly GraphNode[], pulses: readonly LedgerPulse[], at: number, width: number, height: number): string {
  const { at: placed, depth } = layoutTree(nodes)
  const levels = depth + 1
  const top = 22
  const bottom = 40
  const marginX = 44
  const step = levels > 1 ? (height - top - bottom) / (levels - 1) : 0
  const pos = new Map<string, { x: number; y: number }>()
  for (const n of nodes) {
    const p = placed.get(n.id)
    if (p) pos.set(n.id, { x: marginX + p.x * (width - 2 * marginX), y: top + p.depth * step })
  }
  const f = (v: number) => v.toFixed(1)
  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">`,
    '<defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>',
  )
  for (const n of nodes) {
    if (n.parentId === null) continue
    const a = pos.get(n.parentId)
    const b = pos.get(n.id)
    if (!a || !b) continue
    const color = modelColor(n.model)
    const strokeWidth = [0, 1.5, 3, 4.5][edgeWidth(n.contextTokens)] ?? 1.5
    parts.push(`<line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}" stroke="${css(mix(color, COLOR.bg, 0.5))}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`)
    if (n.status === 'running') {
      parts.push(
        `<line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}" stroke="${css(color)}" stroke-width="${Math.max(1.5, strokeWidth - 0.5)}" stroke-dasharray="4 8" stroke-linecap="round"><animate attributeName="stroke-dashoffset" from="12" to="0" dur="0.6s" repeatCount="indefinite"/></line>`,
      )
    }
  }
  for (const n of nodes) {
    const p = pos.get(n.id)
    if (!p) continue
    const color = css(modelColor(n.model))
    const r = n.id === 'main' ? 9 : 8
    if (n.status === 'running') {
      const dur = (heartbeat(n.rate) / 1000).toFixed(2)
      for (const delay of ['0s', `${(heartbeat(n.rate) / 2000).toFixed(2)}s`]) {
        parts.push(
          `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${r + 2}" fill="none" stroke="${color}"><animate attributeName="r" values="${r + 1};${r + 10}" dur="${dur}s" begin="${delay}" repeatCount="indefinite"/><animate attributeName="stroke-opacity" values="0.7;0" dur="${dur}s" begin="${delay}" repeatCount="indefinite"/></circle>`,
        )
      }
    }
    if (n.startedAt !== null && within(n.startedAt, at, SPAWN_MS)) {
      const elapsed = ((at - n.startedAt) / 1000).toFixed(2)
      parts.push(
        `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${r}" fill="none" stroke="${color}" stroke-width="2"><animate attributeName="r" values="${r};${r + 22}" dur="${SPAWN_MS / 1000}s" begin="-${elapsed}s" fill="freeze"/><animate attributeName="stroke-opacity" values="0.9;0" dur="${SPAWN_MS / 1000}s" begin="-${elapsed}s" fill="freeze"/></circle>`,
      )
    }
    if (n.endedAt !== null && within(n.endedAt, at, BURST_MS) && (n.status === 'done' || n.status === 'failed')) {
      const elapsed = ((at - n.endedAt) / 1000).toFixed(2)
      const burst = css(n.status === 'done' ? COLOR.ok : COLOR.bad)
      parts.push(
        `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${r}" fill="${burst}" fill-opacity="0.35" stroke="${burst}" stroke-width="2"><animate attributeName="r" values="${r};${r + 26}" dur="${BURST_MS / 1000}s" begin="-${elapsed}s" fill="freeze"/><animate attributeName="opacity" values="1;0" dur="${BURST_MS / 1000}s" begin="-${elapsed}s" fill="freeze"/></circle>`,
      )
    }
    const fill = n.status === 'failed' ? css(COLOR.bad) : color
    const opacity = n.status === 'done' || n.status === 'failed' ? 0.55 : 1
    parts.push(`<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${r}" fill="${fill}" fill-opacity="${opacity}" filter="url(#glow)"/>`)
    if (n.status === 'done') {
      parts.push(`<path d="M ${f(p.x - 3.5)} ${f(p.y)} l 2.5 2.5 l 4.5 -5" stroke="#ffffff" stroke-width="1.8" fill="none"/>`)
    } else if (n.status === 'failed') {
      parts.push(`<path d="M ${f(p.x - 3)} ${f(p.y - 3)} l 6 6 m 0 -6 l -6 6" stroke="#ffffff" stroke-width="1.8"/>`)
    }
    parts.push(
      `<text x="${f(p.x)}" y="${f(p.y + r + 13)}" text-anchor="middle" font-size="11" stroke="#1e1f22" stroke-width="3" paint-order="stroke" fill="${css(COLOR.text)}" font-weight="600">${esc(truncate(n.label, 22))}</text>`,
      `<text x="${f(p.x)}" y="${f(p.y + r + 25)}" text-anchor="middle" font-size="10" stroke="#1e1f22" stroke-width="3" paint-order="stroke" fill="${n.model === null ? css(COLOR.muted) : color}">${esc(shortModel(n.model ?? 'inherit'))}</text>`,
    )
  }
  for (const { pulse, t } of activePulses(pulses, at)) {
    const a = pos.get(pulse.from)
    const b = pos.get(pulse.to)
    if (!a || !b) continue
    const node = nodes.find(n => n.id === (pulse.kind === 'route' ? pulse.to : pulse.from))
    const color = pulse.kind === 'route' ? css(COLOR.accent) : css(modelColor(node?.model ?? null))
    const elapsed = (t * PULSE_MS) / 1000
    const motion = (lag: number) =>
      `<animateMotion dur="${(PULSE_MS / 1000).toFixed(1)}s" begin="-${Math.max(0, elapsed - lag).toFixed(2)}s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.45 0 0.55 1" path="M ${f(a.x)} ${f(a.y)} L ${f(b.x)} ${f(b.y)}"/>`
    for (let k = TRAIL; k >= 1; k--) {
      parts.push(`<circle r="${(3.2 - k * 0.5).toFixed(1)}" fill="${color}" fill-opacity="${(0.55 - k * 0.11).toFixed(2)}">${motion(k * 0.07)}</circle>`)
    }
    parts.push(`<rect x="-4" y="-4" width="8" height="8" rx="2" fill="${color}" filter="url(#glow)">${motion(0)}</rect>`)
    if (pulse.kind === 'route') {
      parts.push(
        `<text font-size="9" fill="${color}" text-anchor="middle"><animateMotion dur="${(PULSE_MS / 1000).toFixed(1)}s" begin="-${elapsed.toFixed(2)}s" fill="freeze" path="M ${f(a.x + 18)} ${f(a.y)} L ${f(b.x + 18)} ${f(b.y)}"/>route</text>`,
      )
    }
  }
  parts.push('</svg>')
  return parts.join('')
}
