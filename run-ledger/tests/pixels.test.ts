import { describe, expect, test } from 'claude-code/testing'

import type { LedgerContextItem, LedgerPulse } from '../types'
import { Bitmap } from '../hooks/bitmap'
import { GLYPH_H, GLYPH_W, glyph, smoothGlyph } from '../hooks/font'
import { PULSE_MS } from '../hooks/graph'
import type { GraphNode } from '../hooks/graph'
import { drawContextPixels, drawGraphPixels, pixelBox } from '../hooks/pixels'
import { adler32, codeLengths, crc32, deflateRaw, encodePng, scanlines, toBase64 } from '../hooks/png'
import { COLOR, modelColor } from '../hooks/theme'

const ascii = (text: string): Uint8Array => Uint8Array.from(text, c => c.charCodeAt(0))

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

/** A small inflater (RFC 1951: stored, fixed and dynamic blocks), so these tests need no zlib. */
function inflate(data: Uint8Array): Uint8Array {
  let pos = 0
  let bit = 0
  const out: number[] = []
  const bits = (n: number): number => {
    let v = 0
    for (let i = 0; i < n; i++) {
      if (pos >= data.length) throw new Error('ran past the end of the stream')
      v |= (((data[pos] ?? 0) >> bit) & 1) << i
      if (++bit === 8) {
        bit = 0
        pos++
      }
    }
    return v
  }
  type Table = { counts: number[]; symbols: number[] }
  const table = (lengths: readonly number[]): Table => {
    const counts = new Array<number>(16).fill(0)
    for (const l of lengths) counts[l] = (counts[l] ?? 0) + 1
    counts[0] = 0
    const offsets = new Array<number>(16).fill(0)
    for (let i = 1; i < 16; i++) offsets[i] = (offsets[i - 1] ?? 0) + (counts[i - 1] ?? 0)
    const symbols = new Array<number>(lengths.length).fill(0)
    lengths.forEach((l, sym) => {
      if (l === 0) return
      symbols[offsets[l] ?? 0] = sym
      offsets[l] = (offsets[l] ?? 0) + 1
    })
    return { counts, symbols }
  }
  const decode = (t: Table): number => {
    let code = 0
    let first = 0
    let index = 0
    for (let len = 1; len < 16; len++) {
      code |= bits(1)
      const count = t.counts[len] ?? 0
      if (code - count < first) return t.symbols[index + (code - first)] ?? -1
      index += count
      first = (first + count) << 1
      code <<= 1
    }
    throw new Error('no such code')
  }
  let isFinal = 0
  do {
    isFinal = bits(1)
    const type = bits(2)
    if (type === 0) {
      if (bit !== 0) {
        bit = 0
        pos++
      }
      const len = (data[pos] ?? 0) | ((data[pos + 1] ?? 0) << 8)
      pos += 4
      for (let i = 0; i < len; i++) out.push(data[pos++] ?? 0)
      continue
    }
    let lit: Table
    let dist: Table
    if (type === 1) {
      lit = table([...new Array<number>(144).fill(8), ...new Array<number>(112).fill(9), ...new Array<number>(24).fill(7), ...new Array<number>(8).fill(8)])
      dist = table(new Array<number>(30).fill(5))
    } else if (type === 2) {
      const hlit = bits(5) + 257
      const hdist = bits(5) + 1
      const hclen = bits(4) + 4
      const cl = new Array<number>(19).fill(0)
      for (let i = 0; i < hclen; i++) cl[ORDER[i] ?? 0] = bits(3)
      const clTable = table(cl)
      const lengths: number[] = []
      while (lengths.length < hlit + hdist) {
        const sym = decode(clTable)
        if (sym < 16) lengths.push(sym)
        else if (sym === 16) {
          const prev = lengths[lengths.length - 1] ?? 0
          for (let r = 3 + bits(2); r > 0; r--) lengths.push(prev)
        } else if (sym === 17) for (let r = 3 + bits(3); r > 0; r--) lengths.push(0)
        else for (let r = 11 + bits(7); r > 0; r--) lengths.push(0)
      }
      lit = table(lengths.slice(0, hlit))
      dist = table(lengths.slice(hlit))
    } else throw new Error('reserved block type')
    for (;;) {
      const sym = decode(lit)
      if (sym < 256) out.push(sym)
      else if (sym === 256) break
      else {
        const li = sym - 257
        const len = (LEN_BASE[li] ?? 0) + bits(LEN_EXTRA[li] ?? 0)
        const di = decode(dist)
        const d = (DIST_BASE[di] ?? 0) + bits(DIST_EXTRA[di] ?? 0)
        if (d > out.length) throw new Error('distance reaches before the start')
        for (let i = 0; i < len; i++) out.push(out[out.length - d] ?? 0)
      }
    }
  } while (isFinal === 0)
  return Uint8Array.from(out)
}

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i])

