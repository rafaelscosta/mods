import { atom, read, update } from 'claude-code'
import type { AgentSpawnInput, EngineInterface, PluginOptions, Register, RenderElement, TurnStepResult } from 'claude-code'

import type { Ledger, LedgerContextFill, LedgerCost, LedgerHistoryEntry, LedgerRecommendation, LedgerReplay } from '../types'
import type { Bitmap } from './bitmap'
import { CARD_WIDTH, agentCard, cardsFor, mainCard, wrapCard } from './cards'
import { contextLabel, contextOf, contextSvg, drawContext, FRESH_MS } from './context'
import { DEMO_MS, DEMO_RUN, demoLedger, demoRate } from './demo'
import { BURST_MS, INTRO_MS, PULSE_MS, SPAWN_MS, cellHitboxes, drawGraph, graphNodes, graphSvg, isAnimating, layoutTree, roleName, within } from './graph'
import type { GraphNode } from './graph'
import { LiveRates, rolling, sparkline } from './live'
import {
  UNATTRIBUTED,
  addItem,
  addPulse,
  addRecommendation,
  agentCost,
  approxTokens,
  availableModels,
  buildJevRequest,
  bumpAttempt,
  cleanLabel,
  closedByPerson,
  decisionFor,
  describeToolCall,
  emptyLedger,
  ensureRun,
  estimateCost,
  exportCsv,
  exportDocument,
  formatSavings,
  formatTokens,
  formatTotal,
  fromApiUsage,
  isEligibleForAuto,
  listOption,
  nextId,
  normalizeLedger,
  parseHandback,
  parseHistory,
  parseJevAnswer,
  patchAgent,
  patchItem,
  patchRecommendation,
  patchRun,
  producerOf,
  reconcile,
  recordRequest,
  resultLine,
  runOfAgent,
  savingsVs,
  statusFromReason,
  totals,
  upsertAgent,
  upsertRun,
} from './ledger'
import type { ApiUsage } from './ledger'
import type { OverlayProps } from './overlay'
import { drawContextPixels, drawGraphPixels, pixelHitboxes } from './pixels'
import { pngOfScanlines, toBase64 } from './png'
import { receiptLines } from './receipt'
import { advanceReplay, clock, ledgerAt, replayEvents, stepReplay } from './replay'
import { ROLE_PREFIX, ROLES, localDecision } from './router'
import { COLOR, THEME_NAMES, applyTheme, currentTheme, hex, shortModel, themeFrom } from './theme'
import { timelineView } from './timeline'
import { decisionCard, fillLine, header, ledgerView, liveRun, roster, routerName, spawns } from './view'
import type { HeaderActions, Motion, ReplayInfo, ViewSettings } from './view'

const PANE = 'run-ledger'
const HISTORY_KEY = 'history'
const MAX_HISTORY = 200
const BAND_LINGER_MS = 120_000
const BAND_RASTER_ROWS = 4

const ledgerAtom = atom({ plugin: 'run-ledger', key: 'ledger' } as const, emptyLedger())
const selectedAtom = atom({ plugin: 'run-ledger', key: 'selected' } as const, null)
const nowAtom = atom({ plugin: 'run-ledger', key: 'now' } as const, 0)
const viewAtom = atom({ plugin: 'run-ledger', key: 'view' } as const, 'live')
const fillAtom = atom({ plugin: 'run-ledger', key: 'fill' } as const, null)
const OFF: LedgerReplay = { runId: null, at: null, isPlaying: false }
const replayAtom = atom({ plugin: 'run-ledger', key: 'replay' } as const, OFF)
const demoAtom = atom({ plugin: 'run-ledger', key: 'demo' } as const, null)
const autoOpenSpentAtom = atom({ plugin: 'run-ledger', key: 'autoOpenSpent' } as const, false)
const NO_PENDING: string[] = []
const pendingReceiptsAtom = atom({ plugin: 'run-ledger', key: 'pendingReceipts' } as const, NO_PENDING)
const MAX_PENDING_RECEIPTS = 50

type Settings = {
  jevEndpoint: string
  routing: 'recommend' | 'auto'
  autoRouteTypes: string[]
  jevModels: string[]
  budgetUsd: number
  jevTimeoutMs: number
  roles: boolean
  band: 'auto' | 'always' | 'off'
  logDecisions: boolean
  autoOpen: boolean
  baselineModel: string
  graphics: 'auto' | 'pixels' | 'braille'
  pixelDensity: number
  theme: string
  receipt: 'subagents' | 'always' | 'off'
  sound: boolean
  intro: boolean
}

