// Laid invisibly over the agent graph (a picture the pointer cannot see into): finds the node
// under the pointer and draws its card beside it. A click pins a card and gives this region the
// keyboard, whose ←/→, space, Home and End drive the replay through the hooks module.

import type { ClientModule } from 'claude-code'

type Hit = { id: string; x: number; y: number; w: number; h: number }
type Line = { text: string; color: string | null; bold: boolean }
type CardData = { title: string; color: string; lines: Line[] }

export type OverlayProps = {
  boxes: Hit[]
  cards: { [id: string]: CardData }
  /** Card width in cells. */
  width: number
  background: string
  muted: string
}

type State = { hover: string | null; pinned: string | null }

const NONE: State = { hover: null, pinned: null }

const pad = (text: string, width: number): string => {
  const chars = [...text]
  return chars.length >= width ? `${chars.slice(0, Math.max(0, width - 1)).join('')}…` : text + ' '.repeat(width - chars.length)
}

const Overlay: ClientModule<OverlayProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state = surface.state ?? NONE
  const hitAt = (x: number, y: number): Hit | undefined => props.boxes.find(b => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h)
  // Set on every call, so the listeners read the newest boxes.
  surface.onPointer(ev => {
    const now = surface.state ?? NONE
    if (ev.type === 'leave') {
      if (now.hover !== null) surface.setState({ ...now, hover: null })
      return
    }
    const hit = hitAt(ev.x, ev.y)
    if (ev.type === 'down' && ev.button === 'left') {
      const pinned = hit === undefined || now.pinned === hit.id ? null : hit.id
      surface.setState({ hover: hit?.id ?? null, pinned })
      surface.post({ kind: 'click', id: hit?.id ?? null })
      return
    }
    const hover = hit?.id ?? null
    if (hover !== now.hover) surface.setState({ ...now, hover })
  })
  surface.onKey(k => surface.post({ kind: 'key', key: k.key }))

  const shown = state.hover ?? state.pinned
  const card = shown === null ? undefined : props.cards[shown]
  const at = props.boxes.find(b => b.id === shown)
  if (!card || !at) return <Box />
  const columns = surface.columns > 0 ? surface.columns : props.width
  // The card is always drawn at its full width: the hooks module wrapped its lines to exactly that
  // (cards.ts wrapCard), so a narrower card would cut them.
  const width = Math.max(16, Math.min(props.width, columns))
  const inner = width - 4
  const roomRight = columns - (at.x + at.w + 1)
  const roomLeft = at.x - 1
  // Beside the node, so it stays in view, only where the whole card fits; else over the picture.
  const isBeside = Math.max(roomRight, roomLeft) >= width
  // Rows: the border's two and the title's one, then the lines, then the hint. Where the picture is
  // shorter than that, the hint gives way first, then the last lines, to a row saying how many.
  const rows = surface.rows > 0 ? surface.rows : card.lines.length + 4
  const room = Math.max(1, rows - 3)
  const showHint = card.lines.length + 1 <= room
  const lines =
    card.lines.length <= room
      ? card.lines
      : [...card.lines.slice(0, room - 1), { text: `… +${card.lines.length - (room - 1)} more lines`, color: props.muted, bold: false }]
  const height = lines.length + 3 + (showHint ? 1 : 0)
  const left = !isBeside
    ? Math.max(0, Math.min(columns - width, at.x + Math.floor(at.w / 2) - Math.floor(width / 2)))
    : roomRight >= width
      ? at.x + at.w + 1
      : at.x - 1 - width
  const top = Math.max(0, Math.min(Math.max(0, rows - height), at.y - 1))
  const isPinned = state.pinned === shown
  return (
    <Box position="absolute" top={top} left={left} width={width} flexDirection="column" borderStyle="round" borderColor={card.color} backgroundColor={props.background} paddingX={1}>
      <Text key="title" bold color={card.color} backgroundColor={props.background}>{pad(`${isPinned ? '◆ ' : ''}${card.title}`, inner)}</Text>
      {lines.map((l, i) => (
        <Text key={`l${i}`} color={l.color ?? undefined} bold={l.bold} backgroundColor={props.background}>
          {pad(l.text, inner)}
        </Text>
      ))}
      {showHint && (
        <Text key="hint" color={props.muted} backgroundColor={props.background}>
          {pad(isPinned ? 'click again to unpin · ←/→ replay' : 'click pins · then ←/→ space replay', inner)}
        </Text>
      )}
    </Box>
  )
}

export default Overlay
