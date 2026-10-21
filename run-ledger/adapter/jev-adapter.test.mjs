// node --test adapter/  — the adapter against a fake JEV: no network, no key.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'

import {
  JEV_ENDPOINT,
  JEV_MODEL,
  createServer,
  jevPayload,
  parseJevResponse,
  parseRequest,
  readKey,
  recommend,
  redactSecrets,
  toLedgerAnswer,
} from './jev-adapter.mjs'

const MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']

/** What run-ledger's buildJevRequest sends. */
const ledgerRequest = (patch = {}) => ({
  schema: 'run-ledger.jev-request/1',
  task: { prompt: 'Read util.py and say what it does.', description: 'Read util.py', agentType: 'Explore', requestedModel: null, parentModel: 'claude-opus-5-5' },
  availableModels: MODELS.map((id, i) => ({ id, usdPerMTok: { input: [10, 4, 2, 1][i], output: [50, 20, 10, 5][i], cacheWrite: 1, cacheRead: 0.1 }, pricesAsOf: '2026-09-25' })),
  budget: { limitUsd: null, spentUsdEstimate: 0.42, spentHasUnknown: false },
  pastResults: [{ agentType: 'Explore', model: 'claude-haiku-4-5', outcome: 'completed', costUsd: 0.004, durationMs: 12000, at: 0 }],
  ...patch,
})

/** What JEV answered in the live probe of 2026-10-19 (status 200, 476 ms). */
const jevAnswer = (patch = {}) => ({
  model: JEV_MODEL,
  answers: {
    model: {
      type: 'choice',
      choice: 'claude-haiku-4-5',
      confidence: 0.9,
      probabilities: { 'claude-fable-5-1': 0, 'claude-opus-5-5': 0.02, 'claude-sonnet-5-5': 0.08, 'claude-haiku-4-5': 0.9 },
    },
  },
  usage: { input_tokens: 565, output_tokens: 66 },
  ...patch,
})

