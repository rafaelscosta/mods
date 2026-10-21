// The agent graph and the context band in real pixels, for terminals that draw images
// (kitty graphics: Ghostty, kitty, WezTerm). Same layout and motion as the braille versions,
// with glowing nodes, smooth lines and packets that move by the pixel.

import type { LedgerAgent, LedgerContextItem, LedgerPulse } from '../types'
import { Bitmap } from './bitmap'
import { place, producerSpot, FRESH_MS } from './context'
import { ADVANCE } from './font'
import { BURST_MS, SPAWN_MS, activePulses, edgeWidth, introGrowth, layoutTree, smooth, truncate, within } from './graph'
import type { GraphNode, Hitbox } from './graph'
import { ease, heartbeat } from './live'
import { COLOR, LOOK, mix, modelColor, shortModel } from './theme'

/** A terminal cell at 1x, in pixels; most monospace fonts sit near this 9:20. */
export const CELL_W = 9
export const CELL_H = 20
/** Neither side of a picture goes past this, so it stays well inside what terminals take. */
export const MAX_SIDE = 2048

const WHITE = 0xffffff

/** `unit`: pixels per 1x pixel; `scale`: pixels per font pixel, so a letter is as wide as a terminal cell (6 font pixels in 9). */
export type PixelBox = { width: number; height: number; unit: number; scale: number }

/** Picture size for a box of cells at `density` (2 for a Retina screen), and the font scale. */
export function pixelBox(columns: number, rows: number, density: number): PixelBox {
  const wanted = Math.max(0.5, density)
  const unit = Math.min(wanted, MAX_SIDE / (columns * CELL_W), MAX_SIDE / (rows * CELL_H))
  return {
    width: Math.max(1, Math.round(columns * CELL_W * unit)),
    height: Math.max(1, Math.round(rows * CELL_H * unit)),
    unit,
    scale: unit * 1.5,
  }
}

// One picture per size, cleared and drawn again each frame instead of allocated anew.
const pool = new Map<string, Bitmap>()

/** A transparent picture `width` x `height`; the one drawn at this size last frame, cleared. */
function canvasOf(box: PixelBox): Bitmap {
  const key = `${box.width}x${box.height}`
  const known = pool.get(key)
  if (known) return known.clear()
  if (pool.size >= 4) pool.clear()
  const made = new Bitmap(box.width, box.height)
  pool.set(key, made)
  return made
}

/** A glossy sphere: shadow, body, rim and a highlight up and to the left. */
function sphere(b: Bitmap, x: number, y: number, r: number, color: number, alpha: number, u: number): void {
  b.disk(x, y + u, r + u, 0x000000, 0.35 * alpha)
  b.disk(x, y, r, color, alpha)
  b.ring(x, y, r - 0.5 * u, u, mix(color, WHITE, 0.35), 0.55 * alpha)
  b.disk(x - r * 0.32, y - r * 0.36, r * 0.42, mix(color, WHITE, 0.6), 0.5 * alpha)
}

const easeOutBack = (t: number): number => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2

type PixelLayout = {
  pos: Map<string, { x: number; y: number; depth: number }>
  /** Where an edge leaves a node: under its name and model, so it never crosses them. */
  below: Map<string, { x: number; y: number }>
  radius: (n: GraphNode) => number
  lineH: number
  /** Most characters a name or model shows. */
  room: number
}

/** Where each node of the picture sits, in pixels of `box`. */
function pixelLayout(nodes: readonly GraphNode[], box: PixelBox): PixelLayout {
  const u = box.unit
  const s = box.scale
  const { at: placed, depth, leaves } = layoutTree(nodes)
  const levels = depth + 1
  const radius = (n: GraphNode) => (n.id === 'main' ? 10.5 : 9) * u
  const lineH = 9 * s + 2 * u
  const top = 10.5 * u + 24 * u
  const bottom = 10.5 * u + 6 * u + 2 * lineH
  const marginX = Math.max(30 * u, Math.min(box.width / 4, (ADVANCE * s * 8) / 2))
  const step = levels > 1 ? Math.max(0, box.height - top - bottom) / (levels - 1) : 0
  const pos = new Map<string, { x: number; y: number; depth: number }>()
  for (const n of nodes) {
    const p = placed.get(n.id)
    if (p) pos.set(n.id, { x: marginX + p.x * (box.width - 2 * marginX), y: levels > 1 ? top + p.depth * step : box.height * 0.36, depth: p.depth })
  }
  const below = new Map<string, { x: number; y: number }>()
  for (const n of nodes) {
    const p = pos.get(n.id)
    if (p) below.set(n.id, { x: p.x, y: p.y + radius(n) + 6 * u + 2 * lineH + 2 * u })
  }
  const room = Math.max(4, Math.min(22, Math.floor((box.width - marginX) / Math.max(1, leaves) / (ADVANCE * s)) - 1))
  return { pos, below, radius, lineH, room }
}

