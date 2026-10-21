import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { On, TurnStepInput, TurnUsage } from 'claude-code'

import { cellsToText } from '../hooks/canvas'

const PLUGIN = 'run-ledger'
const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: 'run-ledger',
  props: { title: 'run-ledger', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const
const BAND = {
  plugin: PLUGIN,
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 14, bodyColumns: 110, scroll: { offset: 0, bodyRows: 14 }, view: {} },
} as const

const use = (model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): TurnUsage => ({
  model,
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
})

const helper: Plugin = {
  name: 'helper',
  register: on => {
    on('command.run', { command: 'ask' }, async $ => {
      const reply = await $.model.complete({ model: 'haiku', prompt: 'hi' })
      return { text: reply.isAnswered ? reply.text : 'no answer' }
    })
  },
}

type Exported = {
  totals: { requests: number; retries: number; unknownCost: number; knownUsd: number; jevUsd: number }
  requests: { key: string; runId: string; sourceKind: string; sourcePlugin: string | null; cost: { usd: number | null; basis: string }; attempt: number }[]
  agents: { id: string; runId: string; parentId: string | null; status: string; lastAction: string | null; actualModel: string | null; routed: boolean; result: string | null; contextTokens: number | null }[]
  recommendations: { agentType: string; router: string; status: string; model: string | null; applied: boolean; reason: string; ranking: { model: string }[]; jevCost: { usd: number | null } }[]
  context: { kind: string; label: string; agentId: string | null; fromAgentId: string | null; tokens: number | null }[]
}

type Beneath = {
  /** Variables besides HOME, e.g. the terminal's. */
  env?: { [name: string]: string }
  /** Why the terminal refuses a blit to `key`; undefined takes it. */
  blitDeny?: (key: string) => string | undefined
}