const fakeFetch = (status, body, sent = []) => async (url, init) => {
  sent.push({ url, init })
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('the request to JEV: the task as data, one choice whose options are exactly the offered models', () => {
  const parsed = parseRequest(ledgerRequest())
  assert.equal(parsed.ok, true)
  const payload = jevPayload(parsed.request)
  assert.equal(payload.model, JEV_MODEL)
  assert.equal(payload.questions.model.type, 'choice')
  assert.deepEqual(Object.keys(payload.questions.model.criteria), MODELS)
  assert.match(payload.questions.model.criteria['claude-haiku-4-5'], /cheapest.*\$1 in, \$5 out/)
  assert.match(payload.questions.model.instructions, /untrusted data/)
  assert.equal(payload.state.task.agentType, 'Explore')
  assert.deepEqual(payload.state.pastResults[0], { model: 'claude-haiku-4-5', outcome: 'completed', costUsd: 0.004, durationMs: 12000 })
})

test('credentials in the task text are redacted before it leaves, and the prompt stays within 4000 characters', () => {
  const prompt = `use TYPESAFE_API_KEY=ts_live_123456789 and sk-ant-api03-abcdefghijklmnopqrstuvwxyz and ghp_${'a'.repeat(36)} ${'x'.repeat(5000)}`
  const payload = jevPayload(parseRequest(ledgerRequest({ task: { ...ledgerRequest().task, prompt } })).request)
  const sent = payload.state.task.prompt
  assert.ok(!sent.includes('ts_live_123456789'))
  assert.ok(!sent.includes('sk-ant-api03'))
  assert.ok(!sent.includes('ghp_'))
  assert.match(sent, /TYPESAFE_API_KEY=\[redacted\]/)
  assert.ok(sent.length <= 4000)
  assert.equal(redactSecrets('nothing secret here'), 'nothing secret here')
})

test('a request run-ledger did not shape is refused before any call', () => {
  assert.equal(parseRequest({ schema: 'other' }).ok, false)
  assert.equal(parseRequest(ledgerRequest({ availableModels: [{ id: 'claude-haiku-4-5' }] })).ok, false)
})

test("JEV's answer becomes run-ledger's: choice, reason from JEV's numbers, ranking, JEV's own cost", () => {
  const parsed = parseJevResponse(jevAnswer(), MODELS)
  assert.equal(parsed.ok, true)
  const answer = toLedgerAnswer(parsed)
  assert.equal(answer.model, 'claude-haiku-4-5')
  assert.equal(answer.confidence, 0.9)
  assert.equal(answer.reason, `JEV ${JEV_MODEL} chose claude-haiku-4-5 (p 0.90) over claude-sonnet-5-5 (p 0.08)`)
  assert.deepEqual(answer.ranking.map(r => r.model), ['claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'])
  assert.ok(Math.abs(answer.cost.usd - (565 * 0.042) / 1e6) < 1e-12)
})

test('JEV usage missing: its cost is left out (unknown), never zero', () => {
  const answer = toLedgerAnswer(parseJevResponse(jevAnswer({ usage: undefined }), MODELS))
  assert.equal('cost' in answer, false)
})

test('an answer JEV should not give is refused, never repaired', () => {
  const bad = [
    jevAnswer({ model: 'jev-1.14.0' }),
    jevAnswer({ answers: { model: { ...jevAnswer().answers.model, choice: 'gpt-x' } } }),
    jevAnswer({ answers: { model: { ...jevAnswer().answers.model, probabilities: { 'claude-haiku-4-5': 0.5, 'claude-opus-5-5': 0.2 } } } }),
    jevAnswer({ answers: { model: { ...jevAnswer().answers.model, choice: 'claude-opus-5-5' } } }),
    jevAnswer({ answers: { model: { ...jevAnswer().answers.model, probabilities: { 'gpt-x': 1 } } } }),
    jevAnswer({ answers: { model: { type: 'noul', noul: 0.3 } } }),
  ]
  for (const answer of bad) assert.equal(parseJevResponse(answer, MODELS).ok, false)
})

test('one recommendation: the pinned endpoint, the bearer key, no redirects', async () => {
  const sent = []
  const result = await recommend(ledgerRequest(), { key: 'test-key', fetchImpl: fakeFetch(200, jevAnswer(), sent) })
  assert.equal(result.status, 200)
  assert.equal(result.body.model, 'claude-haiku-4-5')
  assert.equal(sent[0].url, JEV_ENDPOINT)
  assert.equal(sent[0].init.headers.Authorization, 'Bearer test-key')
  assert.equal(sent[0].init.redirect, 'error')
  assert.equal(JSON.stringify(result.log).includes('util.py'), false) // the log holds no task text
})

test("JEV's failures answer non-200, so run-ledger keeps the engine's choice", async () => {
  assert.equal((await recommend(ledgerRequest(), { key: '', fetchImpl: fakeFetch(200, jevAnswer()) })).status, 503)
  assert.deepEqual((await recommend(ledgerRequest(), { key: 'k', fetchImpl: fakeFetch(429, {}) })).body, { error: 'rate_limited' })
  assert.equal((await recommend(ledgerRequest(), { key: 'k', fetchImpl: fakeFetch(500, {}) })).status, 503)
  assert.equal((await recommend(ledgerRequest(), { key: 'k', fetchImpl: fakeFetch(200, jevAnswer({ model: 'other' })) })).status, 502)
  const never = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
  const late = await recommend(ledgerRequest(), { key: 'k', fetchImpl: never, timeoutMs: 50 })
  assert.equal(late.status, 504)
  assert.equal(late.body.error, 'jev_timeout')
  assert.equal((await recommend({ schema: 'x' }, { key: 'k', fetchImpl: fakeFetch(200, jevAnswer()) })).status, 400)
})

test('the key comes from the environment first, then from an .env line; it is never in a response', async () => {
  assert.equal(readKey({ env: { TYPESAFE_API_KEY: ' from-env ' } }), 'from-env')
  assert.equal(readKey({ env: {}, envFile: '/nonexistent/.env' }), '')
  const server = createServer({ key: 'secret-key', fetchImpl: fakeFetch(200, jevAnswer()) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const health = await (await fetch(`${base}/health`)).json()
    assert.equal(health.keyLoaded, true)
    assert.equal(JSON.stringify(health).includes('secret-key'), false)
    const ok = await fetch(`${base}/recommend`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ledgerRequest()) })
    assert.equal(ok.status, 200)
    assert.equal((await ok.json()).model, 'claude-haiku-4-5')
    // A web page cannot drive it: an Origin header, or a body that is not JSON, is refused.
    const fromPage = await fetch(`${base}/recommend`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' })
    assert.equal(fromPage.status, 403)
    const form = await fetch(`${base}/recommend`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })
    assert.equal(form.status, 415)
    assert.equal((await fetch(`${base}/other`)).status, 404)
  } finally {
    server.close()
  }
})