/** Where the pointer finds each node of the picture, in cells: the sphere and the two lines under it. */
export function pixelHitboxes(nodes: readonly GraphNode[], columns: number, rows: number, density: number): Hitbox[] {
  const box = pixelBox(columns, rows, density)
  const { pos, radius, lineH, room } = pixelLayout(nodes, box)
  const cw = box.width / columns
  const ch = box.height / rows
  return nodes.flatMap(n => {
    const p = pos.get(n.id)
    if (!p) return []
    const chars = Math.min(room, Math.max(n.label.length, shortModel(n.model ?? 'inherit').length))
    const half = Math.max(radius(n), (chars * ADVANCE * box.scale) / 2)
    const x0 = Math.max(0, Math.floor((p.x - half) / cw))
    const x1 = Math.min(columns, Math.ceil((p.x + half) / cw))
    const y0 = Math.max(0, Math.floor((p.y - radius(n)) / ch))
    const y1 = Math.min(rows, Math.ceil((p.y + radius(n) + 6 * box.unit + 2 * lineH) / ch))
    return [{ id: n.id, x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }]
  })
}

/**
 * The agent graph at time `at` as a picture (reused: encode it before drawing the next) for `columns` x `rows` cells: edges as wide as
 * the context they carried with light flowing into running agents, nodes that glow and beat
 * with their output speed, a ripple as an agent starts, a burst as it ends, packets with trails.
 * `introMs` into the pane's opening, nodes pop in level by level, edges growing out of the parent.
 */
