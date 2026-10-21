// The pane's sections, drawn the same on every surface from Box, Text and Button.
// The graph itself (a Raster or an Svg) is handed in by the render hook.

import type { Elements, RenderElement } from 'claude-code'

import type { Ledger, LedgerContextFill, LedgerRecommendation, LedgerRun } from '../types'
import { CARD_WIDTH, trimLines, wrapCard } from './cards'
import type { Card } from './cards'
import { agentCost, decisionFor, formatElapsed, formatTokens, formatTotal, formatUsd, clockLocal, totals } from './ledger'
import { agentLabel, agentModel, roleName } from './graph'
import { ease } from './live'
import { PRICES_AS_OF } from './prices'
import { shares } from './router'
import { COLOR, hex, mix, modelColor, shortModel } from './theme'

export type Els = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

/** What moves: the odometer's value, the savings line, live output per loop. */
export type Motion = {
  /** The session's known cost as the odometer shows it this frame. */
  shownUsd: number | null
  /** "routing saved ≈$0.84 (62%) vs all opus-5.5", or null. */
  savings: string | null
  saved: number
  /** A loop's live output: braille sparkline of the last 16 s and tokens per second now. */
  live: (loop: string) => { spark: string; rate: number } | null
}

export const STILL: Motion = { shownUsd: null, savings: null, saved: 0, live: () => null }

/** How far a decision's bars have grown, `at` ms after it arrived. */
export const raceProgress = (at: number, decidedAt: number): number => ease(at - decidedAt, 650)

export type ViewSettings = {
  isJev: boolean
  routing: 'recommend' | 'auto'
  /** Roles the roster always lists (registered run-ledger roles). */
  roles: readonly string[]
}

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
export const spinner = (at: number): string => SPIN[Math.floor(at / 120) % SPIN.length] ?? '⠋'

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** A bar `width` cells long filled to `value` (0..1), in eighths of a cell. */
export function bar(value: number, width: number): { filled: string; empty: string } {
  const v = Math.max(0, Math.min(1, value))
  const eighths = Math.round(v * width * 8)
  const full = Math.floor(eighths / 8)
  const part = EIGHTHS[eighths % 8] ?? ''
  const filled = '█'.repeat(full) + part
  return { filled, empty: '─'.repeat(Math.max(0, width - full - (part ? 1 : 0))) }
}

const fit = (text: string, max: number): string => (text.length <= max ? text : max <= 1 ? text.slice(0, max) : `${text.slice(0, max - 1)}…`)

export const routerName = (s: ViewSettings): string => (s.isJev ? 'Jev' : 'local router')

const padCell = (text: string, width: number): string => (text.length >= width ? fit(text, width) : text + ' '.repeat(width - text.length))

/** Rows a card takes as drawn: its border, its title, its lines wrapped to the card. */
export const cardHeight = (card: Card): number => wrapCard(card, CARD_WIDTH - 4).lines.length + 3

/**
 * The row a card `height` rows tall starts on, beside an item on rows `first`..`last` of a box
 * with `rows` content rows: the row under the item when it fits there (or the item's own, set
 * `isBeside`), else as low as it fits, never above the box's first row: a box's border is
 * painted over whatever crosses it.
 */
export function cardRow(first: number, last: number, rows: number, height: number, isBeside = false): number {
  return Math.max(0, Math.min(isBeside ? first : last + 1, rows - height))
}

/**
 * A card, hidden until any element of hover group `scope` is under the pointer (the row it
 * belongs to): placed `top` rows and `left` columns into the box it is drawn in, over what is
 * there, moving nothing. Drawn after the box's rows, so it paints over them. At most `rows` tall.
 */
