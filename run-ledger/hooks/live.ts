// Live output speed per model loop: what each agent is writing right now, measured from the
// streamed chunks of its requests (characters / 4 ≈ tokens). Kept in memory only: it is
// a picture of the moment, not a record, and a reload starts it over.

const BUCKET_MS = 250
const KEEP_MS = 30_000

export type LiveSample = { at: number; tokens: number }

export class LiveRates {
  private readonly samples = new Map<string, LiveSample[]>()

  /** Adds `tokens` written by `loop` at `at`, folded into 250 ms buckets. */
  add(loop: string, at: number, tokens: number): void {
    if (!(tokens > 0)) return
    const list = this.samples.get(loop) ?? []
    const bucket = Math.floor(at / BUCKET_MS) * BUCKET_MS
    const last = list[list.length - 1]
    if (last && last.at === bucket) last.tokens += tokens
    else list.push({ at: bucket, tokens })
    while (list.length > 0 && (list[0]?.at ?? 0) < at - KEEP_MS) list.shift()
    this.samples.set(loop, list)
  }

  /** Tokens per second over the last `windowMs`. */
  rate(loop: string, at: number, windowMs = 3000): number {
    const list = this.samples.get(loop)
    if (!list) return 0
    let sum = 0
    for (const s of list) if (s.at > at - windowMs && s.at <= at) sum += s.tokens
    return sum / (windowMs / 1000)
  }

  /** Tokens per second in each of the last `buckets` seconds, oldest first. */
  series(loop: string, at: number, buckets = 16): number[] {
    const out = new Array<number>(buckets).fill(0)
    const list = this.samples.get(loop)
    if (!list) return out
    const end = Math.floor(at / 1000)
    for (const s of list) {
      const i = buckets - 1 - (end - Math.floor(s.at / 1000))
      if (i >= 0 && i < buckets) out[i] = (out[i] ?? 0) + s.tokens
    }
    return out
  }

  /** Whether `loop` wrote anything in the last `windowMs`. */
  isActive(loop: string, at: number, windowMs = 1500): boolean {
    return this.rate(loop, at, windowMs) > 0
  }
}

/** Halo heartbeat period: 1.6 s at rest, quicker as output speeds up, 0.3 s at 80 tok/s and more. */
export function heartbeat(rate: number): number {
  const r = Math.max(0, Math.min(80, rate))
  return Math.round(1600 - (r / 80) * 1300)
}

// Braille dots of one column filled bottom-up, for 0..4 levels: left column, right column.
const LEFT = [0, 0x40, 0x44, 0x46, 0x47]
const RIGHT = [0, 0x80, 0xa0, 0xb0, 0xb8]

/** A braille sparkline, two values per character, scaled to the largest value. */
export function sparkline(values: readonly number[]): string {
  const top = Math.max(...values, 0)
  const level = (v: number) => (top <= 0 || v <= 0 ? 0 : Math.max(1, Math.round((v / top) * 4)))
  let out = ''
  for (let i = 0; i < values.length; i += 2) {
    const l = LEFT[level(values[i] ?? 0)] ?? 0
    const r = RIGHT[level(values[i + 1] ?? 0)] ?? 0
    out += String.fromCodePoint(0x2800 + l + r)
  }
  return out
}

/** Smoothstep 0..1 of how far `elapsed` is into `duration`. */
export function ease(elapsed: number, duration: number): number {
  const t = Math.max(0, Math.min(1, elapsed / duration))
  return t * t * (3 - 2 * t)
}

/** A value rolling from `from` to `to` like an odometer, `elapsed` ms into `duration`. */
export const rolling = (from: number, to: number, elapsed: number, duration = 700): number => from + (to - from) * ease(elapsed, duration)