export function drawGraphPixels(nodes: readonly GraphNode[], pulses: readonly LedgerPulse[], at: number, columns: number, rows: number, density: number, introMs: number | null = null): Bitmap {
  const box = pixelBox(columns, rows, density)
  const u = box.unit
  const s = box.scale
  const b = canvasOf(box)
  const { pos, below, radius, lineH, room } = pixelLayout(nodes, box)
  const grown = (id: string): number => introGrowth(introMs, pos.get(id)?.depth ?? 0)
  const glow = LOOK.glow

  // Edges: a dim line as wide as the context carried; into a running agent a glowing tube and flowing dashes.
  for (const n of nodes) {
    if (n.parentId === null) continue
    const a = below.get(n.parentId)
    const full = pos.get(n.id)
    const g = grown(n.id)
    if (!a || !full || g <= 0) continue
    const e = smooth(g)
    const c = { x: a.x + (full.x - a.x) * e, y: a.y + (full.y - a.y) * e }
    const color = modelColor(n.model)
    const width = ([0, 1.5, 3, 4.5][edgeWidth(n.contextTokens)] ?? 1.5) * u
    if (n.status === 'running') {
      if (glow > 0) b.line(a.x, a.y, c.x, c.y, width + 7 * u, color, 0.1 * glow)
      b.line(a.x, a.y, c.x, c.y, width, mix(color, COLOR.bg, 0.45), 0.95)
      b.line(a.x, a.y, c.x, c.y, Math.max(1.5 * u, width - 0.5 * u), mix(color, WHITE, 0.15), 1, 7 * u, 9 * u, (at / 1000) * 70 * u)
    } else {
      b.line(a.x, a.y, c.x, c.y, width, mix(color, COLOR.bg, 0.5), 0.9)
    }
  }

  // Light around each node, beating with a running agent's output.
  for (const n of nodes) {
    const p = pos.get(n.id)
    const g = grown(n.id)
    if (!p || g <= 0) continue
    const color = n.status === 'failed' ? COLOR.bad : modelColor(n.model)
    const r = radius(n)
    if (n.status === 'running' && g >= 1) {
      const period = heartbeat(n.rate)
      const beat = 0.5 + 0.5 * Math.cos(((at % period) / period) * Math.PI * 2)
      b.glow(p.x, p.y, r * 4.4, color, (0.34 + 0.22 * beat) * glow)
      for (const offset of [0, 0.5].slice(0, LOOK.rings)) {
        const ph = (((at / period + offset) % 1) + 1) % 1
        b.ring(p.x, p.y, r + 2 * u + 15 * u * ph, 1.6 * u, color, 0.8 * (1 - ph) * (1 - ph))
      }
    } else {
      b.glow(p.x, p.y, r * 3.6, color, (n.status === 'main' ? 0.32 : 0.18) * glow * g)
    }
    if (g < 1) continue
    if (n.startedAt !== null && within(n.startedAt, at, SPAWN_MS)) {
      const t = ease(at - n.startedAt, SPAWN_MS)
      b.ring(p.x, p.y, r + 28 * u * t, 2.2 * u, color, 0.9 * (1 - t))
    }
    if (n.endedAt !== null && within(n.endedAt, at, BURST_MS) && (n.status === 'done' || n.status === 'failed')) {
      const t = ease(at - n.endedAt, BURST_MS)
      const flash = n.status === 'done' ? COLOR.ok : COLOR.bad
      if (t < 0.35) b.glow(p.x, p.y, r * 4 + 20 * u * t, flash, 0.55 * (1 - t / 0.35) * Math.max(0.4, glow))
      b.ring(p.x, p.y, r + 34 * u * t, 2.6 * u, flash, 0.95 * (1 - t))
      if (t < 0.75) b.ring(p.x, p.y, r + 18 * u * t, 1.8 * u, flash, 0.8 * (1 - t / 0.75))
    }
  }

  // Names and models under the nodes, fading in as a node arrives.
  for (const n of nodes) {
    const p = pos.get(n.id)
    const shown = Math.max(0, Math.min(1, (grown(n.id) - 0.5) / 0.5))
    if (!p || shown <= 0) continue
    const r = radius(n)
    const name = truncate(n.label, room)
    const model = truncate(shortModel(n.model ?? 'inherit'), room)
    const y0 = p.y + r + 6 * u
    const at0 = (text: string) => Math.max(s, Math.min(box.width - [...text].length * ADVANCE * s, p.x - ([...text].length * ADVANCE * s - s) / 2))
    b.text(at0(name), y0, name, n.status === 'done' ? COLOR.muted : COLOR.text, s, shown, COLOR.bg)
    b.text(at0(model), y0 + lineH, model, n.model === null ? COLOR.muted : modelColor(n.model), s, shown, COLOR.bg)
  }

  // Nodes: glossy spheres; a finished one dims after its flash, with a check or a cross.
  for (const n of nodes) {
    const p = pos.get(n.id)
    const g = grown(n.id)
    if (!p || g <= 0) continue
    const r = radius(n) * (g < 1 ? Math.max(0.05, easeOutBack(g)) : 1)
    const base = n.status === 'failed' ? COLOR.bad : modelColor(n.model)
    const isFresh = n.endedAt !== null && within(n.endedAt, at, BURST_MS / 2)
    const isOver = n.status === 'done' || n.status === 'failed'
    sphere(b, p.x, p.y, r, base, isOver && !isFresh ? 0.6 : 1, u)
    if (n.id === 'main') b.ring(p.x, p.y, r + 3 * u, 1.2 * u, base, 0.55)
    if (n.status === 'done') {
      b.line(p.x - 3.6 * u, p.y + 0.2 * u, p.x - 1 * u, p.y + 2.8 * u, 1.9 * u, WHITE, 0.95)
      b.line(p.x - 1 * u, p.y + 2.8 * u, p.x + 4 * u, p.y - 2.8 * u, 1.9 * u, WHITE, 0.95)
    } else if (n.status === 'failed') {
      b.line(p.x - 3 * u, p.y - 3 * u, p.x + 3 * u, p.y + 3 * u, 1.9 * u, WHITE, 0.95)
      b.line(p.x + 3 * u, p.y - 3 * u, p.x - 3 * u, p.y + 3 * u, 1.9 * u, WHITE, 0.95)
    }
  }

  // Packets with a fading trail: a route parent -> child as a subagent starts, a result child -> parent as it ends.
  for (const { pulse, t } of activePulses(pulses, at)) {
    // Along the edge: a route leaves from under the parent, a result arrives there.
    const a = pulse.kind === 'route' ? below.get(pulse.from) : pos.get(pulse.from)
    const c = pulse.kind === 'route' ? pos.get(pulse.to) : below.get(pulse.to)
    if (!a || !c) continue
    const node = nodes.find(n => n.id === (pulse.kind === 'route' ? pulse.to : pulse.from))
    const color = pulse.kind === 'route' ? COLOR.accent : modelColor(node?.model ?? null)
    const fade = t > 0.85 ? (1 - t) / 0.15 : 1
    for (let k = 9; k >= 0; k--) {
      const tk = t - k * 0.022
      if (tk <= 0) continue
      const e = smooth(tk)
      const x = a.x + (c.x - a.x) * e
      const y = a.y + (c.y - a.y) * e
      if (k === 0) {
        b.glow(x, y, 16 * u, color, 0.55 * fade)
        b.disk(x, y, 4 * u, color, fade)
        b.disk(x, y, 1.8 * u, WHITE, 0.85 * fade)
      } else {
        b.disk(x, y, Math.max(0.8 * u, (3.6 - k * 0.3) * u), color, (0.6 - k * 0.06) * fade)
      }
    }
  }
  return b
}

