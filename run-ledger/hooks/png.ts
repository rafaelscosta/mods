// A PNG encoder in plain JavaScript (the hooks environment has no zlib): RGBA rows with
// filter None (on these mostly transparent pictures no filter compresses better), deflated
// with LZ77 over hash chains and one dynamic Huffman block.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 5552)
    for (; i < end; i++) {
      a += bytes[i] ?? 0
      b += a
    }
    a %= 65521
    b %= 65521
  }
  return ((b << 16) | a) >>> 0
}

/** LSB-first bit writer into a growing buffer. */
class Bits {
  buf: Uint8Array
  pos = 0
  private acc = 0
  private count = 0
  constructor(size: number) {
    this.buf = new Uint8Array(Math.max(64, size))
  }
  private room(n: number): void {
    if (this.pos + n <= this.buf.length) return
    const bigger = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n))
    bigger.set(this.buf.subarray(0, this.pos))
    this.buf = bigger
  }
  write(value: number, n: number): void {
    this.acc |= value << this.count
    this.count += n
    while (this.count >= 8) {
      this.room(1)
      this.buf[this.pos++] = this.acc & 0xff
      this.acc >>>= 8
      this.count -= 8
    }
  }
  flush(): void {
    if (this.count > 0) {
      this.room(1)
      this.buf[this.pos++] = this.acc & 0xff
    }
    this.acc = 0
    this.count = 0
  }
  bytes(raw: Uint8Array): void {
    this.room(raw.length)
    this.buf.set(raw, this.pos)
    this.pos += raw.length
  }
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

// Length 3..258 -> index into LEN_BASE; distance 1..32768 -> index into DIST_BASE.
const LEN_CODE = (() => {
  const t = new Uint8Array(259)
  for (let c = 0; c < LEN_BASE.length; c++) {
    const base = LEN_BASE[c] ?? 0
    const top = c === LEN_BASE.length - 1 ? 258 : base + (1 << (LEN_EXTRA[c] ?? 0)) - 1
    for (let l = base; l <= top && l <= 258; l++) t[l] = c
  }
  t[258] = 28
  return t
})()
const DIST_CODE = (() => {
  const t = new Uint8Array(32769)
  for (let c = 0; c < DIST_BASE.length; c++) {
    const base = DIST_BASE[c] ?? 1
    const top = base + (1 << (DIST_EXTRA[c] ?? 0)) - 1
    for (let d = base; d <= top && d <= 32768; d++) t[d] = c
  }
  return t
})()

/**
 * Huffman code lengths for `freq`, none longer than `limit`. A tree with fewer than two
 * symbols in use gets a second one, so every tree is complete.
 */
export function codeLengths(freq: ArrayLike<number>, limit: number): Uint8Array {
  const n = freq.length
  const lengths = new Uint8Array(n)
  const used: number[] = []
  for (let i = 0; i < n; i++) if ((freq[i] ?? 0) > 0) used.push(i)
  if (used.length === 0) used.push(0)
  if (used.length === 1) used.push(used[0] === 0 ? 1 : 0)
  const weight = (s: number) => Math.max(1, freq[s] ?? 0)
  used.sort((a, b) => weight(a) - weight(b) || a - b)
  // Two-queue Huffman: leaves in order, merged nodes come out in order too.
  const m = used.length
  const w = new Float64Array(2 * m)
  const parent = new Int32Array(2 * m).fill(-1)
  for (let i = 0; i < m; i++) w[i] = weight(used[i] ?? 0)
  let leaf = 0
  let node = m
  let made = m
  const take = (): number => (leaf < m && (node >= made || (w[leaf] ?? 0) <= (w[node] ?? 0)) ? leaf++ : node++)
  while (made < 2 * m - 1) {
    const a = take()
    const b = take()
    w[made] = (w[a] ?? 0) + (w[b] ?? 0)
    parent[a] = made
    parent[b] = made
    made++
  }
  const depth = new Int32Array(2 * m)
  for (let i = 2 * m - 3; i >= 0; i--) depth[i] = (depth[parent[i] ?? 0] ?? 0) + 1
  // Counts per length, then pushed under the limit (JPEG Annex K.3), then handed out by frequency.
  const counts = new Int32Array(Math.max(limit, 2 * m) + 2)
  for (let i = 0; i < m; i++) counts[depth[i] ?? 0] = (counts[depth[i] ?? 0] ?? 0) + 1
  for (let len = counts.length - 1; len > limit; len--) {
    while ((counts[len] ?? 0) > 0) {
      let j = len - 2
      while (j > 0 && (counts[j] ?? 0) === 0) j--
      counts[len] = (counts[len] ?? 0) - 2
      counts[len - 1] = (counts[len - 1] ?? 0) + 1
      counts[j + 1] = (counts[j + 1] ?? 0) + 2
      counts[j] = (counts[j] ?? 0) - 1
    }
  }
  // Most frequent symbols take the shortest codes.
  let k = m - 1
  for (let len = 1; len <= limit; len++) {
    for (let c = counts[len] ?? 0; c > 0; c--) lengths[used[k--] ?? 0] = len
  }
  return lengths
}

