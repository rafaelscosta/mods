// Colours and model naming shared by the terminal and SVG drawings.

import { PRICES } from './prices'

export type ModelFamily = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'other'

type Palette = {
  fable: number
  opus: number
  sonnet: number
  haiku: number
  other: number
  accent: number
  text: number
  muted: number
  dim: number
  ok: number
  bad: number
  /** The background the drawings fade toward; the terminal's, as near as the theme guesses. */
  bg: number
}

/** How much light the pictures throw: glow strength, halo rings around a running agent. */
type Look = { glow: number; rings: number }

export type ThemeName = 'neon' | 'minimal' | 'contrast' | 'light'
export const THEME_NAMES: readonly ThemeName[] = ['neon', 'minimal', 'contrast', 'light']

const THEMES: { [T in ThemeName]: { palette: Palette; look: Look } } = {
  neon: {
    palette: { fable: 0xb48cff, opus: 0xe8875b, sonnet: 0xe9b44c, haiku: 0x4fc3a1, other: 0x8fa3ff, accent: 0xe0559f, text: 0xdcdfe4, muted: 0x8b919c, dim: 0x4b505a, ok: 0x7cc49a, bad: 0xe06c75, bg: 0x1e1f22 },
    look: { glow: 1, rings: 2 },
  },
  minimal: {
    palette: { fable: 0x9d8ccf, opus: 0xc9896d, sonnet: 0xc9a764, haiku: 0x6aa894, other: 0x8b97c4, accent: 0xb07a96, text: 0xd0d3d8, muted: 0x80858f, dim: 0x3f434b, ok: 0x88b09a, bad: 0xc07c82, bg: 0x1e1f22 },
    look: { glow: 0.25, rings: 1 },
  },
  contrast: {
    palette: { fable: 0xd0a8ff, opus: 0xff9d5c, sonnet: 0xffd23f, haiku: 0x3ff0c0, other: 0xa0b4ff, accent: 0xff4fb0, text: 0xffffff, muted: 0xc8ccd4, dim: 0x80868f, ok: 0x6cf0a0, bad: 0xff6070, bg: 0x000000 },
    look: { glow: 0.6, rings: 2 },
  },
  light: {
    palette: { fable: 0x7c4ddb, opus: 0xc4501c, sonnet: 0xa86f00, haiku: 0x0f8a6c, other: 0x4a5fc4, accent: 0xc2257a, text: 0x1f2328, muted: 0x59636e, dim: 0xc5cad1, ok: 0x1a7f45, bad: 0xc4303e, bg: 0xffffff },
    look: { glow: 0.5, rings: 2 },
  },
}

/** 0x00RRGGBB, the current theme's; `applyTheme` changes them in place, so every drawing follows. */
export const COLOR: Palette = { ...THEMES.neon.palette }
export const LOOK: Look = { ...THEMES.neon.look }
let current: ThemeName = 'neon'

export function applyTheme(name: ThemeName): void {
  Object.assign(COLOR, THEMES[name].palette)
  Object.assign(LOOK, THEMES[name].look)
  current = name
}

export const currentTheme = (): ThemeName => current

/**
 * The theme to use: the one set, or with `auto` the light theme where the terminal says its
 * background is light (`COLORFGBG`, e.g. `0;15`), else neon.
 */
export function themeFrom(setting: string, colorFgBg: string | undefined): ThemeName {
  const named = THEME_NAMES.find(t => t === setting)
  if (named) return named
  const bg = Number((colorFgBg ?? '').split(';').pop())
  return bg === 7 || bg === 15 ? 'light' : 'neon'
}

/** The terminal's own colour, for a Raster cell. */
export const DEFAULT_COLOR = 0x01000000

export const hex = (c: number): string => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`

/** a toward b by t (0..1), per channel. */
export function mix(a: number, b: number, t: number): number {
  const ch = (shift: number) => {
    const x = (a >> shift) & 0xff
    const y = (b >> shift) & 0xff
    return Math.round(x + (y - x) * t) & 0xff
  }
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

export function familyOf(model: string | null): ModelFamily {
  const m = (model ?? '').toLowerCase()
  if (m.includes('fable') || m.includes('mythos')) return 'fable'
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  return 'other'
}

export const modelColor = (model: string | null): number => (model === null ? COLOR.muted : COLOR[familyOf(model)])

/** Capability order of the model lines: Haiku < Sonnet < Opus < Fable. */
export const FAMILY_TIER: { [F in ModelFamily]: number } = { fable: 4, opus: 3, sonnet: 2, haiku: 1, other: 0 }

/** `claude-opus-5-5` -> `opus-5.5`, `us.anthropic.claude-haiku-4-5-20251001-v1:0` -> `haiku-4.5`. */
export function shortModel(model: string | null): string {
  if (model === null) return 'unknown'
  let id = model.trim().toLowerCase()
  const at = id.indexOf('claude-')
  if (at >= 0) id = id.slice(at + 'claude-'.length)
  id = id.replace(/\[.*\]$/, '').replace(/@.*$/, '').replace(/-v\d+(:\d+)?$/, '').replace(/-\d{8}$/, '')
  return id.replace(/-(\d+)-(\d+)$/, '-$1.$2')
}

/** Context window in tokens of a model in the price table; null when unknown. */
export function windowOf(model: string): number | null {
  const id = model.trim().toLowerCase()
  const row = PRICES.find(p => id === p.id || id.startsWith(`${p.id}-`) || id.startsWith(`${p.id}[`))
  if (!row) return null
  return row.id.startsWith('claude-haiku') ? 200_000 : 1_000_000
}
