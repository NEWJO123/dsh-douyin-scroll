/** Isolated fixtures only: these tests never read live DMs, call a model, or send a message. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { createDmReplyService, generateDmReply, loadReplyPersona } from '../lib/dm-reply.mjs'
import { apply } from '../index.js'

const target = { to_id: 'fixture_peer_001', to: 'Fixture', confirm: true }
const inbound = () => ({ ok: true, to_sec_uid: target.to_id, to: target.to,
  messages: [{ from: 'me', text: 'Previous fixture message' }, { from: 'them', text: 'How is the test?', at: '2026-11-04T01:00:00Z' }],
  context: { facts: ['fixture only'], recent: [{ from: 'them', text: 'How is the test?' }] } })
const pause = () => new Promise((resolve) => setImmediate(resolve))
const fixtureRoot = dirname(fileURLToPath(import.meta.url))

function fixture(overrides = {}) {
  // Workspace-local temp files also exercise atomic rename under the Windows desktop sandbox.
  const home = mkdtempSync(join(fixtureRoot, 'douyin-reply-fixture-'))
  const calls = { read: 0, generate: 0, send: 0, noted: 0, locked: false }
  const dependencies = {
    stateDir: home,
    async read() { calls.read++; return inbound() },
    async generate() { calls.generate++; return { text: 'The fixture passed.' } },
    async send(args) { calls.send++; assert.equal(calls.locked, true); return { ok: true, sent: true, to_sec_uid: args.toId } },
    noteSent() { calls.noted++ },
    async withSendLock(fn) { calls.locked = true; try { return await fn() } finally { calls.locked = false } },
    ...overrides,
  }
  const service = createDmReplyService(dependencies)
  return { home, calls, service, dependencies, close() {
    assert.equal(dirname(resolve(home)), resolve(fixtureRoot))
    assert.ok(basename(home).startsWith('douyin-reply-fixture-'))
    rmSync(home, { recursive: true, force: true })
  } }
}
async function complete(service, id) {
  for (let i = 0; i < 100; i++) {
    const result = service.get({ id })
    assert.equal(result.ok, true)
    if (result.job.done) return result.job
    await pause()
  }
  assert.fail('fixture job did not settle')
}

test('requires a stable selected target and explicit confirmation before any work', () => {
  const f = fixture()
  try {
    assert.equal(f.service.start({ ...target, confirm: false }).needsConfirm, true)
    assert.equal(f.service.start({ ...target, to_id: '' }).ok, false)
    assert.equal(f.service.start({ ...target, to_id: '../other' }).ok, false)
    assert.deepEqual(f.calls, { read: 0, generate: 0, send: 0, noted: 0, locked: false })
    assert.deepEqual(f.service.get({ to_id: target.to_id }), { ok: true, job: null })
  } finally { f.close() }
})

test('serializes duplicate clicks and instances, rereads under lock, sends once, and restores by target', async () => {
  const f = fixture()
  try {
    const first = f.service.start(target)
    const second = createDmReplyService(f.dependencies).start(target)
    assert.equal(first.job.id, second.job.id)
    assert.equal(first.job.status, 'reading')
    const done = await complete(f.service, first.job.id)
    assert.equal(done.status, 'sent')
    assert.equal(done.sent, true)
    assert.deepEqual(f.calls, { read: 2, generate: 1, send: 1, noted: 1, locked: false })
    assert.equal(f.service.get({ to_id: target.to_id }).job.id, first.job.id)
    const repeated = await complete(f.service, f.service.start(target).job.id)
    assert.equal(repeated.status, 'skipped')
    assert.equal(repeated.reason, 'already_replied')
    assert.equal(f.calls.send, 1)
  } finally { f.close() }
})

test('an uncertain sender result stays durable across new services and repeated clicks', async () => {
  let sends = 0
  const f = fixture({ async send() { sends++; return { ok: false, sent: false, error: 'fixture timeout' } } })
  try {
    const first = await complete(f.service, f.service.start(target).job.id)
    assert.equal(first.status, 'uncertain')
    assert.equal(first.sent, false)
    const restored = createDmReplyService(f.dependencies)
    assert.equal(restored.get({ to_id: target.to_id }).job.status, 'uncertain')
    const again = await complete(restored, restored.start(target).job.id)
    assert.equal(again.status, 'uncertain')
    assert.equal(again.reason, 'previous_send_uncertain')
    assert.equal(sends, 1)
    assert.equal(f.calls.noted, 0)
  } finally { f.close() }
})

test('crashed sending jobs recover as uncertain and cannot replay the journaled inbound', async () => {
  const f = fixture()
  try {
    await complete(f.service, f.service.start(target).job.id)
    const folder = join(f.home, 'reply-jobs')
    const path = join(folder, readdirSync(folder).find((name) => name.endsWith('.json')))
    const state = JSON.parse(readFileSync(path, 'utf8'))
    Object.assign(state.job, { status: 'sending', phase: 'sending', done: false, sent: false })
    state.attempted[0].status = 'uncertain'
    writeFileSync(path, JSON.stringify(state))
    const restored = createDmReplyService(f.dependencies)
    assert.equal(restored.get({ to_id: target.to_id }).job.status, 'uncertain')
    assert.equal((await complete(restored, restored.start(target).job.id)).status, 'uncertain')
    assert.equal(f.calls.send, 1)
  } finally { f.close() }
})

test('corrupt durable state fails closed instead of forgetting a possible send', async () => {
  const f = fixture()
  try {
    await complete(f.service, f.service.start(target).job.id)
    const folder = join(f.home, 'reply-jobs')
    const path = join(folder, readdirSync(folder).find((name) => name.endsWith('.json')))
    writeFileSync(path, '{incomplete fixture')
    assert.equal(f.service.start(target).ok, false)
    assert.equal(f.service.get({ to_id: target.to_id }).ok, false)
    assert.equal(f.calls.send, 1)
  } finally { f.close() }
})

for (const [label, messages, reason] of [
  ['no inbound', [], 'no_inbound'],
  ['already replied', [{ from: 'them', text: 'hi' }, { from: 'me', text: 'hello' }], 'already_replied'],
  // 🔴 2026-11-05：发送方判不出来 ⇒ 数据不可信，明确报错（不拿猜测决定回复对象）
  ['untrusted sender', [{ from: 'unknown', text: 'hi' }], 'untrusted_sender'],
  ['latest image without text', [{ from: 'them', text: 'older question' }, { from: 'them', kind: 'image', text: '' }], 'unsupported_message'],
]) test(`${label} is explicitly skipped without model or sender`, async () => {
  const f = fixture({ async read() { return { ...inbound(), messages } } })
  try {
    const done = await complete(f.service, f.service.start(target).job.id)
    assert.equal(done.status, 'skipped')
    assert.equal(done.reason, reason)
    assert.equal(f.calls.generate, 0)
    assert.equal(f.calls.send, 0)
  } finally { f.close() }
})

test('an unattributable trailing message is reported as untrusted, never replied to by guessing', async () => {
  // 方向不明不是「没判出来就猜上一条」，而是「这份数据不可信」—— 明确报错，不发
  const f = fixture({ async read() {
    return { ...inbound(), messages: [
      { from: 'them', text: '在吗' },
      { from: 'unknown', text: '', kind: 'unknown' },
    ] }
  } })
  try {
    const done = await complete(f.service, f.service.start(target).job.id)
    assert.equal(done.status, 'skipped')
    assert.equal(done.reason, 'untrusted_sender')
    assert.match(done.note, /接口路径重读/)
    assert.equal(f.calls.generate, 0, '不可信的数据不该拿去生成回复')
    assert.equal(f.calls.send, 0)
  } finally { f.close() }
})

test('a trailing message we sent still counts as already replied', async () => {
  const f = fixture({ async read() {
    return { ...inbound(), messages: [
      { from: 'them', text: '在吗' },
      { from: 'me', text: '在' },
    ] }
  } })
  try {
    const done = await complete(f.service, f.service.start(target).job.id)
    assert.equal(done.reason, 'already_replied')
    assert.equal(f.calls.generate, 0)
    assert.equal(f.calls.send, 0)
  } finally { f.close() }
})

for (const kind of ['new inbound', 'background reply', 'identity changed']) test(`reread catches ${kind} before sending`, async () => {
  let reads = 0
  const f = fixture({ async read() {
    reads++
    const conversation = inbound()
    if (reads === 2) {
      if (kind === 'identity changed') conversation.to_sec_uid = 'fixture_other_001'
      else conversation.messages.push({ from: kind === 'background reply' ? 'me' : 'them', text: 'arrived while generating' })
    }
    return conversation
  } })
  try {
    const done = await complete(f.service, f.service.start(target).job.id)
    assert.equal(done.status, kind === 'identity changed' ? 'failed' : 'skipped')
    assert.equal(f.calls.generate, 1)
    assert.equal(f.calls.send, 0)
  } finally { f.close() }
})

test('read failures keep their actual cause and do not generate or send', async () => {
  const f = fixture({ async read() { return { ok: false, error: 'fixture login missing' } } })
  try {
    const done = await complete(f.service, f.service.start(target).job.id)
    assert.equal(done.status, 'failed')
    assert.equal(done.error, 'fixture login missing')
    assert.equal(f.calls.generate, 0)
    assert.equal(f.calls.send, 0)
  } finally { f.close() }
})

test('generation timeout cannot send a late result', async () => {
  let resolveGeneration
  const f = fixture({ timeoutMs: 1, generate() { return new Promise((resolve) => { resolveGeneration = resolve }) } })
  try {
    const done = await complete(f.service, f.service.start(target).job.id)
    assert.equal(done.status, 'failed')
    resolveGeneration({ text: 'late fixture text' })
    await pause()
    assert.equal(f.calls.send, 0)
  } finally { f.close() }
})

test('sender exceptions and mismatched receipt identity are uncertain without resends', async () => {
  for (const send of [async () => { throw new Error('fixture interrupted') }, async () => ({ ok: true, sent: true, to_sec_uid: 'fixture_other_001' })]) {
    const f = fixture({ send })
    try {
      const done = await complete(f.service, f.service.start(target).job.id)
      assert.equal(done.status, 'uncertain')
      assert.equal(done.sent, false)
      assert.equal((await complete(f.service, f.service.start(target).job.id)).status, 'uncertain')
      assert.equal(f.calls.generate, 1)
    } finally { f.close() }
  }
})

const modelOptions = { route: { provider: 'fixture', model: 'model', reasoningEffort: 'low' }, persona: 'fixture persona', conversation: inbound(), context: { facts: ['remembered fixture fact'] } }
function streamFixture(output, finish = { kind: 'stop' }) {
  let request
  return { get request() { return request }, llm: { async *stream(options) {
    request = options
    yield { type: 'text-delta', text: output }
    if (finish) yield { type: 'finish', reason: finish }
  } } }
}

test('native DSH completion uses selected model/reasoning, plugin persona, and this DM context without tools', async () => {
  const fixture = streamFixture('{"action":"reply","text":"fixture reply"}')
  assert.deepEqual(await generateDmReply({ ...modelOptions, llm: fixture.llm }), { text: 'fixture reply' })
  assert.equal(fixture.request.provider, 'fixture')
  assert.equal(fixture.request.reasoningEffort, 'low')
  assert.match(fixture.request.system, /fixture persona/)
  assert.match(fixture.request.messages[0].content[0].text, /remembered fixture fact/)
  assert.equal(fixture.request.tools, undefined)
})

test('native completion rejects truncated, empty, malformed and overlong responses', async () => {
  for (const [text, finish] of [
    ['', { kind: 'stop' }], ['plain fixture prose', { kind: 'stop' }],
    ['{"action":"reply","text":"ok"}', { kind: 'max-tokens' }],
    ['{"action":"reply","text":"ok"}', { kind: 'error', failure: { code: 'AUTH' } }],
    ['{"action":"reply","text":"ok"}', null],
    [JSON.stringify({ action: 'reply', text: 'x'.repeat(501) }), { kind: 'stop' }],
  ]) await assert.rejects(generateDmReply({ ...modelOptions, llm: streamFixture(text, finish).llm }))
  assert.equal((await generateDmReply({ ...modelOptions, llm: streamFixture('{"action":"skip","reason":"fixture advertisement"}').llm })).skip, true)
})

test('persona priority follows this plugin state, bundled private persona, then neutral default with badge checks', () => {
  const f = fixture()
  try {
    const pluginDir = join(f.home, 'plugin'), prompts = join(pluginDir, 'prompts')
    mkdirSync(prompts, { recursive: true })
    writeFileSync(join(prompts, 'persona.default.md'), '<!-- persona: default -->\nneutral fixture')
    writeFileSync(join(prompts, 'persona.md'), '<!-- persona: other-plugin -->\nignore wrong plugin')
    assert.match(loadReplyPersona(f.home, pluginDir), /neutral fixture/)
    writeFileSync(join(prompts, 'persona.md'), '<!-- persona: douyin-scroll -->\nbundled fixture')
    assert.match(loadReplyPersona(f.home, pluginDir), /bundled fixture/)
    writeFileSync(join(f.home, 'persona.md'), '<!-- persona: douyin-scroll -->\nstate fixture')
    assert.match(loadReplyPersona(f.home, pluginDir), /state fixture/)
  } finally { f.close() }
})

test('actual settings routes expose jobs without credentials or enabling background automation', async () => {
  const f = fixture(), cleanup = []
  let handler
  writeFileSync(join(f.home, 'config.json'), JSON.stringify({ autoSend: false, chatWatch: false, petLinkTo: false, perDay: 0, noon: false, night: false }))
  const ctx = {
    logger: { info() {}, warn() {}, error() {} }, tools: { register() { return () => {} } },
    get(name) {
      if (name === 'dshHomePath') return () => f.home
      if (name === 'webServer') return { register(spec) { handler = spec.handler; return () => {} } }
    },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose) },
    inject(names, fn) { fn(ctx) }, provide() {},
  }
  const request = async (path, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method: body === undefined ? 'GET' : 'POST', url: `/api/douyin-duty${path}`, headers: {} })
    let output
    await handler(req, { setHeader() {}, writeHead() {}, end(value) { output = value } })
    return JSON.parse(output)
  }
  try {
    apply(ctx, {})
    for (const dispose of cleanup.reverse()) dispose()
    assert.deepEqual(await request(`/chat/reply?to_id=${target.to_id}`), { ok: true, job: null })
    assert.equal((await request('/chat/reply', { ...target, confirm: false })).needsConfirm, true)
    const first = await request('/chat/reply', target)
    assert.equal(first.ok, true)
    let restored
    for (let i = 0; i < 10; i++) {
      restored = await request(`/chat/reply?to_id=${target.to_id}`)
      if (restored.job.done) break
      await pause()
    }
    assert.equal(restored.job.id, first.job.id)
    assert.equal(restored.job.status, 'failed')
    assert.match(restored.job.error, /登录/)
    assert.equal((await request(`/chat/reply?id=${first.job.id}`)).job.id, first.job.id)
    const config = (await request('/config')).config
    assert.equal(config.autoSend, false)
    assert.equal(config.chatWatch, false)
  } finally { f.close() }
})
