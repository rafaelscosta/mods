// The Timeline tab: one lane per loop of a run (main, then its subagents in tree order), a bar
// in the model's colour from start to end, a notch for every tool call, a time axis, and the
// replay cursor. Text cells, so it draws the same on every surface.

import type { RenderElement } from 'claude-code'

import type { Ledger } from '../types'
import type { Card } from './cards'
import { agentLabel, agentModel } from './graph'
import { agentCost, formatElapsed, formatTotal } from './ledger'
import { COLOR, hex, mix, modelColor, shortModel } from './theme'
import { cardHeight, cardRow, hoverCard } from './view'
import type { Els } from './view'

export type Lane = {
  id: string
  depth: number
  label: string
  model: string | null
  start: number
  end: number | null
  status: 'running' | 'done' | 'failed'
  ticks: number[]
}

const ACTIONS = new Set(['read', 'write', 'run'])

/** Lanes of run `runId`: main first, then each subagent under its parent, oldest first. */
export function lanesOf(ledger: Ledger, runId: string, mainModel: string | null, at: number): Lane[] {
  const run = ledger.runs.find(r => r.id === runId)
  const agents = ledger.agents.filter(a => a.runId === runId)
  const ids = new Set(agents.map(a => a.id))
  const ticks = (id: string | null) => ledger.items.filter(i => i.runId === runId && i.agentId === id && ACTIONS.has(i.kind)).map(i => i.at)
  const lanes: Lane[] = [
    {
      id: 'main',
      depth: 0,
      label: 'main',
      model: mainModel,
      start: run?.startedAt ?? agents[0]?.startedAt ?? at,
      end: run?.endedAt ?? null,
      status: run && run.endedAt !== null && run.status !== 'completed' ? 'failed' : run && run.endedAt !== null ? 'done' : 'running',
      ticks: ticks(null),
    },
  ]
  const walk = (parent: string | null, depth: number) => {
    const kids = agents
      .filter(a => (parent === null ? a.parentId === null || !ids.has(a.parentId) : a.parentId === parent))
      .sort((x, y) => x.startedAt - y.startedAt)
    for (const a of kids) {
      lanes.push({
        id: a.id,
        depth,
        label: agentLabel(a),
        model: agentModel(a),
        start: a.startedAt,
        end: a.endedAt,
        status: a.status === 'running' ? 'running' : a.status === 'completed' ? 'done' : 'failed',
        ticks: ticks(a.id),
      })
      walk(a.id, depth + 1)
    }
  }
  walk(null, 1)
  return lanes
}

/** A round axis step for `ms` across `cells` columns: labels at least about ten cells apart. */
export function axisStep(ms: number, cells: number): number {
  const steps = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000]
  const perCell = ms / Math.max(1, cells)
  return steps.find(step => step / perCell >= 10) ?? 3_600_000
}

type Cell = { ch: string; fg: number | null; bg: number | null }

/** Runs of cells with the same colours, as nested Texts. */
function paint(els: Els, cells: readonly Cell[], key: string): RenderElement[] {
  const { Text } = els
  const out: RenderElement[] = []
  let i = 0
  while (i < cells.length) {
    const first = cells[i]
    if (!first) break
    let text = ''
    let j = i
    while (j < cells.length && cells[j]?.fg === first.fg && cells[j]?.bg === first.bg) text += cells[j++]?.ch ?? ' '
    out.push(
      <Text key={`${key}${i}`} color={first.fg === null ? undefined : hex(first.fg)} backgroundColor={first.bg === null ? undefined : hex(first.bg)}>
        {text}
      </Text>,
    )
    i = j
  }
  return out
}

const fit = (text: string, max: number): string => (text.length <= max ? text : max <= 1 ? text.slice(0, max) : `${text.slice(0, max - 1)}…`)