/** The world beneath the plugin: a clock, a store, HOME, files written, logs, and turns answered by `usageFor`. */
function world(on: On, usageFor: (e: TurnStepInput) => TurnUsage | null, textFor: (e: TurnStepInput) => string = () => '', beneath: Beneath = {}) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 3, 12, 0, 0) })
  mock.store(on)
  mock.env(on, { HOME: '/home/tester', ...beneath.env })
  const writes: { path: string; text: string }[] = []
  const modelCalls: string[] = []
  const logs: string[] = []
  const blits: string[] = []
  const images: string[] = []
  const toasts: string[] = []
  const opened: string[] = []
  const played: string[] = []
  on('fs.write', ($, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.play', ($, e) => {
    if (e.clip.asset !== undefined) played.push(e.clip.asset)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.blit', ($, e) => {
    blits.push(e.key)
    if ('source' in e && 'png' in e.source) images.push(e.source.png)
    const deny = beneath.blitDeny?.(e.key)
    return { value: deny === undefined ? {} : { deny } }
  })
  on('turn.step', async function* ($, e) {
    const text = textFor(e)
    if (text !== '') yield { kind: 'text' as const, index: 0, text }
    const usage = usageFor(e)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: usage ? 'end_turn' : null, usage }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine-band" />
  })
  on('model.complete', ($, e) => {
    modelCalls.push(e.model)
    return {
      value: {
        isAnswered: true as const,
        text: 'hello',
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  return { clock, writes, modelCalls, logs, blits, images, toasts, opened, played }
}

let spawnCount = 0
/** The Agent tool's spawn as the engine raises it, the fields a test leaves to the engine filled in. */
function spawn($: Engine, args: { prompt: string; description: string; subagentType: string; model?: string; parentAgentId?: string }) {
  spawnCount += 1
  return $.agent.spawn({
    tool_use_id: `toolu_${spawnCount}`,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
    ...args,
  })
}

const run = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

/** A tool call made inside loop `agentId` (undefined: the main loop). */
function callIn($: Engine, agentId: string | undefined, input: { tool: 'Read'; file_path: string } | { tool: 'Write'; file_path: string; content: string }) {
  const call = { ...input, ...(agentId === undefined ? {} : { agentId }) }
  return $.tool.call(call)
}

async function step($: Engine, input: TurnStepInput) {
  const stream = $.turn.step(input)
  for await (const chunk of stream) void chunk
  return stream.result
}

async function exported($: Engine, writes: { path: string; text: string }[]): Promise<Exported> {
  await run($, 'run-ledger', 'export')
  const json = [...writes].reverse().find(w => w.path.endsWith('.json'))
  expect(json, 'an export was written').toBeDefined()
  return JSON.parse(json?.text ?? '{}')
}

/** Width and height from a base64 PNG's header; zero when it is not a PNG. */
function pngSize(png: string): { width: number; height: number } {
  const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0))
  const isPng = [0x89, 0x50, 0x4e, 0x47].every((v, i) => bytes[i] === v)
  if (!isPng || bytes.length < 24) return { width: 0, height: 0 }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** The PNG and box of a mounted Image. */
async function imageOf(ui: { find: (q: { type?: string; key?: string }) => Promise<{ props: Record<string, unknown> } | undefined> }, key: string) {
  const image = await ui.find({ type: 'Image', key })
  const source = image?.props.source
  const png = typeof source === 'object' && source !== null && 'png' in source && typeof source.png === 'string' ? source.png : ''
  const columns = image?.props.columns
  const rows = image?.props.rows
  return { isDrawn: image !== undefined, png, columns: typeof columns === 'number' ? columns : 0, rows: typeof rows === 'number' ? rows : 0 }
}

/** The text a mounted Raster shows. */
async function rasterText(ui: { find: (q: { type?: string; key?: string }) => Promise<{ props: Record<string, unknown> } | undefined> }, key: string): Promise<string> {
  const raster = await ui.find({ type: 'Raster', key })
  expect(raster, `Raster ${key} is drawn`).toBeDefined()
  const cells = raster?.props.cells
  const columns = raster?.props.columns
  return typeof cells === 'string' && typeof columns === 'number' ? cellsToText(cells, columns).join('\n') : ''
}

describe('counting and attribution', () => {
  test('each request counts once; retries, subagents and unknowns land where they belong', async ($, on) => {
    const { clock, writes, modelCalls } = world(on, e => {
      if (e.turnId === 't2' && e.index === 1) return null // interrupted: no usage
      if (e.turnId === 't2') return use('mystery-model-9', 100, 10) // a model with no price
      if (e.agentId === 'agent-1') return use('claude-haiku-4-5', 3000, 400)
      if (e.index === 0) return use('claude-opus-5-5', 1000, 500, 10_000, 2000)
      return use('claude-opus-5-5', 500, 100)
    })
    let spawnedModel: string | undefined = 'unset'
    on('agent.spawn', ($, e) => {
      spawnedModel = e.model
      return { model: 'claude-haiku-4-5', agentId: 'agent-1' }
    })
    on('tool.call', () => ({ deny: 'test world runs no tools' }))
    let fetches = 0
    on('http.fetch', () => {
      fetches += 1
      return { value: { status: 500, ok: false, headers: {}, text: '' } }
    })

    await $.turn.start({ text: 'fix the flaky test', turnId: 't1' })
    await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
    await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }) // re-send of the same step
    await spawn($, { prompt: 'find the flaky test file', description: 'find test', subagentType: 'Explore' })
    await callIn($, 'agent-1', { tool: 'Read', file_path: '/repo/tests/flaky.test.ts' })
    await step($, { turnId: 't1', index: 1, model: 'claude-opus-5-5', messageCount: 3 })
    await $.turn.complete({
      turnId: 't1', answer: 'done', durationMs: 900, isAborted: false, reason: 'answer',
      usage: use('claude-opus-5-5', 99_999, 99_999), // the turn's summed usage: never added again
    })
    // The background subagent keeps working after its run's turn ended.
    await step($, { turnId: 'sub-1', index: 0, model: 'claude-haiku-4-5', messageCount: 1, agentId: 'agent-1' })
    await clock.advance(12_000)
    await $.turn.complete({ turnId: 'sub-1', agentId: 'agent-1', answer: 'found tests/flaky.test.ts', durationMs: 12_000, isAborted: false, reason: 'answer' })

    await $.turn.start({ text: 'second prompt', turnId: 't2' })
    await step($, { turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
    await step($, { turnId: 't2', index: 1, model: 'claude-opus-5-5', messageCount: 2 })

    const doc = await exported($, writes)
    expect(doc.totals.requests).toBe(6)
    expect(doc.requests.map(r => r.key).sort()).toEqual(
      ['agent-1|sub-1|0|0', 'main|t1|0|0', 'main|t1|0|1', 'main|t1|1|0', 'main|t2|0|0', 'main|t2|1|0'].sort(),
    )
    expect(doc.totals.retries).toBe(1)
    expect(doc.totals.unknownCost).toBe(2)
    // 0.026 + 0.026 (the re-send is billed again) + 0.004 (opus) + 0.005 (haiku)
    expect(doc.totals.knownUsd).toBeGreaterThan(0.060999)
    expect(doc.totals.knownUsd).toBeLessThan(0.061001)
    const sub = doc.requests.find(r => r.key === 'agent-1|sub-1|0|0')
    expect(sub?.runId).toBe('t1')
    expect(sub?.sourceKind).toBe('subagent')
    expect(doc.agents[0]).toMatchObject({
      id: 'agent-1',
      runId: 't1',
      parentId: null,
      status: 'completed',
      actualModel: 'claude-haiku-4-5',
      lastAction: 'Read: /repo/tests/flaky.test.ts',
      result: 'found tests/flaky.test.ts',
      contextTokens: 3000,
    })
    // Jev off: the local router recommends, makes no network call, and leaves the spawn alone.
    expect(fetches).toBe(0)
    expect(spawnedModel).toBeUndefined()
    expect(doc.recommendations[0]).toMatchObject({ agentType: 'Explore', router: 'local', status: 'ok', model: 'claude-haiku-4-5', applied: false })
    expect(doc.recommendations[0]?.ranking).toHaveLength(4)
    // Context moved: the task handed over, the file the subagent read, its result handed back.
    expect(doc.context.map(c => c.kind)).toEqual(['handoff', 'read', 'result'])
    expect(doc.context[0]).toMatchObject({ agentId: 'agent-1', fromAgentId: 'main' })
    expect(doc.context[2]).toMatchObject({ agentId: null, fromAgentId: 'agent-1', label: '← Explore: found tests/flaky.test.ts' })
    // The dashboard and the export made no model calls.
    expect(modelCalls).toHaveLength(0)
  })

  test("a plugin's own model call is attributed to that plugin and the running turn", { plugins: [helper] }, async ($, on) => {
    const { writes, modelCalls } = world(on, () => use('claude-opus-5-5', 10, 10))
    await $.turn.start({ text: 'ask the helper', turnId: 't9' })
    await run($, 'ask')
    expect(modelCalls).toEqual(['haiku'])
    const doc = await exported($, writes)
    expect(doc.requests).toHaveLength(1)
    expect(doc.requests[0]).toMatchObject({ runId: 't9', sourceKind: 'plugin-model-call', sourcePlugin: 'helper' })
    expect(doc.requests[0]?.cost.basis).toBe('alias-assumed')
    expect(doc.requests[0]?.cost.usd).toBeGreaterThan(0.000199)
  })

  test("a plugin's model call between turns gets a run of its own", { plugins: [helper] }, async ($, on) => {
    const { writes } = world(on, () => null)
    await run($, 'ask')
    const doc = await exported($, writes)
    expect(doc.requests[0]).toMatchObject({ sourceKind: 'plugin-model-call', sourcePlugin: 'helper' })
    expect(doc.requests[0]?.runId).toMatch(/^plugin-call-/)
  })

  test('a file one loop wrote and another read is context that crossed between them', async ($, on) => {
    const { writes } = world(on, () => null)
    let n = 0
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `agent-${++n}` }))
    on('tool.call', () => ({ result: 'x'.repeat(400) }) as never)
    await $.turn.start({ text: 'build it', turnId: 't1' })
    await spawn($, { prompt: 'write it', description: 'builder', subagentType: 'run-ledger:builder' })
    await callIn($, 'agent-1', { tool: 'Write', file_path: '/repo/src/route.ts', content: 'export const route = 1\n' })
    await spawn($, { prompt: 'use it', description: 'implementer', subagentType: 'run-ledger:implementer' })
    await callIn($, 'agent-2', { tool: 'Read', file_path: '/repo/src/route.ts' })
    const doc = await exported($, writes)
    const read = doc.context.find(c => c.kind === 'read')
    expect(read).toMatchObject({ label: 'route.ts', agentId: 'agent-2', fromAgentId: 'agent-1' })
    expect(read?.tokens).toBeGreaterThan(90)
  })
})