/** Canonical codes for `lengths`, bit-reversed for an LSB-first writer. */
function canonical(lengths: Uint8Array): Uint16Array {
  const maxLen = Math.max(1, ...lengths)
  const count = new Uint16Array(maxLen + 1)
  for (const l of lengths) if (l > 0) count[l] = (count[l] ?? 0) + 1
  const next = new Uint16Array(maxLen + 2)
  let code = 0
  for (let len = 1; len <= maxLen; len++) {
    code = (code + (count[len - 1] ?? 0)) << 1
    next[len] = code
  }
  const codes = new Uint16Array(lengths.length)
  for (let s = 0; s < lengths.length; s++) {
    const len = lengths[s] ?? 0
    if (len === 0) continue
    let c = next[len] ?? 0
    next[len] = c + 1
    let r = 0
    for (let b = 0; b < len; b++) {
      r = (r << 1) | (c & 1)
      c >>= 1
    }
    codes[s] = r
  }
  return codes
}

const MIN_MATCH = 3
const MAX_MATCH = 258
const WINDOW = 32768
const HASH_BITS = 15
const MAX_CHAIN = 16
const NICE = 96
// A run this long of the byte (or pixel) before is taken without a search.
const RUN_TAKEN = 12
// Positions inside a longer match are not hashed: in long runs they only lengthen chains.
const MAX_INSERT = 32

// Work buffers kept between frames, grown when a picture needs more.
const scratch = { lens: new Uint16Array(0), vals: new Uint16Array(0), head: new Int32Array(1 << HASH_BITS), prev: new Int32Array(WINDOW) }

