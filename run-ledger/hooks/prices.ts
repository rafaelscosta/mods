// Dated price table. USD per million tokens, Anthropic first-party API list
// prices as of PRICES_AS_OF. These are API-rate estimates: they are not what a
// Claude subscription is charged, and partner platforms (Bedrock, Vertex)
// price separately. Update the date together with the numbers.

export const PRICES_AS_OF = '2026-09-25'
export const PRICE_SOURCE =
  'Anthropic first-party API list prices (claude-api reference, cached 2026-09-25)'

export type PriceRow = {
  id: string
  input: number
  output: number
  /** 5-minute cache write, 1.25x input (a 1-hour write costs 2x; usage does not say which). */
  cacheWrite: number
  cacheRead: number
  /** true: cache read is the listed price; false: derived as 0.1x input. */
  cacheReadListed: boolean
}

const row = (id: string, input: number, output: number, cacheRead?: number): PriceRow => ({
  id,
  input,
  output,
  cacheWrite: input * 1.25,
  cacheRead: cacheRead ?? input * 0.1,
  cacheReadListed: cacheRead !== undefined,
})

export const PRICES: readonly PriceRow[] = [
  row('claude-fable-5-1', 10, 50, 0.25),
  row('claude-fable-5', 10, 50, 1),
  row('claude-opus-5-5', 4, 20, 0.2),
  row('claude-opus-5', 5, 25),
  row('claude-opus-4-8', 5, 25),
  row('claude-opus-4-7', 5, 25),
  row('claude-opus-4-6', 5, 25),
  row('claude-sonnet-5-5', 2, 10, 0.2),
  row('claude-sonnet-5', 2, 10),
  row('claude-sonnet-4-6', 3, 15),
  row('claude-haiku-4-5', 1, 5),
]

/** What an alias most likely resolves to; a cost priced through it is marked assumed. */
export const ALIASES: readonly { alias: string; id: string }[] = [
  { alias: 'fable', id: 'claude-fable-5-1' },
  { alias: 'opus', id: 'claude-opus-5-5' },
  { alias: 'sonnet', id: 'claude-sonnet-5-5' },
  { alias: 'haiku', id: 'claude-haiku-4-5' },
]

export const DEFAULT_JEV_MODELS: readonly string[] = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-4-5',
]
