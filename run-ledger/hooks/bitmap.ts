// A small anti-aliased rasterizer over a transparent RGBA picture: discs, rings, soft glows,
// lines with width and round caps, flowing dashes, and pixel-font text. Colors are 0xRRGGBB;
// pixels are premultiplied floats until `rgba()` turns them into straight 8-bit RGBA.

import { ADVANCE, GLYPH_H, GLYPH_W, smoothGlyph, textWidth } from './font'

const clamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v)

export class Bitmap {
  readonly width: number
  readonly height: number
  private readonly px: Float32Array

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.round(width))
    this.height = Math.max(1, Math.round(height))
    this.px = new Float32Array(this.width * this.height * 4)
  }

  /** Back to fully transparent, to draw the next frame in the same memory. */
  clear(): this {
    this.px.fill(0)
    return this
  }

  /** Lays `color` over pixel (x, y) with coverage `a` (0..1). */
  private over(x: number, y: number, color: number, a: number): void {
    if (a <= 0.002 || x < 0 || y < 0 || x >= this.width || y >= this.height) return
    const i = (y * this.width + x) * 4
    const k = 1 - a
    const p = this.px
    p[i] = ((color >>> 16) & 0xff) / 255 * a + (p[i] ?? 0) * k
    p[i + 1] = ((color >>> 8) & 0xff) / 255 * a + (p[i + 1] ?? 0) * k
    p[i + 2] = (color & 0xff) / 255 * a + (p[i + 2] ?? 0) * k
    p[i + 3] = a + (p[i + 3] ?? 0) * k
  }

  /** Adds light: `color` brightens what is there and makes it more opaque, never darker. */
  private add(x: number, y: number, color: number, a: number): void {
    if (a <= 0.002 || x < 0 || y < 0 || x >= this.width || y >= this.height) return
    const i = (y * this.width + x) * 4
    const p = this.px
    p[i] = Math.min(1, (p[i] ?? 0) + ((color >>> 16) & 0xff) / 255 * a)
    p[i + 1] = Math.min(1, (p[i + 1] ?? 0) + ((color >>> 8) & 0xff) / 255 * a)
    p[i + 2] = Math.min(1, (p[i + 2] ?? 0) + (color & 0xff) / 255 * a)
    p[i + 3] = Math.min(1, (p[i + 3] ?? 0) + a)
  }

  /** A filled disc, edge anti-aliased. */
  disk(cx: number, cy: number, r: number, color: number, alpha = 1): void {
    if (r <= 0 || alpha <= 0) return
    const x0 = Math.floor(cx - r - 1)
    const x1 = Math.ceil(cx + r + 1)
    const y0 = Math.floor(cy - r - 1)
    const y1 = Math.ceil(cy + r + 1)
    for (let y = Math.max(0, y0); y <= Math.min(this.height - 1, y1); y++) {
      const dy = y + 0.5 - cy
      for (let x = Math.max(0, x0); x <= Math.min(this.width - 1, x1); x++) {
        const dx = x + 0.5 - cx
        this.over(x, y, color, alpha * clamp01(r - Math.sqrt(dx * dx + dy * dy) + 0.5))
      }
    }
  }

  /** A ring of radius `r` and stroke `width`. */
  ring(cx: number, cy: number, r: number, width: number, color: number, alpha = 1): void {
    if (r <= 0 || width <= 0 || alpha <= 0) return
    const half = width / 2
    const reach = r + half + 1
    for (let y = Math.max(0, Math.floor(cy - reach)); y <= Math.min(this.height - 1, Math.ceil(cy + reach)); y++) {
      const dy = y + 0.5 - cy
      for (let x = Math.max(0, Math.floor(cx - reach)); x <= Math.min(this.width - 1, Math.ceil(cx + reach)); x++) {
        const dx = x + 0.5 - cx
        const d = Math.abs(Math.sqrt(dx * dx + dy * dy) - r)
        this.over(x, y, color, alpha * clamp01(half - d + 0.5))
      }
    }
  }

  /** A soft light: `color` falling off from the centre to nothing at radius `r`. */
  glow(cx: number, cy: number, r: number, color: number, alpha: number): void {
    if (r <= 0 || alpha <= 0) return
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(this.height - 1, Math.ceil(cy + r)); y++) {
      const dy = y + 0.5 - cy
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(this.width - 1, Math.ceil(cx + r)); x++) {
        const dx = x + 0.5 - cx
        const t = 1 - Math.sqrt(dx * dx + dy * dy) / r
        if (t > 0) this.add(x, y, color, alpha * t * t)
      }
    }
  }

  /**
   * A line from (x0, y0) to (x1, y1), `width` across with round caps. With `dash`, only the
   * dashes are drawn: `dash` long, `gap` apart, shifted along the line by `phase` pixels.
   */
  line(x0: number, y0: number, x1: number, y1: number, width: number, color: number, alpha = 1, dash = 0, gap = 0, phase = 0): void {
    if (width <= 0 || alpha <= 0) return
    const dx = x1 - x0
    const dy = y1 - y0
    const len2 = dx * dx + dy * dy
    const len = Math.sqrt(len2)
    const half = width / 2
    const reach = half + 1
    const period = dash + gap
    const top = Math.max(0, Math.floor(Math.min(y0, y1) - reach))
    const bottom = Math.min(this.height - 1, Math.ceil(Math.max(y0, y1) + reach))
    const left = Math.min(x0, x1) - reach
    const right = Math.max(x0, x1) + reach
    for (let y = top; y <= bottom; y++) {
      const py = y + 0.5
      // The row's stretch the line can touch.
      let lo = left
      let hi = right
      if (Math.abs(dy) > 1e-6) {
        const xc = x0 + ((py - y0) * dx) / dy
        const spread = (reach * len) / Math.abs(dy)
        lo = Math.max(lo, xc - spread)
        hi = Math.min(hi, xc + spread)
      }
      for (let x = Math.max(0, Math.floor(lo)); x <= Math.min(this.width - 1, Math.ceil(hi)); x++) {
        const px = x + 0.5
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2))
        const ex = px - (x0 + t * dx)
        const ey = py - (y0 + t * dy)
        let a = clamp01(half - Math.sqrt(ex * ex + ey * ey) + 0.5)
        if (a <= 0) continue
        if (period > 0) {
          const s = ((((t * len - phase) % period) + period) % period)
          // Soft dash ends, half a pixel each side.
          a *= clamp01(Math.min(s + 0.5, dash - s + 0.5))
        }
        this.over(x, y, color, alpha * a)
      }
    }
  }

  /**
   * Pixel-font `text` with its top-left at (x, y), each font pixel `scale` pixels square
   * (any size: Scale2x-smoothed, edges anti-aliased). With `outline`, a thin rim in that
   * color keeps it readable over lines and glows.
   */
  text(x: number, y: number, text: string, color: number, scale: number, alpha = 1, outline: number | null = null): void {
    const chars = [...text]
    if (chars.length === 0 || scale <= 0) return
    // The text doubled (Scale2x) as a mask, with a border of one for the rim.
    const mw = chars.length * ADVANCE * 2 + 2
    const mh = GLYPH_H * 2 + 2
    const mask = new Uint8Array(mw * mh)
    chars.forEach((ch, c) => {
      const g = smoothGlyph(ch)
      for (let r = 0; r < GLYPH_H * 2; r++) {
        for (let k = 0; k < GLYPH_W * 2; k++) if (g[r * GLYPH_W * 2 + k]) mask[(r + 1) * mw + c * ADVANCE * 2 + k + 1] = 1
      }
    })
    const unit = scale / 2
    const ox = x - unit
    const oy = y - unit
    if (outline !== null) {
      const rim = new Uint8Array(mw * mh)
      for (let r = 0; r < mh; r++) {
        for (let c = 0; c < mw; c++) {
          if (mask[r * mw + c]) continue
          for (let dr = -1; dr <= 1 && !rim[r * mw + c]; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const rr = r + dr
              const cc = c + dc
              if (rr >= 0 && rr < mh && cc >= 0 && cc < mw && mask[rr * mw + cc]) {
                rim[r * mw + c] = 1
                break
              }
            }
          }
        }
      }
      this.coverage(rim, mw, mh, ox, oy, unit, outline, alpha * 0.7)
    }
    this.coverage(mask, mw, mh, ox, oy, unit, color, alpha)
  }

  /** Lays a mask of `unit`-sized squares at (ox, oy), summing exact coverage so squares meet without seams. */
  private coverage(mask: Uint8Array, mw: number, mh: number, ox: number, oy: number, unit: number, color: number, alpha: number): void {
    const x0 = Math.max(0, Math.floor(ox))
    const y0 = Math.max(0, Math.floor(oy))
    const x1 = Math.min(this.width, Math.ceil(ox + mw * unit))
    const y1 = Math.min(this.height, Math.ceil(oy + mh * unit))
    if (x1 <= x0 || y1 <= y0) return
    const w = x1 - x0
    const cov = new Float32Array(w * (y1 - y0))
    for (let r = 0; r < mh; r++) {
      const top = oy + r * unit
      for (let c = 0; c < mw; c++) {
        if (!mask[r * mw + c]) continue
        const left = ox + c * unit
        for (let py = Math.max(y0, Math.floor(top)); py < Math.min(y1, Math.ceil(top + unit)); py++) {
          const fy = Math.min(py + 1, top + unit) - Math.max(py, top)
          if (fy <= 0) continue
          for (let px = Math.max(x0, Math.floor(left)); px < Math.min(x1, Math.ceil(left + unit)); px++) {
            const fx = Math.min(px + 1, left + unit) - Math.max(px, left)
            if (fx > 0) cov[(py - y0) * w + px - x0] = (cov[(py - y0) * w + px - x0] ?? 0) + fx * fy
          }
        }
      }
    }
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) this.over(px, py, color, alpha * clamp01(cov[(py - y0) * w + px - x0] ?? 0))
    }
  }

  /** PNG scanlines, each a filter byte (0, None) then straight-alpha 8-bit RGBA. */
  scanlines(): Uint8Array {
    const stride = this.width * 4 + 1
    const out = new Uint8Array(stride * this.height)
    this.convert(out, stride, 1)
    return out
  }

  /** Straight-alpha 8-bit RGBA; fully transparent pixels are all zero. */
  rgba(): Uint8Array {
    const out = new Uint8Array(this.width * this.height * 4)
    this.convert(out, this.width * 4, 0)
    return out
  }

  private convert(out: Uint8Array, stride: number, lead: number): void {
    const p = this.px
    for (let y = 0; y < this.height; y++) {
      let o = y * stride + lead
      let i = y * this.width * 4
      for (let x = 0; x < this.width; x++, i += 4, o += 4) {
        const a = p[i + 3] ?? 0
        if (a < 0.002) continue
        const k = 255 / a
        out[o] = Math.min(255, Math.round((p[i] ?? 0) * k))
        out[o + 1] = Math.min(255, Math.round((p[i + 1] ?? 0) * k))
        out[o + 2] = Math.min(255, Math.round((p[i + 2] ?? 0) * k))
        out[o + 3] = Math.min(255, Math.round(a * 255))
      }
    }
  }
}

export { textWidth }