/** Raw deflate (RFC 1951) of `data`: LZ77 then one dynamic Huffman block. */
export function deflateRaw(data: Uint8Array): Uint8Array {
  const n = data.length
  // LZ77 into parallel arrays: lens[i] 0 for a literal (vals[i] the byte), else a match of lens[i] at distance vals[i].
  if (scratch.lens.length < n + 1) {
    scratch.lens = new Uint16Array(n + 1)
    scratch.vals = new Uint16Array(n + 1)
  }
  const { lens, vals, head, prev } = scratch
  head.fill(-1)
  let count = 0
  const hashAt = (i: number): number =>
    ((((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0)) * 2654435761) >>> (32 - HASH_BITS)
  const insert = (i: number): void => {
    const h = hashAt(i)
    prev[i & (WINDOW - 1)] = head[h] ?? -1
    head[h] = i
  }
  let i = 0
  while (i < n) {
    // Transparent space and flat colour: a run of the byte before (distance 1) or the pixel before (4).
    if (i >= 4) {
      const cap = Math.min(MAX_MATCH, n - i)
      let one = 0
      while (one < cap && data[i + one] === data[i - 1]) one++
      let four = 0
      if (one < RUN_TAKEN) while (four < cap && data[i + four] === data[i + four - 4]) four++
      const run = Math.max(one, four)
      if (run >= RUN_TAKEN) {
        lens[count] = run
        vals[count++] = one >= four ? 1 : 4
        i += run
        if (i + MIN_MATCH <= n) insert(i - 1)
        continue
      }
    }
    let best = 0
    let dist = 0
    if (i + MIN_MATCH <= n) {
      const h = hashAt(i)
      let cand = head[h] ?? -1
      let chain = MAX_CHAIN
      const limit = Math.min(MAX_MATCH, n - i)
      while (cand >= 0 && i - cand <= WINDOW && chain-- > 0) {
        if (data[cand + best] === data[i + best] && data[cand] === data[i]) {
          let len = 0
          while (len < limit && data[cand + len] === data[i + len]) len++
          if (len > best) {
            best = len
            dist = i - cand
            if (len >= NICE || len === limit) break
          }
        }
        const back = prev[cand & (WINDOW - 1)] ?? -1
        if (back >= cand) break
        cand = back
      }
      prev[i & (WINDOW - 1)] = head[h] ?? -1
      head[h] = i
    }
    if (best >= MIN_MATCH) {
      lens[count] = best
      vals[count++] = dist
      const end = i + best
      if (best <= MAX_INSERT) for (let j = i + 1; j < end && j + MIN_MATCH <= n; j++) insert(j)
      else if (end - 1 + MIN_MATCH <= n) insert(end - 1)
      i = end
    } else {
      lens[count] = 0
      vals[count++] = data[i] ?? 0
      i++
    }
  }

  const litFreq = new Uint32Array(286)
  const distFreq = new Uint32Array(30)
  for (let s = 0; s < count; s++) {
    const len = lens[s] ?? 0
    if (len === 0) litFreq[vals[s] ?? 0] = (litFreq[vals[s] ?? 0] ?? 0) + 1
    else {
      const lc = 257 + (LEN_CODE[len] ?? 0)
      litFreq[lc] = (litFreq[lc] ?? 0) + 1
      const dc = DIST_CODE[vals[s] ?? 1] ?? 0
      distFreq[dc] = (distFreq[dc] ?? 0) + 1
    }
  }
  litFreq[256] = 1
  const litLen = codeLengths(litFreq, 15)
  const distLen = codeLengths(distFreq, 15)
  let hlit = 286
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--
  let hdist = 30
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--

  // Code lengths of both trees, run-length coded with 16/17/18.
  const all = [...litLen.subarray(0, hlit), ...distLen.subarray(0, hdist)]
  const clSyms: number[] = []
  const clExtra: number[] = []
  for (let p = 0; p < all.length; ) {
    const v = all[p] ?? 0
    let run = 1
    while (p + run < all.length && all[p + run] === v) run++
    if (v === 0 && run >= 3) {
      const r = Math.min(run, 138)
      if (r >= 11) {
        clSyms.push(18)
        clExtra.push(r - 11)
      } else {
        clSyms.push(17)
        clExtra.push(r - 3)
      }
      p += r
    } else if (v !== 0 && run >= 4) {
      clSyms.push(v)
      clExtra.push(0)
      const r = Math.min(run - 1, 6)
      clSyms.push(16)
      clExtra.push(r - 3)
      p += r + 1
    } else {
      clSyms.push(v)
      clExtra.push(0)
      p += 1
    }
  }
  const clFreq = new Uint32Array(19)
  for (const sym of clSyms) clFreq[sym] = (clFreq[sym] ?? 0) + 1
  const clLen = codeLengths(clFreq, 7)
  let hclen = 19
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1] ?? 0] === 0) hclen--

  const litCodes = canonical(litLen)
  const distCodes = canonical(distLen)
  const clCodes = canonical(clLen)
  const out = new Bits((n >>> 3) + 1024)
  out.write(1, 1) // final block
  out.write(2, 2) // dynamic Huffman
  out.write(hlit - 257, 5)
  out.write(hdist - 1, 5)
  out.write(hclen - 4, 4)
  for (let k = 0; k < hclen; k++) out.write(clLen[CL_ORDER[k] ?? 0] ?? 0, 3)
  for (let k = 0; k < clSyms.length; k++) {
    const sym = clSyms[k] ?? 0
    out.write(clCodes[sym] ?? 0, clLen[sym] ?? 0)
    if (sym === 16) out.write(clExtra[k] ?? 0, 2)
    else if (sym === 17) out.write(clExtra[k] ?? 0, 3)
    else if (sym === 18) out.write(clExtra[k] ?? 0, 7)
  }
  for (let s = 0; s < count; s++) {
    const len = lens[s] ?? 0
    const v = vals[s] ?? 0
    if (len === 0) {
      out.write(litCodes[v] ?? 0, litLen[v] ?? 0)
      continue
    }
    const lc = LEN_CODE[len] ?? 0
    out.write(litCodes[257 + lc] ?? 0, litLen[257 + lc] ?? 0)
    const le = LEN_EXTRA[lc] ?? 0
    if (le > 0) out.write(len - (LEN_BASE[lc] ?? 0), le)
    const dc = DIST_CODE[v] ?? 0
    out.write(distCodes[dc] ?? 0, distLen[dc] ?? 0)
    const de = DIST_EXTRA[dc] ?? 0
    if (de > 0) out.write(v - (DIST_BASE[dc] ?? 0), de)
  }
  out.write(litCodes[256] ?? 0, litLen[256] ?? 0)
  out.flush()
  return out.buf.subarray(0, out.pos)
}