export function hoverCard(els: Els, card: Card, scope: string, top: number, left: number, rows = Infinity): RenderElement {
  const { Box, Text } = els
  const inner = CARD_WIDTH - 4
  const bg = hex(COLOR.bg)
  // Every line wrapped to the card; where the box is too short, the last rows say how many were left out.
  const drawn = wrapCard(card, inner)
  const lines = trimLines(drawn.lines, Math.max(1, rows - 3), hex(COLOR.muted))
  return (
    <Box position="absolute" top={top} left={left} width={CARD_WIDTH} display="none" hover={{ display: 'flex', scope }} flexDirection="column" borderStyle="round" borderColor={card.color} backgroundColor={bg} paddingX={1}>
      <Text key="t" bold color={card.color} backgroundColor={bg}>{padCell(drawn.title, inner)}</Text>
      {lines.map((l, i) => (
        <Text key={`c${i}`} color={l.color ?? undefined} bold={l.bold} backgroundColor={bg}>
          {padCell(l.text, inner)}
        </Text>
      ))}
    </Box>
  )
}

export type View = 'live' | 'ledger' | 'timeline'

export type HeaderActions = {
  onView: (v: View) => void
  onExport: () => void
  onClose: () => void
  /** Starts a replay of the run from its first event, or ends one. */
  onReplay: () => void
}

/** A replay under way: where it stands, and its controls. */
export type ReplayInfo = {
  /** "0:41 / 2:19". */
  position: string
  progress: number
  /** "event 12/37". */
  event: string
  isPlaying: boolean
  onStep: (dir: -1 | 1) => void
  onPlay: () => void
}

/** The run the live view follows: the one running, else the latest. */
export function liveRun(ledger: Ledger): LedgerRun | undefined {
  const run = ledger.runs.find(r => r.id === ledger.currentRunId) ?? ledger.runs[ledger.runs.length - 1]
  // A background subagent's hand-back starts a main-loop turn of its own (source `agent:<id>`), with no
  // agents of its own: the live view stays on the run that spawned that agent. Its requests stay its own.
  if (run === undefined || !run.source.startsWith('agent:')) return run
  const agentId = run.source.slice('agent:'.length)
  const spawnedIn = ledger.agents.find(a => a.id === agentId)?.runId
  return ledger.runs.find(r => r.id === spawnedIn) ?? run
}

export type RosterRow = { role: string; decision: LedgerRecommendation | undefined; isRole: boolean }

/** The roster: registered roles first, then every subagent type this session spawned or routed. */
export function rosterRows(ledger: Ledger, runId: string | null, s: ViewSettings): RosterRow[] {
  const types: string[] = [...s.roles]
  for (const t of [...ledger.agents.map(a => a.type), ...ledger.recommendations.map(r => r.agentType)]) {
    if (!types.includes(t) && t !== 'fork') types.push(t)
  }
  return types.map(role => ({ role, decision: runId === null ? undefined : decisionFor(ledger, runId, role), isRole: s.roles.includes(role) }))
}