function settingsOf(options: PluginOptions): Settings {
  const text = (v: PluginOptions[string] | undefined): string => (typeof v === 'string' ? v : '')
  const num = (v: PluginOptions[string] | undefined, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
  const flag = (v: PluginOptions[string] | undefined, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
  const band = text(options.band)
  const graphics = text(options.graphics)
  const receipt = text(options.receipt)
  const theme = text(options.theme)
  return {
    jevEndpoint: text(options.jevEndpoint).trim(),
    routing: text(options.routing) === 'auto' ? 'auto' : 'recommend',
    autoRouteTypes: listOption(text(options.autoRouteTypes), []),
    jevModels: availableModels(text(options.jevModels)),
    budgetUsd: num(options.budgetUsd, 0),
    jevTimeoutMs: Math.max(250, num(options.jevTimeoutMs, 4000)),
    roles: flag(options.roles, false),
    band: band === 'always' || band === 'off' ? band : 'auto',
    logDecisions: flag(options.logDecisions, true),
    autoOpen: flag(options.autoOpen, true),
    baselineModel: text(options.baselineModel).trim() || 'claude-opus-5-5',
    graphics: graphics === 'pixels' || graphics === 'braille' ? graphics : 'auto',
    pixelDensity: Math.max(1, Math.min(3, num(options.pixelDensity, 2) || 2)),
    theme: THEME_NAMES.some(t => t === theme) ? theme : 'auto',
    receipt: receipt === 'always' || receipt === 'off' ? receipt : 'subagents',
    sound: flag(options.sound, false),
    intro: flag(options.intro, true),
  }
}

const roleTypes = (): string[] => ROLES.map(r => `${ROLE_PREFIX}${r.role}`)

const fieldsOf = (value: object): { [field: string]: unknown } => Object.fromEntries(Object.entries(value))

/** Where a prompt came from, as a run's `source`: the person's own is `session`. */
function sourceOf(origin: { [field: string]: unknown }): string {
  if (origin.kind === 'plugin' && typeof origin.name === 'string') return `plugin:${origin.name}`
  if (origin.kind === 'channel' && typeof origin.server === 'string') return `channel:${origin.server}`
  if (typeof origin.kind === 'string' && origin.kind !== 'composer') return origin.kind
  return 'session'
}

/** The session's /cost total, or null where the host keeps none or the call fails. */
async function sessionCost($: EngineInterface): Promise<number | null> {
  try {
    const usage = await $.session.usage({})
    return usage.cost?.usd ?? null
  } catch {
    return null
  }
}

const stringField = (fields: { [field: string]: unknown }, name: string): string | null => {
  const v = fields[name]
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** The model the main loop last answered with. */
export const mainModelOf = (ledger: Ledger): string | null =>
  [...ledger.requests].reverse().find(r => r.sourceKind === 'main' && r.model !== null)?.model ?? liveRun(ledger)?.model ?? null

// Where the animated pictures are mounted (braille Rasters, or Images where the terminal draws
// pixels); a reload starts it over and the next draw sets it again.
type Site = 'pane' | 'band'
type Mount = { requestId: string; columns: number; rows: number; isImage: boolean }
const mounts: { [site in Site]: Mount | null } = { pane: null, band: null }
const wasMoving: { [site in Site]: boolean } = { pane: false, band: false }
// Pixel pictures: the last frame each site drew (a redraw reuses it while nothing changed), when
// each draws next, a frame owed (a new mount, the frame after motion stops), and whether the
// terminal draws images at all: guessed from its environment, settled by its first answer.
type Frame = { sign: string; png: string; at: number }
const frames: { [site in Site]: Frame | null } = { pane: null, band: null }
const dueAt: { [site in Site]: number } = { pane: 0, band: 0 }
const owed: { [site in Site]: boolean } = { pane: false, band: false }
const pictures: { terminal: boolean | null; isRefused: boolean; isBusy: boolean; isAnnounced: boolean } = {
  terminal: null,
  isRefused: false,
  isBusy: false,
  isAnnounced: false,
}
const IMAGE_KEY: { [site in Site]: string } = { pane: 'graph-px', band: 'context-px' }
// What each loop is writing now, measured from its streamed chunks; memory only.
const live = new LiveRates()
// The session cost as the odometer last rolled it, and until when text re-renders run for an animation.
const odometer = { from: 0, to: 0, at: 0 }
let burstUntil = 0
const FRAME_MS = 60
// The pane's opening (pending until the pane draws after an open), the replay's wall clock, the theme.
const intro: { isPending: boolean; at: number | null } = { isPending: false, at: null }
let replayTick = 0
let isThemeSet = false

/** Keeps the pane re-rendering for `ms` (bars racing, the odometer rolling). */
function burst(at: number, ms: number): void {
  burstUntil = Math.max(burstUntil, at + ms)
}

/** The odometer's value at `at`; a new target starts a roll from where it stands. */
function odometerValue(target: number, at: number): number {
  if (odometer.at === 0) {
    odometer.from = target
    odometer.to = target
    odometer.at = at
  } else if (Math.abs(target - odometer.to) > 1e-12) {
    const current = rolling(odometer.from, odometer.to, at - odometer.at)
    odometer.from = current
    odometer.to = target
    odometer.at = at
    burst(at, 750)
  }
  return rolling(odometer.from, odometer.to, at - odometer.at)
}

/** What the pane draws: the session (or the demo) live, or one of its runs replayed at a moment. */
type Scene = {
  /** What the views read: the run as of the replay's moment while one is on. */
  ledger: Ledger
  /** The session's ledger, or the demo's, whole. */
  base: Ledger
  /** The moment drawn: now, or the replay's. */
  at: number
  now: number
  runId: string | null
  mainModel: string | null
  isDemo: boolean
  replay: LedgerReplay
}

/** The session's ledger, or the demo's while `/run-ledger demo` runs. */
async function baseOf($: EngineInterface, now: number): Promise<{ base: Ledger; isDemo: boolean }> {
  const demo = await read($, demoAtom)
  return demo ? { base: demoLedger(demo.startedAt, now), isDemo: true } : { base: await read($, ledgerAtom), isDemo: false }
}

async function sceneOf($: EngineInterface): Promise<Scene> {
  const now = await $.clock.now()
  const { base, isDemo } = await baseOf($, now)
  const replay = await read($, replayAtom)
  const mainModel = mainModelOf(base)
  const runId = replay.runId
  if (replay.at !== null && runId !== null && base.runs.some(r => r.id === runId)) {
    return { ledger: ledgerAt(base, runId, replay.at), base, at: replay.at, now, runId, mainModel, isDemo, replay }
  }
  return { ledger: base, base, at: now, now, runId: liveRun(base)?.id ?? null, mainModel, isDemo, replay: OFF }
}

const isReplaying = (scene: Scene): boolean => scene.replay.at !== null

/** A loop's output speed: measured from its stream, made up in the demo, not known in a replay. */
const rateIn = (scene: Scene) => (loop: string): number =>
  scene.isDemo ? demoRate(loop, scene.at) : isReplaying(scene) ? 0 : live.rate(loop, Date.now())

function liveIn(scene: Scene): (loop: string) => { spark: string; rate: number } | null {
  return loop => {
    if (isReplaying(scene)) return null
    if (scene.isDemo) {
      const series = Array.from({ length: 16 }, (_, k) => demoRate(loop, scene.at - (15 - k) * 1000))
      return { spark: sparkline(series), rate: demoRate(loop, scene.at) }
    }
    const now = Date.now()
    const series = live.series(loop, now)
    if (!series.some(v => v > 0)) return null
    return { spark: sparkline(series), rate: live.rate(loop, now) }
  }
}

const nodesOf = (scene: Scene): GraphNode[] => {
  const run = scene.ledger.runs.find(r => r.id === scene.runId)
  return graphNodes(scene.ledger, scene.runId, scene.mainModel, run?.status === 'running', rateIn(scene))
}

const bandItems = (base: Ledger) => contextOf(base, liveRun(base)?.id ?? null).items

/** How far into the pane's opening `now` is; null once it has played, or with `intro` off. */
const introMs = (s: Settings, now: number): number | null =>
  s.intro && intro.at !== null && now - intro.at >= 0 && now - intro.at < INTRO_MS ? now - intro.at : null

function graphCells(scene: Scene, s: Settings, columns: number, rows: number): string {
  return drawGraph(nodesOf(scene), scene.ledger.pulses, scene.at, columns, rows, introMs(s, scene.now)).encode()
}

function bandCells(scene: Scene, columns: number, rows: number): string {
  return drawContext(bandItems(scene.base), scene.base.agents, mainModelOf(scene.base), scene.now, columns, rows).encode()
}

function sitePicture(site: Site, scene: Scene, s: Settings, mount: Mount): Bitmap {
  return site === 'pane'
    ? drawGraphPixels(nodesOf(scene), scene.ledger.pulses, scene.at, mount.columns, mount.rows, s.pixelDensity, introMs(s, scene.now))
    : drawContextPixels(bandItems(scene.base), scene.base.agents, mainModelOf(scene.base), scene.now, mount.columns, mount.rows, s.pixelDensity)
}

const encodePicture = (b: Bitmap): string => toBase64(pngOfScanlines(b.scanlines(), b.width, b.height))

/** What a frame shows apart from the time: a redraw within a second with the same sign reuses the last frame. */
function signOf(site: Site, scene: Scene, mount: Mount): string {
  const l = site === 'pane' ? scene.ledger : scene.base
  const moment = site === 'pane' && scene.replay.at !== null ? scene.replay.at : ''
  return `${mount.columns}x${mount.rows}|${currentTheme()}|${scene.isDemo}|${moment}|${l.counter}|${l.requests.length}|${l.items.length}|${l.agents.map(a => `${a.status}:${a.actualModel ?? ''}`).join(',')}`
}

/**
 * The picture a render draws at `site`: the last frame while it still holds, else a new one.
 * While the picture moves on its own (a replay playing, the opening) a frame under 400 ms old
 * holds whatever it shows: the animation's blits keep it current.
 */
function frameFor(site: Site, scene: Scene, s: Settings, mount: Mount, isMoving: boolean): string {
  const sign = signOf(site, scene, mount)
  const last = frames[site]
  const age = last ? scene.now - last.at : Infinity
  if (last && age >= 0 && ((last.sign === sign && age < 1000) || (isMoving && age < 400 && last.sign.startsWith(`${mount.columns}x${mount.rows}|`)))) return last.png
  const png = encodePicture(sitePicture(site, scene, s, mount))
  frames[site] = { sign, png, at: scene.now }
  return png
}

/** Records where a render mounted `site`; a new Image is owed a frame, which tells whether pixels show. */
function noteMount(site: Site, mount: Mount): void {
  const was = mounts[site]
  const isNew = !was || was.requestId !== mount.requestId || was.columns !== mount.columns || was.rows !== mount.rows || was.isImage !== mount.isImage
  mounts[site] = mount
  if (isNew && mount.isImage) owed[site] = true
}

/**
 * Whether to draw pixels on this terminal: kitty graphics (Ghostty, kitty), not inside tmux or screen.
 * A TERM_PROGRAM naming another program wins over the kitty clues: Tern exports TERM=xterm-kitty and
 * KITTY_WINDOW_ID and answers the engine's image probe, yet draws no placeholder images, so the graph
 * came out blank there.
 */
async function drawsPixels($: EngineInterface, s: Settings): Promise<boolean> {
  if (s.graphics === 'braille' || pictures.isRefused) return false
  if (s.graphics === 'pixels') return true
  if (pictures.terminal === null) {
    const lower = (v: string | undefined): string => (v ?? '').toLowerCase()
    const program = lower(await $.env.get('TERM_PROGRAM'))
    const term = lower(await $.env.get('TERM'))
    const isOther = program !== '' && program !== 'ghostty' && program !== 'kitty'
    const isGraphical =
      !isOther &&
      (program === 'ghostty' || program === 'kitty' || term.includes('ghostty') || term.includes('kitty') ||
        lower(await $.env.get('GHOSTTY_RESOURCES_DIR')) !== '' || lower(await $.env.get('KITTY_WINDOW_ID')) !== '')
    const isMultiplexed =
      lower(await $.env.get('TMUX')) !== '' || lower(await $.env.get('STY')) !== '' || term.startsWith('screen') || term.startsWith('tmux')
    pictures.terminal = isGraphical && !isMultiplexed
  }
  return pictures.terminal
}

/** The theme, chosen once per load: the one set, or with `auto` light where the terminal says it is light. */
async function ensureTheme($: EngineInterface, s: Settings): Promise<void> {
  if (isThemeSet) return
  isThemeSet = true
  applyTheme(themeFrom(s.theme, s.theme === 'auto' ? await $.env.get('COLORFGBG') : undefined))
}

/** Something on screen moves fast (a packet, a ripple, a burst): pictures run at their full rate. */
const isQuick = (ledger: Ledger, at: number): boolean =>
  ledger.pulses.some(p => at - p.at >= 0 && at - p.at < PULSE_MS + 100) ||
  ledger.agents.some(a => within(a.startedAt, at, SPAWN_MS + 100) || within(a.endedAt, at, BURST_MS + 100)) ||
  ledger.items.some(i => at - i.at >= 0 && at - i.at < 1000)

const isFreshIn = (ledger: Ledger, at: number): boolean => ledger.items.some(i => at - i.at >= 0 && at - i.at < FRESH_MS + 200)

/**
 * Sends `site` its next pixel frame. Frames come every 80 ms while something moves fast, 160 ms
 * otherwise, and never faster than three times what the last one took to make, so drawing keeps
 * to about a third of a core at most.
 */
async function blitPicture($: EngineInterface, s: Settings, site: Site, mount: Mount, scene: Scene, isFast: boolean): Promise<void> {
  if (pictures.isBusy || (scene.now < dueAt[site] && !owed[site])) return
  pictures.isBusy = true
  try {
    const started = performance.now()
    const png = encodePicture(sitePicture(site, scene, s, mount))
    const cost = performance.now() - started
    frames[site] = { sign: signOf(site, scene, mount), png, at: scene.now }
    owed[site] = false
    dueAt[site] = scene.now + Math.max(isFast ? 80 : 160, cost * 3)
    const r = await $.ui.blit({ requestId: mount.requestId, key: IMAGE_KEY[site], source: { png } })
    if (r.deny !== undefined) refusePictures($, site, r.deny)
  } finally {
    pictures.isBusy = false
  }
}

/** A refused blit unmounts the site; one saying the Image shows its alt switches to braille for good. */
function refusePictures($: EngineInterface, site: Site, why: string): void {
  mounts[site] = null
  if (!/draws its alt/.test(why)) return
  pictures.isRefused = true
  frames.pane = null
  frames.band = null
  if (!pictures.isAnnounced) {
    pictures.isAnnounced = true
    $.ui.toast(`run-ledger: no pixel pictures here (${why.replace(/^the Image draws its alt here: /, '')}); drawing in braille.`)
  }
  $.ui.invalidate('ui.render')
}

type ReplayAction = 'toggle' | 'start' | 'exit' | 'play' | 'step-back' | 'step-fwd' | 'home' | 'end'

/** Starts, ends, steps or plays the replay of the run the pane shows. */
async function controlReplay($: EngineInterface, action: ReplayAction): Promise<void> {
  const now = await $.clock.now()
  const { base } = await baseOf($, now)
  const replay = await read($, replayAtom)
  const runId = replay.runId ?? liveRun(base)?.id ?? null
  if (runId === null) return
  const events = replayEvents(base, runId)
  const first = events[0]
  const last = events[events.length - 1]
  if (first === undefined || last === undefined) return
  const set = async (next: LedgerReplay) => {
    if (next.isPlaying && !replay.isPlaying) replayTick = now
    await update($, replayAtom, () => next)
    burst(now, 300)
  }
  const at = replay.at
  if (action === 'exit' || (action === 'toggle' && at !== null)) return set(OFF)
  if (action === 'toggle' || action === 'start' || (action === 'play' && at === null)) return set({ runId, at: first, isPlaying: true })
  if (action === 'play' && at !== null) return set({ runId, at: !replay.isPlaying && at >= last ? first : at, isPlaying: !replay.isPlaying })
  if (action === 'step-back') return set({ runId, at: stepReplay(events, at ?? now + 1, -1) ?? first, isPlaying: false })
  if (action === 'step-fwd' && at !== null) return set({ runId, at: stepReplay(events, at, 1) ?? last, isPlaying: false })
  if (action === 'home') return set({ runId, at: first, isPlaying: false })
  if (action === 'end') return set({ runId, at: last, isPlaying: false })
}

/** Where a replay stands, for the bar under the header; null while live. */
function replayInfo(scene: Scene, onStep: (dir: -1 | 1) => void, onPlay: () => void): ReplayInfo | null {
  if (!isReplaying(scene) || scene.runId === null) return null
  const events = replayEvents(scene.base, scene.runId)
  const run = scene.base.runs.find(r => r.id === scene.runId)
  const start = run?.startedAt ?? events[0] ?? scene.at
  const end = Math.max(run?.endedAt ?? scene.now, events[events.length - 1] ?? start)
  return {
    position: `${clock(scene.at - start)} / ${clock(end - start)}`,
    progress: end > start ? Math.min(1, (scene.at - start) / (end - start)) : 1,
    event: `event ${events.filter(t => t <= scene.at).length}/${events.length}`,
    isPlaying: scene.replay.isPlaying,
    onStep,
    onPlay,
  }
}

/** A playing replay moves its moment on, at REPLAY_SPEED, skipping quiet stretches. */
async function tickReplay($: EngineInterface): Promise<void> {
  const replay = await read($, replayAtom)
  if (!replay.isPlaying || replay.at === null || replay.runId === null) return
  const now = await $.clock.now()
  if (now - replayTick < 100) return
  const elapsed = Math.min(400, now - replayTick)
  replayTick = now
  const { base } = await baseOf($, now)
  const step = advanceReplay(replayEvents(base, replay.runId), replay.at, elapsed)
  await update($, replayAtom, r => ({ ...r, at: step.at, isPlaying: !step.isOver }))
}

/** One animation frame: moves a playing replay on, then repaints the mounted pictures while something moves, and once after. */
async function animate($: EngineInterface, s: Settings): Promise<void> {
  await tickReplay($)
  if (!mounts.pane && !mounts.band) return
  await ensureTheme($, s)
  const scene = await sceneOf($)
  const now = scene.now
  if (now < burstUntil) await update($, nowAtom, () => now)
  const isOpening = introMs(s, now) !== null
  const moving: { [site in Site]: boolean } = {
    pane: isOpening || scene.replay.isPlaying || (!isReplaying(scene) && (isAnimating(scene.ledger, scene.at) || isFreshIn(scene.ledger, scene.at))),
    band: isAnimating(scene.base, now) || isFreshIn(scene.base, now),
  }
  for (const site of ['pane', 'band'] as const) {
    const mount = mounts[site]
    if (!mount) continue
    const isMoving = moving[site]
    if (!isMoving && !wasMoving[site] && !owed[site]) continue
    // The frame after motion stops is owed to Images, which may skip a tick while one encodes.
    if (!isMoving && wasMoving[site] && mount.isImage) owed[site] = true
    wasMoving[site] = isMoving
    if (mount.isImage) {
      const isFast = site === 'pane' ? isOpening || scene.replay.isPlaying || isQuick(scene.ledger, scene.at) : isQuick(scene.base, now)
      await blitPicture($, s, site, mount, scene, isFast)
      continue
    }
    const cells = site === 'pane' ? graphCells(scene, s, mount.columns, mount.rows) : bandCells(scene, mount.columns, mount.rows)
    const r = await $.ui.blit({ requestId: mount.requestId, key: site === 'pane' ? 'graph' : 'context', cells })
    if (r.deny !== undefined) mounts[site] = null
  }
}

/** The receipt in the transcript as a run ends, and the sound when it is on; for runs with subagents unless set otherwise. */
async function announceRun($: EngineInterface, s: Settings, ledger: Ledger, runId: string, at: number, prefix: string): Promise<void> {
  const agents = ledger.agents.filter(a => a.runId === runId)
  if (s.receipt === 'always' || (s.receipt === 'subagents' && agents.length > 0)) {
    for (const text of receiptLines(ledger, runId, s.baselineModel, at, prefix)) $.ui.log(text)
  }
  if (!s.sound || agents.length === 0) return
  const run = ledger.runs.find(r => r.id === runId)
  const isBad = run?.status !== 'completed' || agents.some(a => a.status !== 'running' && a.status !== 'completed')
  if (isBad) void $.audio.play({ asset: 'sounds/failed.wav' }, { gain: 0.7 }).catch(() => undefined)
  else void $.audio.play({ asset: 'sounds/done.wav' }, { gain: 0.7 }).catch(() => undefined)
}

/**
 * A run's receipt (and sound) once none of its subagents still runs: at the main turn's end when they are
 * done, else when the last background one ends. Issued once: a run leaves the pending list as it is announced.
 */
async function announceWhenSettled($: EngineInterface, s: Settings, ledger: Ledger, runId: string, at: number): Promise<void> {
  if (ledger.agents.some(a => a.runId === runId && a.status === 'running')) {
    await update($, pendingReceiptsAtom, p => (p.includes(runId) ? p : [...p, runId].slice(-MAX_PENDING_RECEIPTS)))
    return
  }
  await update($, pendingReceiptsAtom, p => p.filter(id => id !== runId))
  await announceRun($, s, ledger, runId, at, '')
}

/** The receipts still waiting whose subagents have all ended since (a turn.complete or the engine's list). */
async function settlePending($: EngineInterface, s: Settings): Promise<void> {
  const pending = await read($, pendingReceiptsAtom)
  if (pending.length === 0) return
  const ledger = await read($, ledgerAtom)
  const at = await $.clock.now()
  for (const runId of pending) {
    if (!ledger.agents.some(a => a.runId === runId && a.status === 'running')) await announceWhenSettled($, s, ledger, runId, at)
  }
}

async function stopDemo($: EngineInterface): Promise<void> {
  await update($, demoAtom, () => null)
  await update($, replayAtom, () => OFF)
}

async function showStatus($: EngineInterface, ledger: Ledger): Promise<void> {
  const t = totals(ledger)
  if (t.requests === 0) return
  await $.ui.status(`ledger ${formatTotal(t.knownUsd, t.unknownCost, t.requests)} API est.`)
}

/** The run a plugin's model call belongs to: the turn running now, else one of its own. */
function runForPluginCall(ledger: Ledger, plugin: string, at: number): { ledger: Ledger; runId: string } {
  const current = ledger.runs.find(r => r.id === ledger.currentRunId && r.status === 'running')
  if (current) return { ledger, runId: current.id }
  const made = nextId(ledger, 'plugin-call')
  const run = { id: made.id, label: `model call by ${plugin}`, source: `plugin:${plugin}`, startedAt: at, endedAt: at, status: 'completed', model: null }
  return { ledger: upsertRun(made.ledger, run), runId: made.id }
}

async function recordPluginCall(
  $: EngineInterface,
  plugin: string,
  model: string | null,
  usage: ApiUsage | undefined,
  at: number,
  kind: string,
): Promise<void> {
  const tokens = fromApiUsage(usage)
  const ledger = await update($, ledgerAtom, l => {
    const placed = runForPluginCall(l, plugin, at)
    const made = nextId(placed.ledger, `${kind}`)
    return recordRequest(made.ledger, {
      key: `plugin|${plugin}|${made.id}`,
      runId: placed.runId,
      agentId: null,
      turnId: null,
      index: null,
      attempt: 0,
      requestedModel: model,
      model,
      sourceKind: 'plugin-model-call',
      sourcePlugin: plugin,
      usage: tokens,
      cost: estimateCost(model, tokens),
      stopReason: null,
      at,
    })
  })
  await showStatus($, ledger)
}

const NO_COST: LedgerCost = { usd: null, basis: 'no-usage', pricesAsOf: null }

type Advice = Pick<LedgerRecommendation, 'status' | 'model' | 'reason' | 'confidence' | 'score' | 'ranking' | 'validated' | 'jevCost'>

/**
 * Asks Jev, through the adapter at `jevEndpoint`, which model should run the
 * subagent. Any failure leaves the engine's own choice in place.
 */
async function consultJev($: EngineInterface, s: Settings, e: AgentSpawnInput, ledger: Ledger, budgetMs: number): Promise<Advice> {
  const fail = (reason: string, jevCost: LedgerCost = NO_COST): Advice => ({
    status: 'error', model: null, reason, confidence: null, score: null, ranking: [], validated: false, jevCost,
  })
  const history = parseHistory(await $.store.get(HISTORY_KEY))
  const body = buildJevRequest({
    prompt: e.prompt,
    description: e.description,
    agentType: e.subagentType,
    requestedModel: e.model ?? null,
    parentModel: e.parentModel,
    models: s.jevModels,
    budgetUsd: s.budgetUsd,
    ledger,
    history,
  })
  const waitMs = Math.max(100, Math.min(s.jevTimeoutMs, budgetMs - 500))
  const stop = new AbortController()
  const timedOut = $.clock.sleep(waitMs, { signal: stop.signal }).then(
    () => 'timeout' as const,
    () => 'cancelled' as const,
  )
  try {
    const answer = await Promise.race([
      $.http.fetch(s.jevEndpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      timedOut,
    ])
    if (answer === 'timeout' || answer === 'cancelled') return fail(`Jev did not answer within ${waitMs} ms; engine's choice kept`)
    if (!answer.ok) return fail(`Jev answered HTTP ${answer.status}; engine's choice kept`)
    const parsed = parseJevAnswer(answer.text, s.jevModels)
    if (!parsed.isValid) return fail(`${parsed.problem}; engine's choice kept`, parsed.cost)
    const top = parsed.ranking.find(c => c.model === parsed.model)
    return {
      status: 'ok',
      model: parsed.model,
      reason: parsed.reason,
      confidence: parsed.confidence,
      score: top?.score ?? null,
      ranking: parsed.ranking,
      validated: true,
      jevCost: parsed.cost,
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return fail(`Jev call failed (${why.slice(0, 80)}); engine's choice kept`)
  } finally {
    stop.abort()
  }
}

function localAdvice(s: Settings, agentType: string, history: readonly LedgerHistoryEntry[], contextTokens: number | null): Advice {
  const d = localDecision({ agentType, models: s.jevModels, history, contextTokens })
  return {
    status: d.model === null ? 'error' : 'ok',
    model: d.model,
    reason: d.reason,
    confidence: d.confidence,
    score: d.score,
    ranking: d.ranking,
    validated: d.validated,
    jevCost: NO_COST,
  }
}

function logDecision($: EngineInterface, s: Settings, rec: Pick<LedgerRecommendation, 'agentType' | 'model' | 'score' | 'confidence' | 'status' | 'reason' | 'applied'>): void {
  if (!s.logDecisions) return
  const who = s.jevEndpoint === '' ? 'router' : 'Jev'
  if (rec.status !== 'ok' || rec.model === null) {
    $.ui.log(`◆ ${who}: ${roleName(rec.agentType)}: ${rec.reason}`)
    return
  }
  const stats = [rec.score === null ? null : `score ${rec.score.toFixed(2)}`, rec.confidence === null ? null : `p ${rec.confidence.toFixed(2)}`]
    .filter(x => x !== null)
    .join(' · ')
  $.ui.log(`◆ ${who}: ${roleName(rec.agentType)} → ${shortModel(rec.model)}${stats ? ` (${stats})` : ''}${rec.applied ? '' : ' · recommendation'}`)
}

async function appendHistory($: EngineInterface, entry: LedgerHistoryEntry): Promise<void> {
  const history = parseHistory(await $.store.get(HISTORY_KEY))
  await $.store.set(HISTORY_KEY, [...history, entry].slice(-MAX_HISTORY))
}

async function exportLedger($: EngineInterface, folder: string): Promise<string> {
  const ledger = await read($, ledgerAtom)
  const at = await $.clock.now()
  const home = await $.env.get('HOME')
  const base = folder !== '' ? folder.replace(/\/+$/, '') : home ? `${home}/.claude/run-ledger/exports` : ''
  if (base === '') return 'HOME is not set: name a folder, /run-ledger export <folder>.'
  const stamp = new Date(at).toISOString().replace(/[:.]/g, '-')
  const jsonPath = `${base}/run-ledger-${stamp}.json`
  const csvPath = `${base}/run-ledger-${stamp}.csv`
  await $.fs.write(jsonPath, JSON.stringify(exportDocument(ledger, at), null, 2) + '\n')
  await $.fs.write(csvPath, exportCsv(ledger))
  return `Exported ${ledger.requests.length} requests: ${jsonPath} and ${csvPath}`
}

/** Brings agent rows in line with the engine's own list: statuses, and agents spawned before this mod loaded. */
async function syncAgents($: EngineInterface): Promise<void> {
  const listed = await $.agent.list()
  const at = await $.clock.now()
  await update($, ledgerAtom, l => {
    let out = l
    for (const info of listed) {
      const known = out.agents.find(a => a.id === info.id)
      if (!known) {
        out = upsertAgent(out, {
          id: info.id,
          runId: out.currentRunId ?? UNATTRIBUTED,
          parentId: info.parentId ?? null,
          type: info.type,
          description: info.description,
          spawnedBy: info.spawnedBy ?? null,
          provider: null,
          background: false,
          requestedModel: null,
          recommendationId: null,
          recommendedModel: null,
          routed: false,
          actualModel: null,
          status: info.status,
          lastAction: null,
          contextTokens: null,
          startedAt: at,
          endedAt: info.status === 'running' ? null : at,
          result: null,
        })
      } else if (known.status === 'running' && info.status !== 'running') {
        out = patchAgent(out, info.id, { status: info.status, endedAt: known.endedAt ?? at })
      }
    }
    return out
  })
}

async function refreshFill($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  const fill: LedgerContextFill = { tokens: usage.context.tokens ?? null, window: usage.context.window, percent: usage.context.percent ?? null }
  await update($, fillAtom, () => fill)
}

// Tools that are Claude Code's own bookkeeping, not context worth drawing.
const INTERNAL = new Set(['Agent', 'Task', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TodoWrite', 'ToolSearch', 'SendMessage', 'SubagentHandback'])

function contextKind(tool: string): 'read' | 'write' | 'run' {
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') return 'write'
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob' || tool === 'WebFetch' || tool === 'WebSearch' || tool === 'NotebookRead') return 'read'
  return 'run'
}

export const register: Register = (on, options) => {
  const s = settingsOf(options)
  // A load or reload guesses the terminal afresh; the next draw mounts the pictures again.
  pictures.terminal = null
  pictures.isRefused = false
  frames.pane = null
  frames.band = null
  intro.at = null
  // A theme named outright applies now; `auto` looks at the terminal when it first draws.
  applyTheme(themeFrom(s.theme, undefined))
  isThemeSet = s.theme !== 'auto'
  const view: ViewSettings = { isJev: s.jevEndpoint !== '', routing: s.routing, roles: s.roles ? roleTypes() : [] }
  const allowedTypes = [...s.autoRouteTypes, ...(s.roles ? roleTypes() : [])]
  // Where the next turn's prompt came from; a module variable, so a reload forgets one pending prompt at most.
  let pendingSource = 'session'
  let ticks = 0

  on('session.start', async ($, e, next) => {
    // A ledger an older run-ledger left in this session's state (a hot reload over 0.1.x) gets the
    // fields this version reads, before any other hook touches it.
    await update($, ledgerAtom, l => normalizeLedger(l))
    await $.command.register({
      name: 'run-ledger',
      description: 'Sub-agent model allocation: live graph, routing and API-rate costs',
      argumentHint: '[live|timeline|ledger|replay|demo [off]|receipt|export [folder]|reset|roles on|off|routing auto|recommend|graphics auto|pixels|braille|theme auto|neon|minimal|contrast|light|sound on|off]',
    })
    await ensureTheme($, s)
    if (s.roles) {
      for (const role of ROLES) {
        await $.agent.register({ name: role.role, description: role.description, prompt: role.prompt }).catch(() => undefined)
      }
    }
    $.clock.every(FRAME_MS, () => {
      void animate($, s).catch(() => undefined)
    })
    $.clock.every(1000, () => {
      ticks += 1
      void (async () => {
        const demo = await read($, demoAtom)
        if (demo) {
          const now = await $.clock.now()
          await update($, nowAtom, () => now)
          // The demo's end gets the receipt (and sound) a real run gets.
          if (!demo.isAnnounced && now - demo.startedAt >= DEMO_MS) {
            await update($, demoAtom, d => (d ? { ...d, isAnnounced: true } : d))
            await announceRun($, s, demoLedger(demo.startedAt, now), DEMO_RUN, now, 'DEMO ')
          }
          return
        }
        const ledger = await read($, ledgerAtom)
        const isLive =
          ledger.agents.some(a => a.status === 'running') || ledger.recommendations.some(r => r.status === 'deciding')
        if (!isLive) return
        const now = await $.clock.now()
        await update($, nowAtom, () => now)
        if (ticks % 5 === 0) {
          await syncAgents($)
          // An agent the engine reports ended without a turn.complete here (killed, stopped) settles its run too.
          await settlePending($, s)
        }
      })().catch(() => undefined)
    })
    await refreshFill($).catch(() => undefined)
    // /cost counts from the session's start; the ledger from now, when it has counted nothing yet.
    const loaded = await read($, ledgerAtom)
    if (loaded.requests.length === 0 && loaded.costBaselineUsd === null) {
      const usd = await sessionCost($)
      await update($, ledgerAtom, l => ({ ...l, costBaselineUsd: usd ?? 0 }))
    }
    await showStatus($, await read($, ledgerAtom))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await refreshFill($).catch(() => undefined)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    pendingSource = sourceOf(fieldsOf(e.origin))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // A subagent's own turns belong to the run that spawned it, not to a run (or a roster) of their own.
    if (e.agentId !== undefined) return next(e)
    const at = await $.clock.now()
    const source = pendingSource
    pendingSource = 'session'
    const handback = parseHandback(e.text)
    const ledger = await update($, ledgerAtom, l => {
      const agent = handback ? l.agents.find(a => a.id === handback.agentId) : undefined
      const runLabel = handback
        ? cleanLabel(`↩ ${agent ? `${roleName(agent.type)} "${agent.description}"` : 'a subagent'} handed back its report`)
        : cleanLabel(e.text)
      let out = upsertRun(l, {
        id: e.turnId,
        label: runLabel,
        source: handback ? `agent:${handback.agentId}` : source,
        startedAt: at,
        endedAt: null,
        status: 'running',
        model: null,
      })
      if (agent && agent.result === null && handback?.report) out = patchAgent(out, agent.id, { result: resultLine(handback.report) })
      return { ...out, currentRunId: e.turnId }
    })
    // The local router lays out the roster for this prompt at once; Jev decides per spawn, with the task in hand.
    if (s.jevEndpoint === '') {
      const types = [...new Set([...(s.roles ? roleTypes() : []), ...ledger.agents.map(a => a.type)])].filter(t => t !== 'fork')
      if (types.length > 0) {
        const history = parseHistory(await $.store.get(HISTORY_KEY))
        const made: LedgerRecommendation[] = []
        await update($, ledgerAtom, l => {
          let out = l
          made.length = 0
          for (const agentType of types) {
            const id = nextId(out, 'rec')
            const rec: LedgerRecommendation = {
              id: id.id, runId: e.turnId, agentType, router: 'local', ...localAdvice(s, agentType, history, null), mode: s.routing, applied: false, at,
            }
            made.push(rec)
            out = addRecommendation(id.ledger, rec)
          }
          return out
        })
        for (const rec of made) logDecision($, s, rec)
        burst(at, 800)
      }
    }
    await update($, nowAtom, () => at)
    return next(e)
  })

  // Every model request of every loop passes here exactly once per send: the
  // one place requests are counted. turn.complete's summed usage is never added.
  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId ?? null
    const baseKey = `${agentId ?? 'main'}|${e.turnId}|${e.index}`
    const at = await $.clock.now()
    let attempt = 0
    await update($, ledgerAtom, l => {
      const bumped = bumpAttempt(l, baseKey)
      attempt = bumped.attempt
      return bumped.ledger
    })
    let result: TurnStepResult | undefined
    const loop = agentId ?? 'main'
    try {
      const stream = next(e)
      for await (const chunk of stream) {
        if (chunk.kind === 'text' || chunk.kind === 'thinking') live.add(loop, Date.now(), chunk.text.length / 4)
        else if (chunk.kind === 'input') live.add(loop, Date.now(), chunk.json.length / 4)
        yield chunk
      }
      result = await stream.result
      return result
    } finally {
      try {
        const answered = result
        const ledger = await update($, ledgerAtom, l => {
          const runId = agentId === null ? e.turnId : runOfAgent(l, agentId) ?? l.currentRunId ?? UNATTRIBUTED
          const placed = ensureRun(
            l,
            runId,
            agentId === null ? '(turn began before run-ledger loaded)' : 'subagent work with no known run',
            'session',
            at,
          )
          const agent = agentId === null ? undefined : placed.agents.find(a => a.id === agentId)
          const run = placed.runs.find(r => r.id === runId)
          const usage = fromApiUsage(answered?.usage)
          const model = answered?.usage?.model ?? null
          let out = recordRequest(placed, {
            key: `${baseKey}|${attempt}`,
            runId,
            agentId,
            turnId: e.turnId,
            index: e.index,
            attempt,
            requestedModel: e.model,
            model,
            sourceKind: agentId === null ? 'main' : 'subagent',
            sourcePlugin:
              agentId === null
                ? run?.source.startsWith('plugin:') ? run.source.slice('plugin:'.length) : null
                : agent?.spawnedBy ?? null,
            usage,
            cost: estimateCost(model ?? e.model, usage),
            stopReason: answered ? answered.stopReason : 'interrupted',
            at,
          })
          if (agent && model) out = patchAgent(out, agent.id, { actualModel: model })
          if (agent && usage && agent.contextTokens === null) {
            out = patchAgent(out, agent.id, { contextTokens: usage.input + usage.cacheRead + usage.cacheWrite })
          }
          if (agentId === null && model) out = patchRun(out, runId, { model })
          return out
        })
        await showStatus($, ledger)
      } catch {
        // Bookkeeping never breaks a request.
      }
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const at = await $.clock.now()
    const before = await read($, ledgerAtom)
    const runId = runOfAgent(before, e.parentAgentId ?? null) ?? before.currentRunId ?? UNATTRIBUTED
    let advice: Advice
    let recId = ''
    const existing = decisionFor(before, runId, e.subagentType)
    const isReused = s.jevEndpoint === '' && existing !== undefined && existing.router === 'local' && existing.status === 'ok'
    if (s.jevEndpoint !== '') {
      // Shown as deciding while Jev weighs it.
      await update($, ledgerAtom, l => {
        const made = nextId(l, 'rec')
        recId = made.id
        return addRecommendation(made.ledger, {
          id: made.id, runId, agentType: e.subagentType, router: 'jev', status: 'deciding', model: null, reason: 'deciding',
          confidence: null, score: null, ranking: [], validated: false, jevCost: NO_COST, mode: s.routing, applied: false, at,
        })
      })
      advice = await consultJev($, s, e, before, next.budget.remainingMs)
    } else if (isReused && existing) {
      recId = existing.id
      advice = existing
    } else {
      const history = parseHistory(await $.store.get(HISTORY_KEY))
      const local = localAdvice(s, e.subagentType, history, e.fork ? null : approxTokens(e.prompt))
      advice = local
      await update($, ledgerAtom, l => {
        const made = nextId(l, 'rec')
        recId = made.id
        return addRecommendation(made.ledger, { id: made.id, runId, agentType: e.subagentType, router: 'local', ...local, mode: s.routing, applied: false, at })
      })
    }
    const routed =
      advice.status === 'ok' &&
      advice.model !== null &&
      advice.validated &&
      isEligibleForAuto({ mode: s.routing, agentType: e.subagentType, fork: e.fork, requestedModel: e.model, allowedTypes })
    const result = await next(routed && advice.model !== null ? { ...e, model: advice.model } : e)
    const spawnedBy = next.origin.plugin === 'engine' ? null : next.origin.plugin
    const applied = routed && result.deny === undefined
    const ledger = await update($, ledgerAtom, l => {
      let out = patchRecommendation(l, recId, { ...advice, applied: applied || (l.recommendations.find(r => r.id === recId)?.applied ?? false) })
      if (result.deny !== undefined || result.agentId === undefined) return out
      const agentId = result.agentId
      const parent = e.parentAgentId ?? 'main'
      out = upsertAgent(out, {
        id: agentId,
        runId,
        parentId: e.parentAgentId ?? null,
        type: e.subagentType,
        description: e.description,
        spawnedBy,
        provider: e.provider.plugin === 'engine' ? null : e.provider.plugin,
        background: e.background,
        requestedModel: e.model ?? null,
        recommendationId: recId,
        recommendedModel: advice.model,
        routed,
        actualModel: result.model,
        status: 'running',
        lastAction: null,
        contextTokens: null,
        startedAt: at,
        endedAt: null,
        result: null,
      })
      const pulse = nextId(out, 'pulse')
      out = addPulse(pulse.ledger, { id: pulse.id, from: parent, to: agentId, kind: 'route', at })
      const item = nextId(out, 'ctx')
      return addItem(item.ledger, {
        id: item.id, runId, agentId, kind: 'handoff', label: `→ ${roleName(e.subagentType)}: ${e.description}`,
        path: null, tokens: approxTokens(e.prompt), fromAgentId: parent, at,
      })
    })
    const rec = ledger.recommendations.find(r => r.id === recId)
    // A decision the roster already announced is logged again only when it was applied.
    if (rec && (!isReused || applied)) logDecision($, s, rec)
    if (!isReused) burst(await $.clock.now(), 800)
    await update($, nowAtom, () => at)
    // Once a session (kept in state, so a hot reload does not open it again), never over a pane
    // already open, never after the person closed it by hand. The open itself is not awaited.
    if (s.autoOpen && result.agentId !== undefined && !(await read($, autoOpenSpentAtom))) {
      await update($, autoOpenSpentAtom, () => true)
      const isOpen = await $.ui.panes().then(
        panes => panes.some(p => p.id === PANE),
        () => false,
      )
      if (!isOpen) {
        intro.isPending = true
        void $.ui.open({ id: PANE, title: 'run-ledger' }).catch(() => undefined)
      }
    }
    return result
  })

  // The person's own close is the last word for the session: no auto-open after it.
  on('ui.close', async ($, e, next) => {
    if (closedByPerson(PANE, e)) await update($, autoOpenSpentAtom, () => true)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const agentId = e.agentId ?? null
    // A background subagent ends by handing its report back through this internal tool: its result.
    if (tool === 'SubagentHandback' && agentId !== null) {
      const message = fieldsOf(e).message
      const report = typeof message === 'string' ? resultLine(message) : null
      await update($, ledgerAtom, l =>
        patchAgent(l, agentId, report ? { lastAction: 'handed back its report', result: report } : { lastAction: 'handed back its report' }),
      )
      return next(e)
    }
    if (INTERNAL.has(tool)) return next(e)
    const fields = fieldsOf(e)
    const at = await $.clock.now()
    const kind = contextKind(tool)
    const path = stringField(fields, 'file_path') ?? stringField(fields, 'notebook_path')
    const text = path ?? stringField(fields, 'description') ?? stringField(fields, 'command') ?? stringField(fields, 'pattern') ?? stringField(fields, 'url') ?? stringField(fields, 'query') ?? tool
    const action = describeToolCall(tool, fields)
    let itemId = ''
    await update($, ledgerAtom, l => {
      let out = agentId === null ? l : patchAgent(l, agentId, { lastAction: action })
      const runId = agentId === null ? (l.currentRunId ?? UNATTRIBUTED) : (runOfAgent(l, agentId) ?? l.currentRunId ?? UNATTRIBUTED)
      const producer = kind === 'read' && path !== null ? producerOf(l, path, agentId, at) : undefined
      const made = nextId(out, 'ctx')
      itemId = made.id
      const written = kind === 'write' ? (stringField(fields, 'content') ?? stringField(fields, 'new_string')) : null
      out = addItem(made.ledger, {
        id: made.id, runId, agentId, kind, label: contextLabel(kind, kind === 'run' ? `${tool === 'Bash' ? '$ ' : `${tool}: `}${text}` : text),
        path, tokens: written === null ? null : approxTokens(written), fromAgentId: producer === undefined ? null : (producer ?? 'main'), at,
      })
      return out
    })
    const r = await next(e)
    if (kind !== 'write' && 'result' in r && r.result !== undefined) {
      const size = (() => {
        try {
          return JSON.stringify(r.result).length
        } catch {
          return null
        }
      })()
      if (size !== null) await update($, ledgerAtom, l => patchItem(l, itemId, { tokens: Math.ceil(size / 4) }))
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const at = await $.clock.now()
    const status = statusFromReason(e.reason)
    const agentId = e.agentId
    if (agentId === undefined) {
      const ended = await update($, ledgerAtom, l => ({
        ...patchRun(l, e.turnId, { endedAt: at, status, model: e.usage?.model ?? l.runs.find(r => r.id === e.turnId)?.model ?? null }),
        currentRunId: l.currentRunId === e.turnId ? null : l.currentRunId,
      }))
      await update($, nowAtom, () => at)
      // A background subagent may still be working: its requests and the routing savings are not in yet.
      await announceWhenSettled($, s, ended, e.turnId, at)
      return next(e)
    }
    const answered = e.reason === 'refusal' ? `refused: ${e.refusal.category ?? 'no category'}` : resultLine(e.answer)
    const ledger = await update($, ledgerAtom, l => {
      // A hand-back leaves the answer empty: keep the report it already recorded.
      const result = answered ?? l.agents.find(a => a.id === agentId)?.result ?? null
      let out = patchAgent(l, agentId, { status, endedAt: at, result })
      const agent = out.agents.find(a => a.id === agentId)
      if (!agent) return out
      const parent = agent.parentId ?? 'main'
      const pulse = nextId(out, 'pulse')
      out = addPulse(pulse.ledger, { id: pulse.id, from: agentId, to: parent, kind: 'result', at })
      const item = nextId(out, 'ctx')
      return addItem(item.ledger, {
        id: item.id, runId: agent.runId, agentId: agent.parentId, kind: 'result',
        label: `← ${roleName(agent.type)}: ${status === 'completed' ? (result ?? 'done') : status}`,
        path: null, tokens: e.answer.length > 0 ? approxTokens(e.answer) : null, fromAgentId: agentId, at,
      })
    })
    const agent = ledger.agents.find(a => a.id === agentId)
    if (agent) {
      const spent = agentCost(ledger, agentId)
      await appendHistory($, {
        agentType: agent.type,
        model: agent.actualModel,
        outcome: status,
        costUsd: spent.unknown > 0 || spent.requests === 0 ? null : spent.usd,
        durationMs: at - agent.startedAt,
        at,
      })
    }
    await update($, nowAtom, () => at)
    await settlePending($, s)
    return next(e)
  })

  // Model calls other plugins make outside the turn loop.
  on('model.complete', async ($, e, next) => {
    const at = await $.clock.now()
    const result = await next(e)
    await recordPluginCall($, next.origin.plugin, e.model, result.value?.usage, at, 'complete')
    return result
  })

  on('model.fork', async ($, e, next) => {
    const at = await $.clock.now()
    const result = await next(e)
    const value = result.value
    const usage = value && 'usage' in value ? value.usage : undefined
    const ledger = await read($, ledgerAtom)
    await recordPluginCall($, next.origin.plugin, mainModelOf(ledger), usage, at, 'fork')
    return result
  })

  on('command.run', { command: 'run-ledger' }, async ($, e) => {
    const [verb = '', arg = '', ...rest] = e.args.trim().split(/\s+/)
    if (verb === 'export') return { text: await exportLedger($, [arg, ...rest].filter(x => x !== '').join(' ')) }
    if (verb === 'reset') {
      const usd = await sessionCost($)
      await update($, ledgerAtom, () => ({ ...emptyLedger(), costBaselineUsd: usd ?? 0 }))
      await update($, selectedAtom, () => null)
      await $.ui.status(undefined)
      return { text: 'Run ledger cleared for this session. Past subagent results kept for the routers.' }
    }
    if (verb === 'roles' && (arg === 'on' || arg === 'off')) {
      const set = await $.config.set({ key: 'run-ledger.roles', value: arg === 'on' }).catch((error: Error) => ({ deny: error.message }))
      return { text: set.deny !== undefined ? `Could not change it (${set.deny}); set run-ledger roles in /config.` : `Roles ${arg}: run-ledger reloads with ${arg === 'on' ? 'five roles registered' : 'no roles'}.` }
    }
    if (verb === 'routing' && (arg === 'auto' || arg === 'recommend')) {
      const set = await $.config.set({ key: 'run-ledger.routing', value: arg }).catch((error: Error) => ({ deny: error.message }))
      return { text: set.deny !== undefined ? `Could not change it (${set.deny}); set run-ledger routing in /config.` : `Routing: ${arg}.` }
    }
    if (verb === 'graphics' && (arg === 'auto' || arg === 'pixels' || arg === 'braille')) {
      const set = await $.config.set({ key: 'run-ledger.graphics', value: arg }).catch((error: Error) => ({ deny: error.message }))
      return { text: set.deny !== undefined ? `Could not change it (${set.deny}); set run-ledger graphics in /config.` : `Graphics: ${arg}.` }
    }
    if (verb === 'theme' && (arg === 'auto' || THEME_NAMES.some(t => t === arg))) {
      const set = await $.config.set({ key: 'run-ledger.theme', value: arg }).catch((error: Error) => ({ deny: error.message }))
      return { text: set.deny !== undefined ? `Could not change it (${set.deny}); set run-ledger theme in /config.` : `Theme: ${arg}.` }
    }
    if (verb === 'sound' && (arg === 'on' || arg === 'off')) {
      const set = await $.config.set({ key: 'run-ledger.sound', value: arg === 'on' }).catch((error: Error) => ({ deny: error.message }))
      return { text: set.deny !== undefined ? `Could not change it (${set.deny}); set run-ledger sound in /config.` : `Sound ${arg}${arg === 'on' ? ' (macOS plays it; other systems have no player)' : ''}.` }
    }
    if (verb === 'receipt') {
      const ledger = await read($, ledgerAtom)
      const run = liveRun(ledger)
      const lines = run ? receiptLines(ledger, run.id, s.baselineModel, await $.clock.now()) : []
      for (const text of lines) $.ui.log(text)
      return { text: lines.length > 0 ? 'run-ledger: the latest run\'s receipt is above.' : 'run-ledger: no run yet.' }
    }
    if (verb === 'demo') {
      if (arg === 'off') {
        await stopDemo($)
        return { text: 'run-ledger demo ended.' }
      }
      const now = await $.clock.now()
      await update($, demoAtom, () => ({ startedAt: now, isAnnounced: false }))
      await update($, replayAtom, () => OFF)
      await update($, viewAtom, () => 'live')
      intro.isPending = true
      await $.ui.open({ id: PANE, title: 'run-ledger', focus: true })
      return { text: 'run-ledger demo: a scripted run with sample data, no model calls and nothing added to the ledger. /run-ledger demo off ends it.' }
    }
    if (verb === 'replay') {
      await controlReplay($, 'start')
      await update($, viewAtom, () => 'live')
    }
    if (verb === 'ledger' || verb === 'live' || verb === 'timeline') await update($, viewAtom, () => verb)
    intro.isPending = true
    await $.ui.open({ id: PANE, title: 'run-ledger', focus: true })
    return { text: 'run-ledger opened. l: live · t: timeline · g: ledger · r: replay · e: export · q: close' }
  })

  // Keys from the overlay on the graph, which holds the keyboard after a click: ←/→ step the
  // replay, space plays it, Home and End jump, and the header's letters do what they do there.
  on('ui.message', async ($, e, next) => {
    if (e.element !== 'graph-overlay') return next(e)
    const data = e.data
    if (typeof data !== 'object' || data === null || !('kind' in data) || data.kind !== 'key' || !('key' in data)) return {}
    const key = data.key
    const replayKeys: { [k: string]: ReplayAction } = { left: 'step-back', b: 'step-back', right: 'step-fwd', f: 'step-fwd', ' ': 'play', space: 'play', p: 'play', home: 'home', end: 'end', r: 'toggle' }
    const views: { [k: string]: 'live' | 'timeline' | 'ledger' } = { l: 'live', t: 'timeline', g: 'ledger' }
    if (typeof key !== 'string') return {}
    const action = replayKeys[key]
    const view = views[key]
    if (action !== undefined) await controlReplay($, action)
    else if (view !== undefined) {
      if (view === 'live') await update($, replayAtom, () => OFF)
      await update($, viewAtom, () => view)
    } else if (key === 'e') $.ui.toast(await exportLedger($, ''))
    else if (key === 'q') await $.ui.close({ id: PANE })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await ensureTheme($, s)
    const els = $.ui.resolve(e)
    const scene = await sceneOf($)
    const shown = await read($, viewAtom)
    const selected = await read($, selectedAtom)
    await read($, nowAtom) // the clock redraws the spinners and elapsed times
    const { ledger, at, now, runId, mainModel } = scene
    if (intro.isPending) {
      intro.isPending = false
      intro.at = now
      burst(now, INTRO_MS)
    }
    const opening = introMs(s, now)
    const width = Math.max(44, e.props.bodyColumns)
    const saving = savingsVs(scene.base, s.baselineModel)
    const motion: Motion = {
      shownUsd: scene.isDemo ? null : odometerValue(totals(scene.base).knownUsd, now),
      savings: formatSavings(saving, shortModel),
      saved: saving.saved,
      live: liveIn(scene),
    }
    const actions: HeaderActions = {
      onView: v =>
        void (async () => {
          if (v === 'live') await update($, replayAtom, () => OFF)
          await update($, viewAtom, () => v)
        })(),
      onExport: () => void exportLedger($, '').then(text => $.ui.toast(text)),
      onClose: () => void $.ui.close({ id: PANE }),
      onReplay: () => void controlReplay($, 'toggle'),
    }
    const replay = replayInfo(scene, dir => void controlReplay($, dir < 0 ? 'step-back' : 'step-fwd'), () => void controlReplay($, 'play'))
    const top = header(els, view, scene.base, shown, actions, motion, replay, scene.isDemo)
    const { Box, Text } = els
    const cardOf = (id: string) => (id === 'main' ? mainCard(ledger, runId, mainModel, at) : agentCard(ledger, id, at))
    if (shown === 'ledger') {
      mounts.pane = null
      const seen = scene.isDemo ? null : reconcile(await sessionCost($), scene.base.costBaselineUsd ?? null, totals(scene.base))
      return (
        <Box flexDirection="column">
          {top}
          {ledgerView(els, scene.base, selected, width, id => void update($, selectedAtom, () => id), motion, seen)}
        </Box>
      )
    }
    if (shown === 'timeline') {
      mounts.pane = null
      return (
        <Box flexDirection="column">
          {top}
          {timelineView(els, ledger, runId, mainModel, at, width, cardOf, isReplaying(scene) ? at : null)}
        </Box>
      )
    }
    const isWide = width >= 100
    const graphWidth = isWide ? Math.floor(width * 0.56) : width
    const sideWidth = isWide ? width - graphWidth - 1 : width
    const nodes = nodesOf(scene)
    const { depth } = layoutTree(nodes)
    const graphRows = Math.max(8, Math.min(18, (depth + 1) * 5 + 2))
    const running = ledger.agents.filter(a => a.status === 'running').length
    let picture: RenderElement
    const alt = `Agent graph: ${nodes.length - 1} subagents, ${running} running`
    if (e.surface === 'terminal') {
      const { Image, Raster, Client } = $.ui.resolve(e)
      const columns = Math.max(10, graphWidth - 4)
      const isPixels = await drawsPixels($, s)
      const mount = { requestId: e.requestId, columns, rows: graphRows, isImage: isPixels }
      noteMount('pane', mount)
      const graph = isPixels ? (
        <Image key={IMAGE_KEY.pane} source={{ png: frameFor('pane', scene, s, mount, opening !== null || scene.replay.isPlaying) }} columns={columns} rows={graphRows} alt={alt} />
      ) : (
        <Raster key="graph" columns={columns} rows={graphRows} cells={graphCells(scene, s, columns, graphRows)} />
      )
      // An invisible layer over the picture: the node under the pointer shows its card there.
      const overlay: OverlayProps = {
        boxes: isPixels ? pixelHitboxes(nodes, columns, graphRows, s.pixelDensity) : cellHitboxes(nodes, columns, graphRows),
        // Wrapped here to the width the overlay draws (its full width, or the picture's when narrower).
        cards: Object.fromEntries(
          Object.entries(cardsFor(ledger, nodes.map(n => n.id), runId, mainModel, at)).map(([id, card]) => [
            id,
            wrapCard(card, Math.max(16, Math.min(CARD_WIDTH, columns)) - 4),
          ]),
        ),
        width: CARD_WIDTH,
        background: hex(COLOR.bg),
        muted: hex(COLOR.muted),
      }
      picture = (
        <Box key="pic" width={columns} height={graphRows}>
          {graph}
          <Box key="over" position="absolute" top={0} left={0} width={columns} height={graphRows}>
            <Client key="graph-overlay" module="./overlay.tsx" width={columns} height={graphRows} props={overlay} />
          </Box>
        </Box>
      )
    } else {
      const { Svg } = $.ui.resolve(e)
      const pxWidth = Math.max(240, (graphWidth - 4) * 8)
      picture = (
        <Svg
          key="graph"
          source={graphSvg(nodes, ledger.pulses, at, pxWidth, graphRows * 18)}
          alt={alt}
          width={pxWidth}
          height={graphRows * 18}
          isInteractive
        />
      )
    }
    const graphBox = (
      <Box key="graphbox" flexDirection="column" borderStyle="round" borderColor={hex(COLOR.dim)} paddingX={1} width={graphWidth}>
        <Box key="h" flexDirection="row" justifyContent="space-between">
          <Text key="t" bold>Agent graph</Text>
          <Text key="n" color={hex(running > 0 ? COLOR.ok : COLOR.muted)}>{`${running} running`}</Text>
        </Box>
        {picture}
      </Box>
    )
    return (
      <Box flexDirection="column">
        {top}
        {roster(els, ledger, runId, mainModel, view, at, width, motion, opening)}
        {decisionCard(els, ledger, runId, view, at, width)}
        <Box key="lower" flexDirection={isWide ? 'row' : 'column'} gap={isWide ? 1 : 0}>
          {graphBox}
          {spawns(els, ledger, runId, at, sideWidth, isWide ? Math.max(3, Math.floor((graphRows + 1) / 2)) : 6, motion, id => agentCard(ledger, id, at), isWide ? graphRows + 1 : null)}
        </Box>
      </Box>
    )
  })

  // The band: Context exchange, the run's pieces of context as a timeline, above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (s.band === 'off' || e.props.hasSurvey) {
      mounts.band = null
      return rest
    }
    await ensureTheme($, s)
    const fill = await read($, fillAtom)
    await read($, nowAtom)
    const at = await $.clock.now()
    const { base: ledger } = await baseOf($, at)
    const scene = await sceneOf($)
    const run = liveRun(ledger)
    const runId = run?.id ?? null
    const ctx = contextOf(ledger, runId)
    const runSavings = runId === null ? null : formatSavings(savingsVs(ledger, s.baselineModel, runId), shortModel)
    const last = ctx.items[ctx.items.length - 1]
    const isRecent = e.props.isWorking || (last !== undefined && at - last.at < BAND_LINGER_MS)
    if (ctx.items.length === 0 || (s.band === 'auto' && !isRecent)) {
      mounts.band = null
      return rest
    }
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const columns = Math.max(20, e.props.bodyColumns - 1)
    const summary = `moved ≈${formatTokens(ctx.moved)} tokens between agents · ${ctx.items.length} nodes`
    const head = (
      <Box key="cx-h" flexDirection="row" justifyContent="space-between">
        <Text key="t">
          <Text key="n" bold>{'Context exchange '}</Text>
          <Text key="b" color={hex(COLOR.accent)}>{`◆ ${routerName(view)} · context moved between agents`}</Text>
        </Text>
        <Text key="s" color={hex(COLOR.muted)}>{summary}</Text>
      </Box>
    )
    if (e.props.maxRows < BAND_RASTER_ROWS + 3) {
      mounts.band = null
      return (
        <Box flexDirection="column">
          {head}
          {fillLine(els, fill, ledger, runId, runSavings)}
          {rest}
        </Box>
      )
    }
    let picture: RenderElement
    if (e.surface === 'terminal') {
      const { Image, Raster } = $.ui.resolve(e)
      if (await drawsPixels($, s)) {
        const mount = { requestId: e.requestId, columns, rows: BAND_RASTER_ROWS, isImage: true }
        noteMount('band', mount)
        picture = <Image key={IMAGE_KEY.band} source={{ png: frameFor('band', scene, s, mount, false) }} columns={columns} rows={BAND_RASTER_ROWS} alt={`Context exchange: ${ctx.items.length} pieces`} />
      } else {
        noteMount('band', { requestId: e.requestId, columns, rows: BAND_RASTER_ROWS, isImage: false })
        picture = <Raster key="context" columns={columns} rows={BAND_RASTER_ROWS} cells={drawContext(ctx.items, ledger.agents, mainModelOf(ledger), at, columns, BAND_RASTER_ROWS).encode()} />
      }
    } else {
      const { Svg } = $.ui.resolve(e)
      const pxWidth = Math.max(240, columns * 8)
      picture = (
        <Svg
          key="context"
          source={contextSvg(ctx.items, ledger.agents, mainModelOf(ledger), at, pxWidth, 72)}
          alt={`Context exchange: ${ctx.items.length} pieces, ${summary}`}
          width={pxWidth}
          height={72}
          isInteractive
        />
      )
    }
    return (
      <Box flexDirection="column">
        {head}
        {picture}
        {fillLine(els, fill, ledger, runId, runSavings)}
        {rest}
      </Box>
    )
  })
}