/**
 * The context band as a picture: the run's pieces in two lanes, a dim chain between them,
 * pink light flowing from producer to receiver where context crossed loops, ripples on new ones.
 */
export function drawContextPixels(items: readonly LedgerContextItem[], agents: readonly LedgerAgent[], mainModel: string | null, at: number, columns: number, rows: number, density: number): Bitmap {
  const box = pixelBox(columns, rows, density)
  const u = box.unit
  const s = box.scale
  const b = canvasOf(box)
  const r = 4.8 * u
  const capH = 7 * s
  const upper = Math.max(r + 4 * u + capH + 2 * u, box.height * 0.36)
  const lower = Math.min(box.height - r - 4 * u - 9 * s, box.height * 0.64)
  const spots = place(items, agents, mainModel, box.width, [upper, Math.max(upper + 6 * u, lower)], 64 * u, 40 * u)
  for (let i = 1; i < spots.length; i++) {
    const a = spots[i - 1]
    const c = spots[i]
    if (a && c) b.line(a.x, a.y, c.x, c.y, 1.2 * u, mix(COLOR.dim, COLOR.bg, 0.1), 0.9)
  }
  for (let i = 0; i < spots.length; i++) {
    const sp = spots[i]
    const from = producerSpot(spots, i)
    if (!sp || !from) continue
    b.line(from.x, from.y, sp.x, sp.y, 6 * u, COLOR.accent, 0.1)
    b.line(from.x, from.y, sp.x, sp.y, 1.6 * u, COLOR.accent, 1, 5 * u, 5 * u, (at / 1000) * 40 * u)
  }
  const room = Math.max(3, Math.floor((spots.length > 1 ? box.width / (spots.length - 1) : box.width) / (ADVANCE * s)) - 1)
  for (const sp of spots) {
    const age = at - sp.item.at
    const isFresh = age >= 0 && age < FRESH_MS
    b.glow(sp.x, sp.y, 15 * u, sp.color, (isFresh ? 0.55 : 0.3) * LOOK.glow)
    if (isFresh) {
      const t = Math.min(1, age / 900)
      b.ring(sp.x, sp.y, r + 2 * u + 10 * u * t, 1.6 * u, sp.color, 0.85 * (1 - t))
    }
    sphere(b, sp.x, sp.y, r, sp.color, 1, u)
    const label = truncate(sp.item.label, room)
    const w = [...label].length * ADVANCE * s - s
    const x = Math.max(s, Math.min(box.width - w - s, sp.x - w / 2))
    const y = sp.lane === 0 ? sp.y - r - 4 * u - capH : sp.y + r + 4 * u
    b.text(x, y, label, isFresh ? COLOR.text : COLOR.muted, s, 1, COLOR.bg)
  }
  return b
}