/** The Timeline of run `runId` at `at`, `width` columns wide; `cursorAt` marks a replay's moment. */
export function timelineView(els: Els, ledger: Ledger, runId: string | null, mainModel: string | null, at: number, width: number, cardOf: (id: string) => Card | null, cursorAt: number | null): RenderElement {
  const { Box, Text } = els
  const run = ledger.runs.find(r => r.id === runId)
  if (!run || runId === null) {
    return (
      <Box key="timeline" flexDirection="column" borderStyle="round" borderColor={hex(COLOR.dim)} paddingX={1} width={width}>
        <Text key="h" bold>Timeline</Text>
        <Text key="none" color={hex(COLOR.muted)}>No run yet.</Text>
      </Box>
    )
  }
  const lanes = lanesOf(ledger, runId, mainModel, at)
  const start = run.startedAt
  const end = Math.max(start + 1000, run.endedAt ?? at, ...lanes.map(l => l.end ?? at))
  const labelW = Math.min(26, Math.max(12, ...lanes.map(l => l.depth * 2 + l.label.length + 2)))
  const statW = 18
  const barW = Math.max(10, width - 4 - labelW - statW)
  const col = (t: number): number => Math.max(0, Math.min(barW - 1, Math.floor(((t - start) / (end - start)) * barW)))
  const step = axisStep(end - start, barW)
  const grid = new Set<number>()
  for (let t = step; t < end - start; t += step) grid.add(col(start + t))

  const rows = lanes.map((lane, index) => {
    const base = lane.status === 'failed' ? COLOR.bad : modelColor(lane.model)
    const fill = lane.status === 'done' ? mix(base, COLOR.bg, 0.45) : base
    const cells: Cell[] = Array.from({ length: barW }, (_, c) => (grid.has(c) ? { ch: '·', fg: COLOR.dim, bg: null } : { ch: ' ', fg: null, bg: null }))
    const from = col(lane.start)
    const to = col(lane.end ?? at)
    for (let c = from; c <= to; c++) cells[c] = { ch: ' ', fg: null, bg: fill }
    if (lane.status === 'running') cells[to] = { ch: '▌', fg: mix(base, 0xffffff, 0.35), bg: fill }
    const count = new Map<number, number>()
    for (const t of lane.ticks) count.set(col(t), (count.get(col(t)) ?? 0) + 1)
    for (const [c, n] of count) {
      const cell = cells[c]
      if (cell) cells[c] = { ch: n > 2 ? '┃' : '│', fg: cell.bg === null ? base : COLOR.bg, bg: cell.bg }
    }
    if (cursorAt !== null) {
      const c = col(cursorAt)
      const cell = cells[c]
      if (cell) cells[c] = { ch: '┃', fg: COLOR.accent, bg: cell.bg }
    }
    const spent = lane.id === 'main' ? null : agentCost(ledger, lane.id)
    const duration = formatElapsed((lane.end ?? at) - lane.start)
    const stat = `${duration}${spent ? ` · ${formatTotal(spent.usd, spent.unknown, spent.requests)}` : ''}`
    const tree = lane.depth > 0 ? `${'  '.repeat(lane.depth - 1)}└ ` : ''
    const nameW = Math.max(2, labelW - tree.length)
    return (
      <Box key={`lane-${lane.id}`} flexDirection="row" hover={{ scope: `rl-lane-${lane.id}` }}>
        <Text key="l">
          <Text key="tree" color={hex(COLOR.muted)}>{tree}</Text>
          <Text key="n" color={hex(lane.status === 'done' ? COLOR.muted : COLOR.text)} bold={lane.status === 'running'}>
            {fit(lane.label, nameW - 1).padEnd(nameW)}
          </Text>
        </Text>
        <Text key="bar">{paint(els, cells, 'c')}</Text>
        <Text key="s" color={hex(lane.status === 'running' ? COLOR.sonnet : COLOR.muted)}>{` ${fit(stat, statW - 1).padStart(statW - 1)}`}</Text>
      </Box>
    )
  })

  // The axis: round times under the bars, none overlapping.
  const axis: string[] = Array.from({ length: barW }, () => ' ')
  let free = 0
  for (let t = 0; t <= end - start; t += step) {
    const c = col(start + t)
    const text = t === 0 ? '0s' : formatElapsed(t)
    if (c < free || c + text.length > barW) continue
    for (let k = 0; k < text.length; k++) axis[c + k] = text[k] ?? ' '
    free = c + text.length + 2
  }
  const models = [...new Set(lanes.map(l => l.model).filter((m): m is string => m !== null))]
  const tools = lanes.reduce((n, l) => n + l.ticks.length, 0)
  return (
    <Box key="timeline" flexDirection="column" borderStyle="round" borderColor={hex(COLOR.dim)} paddingX={1} width={width}>
      <Box key="h" flexDirection="row" justifyContent="space-between">
        <Text key="t" wrap="truncate-end">
          <Text key="n" bold>{'Timeline '}</Text>
          <Text key="r" color={hex(COLOR.muted)}>{`"${fit(run.label, Math.max(10, width - 60))}"`}</Text>
        </Text>
        <Text key="s" color={hex(COLOR.muted)}>{`${lanes.length - 1} subagents · ${tools} tool calls · ${formatElapsed(end - start)}`}</Text>
      </Box>
      {rows}
      <Text key="axis" color={hex(COLOR.muted)}>{`${' '.repeat(labelW)}${axis.join('')}`}</Text>
      <Text key="legend" wrap="truncate-end">
        {models.map((m, i) => (
          <Text key={`m${i}`}>
            <Text key="d" color={hex(modelColor(m))}>{'■ '}</Text>
            <Text key="n" color={hex(COLOR.muted)}>{`${shortModel(m)}   `}</Text>
          </Text>
        ))}
        <Text key="tick" color={hex(COLOR.muted)}>{'│ tool call   ▌ running   '}</Text>
        {cursorAt !== null && <Text key="cur" color={hex(COLOR.accent)}>{'┃ replay'}</Text>}
        <Text key="hint" color={hex(COLOR.dim)}>{cursorAt === null ? '   hover a lane for its card' : ''}</Text>
      </Text>
      {lanes.map((lane, index) => {
        const card = cardOf(lane.id)
        // The box's rows: the title, a row per lane, the axis and the legend.
        const boxRows = lanes.length + 3
        return card ? hoverCard(els, card, `rl-lane-${lane.id}`, cardRow(index + 1, index + 1, boxRows, cardHeight(card)), labelW + 3, boxRows) : null
      })}
    </Box>
  )
}