export function header(els: Els, s: ViewSettings, ledger: Ledger, view: View, actions: HeaderActions, motion: Motion = STILL, replay: ReplayInfo | null = null, demo = false): RenderElement {
  const { Box, Text, Button } = els
  const t = totals(ledger)
  const shown = motion.shownUsd ?? t.knownUsd
  return (
    <Box key="head" flexDirection="column">
      <Box key="title" flexDirection="row" justifyContent="space-between">
        <Text key="name" bold color={hex(COLOR.accent)}>
          {'◆ run-ledger '}
          <Text key="sub" color={hex(COLOR.text)} bold>
            Sub-agent model allocation
          </Text>
          {demo && <Text key="demo" color={hex(COLOR.bg)} backgroundColor={hex(COLOR.sonnet)} bold>{' DEMO '}</Text>}
        </Text>
        <Text key="badge" color={hex(COLOR.bg)} backgroundColor={hex(s.isJev ? COLOR.accent : COLOR.muted)} bold>
          {` ◆ ${s.isJev ? 'Jev routing' : 'local router'} · ${s.routing === 'auto' ? 'auto' : 'recommend'} `}
        </Text>
      </Box>
      <Box key="tabs" flexDirection="row" justifyContent="space-between">
        <Box key="buttons" flexDirection="row" gap={1}>
          <Button key="live" label="Live" hotkey="l" variant={view === 'live' && replay === null ? 'primary' : 'secondary'} onPress={() => actions.onView('live')} />
          <Button key="timeline" label="Timeline" hotkey="t" variant={view === 'timeline' ? 'primary' : 'secondary'} onPress={() => actions.onView('timeline')} />
          <Button key="ledger" label="Ledger" hotkey="g" variant={view === 'ledger' ? 'primary' : 'secondary'} onPress={() => actions.onView('ledger')} />
          <Button key="replay" label={replay === null ? 'Replay' : 'End replay'} hotkey="r" variant={replay === null ? 'secondary' : 'primary'} onPress={actions.onReplay} />
          <Button key="export" label="Export" hotkey="e" onPress={actions.onExport} />
          <Button key="close" label="Close" hotkey="q" role="dismiss" onPress={actions.onClose} />
        </Box>
      </Box>
      <Box key="spend" flexDirection="row" justifyContent="flex-end">
        <Text key="spent" wrap="truncate-end">
          {motion.savings !== null && (
            <Text key="saved" color={hex(motion.saved > 0 ? COLOR.ok : COLOR.sonnet)} bold>{`${motion.savings}  `}</Text>
          )}
          <Text key="cost" color={hex(COLOR.muted)}>{`${demo ? 'demo' : 'session'} ${formatTotal(shown, t.unknownCost, t.requests)} API est.`}</Text>
        </Text>
      </Box>
      {replay !== null && replayBar(els, replay)}
    </Box>
  )
}

/** The replay's bar: where it stands in the run, and back, play and forward. */
export function replayBar(els: Els, r: ReplayInfo): RenderElement {
  const { Box, Text, Button } = els
  const b = bar(r.progress, 24)
  return (
    <Box key="replay" flexDirection="column" borderStyle="round" borderColor={hex(COLOR.accent)} paddingX={1}>
      <Text key="where" wrap="truncate-end">
        <Text key="h" bold color={hex(COLOR.accent)}>{r.isPlaying ? '▶ REPLAY ' : '❚❚ REPLAY '}</Text>
        <Text key="p">{`${r.position}  `}</Text>
        <Text key="f" color={hex(COLOR.accent)}>{b.filled}</Text>
        <Text key="e" color={hex(COLOR.dim)}>{b.empty}</Text>
        <Text key="ev" color={hex(COLOR.muted)}>{`  ${r.event}`}</Text>
      </Text>
      <Box key="controls" flexDirection="row" gap={2}>
        <Button key="step-back" plain hotkey="b" label="◀ back" onPress={() => r.onStep(-1)} />
        <Button key="play" plain hotkey="p" label={r.isPlaying ? 'pause' : 'play'} onPress={r.onPlay} />
        <Button key="step-fwd" plain hotkey="f" label="forward ▶" onPress={() => r.onStep(1)} />
        <Text key="keys" color={hex(COLOR.dim)} wrap="truncate-end">or ←/→ and space after a click on the graph</Text>
      </Box>
    </Box>
  )
}

/** The roster's rows appear one after another as the pane opens, this many ms apart. */
const CASCADE_MS = 70