/** Opaque-ish pixels within `tolerance` of `color` on every channel. */
function countNear(rgba: Uint8Array, color: number, tolerance = 28): number {
  let n = 0
  for (let i = 0; i < rgba.length; i += 4) {
    if ((rgba[i + 3] ?? 0) < 160) continue
    const dr = Math.abs((rgba[i] ?? 0) - ((color >>> 16) & 0xff))
    const dg = Math.abs((rgba[i + 1] ?? 0) - ((color >>> 8) & 0xff))
    const db = Math.abs((rgba[i + 2] ?? 0) - (color & 0xff))
    if (dr <= tolerance && dg <= tolerance && db <= tolerance) n++
  }
  return n
}

const node = (patch: Partial<GraphNode> & Pick<GraphNode, 'id' | 'parentId' | 'label' | 'model' | 'status'>): GraphNode => ({
  startedAt: null, endedAt: null, contextTokens: null, rate: 0, ...patch,
})

const T0 = 1_000_000
const OPUS = 'claude-opus-5-5'
const HAIKU = 'claude-haiku-4-5'

describe('png', () => {
  test('checksums match their reference values', () => {
    expect(crc32(ascii('123456789'))).toBe(0xcbf43926)
    expect(adler32(ascii('Wikipedia'))).toBe(0x11e60398)
  })

  test('deflate round-trips: nothing, runs, repeats, noise and a real frame', () => {
    let seed = 7
    const noise = Uint8Array.from({ length: 6000 }, () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24)
    const frame = drawGraphPixels(
      [node({ id: 'main', parentId: null, label: 'main', model: OPUS, status: 'running', rate: 30 }), node({ id: 'a', parentId: 'main', label: 'executor', model: HAIKU, status: 'running', startedAt: T0 })],
      [],
      T0 + 400,
      30,
      10,
      1,
    ).scanlines()
    const inputs = [new Uint8Array(0), Uint8Array.of(42), new Uint8Array(70_000), ascii('abcabcabcabcabcabcabd'.repeat(300)), noise, frame]
    for (const input of inputs) expect(same(inflate(deflateRaw(input)), input), `${input.length} bytes`).toBe(true)
    expect(deflateRaw(new Uint8Array(70_000)).length).toBeLessThan(400)
  })

  test('code lengths stay within the limit and make a complete code', () => {
    const fib = [1, 1]
    while (fib.length < 25) fib.push((fib[fib.length - 1] ?? 0) + (fib[fib.length - 2] ?? 0))
    const lengths = [...codeLengths(fib, 7)]
    expect(Math.max(...lengths)).toBeLessThanOrEqual(7)
    expect(lengths.reduce((sum, l) => sum + (l > 0 ? 2 ** -l : 0), 0)).toBe(1)
    // One symbol in use still makes a complete code: a second one is added.
    expect([...codeLengths([0, 0, 5], 15)].filter(l => l === 1).length).toBe(2)
  })

  test('a PNG file: signature, header, checksummed chunks and the pixels back', () => {
    const rgba = Uint8Array.from({ length: 3 * 2 * 4 }, (_, i) => (i * 37) & 0xff)
    const png = encodePng(rgba, 3, 2)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const view = new DataView(png.buffer, png.byteOffset, png.length)
    const chunks: { type: string; data: Uint8Array }[] = []
    for (let at = 8; at < png.length; ) {
      const len = view.getUint32(at)
      const type = String.fromCharCode(...png.subarray(at + 4, at + 8))
      expect(view.getUint32(at + 8 + len), `${type} checksum`).toBe(crc32(png, at + 4, at + 8 + len))
      chunks.push({ type, data: png.subarray(at + 8, at + 8 + len) })
      at += len + 12
    }
    expect(chunks.map(c => c.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    const ihdr = chunks[0]?.data ?? new Uint8Array(13)
    const head = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.length)
    expect([head.getUint32(0), head.getUint32(4), ihdr[8], ihdr[9]]).toEqual([3, 2, 8, 6])
    const idat = chunks[1]?.data ?? new Uint8Array(0)
    expect((((idat[0] ?? 0) << 8) | (idat[1] ?? 0)) % 31).toBe(0)
    const rows = inflate(idat.subarray(2, idat.length - 4))
    expect(same(rows, scanlines(rgba, 3, 2))).toBe(true)
    const tail = new DataView(idat.buffer, idat.byteOffset + idat.length - 4, 4)
    expect(tail.getUint32(0)).toBe(adler32(rows))
  })

  test('base64 matches btoa', () => {
    for (let n = 0; n < 10; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 91 + n * 13) & 0xff)
      expect(toBase64(bytes)).toBe(btoa(String.fromCharCode(...bytes)))
    }
  })
})