describe('routing', () => {
  const JEV = { jevEndpoint: 'http://jev.test/recommend', routing: 'auto', autoRouteTypes: 'Explore' }

  test('Jev recommends, auto-routes only eligible subagents, and counts its own cost', { options: JEV }, async ($, on) => {
    const { writes, logs } = world(on, () => null)
    const bodies: string[] = []
    on('http.fetch', ($, e) => {
      bodies.push(e.init?.body ?? '')
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({
            model: 'claude-haiku-4-5', reason: 'read-only search', confidence: 0.7, cost: { usd: 0.0004 },
            ranking: [{ model: 'claude-haiku-4-5', score: 0.86 }, { model: 'claude-sonnet-5-5', score: 0.7 }],
          }),
        },
      }
    })
    const spawned: (string | undefined)[] = []
    let n = 0
    on('agent.spawn', ($, e) => {
      spawned.push(e.model)
      n += 1
      return { model: e.model ?? 'claude-opus-5-5', agentId: `agent-${n}` }
    })
    await $.turn.start({ text: 'route it', turnId: 't1' })
    await spawn($, { prompt: 'search', description: 'search', subagentType: 'Explore' })
    await spawn($, { prompt: 'plan', description: 'plan', subagentType: 'Plan' })
    await spawn($, { prompt: 'search', description: 'pinned', subagentType: 'Explore', model: 'opus' })

    expect(spawned).toEqual(['claude-haiku-4-5', undefined, 'opus'])
    const sent = JSON.parse(bodies[0] ?? '{}')
    expect(sent.schema).toBe('run-ledger.jev-request/1')
    expect(sent.task.agentType).toBe('Explore')
    expect(sent.availableModels).toContainEqual({
      id: 'claude-haiku-4-5',
      usdPerMTok: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
      pricesAsOf: '2026-09-25',
    })
    const doc = await exported($, writes)
    expect(doc.recommendations.map(r => r.applied)).toEqual([true, false, false])
    expect(doc.recommendations.every(r => r.router === 'jev')).toBe(true)
    expect(doc.agents.map(a => a.routed)).toEqual([true, false, false])
    expect(doc.totals.jevUsd).toBeGreaterThan(0.001199)
    expect(doc.totals.jevUsd).toBeLessThan(0.001201)
    expect(logs[0]).toBe('◆ Jev: Explore → haiku-4.5 (score 0.86 · p 0.70)')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: / ◆ Jev routing · auto / })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /◆ Jev · decision/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /haiku-4\.5/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Jev's own cost \$0\.0004/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test("a model Jev was not offered is refused and the engine's choice kept", { options: JEV }, async ($, on) => {
    const { writes } = world(on, () => null)
    on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ model: 'gpt-x', reason: 'cheap' }) } }))
    const spawned: (string | undefined)[] = []
    on('agent.spawn', ($, e) => {
      spawned.push(e.model)
      return { model: 'claude-opus-5-5', agentId: 'agent-1' }
    })
    await spawn($, { prompt: 'search', description: 'search', subagentType: 'Explore' })
    expect(spawned).toEqual([undefined])
    const doc = await exported($, writes)
    expect(doc.recommendations[0]?.status).toBe('error')
    expect(doc.recommendations[0]?.reason).toContain('not among the offered models')
  })

  test('a Jev that does not answer in time leaves the spawn to the engine', { options: JEV }, async ($, on) => {
    const { clock, writes } = world(on, () => null)
    on('http.fetch', () => new Promise(() => undefined))
    on('agent.spawn', ($, e) => ({ model: e.model ?? 'claude-opus-5-5', agentId: 'agent-1' }))
    const spawning = spawn($, { prompt: 'search', description: 'search', subagentType: 'Explore' })
    await clock.advance(5000)
    const result = await spawning
    expect(result.model).toBe('claude-opus-5-5')
    const doc = await exported($, writes)
    expect(doc.recommendations[0]?.reason).toContain('did not answer')
  })

  test('with roles on, five roles are registered, routed per prompt, and auto-routing applies to them', { options: { roles: true, routing: 'auto', intro: false } }, async ($, on) => {
    const { logs } = world(on, () => null)
    const registered: string[] = []
    on('agent.register', ($, e) => {
      registered.push(e.name)
      return { value: { agent: `run-ledger:${e.name}` } }
    })
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 84_000, window: 200_000, percent: 42 }, rateLimits: [] } }))
    const spawned: (string | undefined)[] = []
    on('agent.spawn', ($, e) => {
      spawned.push(e.model)
      return { model: e.model ?? 'claude-opus-5-5', agentId: `agent-${spawned.length}` }
    })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    expect(registered).toEqual(['orchestrator', 'builder', 'implementer', 'executor', 'iterator'])
    await $.turn.start({ text: 'build an auth page', turnId: 't1' })
    expect(logs).toEqual([
      '◆ router: orchestrator → opus-5.5 (score 0.73 · p 0.48) · recommendation',
      '◆ router: builder → sonnet-5.5 (score 0.71 · p 0.40) · recommendation',
      '◆ router: implementer → sonnet-5.5 (score 0.72 · p 0.42) · recommendation',
      '◆ router: executor → haiku-4.5 (score 0.84 · p 0.56) · recommendation',
      '◆ router: iterator → haiku-4.5 (score 0.79 · p 0.45) · recommendation',
    ])
    await spawn($, { prompt: 'plan the auth page', description: 'plan auth page', subagentType: 'run-ledger:orchestrator' })
    await spawn($, { prompt: 'run the tests', description: 'run tests', subagentType: 'run-ledger:executor', parentAgentId: 'agent-1' })
    await spawn($, { prompt: 'look around', description: 'look', subagentType: 'Explore' })
    expect(spawned).toEqual(['claude-opus-5-5', 'claude-haiku-4-5', undefined])

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /all 6 roles routed · host validated/ })).toBeDefined()
    const graph = await rasterText(ui, 'graph')
    for (const word of ['main', 'orchestrator', 'executor', 'Explore', 'haiku-4.5']) expect(graph).toContain(word)
    await ui.unmount()
  })
})