export function roster(els: Els, ledger: Ledger, runId: string | null, mainModel: string | null, s: ViewSettings, at: number, width: number, motion: Motion = STILL, introMs: number | null = null): RenderElement {
  const mainLive = motion.live('main')
  const { Box, Text } = els
  const rows = rosterRows(ledger, runId, s)
  const revealed = introMs === null ? Infinity : Math.floor(introMs / CASCADE_MS)
  const nameWidth = Math.min(24, Math.max(10, ...rows.map(r => roleName(r.role).length + 1)))
  return (
    <Box key="roster" flexDirection="column" borderStyle="round" borderColor={hex(COLOR.dim)} paddingX={1} width={width}>
      <Box key="h" flexDirection="row" justifyContent="space-between">
        <Text key="t" bold>Model roster</Text>
        <Text key="r" color={hex(COLOR.accent)}>{`◆ ${routerName(s)}`}</Text>
      </Box>
      <Box key="main" flexDirection="row" justifyContent="space-between">
        <Text key="n" color={hex(COLOR.muted)}>main</Text>
        <Text key="m">
          {mainLive !== null && <Text key="spark" color={hex(modelColor(mainModel))}>{`${mainLive.spark} `}</Text>}
          {mainLive !== null && <Text key="rate" color={hex(COLOR.muted)}>{`${Math.round(mainLive.rate)} tok/s  `}</Text>}
          <Text key="v" color={hex(modelColor(mainModel))} bold>{`${shortModel(mainModel)}  (fixed)`}</Text>
        </Text>
      </Box>
      {rows.length === 0 && (
        <Text key="none" color={hex(COLOR.muted)}>
          No subagents yet. /run-ledger roles on registers five roles to route.
        </Text>
      )}
      {rows.map((r, i) => {
        const d = r.decision
        const name = fit(roleName(r.role), nameWidth - 1).padEnd(nameWidth)
        if (i >= revealed) {
          return (
            <Box key={`r${i}`} flexDirection="row">
              <Text key="n">{' '}</Text>
            </Box>
          )
        }
        if (d?.status === 'deciding') {
          return (
            <Box key={`r${i}`} flexDirection="row" justifyContent="space-between" backgroundColor={hex(mix(COLOR.accent, COLOR.bg, 0.85))}>
              <Text key="n">{name}</Text>
              <Text key="m" color={hex(COLOR.accent)}>{`${routerName(s)} deciding ${spinner(at)}`}</Text>
            </Box>
          )
        }
        if (!d || d.model === null) {
          return (
            <Box key={`r${i}`} flexDirection="row" justifyContent="space-between">
              <Text key="n">{name}</Text>
              <Text key="m" color={hex(COLOR.dim)}>{d ? `${d.status}: inherit` : 'inherit (default)'}</Text>
            </Box>
          )
        }
        const stats = `score ${d.score === null ? '–' : d.score.toFixed(2)} · p ${d.confidence === null ? '–' : d.confidence.toFixed(2)}`
        return (
          <Box key={`r${i}`} flexDirection="row" justifyContent="space-between">
            <Text key="n">{name}</Text>
            <Text key="m">
              <Text key="s" color={hex(COLOR.accent)}>{`${stats}  `}</Text>
              <Text key="v" color={hex(modelColor(d.model))} bold>{shortModel(d.model)}</Text>
              <Text key="a" color={hex(COLOR.muted)}>{d.applied ? ' ✓' : ''}</Text>
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

export function decisionCard(els: Els, ledger: Ledger, runId: string | null, s: ViewSettings, at: number, width: number): RenderElement {
  const { Box, Text } = els
  const decisions = ledger.recommendations.filter(r => r.runId === runId)
  const latest = decisions[decisions.length - 1]
  const inner = Math.max(30, width - 4)
  const title = (
    <Box key="h" flexDirection="row" justifyContent="space-between">
      <Text key="t" bold color={hex(COLOR.accent)}>
        {`◆ ${routerName(s)} · decision`}
        {latest ? <Text key="role" color={hex(COLOR.text)}>{`   role: ${roleName(latest.agentType)}`}</Text> : null}
      </Text>
      <Text key="c" color={hex(COLOR.muted)}>cost · latency · quality · context fit</Text>
    </Box>
  )
  if (!latest) {
    return (
      <Box key="decision" flexDirection="column" borderStyle="round" borderColor={hex(mix(COLOR.accent, COLOR.bg, 0.4))} paddingX={1} width={width}>
        {title}
        <Text key="w" color={hex(COLOR.muted)}>{'   waiting for a subagent to route'}</Text>
      </Box>
    )
  }
  const split = latest.ranking.length > 0 ? shares(latest.ranking) : []
  const barWidth = Math.max(8, inner - 38)
  const routed = decisions.filter(d => d.status === 'ok' && d.model !== null)
  const roles = [...new Set(routed.map(d => d.agentType))]
  const allValid = routed.every(d => d.validated)
  const top = latest.ranking.find(c => c.model === latest.model) ?? latest.ranking[0]
  const value = (v: number | null): string => (v === null ? '–' : v.toFixed(2))
  const criteria = top
    ? `cost ${value(top.criteria.cost)} · latency ${value(top.criteria.latency)} · quality ${value(top.criteria.quality)} · fit ${value(top.criteria.fit)}`
    : ''
  return (
    <Box key="decision" flexDirection="column" borderStyle="round" borderColor={hex(mix(COLOR.accent, COLOR.bg, 0.4))} paddingX={1} width={width}>
      {title}
      {latest.status === 'deciding' && (
        <Text key="d" color={hex(COLOR.accent)}>{`   ${routerName(s)} is weighing the models ${spinner(at)}`}</Text>
      )}
      {latest.status !== 'deciding' && latest.ranking.length === 0 && (
        <Text key="x" color={hex(latest.status === 'ok' ? COLOR.text : COLOR.muted)}>
          {`   ${latest.model ? shortModel(latest.model) : 'no model'} · ${fit(latest.reason, inner - 20)}`}
        </Text>
      )}
      {latest.ranking.slice(0, 4).map((c, i) => {
        const b = bar(c.score * raceProgress(at, latest.at), barWidth)
        const color = hex(modelColor(c.model))
        const share = split[i]
        return (
          <Text key={`k${i}`} wrap="truncate-end">
            <Text key="i" color={hex(COLOR.muted)}>{`${i + 1} `}</Text>
            <Text key="m" color={color} bold={i === 0}>{fit(shortModel(c.model), 16).padEnd(17)}</Text>
            <Text key="s" color={hex(COLOR.muted)}>{`score ${c.score.toFixed(2)} `}</Text>
            <Text key="f" color={color}>{b.filled}</Text>
            <Text key="e" color={hex(COLOR.dim)}>{b.empty}</Text>
            <Text key="p" bold>{share !== null && share !== undefined ? ` ${share.toFixed(2)}` : ''}</Text>
          </Text>
        )
      })}
      {latest.ranking.length > 0 && (
        <Text key="why" color={hex(COLOR.muted)} wrap="truncate-end">{`   ${latest.reason} · ${criteria}`}</Text>
      )}
      {roles.length > 1 && (
        <Text key="sum" wrap="wrap">
          <Text key="h" color={hex(COLOR.ok)}>
            {`   all ${roles.length} roles routed${allValid ? ' · host validated' : ' · some models not validated'}  `}
          </Text>
          {roles.map((role, i) => {
            const d = [...routed].reverse().find(x => x.agentType === role)
            const color = hex(modelColor(d?.model ?? null))
            return (
              <Text key={`sum${i}`}>
                <Text key="dot" color={color}>{'● '}</Text>
                <Text key="r">{`${roleName(role)} `}</Text>
                <Text key="m" color={color}>{`${shortModel(d?.model ?? null)}  `}</Text>
              </Text>
            )
          })}
        </Text>
      )}
      {latest.router === 'jev' && (
        <Text key="cost" color={hex(COLOR.muted)}>{`   Jev's own cost ${formatUsd(latest.jevCost.usd)}`}</Text>
      )}
    </Box>
  )
}

const statusText = (status: string, spent: { usd: number; unknown: number; requests: number }): string =>
  `${status} · ${formatTotal(spent.usd, spent.unknown, spent.requests)}`

/**
 * Live spawns. Under the pointer a row shows its agent's card: to the left, over the graph
 * beside the list (`besideRows` tall), or with no room there inside the list, on its right.
 */
export function spawns(els: Els, ledger: Ledger, runId: string | null, at: number, width: number, maxItems: number, motion: Motion = STILL, cardOf: (id: string) => Card | null = () => null, besideRows: number | null = null): RenderElement {
  const { Box, Text } = els
  const agents = ledger.agents.filter(a => a.runId === runId || a.status === 'running').slice().reverse()
  const inner = Math.max(20, width - 4)
  const shownCount = Math.min(agents.length, maxItems)
  const listRows = 1 + 2 * shownCount + (agents.length > maxItems ? 1 : 0)
  return (
    <Box key="spawns" flexDirection="column" borderStyle="round" borderColor={hex(COLOR.dim)} paddingX={1} width={width}>
      <Box key="h" flexDirection="row" justifyContent="space-between">
        <Text key="t" bold>Live spawns</Text>
        <Text key="n" color={hex(COLOR.muted)}>{`${agents.length} spawned`}</Text>
      </Box>
      {agents.length === 0 && <Text key="none" color={hex(COLOR.dim)}>none yet</Text>}
      {agents.slice(0, maxItems).map((a, i) => {
        const model = agentModel(a)
        const color = hex(modelColor(model))
        const spent = agentCost(ledger, a.id)
        const nested = a.parentId !== null
        const live = a.status === 'running' ? motion.live(a.id) : null
        const elapsed = formatElapsed((a.endedAt ?? at) - a.startedAt)
        const status =
          a.status === 'running' ? `${spinner(at)} running ${elapsed}` : a.status === 'completed' ? `${elapsed} · done` : `✗ ${a.status}`
        const statusColor = a.status === 'running' ? COLOR.sonnet : a.status === 'completed' ? COLOR.muted : COLOR.bad
        return (
          <Box key={`sp-${a.id}`} flexDirection="column" hover={{ scope: `rl-spawn-${a.id}` }}>
            <Box key="l1" flexDirection="row" justifyContent="space-between">
              <Text key="n" wrap="truncate-end">
                <Text key="dot" color={color}>{'● '}</Text>
                <Text key="tree" color={hex(COLOR.muted)}>{nested ? '└ ' : ''}</Text>
                <Text key="role" bold>{fit(agentLabel(a), inner - 22)}</Text>
              </Text>
              <Text key="m">
                {live !== null && <Text key="spark" color={color}>{`${live.spark} `}</Text>}
                {live !== null && <Text key="rate" color={hex(COLOR.muted)}>{`${Math.round(live.rate)} tok/s  `}</Text>}
                <Text key="v" color={color}>{shortModel(model)}</Text>
              </Text>
            </Box>
            <Box key="l2" flexDirection="row" justifyContent="space-between">
              <Text key="d" color={hex(COLOR.muted)} wrap="truncate-end">
                {`  ${fit(a.lastAction ?? a.description, Math.max(8, inner - statusText(status, spent).length - 3))}`}
              </Text>
              <Text key="s" color={hex(statusColor)}>
                {statusText(status, spent)}
              </Text>
            </Box>
          </Box>
        )
      })}
      {agents.length > maxItems && <Text key="more" color={hex(COLOR.dim)}>{`+${agents.length - maxItems} more`}</Text>}
      {agents.slice(0, maxItems).map((a, i) => {
        const card = cardOf(a.id)
        if (!card) return null
        const scope = `rl-spawn-${a.id}`
        // Beside the list, over the graph, when there is a graph beside it; else inside the list, on its right.
        return besideRows !== null
          ? hoverCard(els, card, scope, cardRow(1 + 2 * i, 2 + 2 * i, Math.max(besideRows, listRows), cardHeight(card), true), -(CARD_WIDTH + 1), Math.max(besideRows, listRows))
          : hoverCard(els, card, scope, cardRow(1 + 2 * i, 2 + 2 * i, listRows, cardHeight(card)), Math.max(1, inner + 1 - CARD_WIDTH), listRows)
      })}
    </Box>
  )
}

/** The cost ledger: session totals, per-model bars, runs to pick, and the picked run's requests. */
/** The ledger beside /cost (`reconcile`): the engine's own total and what no hook saw. null: not shown (demo, /cost unread). */
export type CostSeen = { engineUsd: number | null; unseenUsd: number | null } | null

export function ledgerView(
  els: Els,
  ledger: Ledger,
  selected: string | null,
  width: number,
  onSelect: (runId: string) => void,
  motion: Motion = STILL,
  seen: CostSeen = null,
): RenderElement {
  const { Box, Text, Button } = els
  const all = totals(ledger)
  const costLine =
    seen === null || seen.engineUsd === null
      ? ''
      : ` · /cost ${formatUsd(seen.engineUsd)}${seen.unseenUsd !== null && seen.unseenUsd >= 0.005 ? ` (~${formatUsd(seen.unseenUsd)} outside hooks)` : ''}`
  const runs = [...ledger.runs].reverse()
  const shown = runs.find(r => r.id === selected) ?? runs[0]
  const t = shown ? totals(ledger, shown.id) : undefined
  const maxUsd = Math.max(0.000001, ...all.byModel.map(m => m.usd))
  const barWidth = Math.max(8, width - 46)
  const requests = shown ? ledger.requests.filter(r => r.runId === shown.id).slice(-10) : []
  return (
    <Box key="ledger" flexDirection="column">
      <Text key="note" color={hex(COLOR.muted)}>
        {`API-rate estimates from list prices as of ${PRICES_AS_OF}, not subscription charges. Missing data shows as unknown.`}
      </Text>
      <Text key="session" bold>
        {`Session: ${all.requests} req · ${formatTotal(all.knownUsd, all.unknownCost, all.requests)}${costLine} · Jev's own cost ${formatTotal(all.jevUsd, all.jevUnknown, all.jevUnknown + (all.jevUsd > 0 ? 1 : 0))}`}
      </Text>
      {costLine !== '' && (
        <Text key="cost-note" color={hex(COLOR.muted)}>
          {'/cost is the engine\'s own total; "outside hooks" is spend no hook sees (calls outside the turn loop).'}
        </Text>
      )}
      {motion.savings !== null && (
        <Text key="saved" color={hex(motion.saved > 0 ? COLOR.ok : COLOR.sonnet)} bold>
          {`${motion.savings} · same tokens priced on that model, net of Jev's own cost`}
        </Text>
      )}
      <Text key="usage" color={hex(COLOR.muted)}>
        {`in ${formatTokens(all.usage.input)} · out ${formatTokens(all.usage.output)} · cache read ${formatTokens(all.usage.cacheRead)} / write ${formatTokens(all.usage.cacheWrite)}${all.usageUnknown > 0 ? ` · ${all.usageUnknown} req tokens unknown` : ''} · retries seen ${all.retries}`}
      </Text>
      <Box key="models" flexDirection="column" borderStyle="round" borderColor={hex(COLOR.dim)} paddingX={1} marginTop={1}>
        <Text key="h" bold>Cost by model</Text>
        {all.byModel.length === 0 && <Text key="none" color={hex(COLOR.dim)}>no requests yet</Text>}
        {all.byModel.map((m, i) => {
          const b = bar(m.usd / maxUsd, barWidth)
          const color = hex(modelColor(m.model))
          return (
            <Text key={`m${i}`} wrap="truncate-end">
              <Text key="n" color={color}>{fit(shortModel(m.model), 16).padEnd(17)}</Text>
              <Text key="f" color={color}>{b.filled}</Text>
              <Text key="e" color={hex(COLOR.dim)}>{b.empty}</Text>
              <Text key="v">{` ${formatTotal(m.usd, m.unknown, m.requests)} · ${m.requests} req`}</Text>
            </Text>
          )
        })}
      </Box>
      <Text key="runs-h" bold>Runs (newest first)</Text>
      {runs.length === 0 && <Text key="runs-none" color={hex(COLOR.dim)}>No runs yet.</Text>}
      {runs.slice(0, 8).map((r, i) => {
        const rt = totals(ledger, r.id)
        const isShown = shown !== undefined && r.id === shown.id
        return (
          <Button
            key={`run-${i}`}
            plain
            variant={isShown ? 'primary' : 'secondary'}
            label={`${isShown ? '▸' : ' '} ${clockLocal(r.startedAt)} ${fit(r.label, 40)} · ${rt.requests} req · ${formatTotal(rt.knownUsd, rt.unknownCost, rt.requests)}`}
            onPress={() => onSelect(r.id)}
          />
        )
      })}
      {shown && t && (
        <Box key="detail" flexDirection="column" marginTop={1}>
          <Text key="d-title" bold>
            {`Run ${clockLocal(shown.startedAt)} · ${shown.label} · ${shown.status}${shown.source === 'session' || shown.source.startsWith('agent:') ? '' : ` · from ${shown.source}`}`}
          </Text>
          <Text key="d-usage" color={hex(COLOR.muted)}>
            {`${t.requests} req · ${formatTotal(t.knownUsd, t.unknownCost, t.requests)} · in ${formatTokens(t.usage.input)} out ${formatTokens(t.usage.output)} · retries seen ${t.retries}`}
          </Text>
          {requests.map((r, i) => (
            <Text key={`d-req-${i}`} color={r.cost.usd === null ? hex(COLOR.muted) : undefined} wrap="truncate-end">
              <Text key="dot" color={hex(modelColor(r.model ?? r.requestedModel))}>{'● '}</Text>
              {`${r.sourceKind}${r.sourcePlugin ? `:${r.sourcePlugin}` : ''} · ${shortModel(r.model ?? r.requestedModel)} · ${
                r.usage
                  ? `in ${formatTokens(r.usage.input)} out ${formatTokens(r.usage.output)} cr ${formatTokens(r.usage.cacheRead)} cw ${formatTokens(r.usage.cacheWrite)}`
                  : 'tokens unknown'
              } · ${formatUsd(r.cost.usd)}${r.cost.basis === 'alias-assumed' ? ' (alias assumed)' : ''}${r.attempt > 0 ? ` · re-send #${r.attempt}` : ''}`}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

/** The bottom line of the band: context fill, the run's cost, agents at work. */
export function fillLine(els: Els, fill: LedgerContextFill | null, ledger: Ledger, runId: string | null, savings: string | null = null): RenderElement {
  const { Text } = els
  const t = runId === null ? undefined : totals(ledger, runId)
  const running = ledger.agents.filter(a => a.status === 'running').length
  const percent = fill?.percent ?? null
  const b = bar((percent ?? 0) / 100, 10)
  const color = percent === null ? COLOR.muted : percent >= 80 ? COLOR.bad : percent >= 60 ? COLOR.sonnet : COLOR.ok
  return (
    <Text key="fill" wrap="truncate-end">
      <Text key="c" color={hex(color)}>
        {percent === null ? '◇ context unknown ' : `◇ context ${percent}% ${formatTokens(fill?.tokens ?? 0)} / ${formatTokens(fill?.window ?? 0)} `}
      </Text>
      <Text key="b" color={hex(color)}>{b.filled}</Text>
      <Text key="e" color={hex(COLOR.dim)}>{b.empty}</Text>
      <Text key="r" color={hex(COLOR.muted)}>
        {`  · run ${t ? formatTotal(t.knownUsd, t.unknownCost, t.requests) : '$0'} API est. · ${running} agent${running === 1 ? '' : 's'} running`}
      </Text>
      {savings !== null && <Text key="s" color={hex(COLOR.ok)}>{`  · ${savings}`}</Text>}
    </Text>
  )
}