describe('pixel pictures', () => {
  test('a picture is sized from its cells and the density, no side past 2048', () => {
    expect(pixelBox(52, 16, 2)).toEqual({ width: 936, height: 640, unit: 2, scale: 3 })
    const wide = pixelBox(255, 4, 2)
    expect(wide.width).toBeLessThanOrEqual(2048)
    // Shrunk to fit, a cell keeps its shape.
    expect(Math.abs(wide.height / 4 / (wide.width / 255) - 20 / 9)).toBeLessThan(0.05)
  })

  test('nodes glow in their model colour on a transparent background', () => {
    const nodes = [
      node({ id: 'main', parentId: null, label: 'main', model: OPUS, status: 'main' }),
      node({ id: 'a', parentId: 'main', label: 'executor', model: HAIKU, status: 'running', startedAt: T0 }),
    ]
    const b = drawGraphPixels(nodes, [], T0 + 5000, 40, 12, 1)
    const rgba = b.rgba()
    expect(rgba[3]).toBe(0)
    expect(countNear(rgba, modelColor(HAIKU))).toBeGreaterThan(30)
    expect(countNear(rgba, modelColor(OPUS))).toBeGreaterThan(30)
  })

  test('a route packet shines mid-flight and is gone once it lands', () => {
    const nodes = [
      node({ id: 'main', parentId: null, label: 'main', model: OPUS, status: 'main' }),
      node({ id: 'a', parentId: 'main', label: 'executor', model: HAIKU, status: 'done', startedAt: T0 - 9000, endedAt: T0 - 5000 }),
    ]
    const pulse: LedgerPulse = { id: 'p', from: 'main', to: 'a', kind: 'route', at: T0 }
    const pink = (at: number) => countNear(drawGraphPixels(nodes, [pulse], at, 40, 12, 1).rgba(), COLOR.accent)
    expect(pink(T0 + PULSE_MS / 2)).toBeGreaterThan(10)
    expect(pink(T0 + PULSE_MS + 50)).toBe(0)
  })

  test("a running agent's halo moves; a settled graph holds still", () => {
    const frame = (status: GraphNode['status'], at: number) =>
      drawGraphPixels(
        [node({ id: 'main', parentId: null, label: 'main', model: OPUS, status: 'main' }), node({ id: 'a', parentId: 'main', label: 'x', model: HAIKU, status, startedAt: T0 - 9000, endedAt: status === 'running' ? null : T0 - 5000, rate: 20 })],
        [],
        at,
        40,
        12,
        1,
      ).rgba()
    expect(same(frame('running', T0), frame('running', T0 + 300))).toBe(false)
    expect(same(frame('done', T0), frame('done', T0 + 300))).toBe(true)
  })

  test('labels: Scale2x rounds diagonals, keeps straight strokes, and gets a rim', () => {
    const lit = (mask: ArrayLike<number>) => Array.from(mask).filter(v => v !== 0).length
    const plainLit = (ch: string) => [...glyph(ch)].reduce((sum, row) => sum + lit([...Array(GLYPH_W)].map((_, b) => (row >> b) & 1)), 0)
    expect(smoothGlyph('/').length).toBe(GLYPH_W * GLYPH_H * 4)
    expect(lit(smoothGlyph('/'))).toBeGreaterThan(4 * plainLit('/'))
    expect(lit(smoothGlyph('|'))).toBe(4 * plainLit('|'))
    const b = new Bitmap(60, 24)
    b.text(2, 2, 'Hi', 0xffffff, 2, 1, 0x000000)
    const rgba = b.rgba()
    expect(countNear(rgba, 0xffffff, 10)).toBeGreaterThan(20)
    expect(countNear(rgba, 0x000000, 10)).toBeGreaterThan(20)
  })

  test('the band draws each piece in its loop colour', () => {
    const items: LedgerContextItem[] = [
      { id: 'c1', runId: 'r', agentId: null, kind: 'read', label: 'README.md', path: null, tokens: 10, fromAgentId: null, at: T0 },
      { id: 'c2', runId: 'r', agentId: 'a', kind: 'handoff', label: '→ executor', path: null, tokens: 10, fromAgentId: 'main', at: T0 + 100 },
    ]
    const agents = [{ ...emptyAgent(), id: 'a', actualModel: HAIKU }]
    const rgba = drawContextPixels(items, agents, OPUS, T0 + 9000, 60, 4, 1).rgba()
    expect(countNear(rgba, modelColor(OPUS))).toBeGreaterThan(5)
    expect(countNear(rgba, modelColor(HAIKU))).toBeGreaterThan(5)
  })
})

function emptyAgent() {
  return {
    id: '', runId: 'r', parentId: null, type: 'Explore', description: '', spawnedBy: null, provider: null, background: false,
    requestedModel: null, recommendationId: null, recommendedModel: null, routed: false, actualModel: null, status: 'running' as const,
    lastAction: null, contextTokens: null, startedAt: T0, endedAt: null, result: null,
  }
}