describe('the dashboard', () => {
  test('routing savings and live output speed show while a subagent works', async ($, on) => {
    world(
      on,
      e => (e.agentId === 'agent-1' ? use('claude-haiku-4-5', 20_000, 2_000) : use('claude-opus-5-5', 20_000, 2_000)),
      e => (e.agentId === 'agent-1' ? 'x'.repeat(4000) : ''),
    )
    on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'agent-1' }))
    await $.turn.start({ text: 'save', turnId: 't1' })
    await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
    await spawn($, { prompt: 'look', description: 'look', subagentType: 'Explore' })
    await step($, { turnId: 'sub', index: 0, model: 'claude-haiku-4-5', messageCount: 1, agentId: 'agent-1' })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      // 0.12 + 0.03 spent against 0.24 had both run on opus-5.5
      expect(await ui.find({ type: 'Text', text: /routing saved ≈\$0\.09 \(38%\) vs all opus-5\.5/ }), surface).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /\d+ tok\/s/ }), surface).toBeDefined()
      await ui.unmount()
    }
  })

  test('draws roster, graph and spawns, with estimates and unknowns, on terminal and desktop', { options: { intro: false } }, async ($, on) => {
    world(on, e => (e.index === 1 ? null : use('claude-opus-5-5', 1000, 100)))
    on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'agent-7' }))
    on('tool.call', () => ({ deny: 'no tools here' }))
    await $.turn.start({ text: 'draw me', turnId: 't1' })
    await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
    await step($, { turnId: 't1', index: 1, model: 'claude-opus-5-5', messageCount: 2 })
    await spawn($, { prompt: 'look', description: 'look around', subagentType: 'Explore' })
    await callIn($, 'agent-7', { tool: 'Read', file_path: '/repo/README.md' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const wanted = [
        /Sub-agent model allocation/,
        / ◆ local router · recommend /,
        /session ~\$0\.0060 \+ 1 unknown API est\./,
        /opus-5\.5  \(fixed\)/,
        /◆ local router · decision/,
        /1 running/,
        /Read: \/repo\/README\.md/,
        /running 0s · \$0/,
      ]
      for (const text of wanted) expect(await ui.find({ type: 'Text', text }), `${surface}: ${String(text)}`).toBeDefined()
      if (surface === 'terminal') {
        const graph = await rasterText(ui, 'graph')
        expect(graph).toContain('main')
        expect(graph).toContain('Explore')
        expect(graph).toContain('haiku-4.5')
      } else {
        const svg = await ui.find({ type: 'Svg' })
        const source = String(svg?.props.source ?? '')
        expect(source).toContain('<animateMotion')
        expect(source).toContain('Explore')
      }
      await ui.unmount()
    }
  })

  test('the Ledger tab shows costs by model; picking a run shows its details; Export writes JSON and CSV', async ($, on) => {
    const { writes } = world(on, e => use('claude-opus-5-5', e.turnId === 'first' ? 1000 : 2000, 0))
    await $.turn.start({ text: 'first prompt', turnId: 'first' })
    await step($, { turnId: 'first', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
    await $.turn.start({ text: 'second prompt', turnId: 'second' })
    await step($, { turnId: 'second', index: 0, model: 'claude-opus-5-5', messageCount: 1 })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'ledger' })
    expect(await ui.find({ type: 'Text', text: /not subscription charges/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Cost by model/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /second prompt · running/ })).toBeDefined()
    await ui.press({ key: 'run-1' })
    expect(await ui.find({ type: 'Text', text: /first prompt · running/ })).toBeDefined()
    await ui.press({ key: 'export' })
    const paths = writes.map(w => w.path)
    expect(paths.some(p => p.startsWith('/home/tester/.claude/run-ledger/exports/') && p.endsWith('.json'))).toBe(true)
    expect(paths.some(p => p.endsWith('.csv'))).toBe(true)
    await ui.press({ key: 'live' })
    expect(await ui.find({ type: 'Text', text: /Model roster/ })).toBeDefined()
    await ui.unmount()
  })

  test('the Context exchange band shows the run timeline and context fill', async ($, on) => {
    world(on, () => null)
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
    on('tool.call', () => ({ result: 'contents' }) as never)
    await $.turn.start({ text: 'band', turnId: 't1' })
    await spawn($, { prompt: 'scaffold', description: 'scaffold route', subagentType: 'run-ledger:builder' })
    await callIn($, 'agent-1', { tool: 'Write', file_path: '/repo/src/route.ts', content: 'x' })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /Context exchange/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /2 nodes/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /context unknown/ })).toBeDefined()
      if (surface === 'terminal') {
        const band = await rasterText(ui, 'context')
        expect(band).toContain('route.ts')
        expect(band).toContain('builder: scaffold')
      } else {
        expect(String((await ui.find({ type: 'Svg' }))?.props.source ?? '')).toContain('route.ts')
      }
      await ui.unmount()
    }
  })

  test('the band stays out of the way with nothing to show, or when off', { options: { band: 'off' } }, async ($, on) => {
    world(on, () => null)
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
    await $.turn.start({ text: 'band', turnId: 't1' })
    await spawn($, { prompt: 'scaffold', description: 'scaffold route', subagentType: 'Explore' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Context exchange/ })).toBeUndefined()
    await ui.unmount()
  })

  test('the graph animates by blitting while a subagent runs, and the first subagent opens the pane', async ($, on) => {
    const { clock, blits, opened } = world(on, () => null)
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
    on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'agent-1' }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.turn.start({ text: 'animate', turnId: 't1' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await spawn($, { prompt: 'look', description: 'look', subagentType: 'Explore' })
    expect(opened).toEqual(['run-ledger'])
    await clock.advance(350)
    expect(blits.filter(k => k === 'graph').length).toBeGreaterThan(0)
    await ui.unmount()
  })
})