/** A zlib stream (RFC 1950) of `data`. */
export function zlib(data: Uint8Array): Uint8Array {
  const body = deflateRaw(data)
  const out = new Uint8Array(body.length + 6)
  out[0] = 0x78
  out[1] = 0x01
  out.set(body, 2)
  const sum = adler32(data)
  out[out.length - 4] = sum >>> 24
  out[out.length - 3] = (sum >>> 16) & 0xff
  out[out.length - 2] = (sum >>> 8) & 0xff
  out[out.length - 1] = sum & 0xff
  return out
}

/** PNG scanlines of straight RGBA: each row a filter byte (0, None) then its pixels. */
export function scanlines(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4
  const out = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) out.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  return out
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length))
  return out
}

/** A whole PNG file of `width` x `height` straight-alpha RGBA pixels. */
export const encodePng = (rgba: Uint8Array, width: number, height: number): Uint8Array =>
  pngOfScanlines(scanlines(rgba, width, height), width, height)

/** A whole PNG file from ready scanlines (see `scanlines`). */
export function pngOfScanlines(rows: Uint8Array, width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib(rows)),
    chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const B64 = Uint8Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', c => c.charCodeAt(0))
const ASCII = new TextDecoder()

/** Base64 of `bytes`. */
export function toBase64(bytes: Uint8Array): string {
  const n = bytes.length
  const out = new Uint8Array(Math.ceil(n / 3) * 4)
  let o = 0
  let i = 0
  for (; i + 2 < n; i += 3) {
    const v = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out[o++] = B64[v >>> 18] ?? 0
    out[o++] = B64[(v >>> 12) & 63] ?? 0
    out[o++] = B64[(v >>> 6) & 63] ?? 0
    out[o++] = B64[v & 63] ?? 0
  }
  if (i < n) {
    const v = ((bytes[i] ?? 0) << 16) | (i + 1 < n ? (bytes[i + 1] ?? 0) << 8 : 0)
    out[o++] = B64[v >>> 18] ?? 0
    out[o++] = B64[(v >>> 12) & 63] ?? 0
    out[o++] = i + 1 < n ? (B64[(v >>> 6) & 63] ?? 0) : 61
    out[o++] = 61
  }
  return ASCII.decode(out)
}
