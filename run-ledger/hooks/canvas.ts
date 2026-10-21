// A cell canvas for the terminal's Raster: lines and disks in braille dots (2x4 per cell),
// text in whole cells, one foreground colour per cell, packed as Raster `cells`.

import { DEFAULT_COLOR } from './theme'

// Braille dot bits by (dx, dy) within a cell.
const BIT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

/** Printable and one cell wide for certain: ASCII, Latin, arrows, box drawing, blocks, braille, check marks. */
export function isNarrow(cp: number): boolean {
  if (cp >= 0x20 && cp <= 0x7e) return true
  if (cp >= 0xa0 && cp <= 0x2ff) return true
  if (cp >= 0x2190 && cp <= 0x21ff) return true
  if (cp >= 0x2500 && cp <= 0x259f) return true
  if (cp >= 0x2800 && cp <= 0x28ff) return true
  return cp === 0x2713 || cp === 0x2717 || cp === 0x00b7 || cp === 0x2022 || cp === 0x2026
}

export class Canvas {
  readonly columns: number
  readonly rows: number
  private readonly dots: Uint8Array
  private readonly dotColor: Uint32Array
  private readonly dotRank: Uint8Array
  private readonly glyph: Uint32Array
  private readonly glyphColor: Uint32Array
  private readonly back: Uint32Array

  constructor(columns: number, rows: number) {
    this.columns = Math.max(1, Math.min(512, Math.floor(columns)))
    this.rows = Math.max(1, Math.min(256, Math.floor(rows)))
    const n = this.columns * this.rows
    this.dots = new Uint8Array(n)
    this.dotColor = new Uint32Array(n)
    this.dotRank = new Uint8Array(n)
    this.glyph = new Uint32Array(n)
    this.glyphColor = new Uint32Array(n)
    this.back = new Uint32Array(n).fill(DEFAULT_COLOR)
  }

  /** Dots across and down. */
  get width(): number {
    return this.columns * 2
  }

  get height(): number {
    return this.rows * 4
  }