describe('pixel pictures', () => {
  const live = async ($: Engine, on: On) => {
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
    on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'agent-1' }))
    on('tool.call', () => ({ result: 'contents' }) as never)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.turn.start({ text: 'pixels', turnId: 't1' })
  }

  test('on Ghostty the graph and the band are real pixels, swapped by blits while they move', async ($, on) => {
    const { clock, blits, images } = world(on, () => null, () => '', { env: { TERM_PROGRAM: 'ghostty' } })
    await live($, on)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await spawn($, { prompt: 'look', description: 'look', subagentType: 'Explore' })
    await callIn($, 'agent-1', { tool: 'Write', file_path: '/repo/src/route.ts', content: 'x' })
    const graph = await imageOf(ui, 'graph-px')
    expect(graph.isDrawn).toBe(true)
    expect(pngSize(graph.png)).toEqual({ width: graph.columns * 18, height: graph.rows * 40 })
    expect(await ui.find({ type: 'Raster', key: 'graph' })).toBeUndefined()
    await clock.advance(400)
    expect(blits).toContain('graph-px')
    expect(pngSize(images[images.length - 1] ?? '').width).toBe(graph.columns * 18)
    await ui.unmount()

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const context = await imageOf(band, 'context-px')
    expect(context.isDrawn).toBe(true)
    expect(pngSize(context.png).width).toBeGreaterThan(0)
    expect(pngSize(context.png).width).toBeLessThanOrEqual(2048)
    await band.unmount()
  })

  test('inside tmux the graph stays braille', { options: { intro: false } }, async ($, on) => {
    world(on, () => null, () => '', { env: { TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux-0/default,1,0' } })
    await live($, on)
    await spawn($, { prompt: 'look', description: 'look', subagentType: 'Explore' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await rasterText(ui, 'graph')).toContain('Explore')
    expect((await imageOf(ui, 'graph-px')).isDrawn).toBe(false)
    await ui.unmount()
  })

  test('a terminal that only poses as kitty (Tern) stays braille', { options: { intro: false } }, async ($, on) => {
    world(on, () => null, () => '', { env: { TERM_PROGRAM: 'tern', TERM: 'xterm-kitty', KITTY_WINDOW_ID: '9', KITTY_PID: '1' } })
    await live($, on)
    await spawn($, { prompt: 'look', description: 'look', subagentType: 'Explore' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await rasterText(ui, 'graph')).toContain('Explore')
    expect((await imageOf(ui, 'graph-px')).isDrawn).toBe(false)
    await ui.unmount()
  })

  test('kitty itself, with no TERM_PROGRAM, still gets pixels', { options: { intro: false } }, async ($, on) => {
    world(on, () => null, () => '', { env: { TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1' } })
    await live($, on)
    await spawn($, { prompt: 'look', description: 'look', subagentType: 'Explore' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await imageOf(ui, 'graph-px')).isDrawn).toBe(true)
    await ui.unmount()
  })

  test('a terminal that shows no images gets braille, and says so once', { options: { graphics: 'pixels', intro: false } }, async ($, on) => {
    const why = 'the Image draws its alt here: the terminal draws no placeholder images (probe: no reply)'
    const { clock, toasts } = world(on, () => null, () => '', { blitDeny: key => (key.endsWith('-px') ? why : undefined) })
    await live($, on)
    await spawn($, { prompt: 'look', description: 'look', subagentType: 'Explore' })
    const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await imageOf(first, 'graph-px')).isDrawn).toBe(true)
    await clock.advance(200)
    await first.unmount()
    const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await rasterText(again, 'graph')).toContain('Explore')
    expect(toasts.filter(t => t.includes('drawing in braille'))).toEqual([
      'run-ledger: no pixel pictures here (the terminal draws no placeholder images (probe: no reply)); drawing in braille.',
    ])
    await again.unmount()
  })
})

describe('interaction and finish', () => {
  /** A run with one subagent that has finished, the pane's world ready. */
  async function finished($: Engine, on: On, model = 'claude-haiku-4-5') {
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
    on('agent.spawn', () => ({ model, agentId: 'agent-1' }))
    on('tool.call', () => ({ result: 'contents' }) as never)
    await $.turn.start({ text: 'build the page', turnId: 't1' })
    await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
    await spawn($, { prompt: 'look', description: 'look around', subagentType: 'Explore' })
    await callIn($, 'agent-1', { tool: 'Write', file_path: '/repo/src/page.tsx', content: 'x' })
    await step($, { turnId: 't1', index: 0, model, messageCount: 1, agentId: 'agent-1' } as never)
  }

  test('the node under the pointer shows its card on the graph; it goes when the pointer leaves', { options: { intro: false } }, async ($, on) => {
    const { clock } = world(on, e => (e.agentId ? use('claude-haiku-4-5', 3000, 800) : use('claude-opus-5-5', 1000, 100)))
    await finished($, on)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const client = await ui.find({ type: 'Client', key: 'graph-overlay' })
    expect(client?.props.module).toBe('hooks/overlay.tsx')
    const props = client?.props.props
    const boxes = typeof props === 'object' && props !== null && 'boxes' in props && Array.isArray(props.boxes) ? props.boxes : []
    const box = boxes.find((b: { id: string }) => b.id === 'agent-1')
    expect(box, 'the subagent has a box').toBeDefined()
    await ui.pointer({ type: 'move', x: box.x, y: box.y, in: 'graph-overlay' })
    expect(await ui.find({ in: 'graph-overlay', text: /Explore · haiku-4\.5/ })).toBeDefined()
    expect(await ui.find({ in: 'graph-overlay', text: /in 3\.0k · out 800/ })).toBeDefined()
    expect(await ui.find({ in: 'graph-overlay', text: /write page\.tsx/ })).toBeDefined()
    // The card is drawn at its full width wherever the node sits, and no line of it is cut.
    const frame = await ui.find({ in: 'graph-overlay', type: 'Box' })
    expect(frame?.props.width).toBe(46)
    const rows = (await ui.findAll({ in: 'graph-overlay', type: 'Text' })).map(t => t.text)
    expect(rows.filter(r => !/click pins|unpin/.test(r)).some(r => r.trimEnd().endsWith('…'))).toBe(false)
    await ui.pointer({ type: 'leave', x: box.x, y: box.y, in: 'graph-overlay' })
    expect(await ui.find({ in: 'graph-overlay', text: /Explore · haiku/ })).toBeUndefined()
    void clock
    await ui.unmount()
  })

  test('with no room beside the node, its card goes over the picture at full width, not narrowed and cut', { options: { intro: false } }, async ($, on) => {
    world(on, e => (e.agentId ? use('claude-haiku-4-5', 3000, 800) : use('claude-opus-5-5', 1000, 100)))
    await finished($, on)
    const narrow = { ...PANE, props: { ...PANE.props, bodyColumns: 64 } }
    const ui = await $.ui.mount({ ...narrow, surface: 'terminal' })
    const client = await ui.find({ type: 'Client', key: 'graph-overlay' })
    const columns = typeof client?.props.width === 'number' ? client.props.width : 0
    const props = client?.props.props
    const boxes = typeof props === 'object' && props !== null && 'boxes' in props && Array.isArray(props.boxes) ? props.boxes : []
    for (const id of ['main', 'agent-1']) {
      const box = boxes.find((b: { id: string }) => b.id === id)
      expect(box, `${id} has a box`).toBeDefined()
      await ui.pointer({ type: 'move', x: box.x, y: box.y, in: 'graph-overlay' })
      const frame = await ui.find({ in: 'graph-overlay', type: 'Box' })
      const width = Number(frame?.props.width)
      const left = Number(frame?.props.left)
      expect(width).toBe(Math.max(16, Math.min(46, columns)))
      expect(left).toBeGreaterThanOrEqual(0)
      expect(left + width).toBeLessThanOrEqual(columns)
      const rows = (await ui.findAll({ in: 'graph-overlay', type: 'Text' })).map(t => t.text)
      expect(rows.filter(r => !/click pins|unpin/.test(r)).some(r => r.trimEnd().endsWith('…'))).toBe(false)
      await ui.pointer({ type: 'leave', x: box.x, y: box.y, in: 'graph-overlay' })
    }
    await ui.unmount()
  })

  test('replay: ←/→ on the graph step through the run; the header buttons start, play and end it', { options: { intro: false } }, async ($, on) => {
    world(on, () => use('claude-opus-5-5', 1000, 100))
    await finished($, on)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /REPLAY/ })).toBeUndefined()
    await ui.key({ key: 'left', in: 'graph-overlay' })
    expect(await ui.find({ type: 'Text', text: /❚❚ REPLAY / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /event \d+\/\d+/ })).toBeDefined()
    await ui.press({ key: 'live' })
    expect(await ui.find({ type: 'Text', text: /REPLAY/ })).toBeUndefined()
    await ui.press({ key: 'replay' })
    expect(await ui.find({ type: 'Text', text: /▶ REPLAY 0:00/ })).toBeDefined()
    await ui.press({ key: 'play' })
    expect(await ui.find({ type: 'Text', text: /❚❚ REPLAY/ })).toBeDefined()
    await ui.press({ key: 'step-fwd' })
    await ui.press({ key: 'step-back' })
    expect(await ui.find({ type: 'Text', text: /event 1\// })).toBeDefined()
    await ui.press({ key: 'replay' })
    expect(await ui.find({ type: 'Text', text: /REPLAY/ })).toBeUndefined()
    // The header's letters work from the graph too, which holds the keyboard after a click.
    await ui.key({ key: 't', in: 'graph-overlay' })
    expect(await ui.find({ type: 'Text', text: /^Timeline $/ })).toBeDefined()
    await ui.unmount()
  })

  test('the Timeline tab: a lane per loop with its duration and cost, an axis, and a card per lane', { options: { intro: false } }, async ($, on) => {
    world(on, () => use('claude-opus-5-5', 1000, 100))
    await finished($, on)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'timeline' })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
    expect(texts).toContain('1 subagents · 1 tool calls')
    expect(await ui.find({ type: 'Text', text: /^main {2,}$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Explore +$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /0s/ })).toBeDefined()
    // Each lane's card waits hidden, revealed by the lane's hover group.
    const cards = (await ui.findAll({ type: 'Box' })).filter(b => b.props.display === 'none')
    expect(cards.length).toBe(2)
    const tree = JSON.stringify(await ui.drawn())
    expect(tree).toContain('"scope":"rl-lane-main"')
    expect(tree).toContain('"scope":"rl-lane-agent-1"')
    await ui.unmount()
  })

  test('a live spawn row reveals its card on hover, drawn after the rows', { options: { intro: false } }, async ($, on) => {
    world(on, e => (e.agentId ? use('claude-haiku-4-5', 3000, 800) : use('claude-opus-5-5', 1000, 100)))
    await finished($, on)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const hidden = (await ui.findAll({ type: 'Box' })).filter(b => b.props.display === 'none')
    expect(hidden.length).toBe(1)
    // The row and its card share a hover group: the row under the pointer reveals the card.
    const tree = JSON.stringify(await ui.drawn())
    expect(tree.split('"scope":"rl-spawn-agent-1"').length - 1).toBe(2)
    expect(await ui.find({ type: 'Text', text: /^Explore · haiku-4\.5 +$/ })).toBeDefined()
    await ui.unmount()
  })

  test('a run that used subagents ends with a receipt in the transcript, and a chime when sound is on', { options: { sound: true } }, async ($, on) => {
    const { logs, played } = world(on, () => use('claude-opus-5-5', 1000, 100))
    await finished($, on)
    await $.turn.complete({ turnId: 'sub-1', agentId: 'agent-1', answer: 'done', durationMs: 4_000, isAborted: false, reason: 'answer' })
    await $.turn.complete({ turnId: 't1', answer: 'all done', durationMs: 9_000, isAborted: false, reason: 'answer' })
    const receipt = logs.filter(l => l.includes('run-ledger receipt') || l.startsWith('  '))
    expect(receipt[0]).toMatch(/^◆ run-ledger receipt · "build the page" · \d+s · completed$/)
    expect(receipt.join('\n')).toMatch(/1 subagent on 1 model · 2 requests/)
    expect(receipt.some(l => /total ~\$[\d.]+ API est\., not a subscription charge/.test(l))).toBe(true)
    expect(played).toEqual(['sounds/done.wav'])
  })

  test("a background subagent's run waits for it: one receipt once it ends, its requests and the savings in", { options: { sound: true } }, async ($, on) => {
    const { logs, played, clock } = world(on, e => (e.agentId ? use('claude-haiku-4-5', 3000, 800) : use('claude-opus-5-5', 1000, 100)))
    await finished($, on)
    // The main turn ends first; the subagent keeps working in the background.
    await $.turn.complete({ turnId: 't1', answer: 'started it', durationMs: 2_000, isAborted: false, reason: 'answer' })
    expect(logs.some(l => l.includes('run-ledger receipt'))).toBe(false)
    expect(played).toEqual([])
    await clock.advance(5_000)
    await step($, { turnId: 't1', index: 1, model: 'claude-haiku-4-5', messageCount: 2, agentId: 'agent-1' } as never)
    await $.turn.complete({ turnId: 'sub-1', agentId: 'agent-1', answer: 'done', durationMs: 6_000, isAborted: false, reason: 'answer' })
    expect(logs.filter(l => l.includes('run-ledger receipt'))).toHaveLength(1)
    const receipt = logs.join('\n')
    expect(receipt).toMatch(/1 subagent on 1 model · 3 requests/)
    expect(receipt).not.toMatch(/still running in the background/)
    expect(receipt).toMatch(/routing saved ≈\$[\d.]+ \(\d+%\) vs all opus-5\.5/)
    expect(played).toEqual(['sounds/done.wav'])
    // Issued once: a later turn of the session does not issue it again.
    await $.turn.start({ text: 'thanks', turnId: 't2' })
    await $.turn.complete({ turnId: 't2', answer: 'ok', durationMs: 500, isAborted: false, reason: 'answer' })
    expect(logs.filter(l => l.includes('run-ledger receipt'))).toHaveLength(1)
  })

  test('a run with no subagents leaves no receipt, and no sound by default', async ($, on) => {
    const { logs, played } = world(on, () => use('claude-opus-5-5', 1000, 100))
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
    await $.turn.complete({ turnId: 't1', answer: 'hello', durationMs: 900, isAborted: false, reason: 'answer' })
    expect(logs.some(l => l.includes('receipt'))).toBe(false)
    expect(played).toEqual([])
  })

  test('the light theme recolours the pane for a light terminal', { options: { theme: 'light', intro: false } }, async ($, on) => {
    world(on, () => use('claude-opus-5-5', 1000, 100))
    await finished($, on)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /^Sub-agent model allocation$/ }))?.props.color).toBe('#1f2328')
    await ui.unmount()
  })

  test('auto turns light when the terminal reports a light background', { options: { intro: false } }, async ($, on) => {
    world(on, () => use('claude-opus-5-5', 1000, 100), () => '', { env: { COLORFGBG: '0;15' } })
    await finished($, on)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /^Sub-agent model allocation$/ }))?.props.color).toBe('#1f2328')
    await ui.unmount()
  })

  test('the demo plays a scripted run with sample data and leaves the ledger alone', async ($, on) => {
    const { clock, writes, logs } = world(on, () => null)
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await run($, 'run-ledger', 'demo')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: ' DEMO ' })).toBeDefined()
    await clock.advance(6_000)
    expect(await ui.find({ type: 'Text', text: /^implementer/ })).toBeDefined()
    await clock.advance(31_000)
    expect(logs.some(l => l.startsWith('DEMO ◆ run-ledger receipt'))).toBe(true)
    await run($, 'run-ledger', 'demo off')
    expect(await ui.find({ type: 'Text', text: ' DEMO ' })).toBeUndefined()
    const doc = await exported($, writes)
    expect(doc.totals.requests).toBe(0)
    await ui.unmount()
  })

  test('as the pane opens, the roster cascades in and the graph grows', async ($, on) => {
    const { clock } = world(on, () => use('claude-opus-5-5', 1000, 100))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
    on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'agent-1' }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.turn.start({ text: 'open', turnId: 't1' })
    await spawn($, { prompt: 'look', description: 'look', subagentType: 'Explore' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    // The roster's row for Explore (its name padded to the column) is not there yet.
    expect(await ui.find({ type: 'Text', text: /^Explore +$/ })).toBeUndefined()
    expect(await rasterText(ui, 'graph')).not.toContain('Explore')
    await clock.advance(1_200)
    expect(await ui.find({ type: 'Text', text: /^Explore +$/ })).toBeDefined()
    expect(await rasterText(ui, 'graph')).toContain('Explore')
    await ui.unmount()
  })
})

describe('carried over from the 0.1.x fixes', () => {
  type ExportedRuns = { runs: { run: { id: string; label: string; source: string } }[] }

  /** ui.panes and ui.close beneath the plugin, over the panes world() records as opened. */
  function panes(on: On, opened: string[]) {
    const closed = new Set<number>()
    on('ui.panes', () => ({
      value: opened
        .filter((_, i) => !closed.has(i))
        .map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
    }))
    on('ui.close', ($, e) => {
      opened.forEach((id, i) => {
        if (id === e.id) closed.add(i)
      })
      return { value: undefined }
    })
  }

  const closer: Plugin = {
    name: 'closer',
    register: on => {
      on('command.run', { command: 'close-ledger' }, async $ => {
        await $.ui.close({ id: 'run-ledger' })
        return { text: 'closed' }
      })
    },
  }

  test("a background subagent's hand-back fills its result and names the run it starts", async ($, on) => {
    const { writes } = world(on, () => use('claude-opus-5-5', 10, 10))
    on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-bg' }))
    on('tool.call', () => ({ deny: 'test world runs no tools' }))
    await $.turn.start({ text: 'list the files in the background', turnId: 't1' })
    await spawn($, { prompt: 'list', description: 'List files', subagentType: 'Explore' })
    await $.turn.start({ text: 'list', turnId: 'sub-1', agentId: 'agent-bg' }) // the subagent's own turn: no run of its own
    // @ts-expect-error SubagentHandback is the engine's internal hand-back tool: real at run time, absent from the typed tool list.
    await $.tool.call({ tool: 'SubagentHandback', message: 'Three files: README.md, notas.txt, util.py.', agentId: 'agent-bg' })
    await $.turn.complete({ turnId: 'sub-1', agentId: 'agent-bg', answer: '', durationMs: 5000, isAborted: false, reason: 'answer' })
    await $.turn.complete({ turnId: 't1', answer: 'started it', durationMs: 900, isAborted: false, reason: 'answer' })
    await $.turn.start({
      text: '<agent-message from="agent-bg">\n[Subagent hand-back] The report follows:\n  Three files: README.md, notas.txt, util.py.\n</agent-message>',
      turnId: 't2',
    })
    const doc = await exported($, writes)
    expect(doc.agents[0]).toMatchObject({
      id: 'agent-bg',
      status: 'completed',
      lastAction: 'handed back its report',
      result: 'Three files: README.md, notas.txt, util.py.',
    })
    const runs: ExportedRuns = JSON.parse([...writes].reverse().find(w => w.path.endsWith('.json'))?.text ?? '{}')
    expect(runs.runs.map(r => r.run.id)).toEqual(['t1', 't2'])
    expect(runs.runs[1]?.run).toMatchObject({ label: '↩ Explore "List files" handed back its report', source: 'agent:agent-bg' })

    // The hand-back's turn is the newest run, yet the live view stays on the run that spawned the agent.
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^1 spawned$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^0 spawned$/ })).toBeUndefined()
    await ui.unmount()
  })

  test('the pane opens by itself once a session, and not over a pane already open', async ($, on) => {
    const { opened } = world(on, () => null)
    panes(on, opened)
    let n = 0
    on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: `agent-${(n += 1)}` }))
    await spawn($, { prompt: 'a', description: 'first', subagentType: 'Explore' })
    await spawn($, { prompt: 'b', description: 'second', subagentType: 'Explore' })
    expect(opened).toEqual(['run-ledger'])
  })

  test("a plugin's close is not the person's: the first subagent still opens the pane", { plugins: [closer] }, async ($, on) => {
    const { opened } = world(on, () => null)
    panes(on, opened)
    on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'agent-1' }))
    await run($, 'run-ledger') // the person opens it
    await run($, 'close-ledger') // a plugin closes it
    await spawn($, { prompt: 'a', description: 'first', subagentType: 'Explore' })
    expect(opened).toEqual(['run-ledger', 'run-ledger'])
  })

  test('autoOpen off: only /run-ledger opens it', { options: { autoOpen: false } }, async ($, on) => {
    const { opened } = world(on, () => null)
    panes(on, opened)
    on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'agent-1' }))
    await spawn($, { prompt: 'a', description: 'first', subagentType: 'Explore' })
    expect(opened).toEqual([])
  })

  test('the Ledger tab sets the count beside /cost, from the baseline a reset takes', async ($, on) => {
    world(on, () => use('claude-opus-5-5', 1000, 100)) // $0.006 a request
    let sessionUsd = 1
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [], cost: { usd: sessionUsd } } }))
    await run($, 'run-ledger', 'reset') // the baseline: /cost at $1
    await $.turn.start({ text: 'count me', turnId: 't1' })
    await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
    sessionUsd = 1 + 0.006 + 0.03 // what was counted, and $0.03 no hook saw
    await run($, 'run-ledger', 'ledger')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Session: 1 req · ~\$0\.0060 · \/cost \$0\.04 \(~\$0\.03 outside hooks\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /UTC/ })).toBeUndefined()
    await ui.unmount()
  })
})