  /** One dot; `rank` decides whose colour a shared cell takes (higher wins). */
  plot(x: number, y: number, color: number, rank = 1): void {
    const px = Math.round(x)
    const py = Math.round(y)
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return
    const cell = (py >> 2) * this.columns + (px >> 1)
    const row = BIT[py & 3]
    if (!row) return
    this.dots[cell] = (this.dots[cell] ?? 0) | (row[px & 1] ?? 0)
    if (rank >= (this.dotRank[cell] ?? 0)) {
      this.dotRank[cell] = rank
      this.dotColor[cell] = color
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, color: number, rank = 1): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))))
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      this.plot(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, color, rank)
    }
  }

  /** A dotted line: every other dot. */
  dashed(x0: number, y0: number, x1: number, y1: number, color: number, rank = 1): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))))
    for (let i = 0; i <= steps; i += 2) {
      const t = i / steps
      this.plot(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, color, rank)
    }
  }

  /**
   * A line whose bright dashes travel from (x0, y0) toward (x1, y1) as `phase` grows:
   * `dash` lit dots in every `period`, the rest in `base`.
   */
  flow(x0: number, y0: number, x1: number, y1: number, base: number, bright: number, phase: number, rank = 1, dash = 3, period = 8): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))))
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const isLit = (((i - Math.floor(phase)) % period) + period) % period < dash
      this.plot(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, isLit ? bright : base, isLit ? rank + 1 : rank)
    }
  }

  /** A line `width` dots thick (1 to 3), widened across its direction. */
  thickLine(x0: number, y0: number, x1: number, y1: number, color: number, width: number, rank = 1): void {
    const len = Math.max(1e-6, Math.hypot(x1 - x0, y1 - y0))
    const nx = -(y1 - y0) / len
    const ny = (x1 - x0) / len
    const offsets = width >= 3 ? [-1, 0, 1] : width === 2 ? [0, 1] : [0]
    for (const k of offsets) this.line(x0 + nx * k, y0 + ny * k, x1 + nx * k, y1 + ny * k, color, rank)
  }

  disk(cx: number, cy: number, r: number, color: number, rank = 3): void {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r + 0.25) this.plot(x, y, color, rank)
      }
    }
  }

  ring(cx: number, cy: number, r: number, color: number, rank = 2): void {
    const steps = Math.max(12, Math.ceil(2 * Math.PI * r * 1.5))
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * 2 * Math.PI
      this.plot(cx + Math.cos(a) * r, cy + Math.sin(a) * r, color, rank)
    }
  }

  /** Text from cell (column, row); characters that are not surely one cell wide become `?`. */
  text(column: number, row: number, text: string, color: number): void {
    if (row < 0 || row >= this.rows) return
    let c = Math.round(column)
    for (const ch of text) {
      if (c >= this.columns) break
      if (c >= 0) {
        const cp = ch.codePointAt(0) ?? 0x3f
        const cell = row * this.columns + c
        this.glyph[cell] = isNarrow(cp) ? cp : 0x3f
        this.glyphColor[cell] = color
      }
      c++
    }
  }

  /** One whole cell: a glyph, its colour and the cell's background. */
  cell(column: number, row: number, glyph: string, color: number, background: number = DEFAULT_COLOR): void {
    const c = Math.round(column)
    if (row < 0 || row >= this.rows || c < 0 || c >= this.columns) return
    const cp = glyph.codePointAt(0) ?? 0x20
    const i = row * this.columns + c
    this.glyph[i] = isNarrow(cp) ? cp : 0x3f
    this.glyphColor[i] = color
    this.back[i] = background
  }

  /** Whether a cell already holds a glyph (text or a node). */
  hasGlyph(column: number, row: number): boolean {
    if (row < 0 || row >= this.rows || column < 0 || column >= this.columns) return false
    return (this.glyph[row * this.columns + column] ?? 0) !== 0
  }

  /** The cell a dot falls in. */
  cellOf(x: number, y: number): { column: number; row: number } {
    return { column: Math.floor(Math.round(x) / 2), row: Math.floor(Math.round(y) / 4) }
  }

  /** Raster `cells`: base64 of little-endian u32 triplets [codePoint, foreground, background]. */
  encode(): string {
    const n = this.columns * this.rows
    const words = new Uint32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const g = this.glyph[i] ?? 0
      const d = this.dots[i] ?? 0
      if (g !== 0) {
        words[i * 3] = g
        words[i * 3 + 1] = this.glyphColor[i] ?? DEFAULT_COLOR
      } else if (d !== 0) {
        words[i * 3] = 0x2800 + d
        words[i * 3 + 1] = this.dotColor[i] ?? DEFAULT_COLOR
      } else {
        words[i * 3] = 0x20
        words[i * 3 + 1] = DEFAULT_COLOR
      }
      words[i * 3 + 2] = this.back[i] ?? DEFAULT_COLOR
    }
    return toBase64(new Uint8Array(words.buffer))
  }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += ALPHABET[(n >> 18) & 63]
    out += ALPHABET[(n >> 12) & 63]
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? ALPHABET[n & 63] : '='
  }
  return out
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (ALPHABET.indexOf(clean[i] ?? 'A') << 18) |
      (ALPHABET.indexOf(clean[i + 1] ?? 'A') << 12) |
      (Math.max(0, ALPHABET.indexOf(clean[i + 2] ?? 'A')) << 6) |
      Math.max(0, ALPHABET.indexOf(clean[i + 3] ?? 'A'))
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}

/** Raster cells back to rows of text (glyphs and braille as drawn): for tests and the text fallback. */
export function cellsToText(cells: string, columns: number): string[] {
  const bytes = fromBase64(cells)
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4))
  const rows: string[] = []
  let line = ''
  for (let i = 0; i * 3 < words.length; i++) {
    line += String.fromCodePoint(words[i * 3] ?? 0x20)
    if ((i + 1) % columns === 0) {
      rows.push(line)
      line = ''
    }
  }
  if (line) rows.push(line)
  return rows
}
