/** Offline comment evidence, model and transport fixtures; never load credentials or publish. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { createCommentAiReplyService, createCommentEvidenceCache, generateCommentReply } from '../lib/comment-ai-reply.mjs'
import { apply } from '../index.js'

const fixtureRoot = dirname(fileURLToPath(import.meta.url))
const target = { aweme_id: '7000000000000000001', comment_id: '7000000000000000002', confirm: true }
const original = () => ({ ...target, root_comment_id: '7000000000000000003', work_url: `https://www.douyin.com/note/${target.aweme_id}`,
  aweme_type: 68, nickname: 'Fixture', content: 'Server-verified original comment', replying_to: 'Earlier public fixture comment' })
const receipt = (placement = { verified: true, ok: true }) => ({ ok: true, sent: true, cid: '7000000000000000004', ...target,
  reply_to: target.comment_id, root: original().root_comment_id, placement })
const pause = () => new Promise((resolve) => setImmediate(resolve))
function fixture(overrides = {}) {
  const home = mkdtempSync(join(fixtureRoot, 'comment-ai-fixture-'))
  const calls = { read: 0, generate: 0, send: 0 }, sent = []
  const dependencies = {
    stateDir: home,
    async evidence() { calls.read++; return original() },
    async generate({ evidence }) { calls.generate++; assert.equal(evidence.content, original().content); return { text: 'Generated fixture reply' } },
    async send(args) { calls.send++; sent.push(args); return receipt() },
    ...overrides,
  }
  return { home, calls, sent, dependencies, service: createCommentAiReplyService(dependencies), close() {
    assert.equal(dirname(resolve(home)), resolve(fixtureRoot)); assert.ok(basename(home).startsWith('comment-ai-fixture-'))
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
  assert.fail('fixture comment job did not settle')
}

test('comment jobs require explicit confirmation and valid original IDs before evidence or model work', () => {
  const f = fixture()
  try {
    assert.equal(f.service.start({ ...target, confirm: false }).needsConfirm, true)
    assert.equal(f.service.start({ ...target, comment_id: 'other' }).ok, false)
    assert.equal(f.service.get({ comment_id: 'invalid' }).ok, false)
    assert.deepEqual(f.service.get(target), { ok: true, job: null })
    assert.deepEqual(f.calls, { read: 0, generate: 0, send: 0 })
  } finally { f.close() }
})

test('concurrent clicks generate once and send only server evidence metadata, ignoring client prose', async () => {
  const f = fixture()
  try {
    const first = f.service.start({ ...target, content: 'FORGED CLIENT TEXT', text: 'DO NOT SEND THIS' })
    assert.equal(createCommentAiReplyService(f.dependencies).start(target).job.id, first.job.id)
    const done = await complete(f.service, first.job.id)
    assert.equal(done.status, 'sent'); assert.equal(done.sent, true)
    assert.deepEqual(f.calls, { read: 2, generate: 1, send: 1 })
    assert.deepEqual(f.sent[0], { ...target, root_comment_id: original().root_comment_id, work_url: original().work_url,
      aweme_type: 68, text: 'Generated fixture reply', mode: 'api' })
    const restored = createCommentAiReplyService(f.dependencies)
    assert.equal(restored.get(target).job.id, first.job.id)
    assert.equal(restored.start({ ...target, content: 'different attempt' }).job.id, first.job.id)
    assert.equal(f.calls.generate, 1)
  } finally { f.close() }
})

for (const [name, supplied, server] of [
  ['wrong root', { root_comment_id: '7000000000000000009' }, original()],
  ['unverified root', { root_comment_id: '7000000000000000009' }, { ...original(), root_comment_id: undefined }],
  ['wrong route', { work_url: `https://www.douyin.com/video/${target.aweme_id}` }, original()],
  ['wrong type', { aweme_type: 0 }, original()],
  ['missing original', {}, null],
  ['mismatched original', {}, { ...original(), comment_id: '7000000000000000009' }],
  ['no original text', {}, { ...original(), content: '' }],
]) test(`${name} fails without generating or publishing`, async () => {
  const f = fixture({ async evidence() { return server } })
  try {
    const done = await complete(f.service, f.service.start({ ...target, ...supplied }).job.id)
    assert.equal(done.status, 'failed'); assert.equal(done.sent, false)
    assert.equal(f.calls.generate, 0); assert.equal(f.calls.send, 0)
  } finally { f.close() }
})

for (const placement of [{ verified: false, ok: null }, { verified: true, ok: false }]) test('accepted publish with uncertain or wrong placement is sent-warning and never repeated', async () => {
  const f = fixture({ async send() { return receipt(placement) } })
  try {
    const first = f.service.start(target)
    const done = await complete(f.service, first.job.id)
    assert.equal(done.status, 'sent-warning'); assert.equal(done.sent, true)
    assert.match(done.note, /已发布/)
    assert.equal(createCommentAiReplyService(f.dependencies).start(target).job.id, first.job.id)
    assert.equal(f.calls.generate, 1)
  } finally { f.close() }
})

for (const result of [
  { ok: false, sent: false, uncertain: true, error: 'fixture timeout' },
  { ...receipt(), reply_to: '7000000000000000009' },
  { ...receipt(), cid: undefined },
]) test('unknown publish or mismatched receipt is durable uncertain and cannot regenerate a second send', async () => {
  const f = fixture({ async send() { return result } })
  try {
    const first = f.service.start(target), done = await complete(f.service, first.job.id)
    assert.equal(done.status, 'uncertain'); assert.equal(done.sent, false)
    assert.equal(createCommentAiReplyService(f.dependencies).start(target).job.id, first.job.id)
    assert.equal(f.calls.generate, 1)
  } finally { f.close() }
})

test('known rejection before publishing permits one explicit new attempt', async () => {
  let attempts = 0
  const f = fixture({ async send() { return ++attempts === 1 ? { ok: false, sent: false, attempted: false, wait_sec: 1, error: 'fixture local rate gate' } : receipt() } })
  try {
    const first = await complete(f.service, f.service.start(target).job.id)
    assert.equal(first.status, 'failed'); assert.equal(first.retryable, true)
    const second = await complete(f.service, f.service.start(target).job.id)
    assert.notEqual(first.id, second.id); assert.equal(second.status, 'sent'); assert.equal(attempts, 2)
  } finally { f.close() }
})

test('crashed sending journal recovers as uncertain and reserves original regardless of model output', async () => {
  const f = fixture()
  try {
    const first = await complete(f.service, f.service.start(target).job.id)
    const folder = join(f.home, 'comment-reply-jobs'), path = join(folder, readdirSync(folder).find((name) => name.endsWith('.json')))
    const state = JSON.parse(readFileSync(path, 'utf8'))
    Object.assign(state.job, { status: 'sending', phase: 'sending', done: false, sent: false })
    writeFileSync(path, JSON.stringify(state))
    const restored = createCommentAiReplyService(f.dependencies)
    assert.equal(restored.get(target).job.status, 'uncertain')
    assert.equal(restored.start(target).job.id, first.id)
    assert.equal(f.calls.send, 1)
    writeFileSync(path, '{broken fixture')
    assert.equal(restored.start(target).ok, false)
  } finally { f.close() }
})

test('generation detects a background reply and a changed original before publishing', async () => {
  for (const mode of ['background', 'changed']) {
    let reads = 0, checks = 0
    const f = fixture({
      async evidence() { return ++reads === 2 && mode === 'changed' ? { ...original(), content: 'edited fixture' } : original() },
      alreadyReplied() { return ++checks === 2 && mode === 'background' },
    })
    try {
      const done = await complete(f.service, f.service.start(target).job.id)
      assert.equal(done.status, 'skipped'); assert.equal(f.calls.send, 0)
    } finally { f.close() }
  }
})

test('evidence cache uses only verified rows, refreshes stale rows, and refuses missing originals', async () => {
  let now = 0, reads = 0
  const cache = createCommentEvidenceCache({ now: () => now, ttlMs: 10, async read() { reads++; return { ok: true, list: reads === 1 ? [original()] : [] } } })
  cache.remember([original()])
  assert.equal((await cache.get(target)).content, original().content); assert.equal(reads, 0)
  now = 11
  await Promise.all([cache.get(target), cache.get(target)])
  assert.equal(reads, 1)
  now = 22
  await assert.rejects(cache.get(target), /没有找到/)
  assert.equal(reads, 2)
})

test('comment model prompt receives only this public thread and current persona/model', async () => {
  let request
  const result = await generateCommentReply({
    llm: { async *stream(options) { request = options; yield { type: 'text-delta', text: '{"action":"reply","text":"fixture generated reply"}' }; yield { type: 'finish', reason: { kind: 'stop' } } } },
    route: { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'low' }, persona: 'fixture persona', evidence: original(),
    memory: { mine: [{ text: 'public fixture history' }], facts: ['PRIVATE DM FACT MUST NOT BE INCLUDED'] },
  })
  assert.equal(result.text, 'fixture generated reply')
  assert.match(request.system, /DSH 回复/); assert.match(request.system, /fixture persona/)
  assert.equal(request.model, 'fixture-model'); assert.equal(request.tools, undefined)
  assert.match(request.messages[0].content[0].text, /public fixture history/)
  assert.doesNotMatch(request.messages[0].content[0].text, /PRIVATE DM FACT/)
})

test('actual comment AI routes expose safe confirmation and recoverable no-login jobs without changing automation', async () => {
  const f = fixture(), cleanup = []
  let handler
  writeFileSync(join(f.home, 'config.json'), JSON.stringify({ autoSend: false, autoComment: false, chatWatch: false, petLinkTo: false, perDay: 0, noon: false, night: false }))
  const ctx = {
    logger: { info() {}, warn() {}, error() {} }, tools: { register() { return () => {} } },
    get(name) { if (name === 'dshHomePath') return () => f.home; if (name === 'webServer') return { register(spec) { handler = spec.handler; return () => {} } } },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose) }, inject(names, fn) { fn(ctx) }, provide() {},
  }
  const request = async (path, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method: body === undefined ? 'GET' : 'POST', url: `/api/douyin-duty${path}`, headers: {} })
    let output
    await handler(req, { setHeader() {}, writeHead() {}, end(value) { output = value } })
    return JSON.parse(output)
  }
  try {
    apply(ctx, {}); for (const dispose of cleanup.reverse()) dispose()
    const query = `aweme_id=${target.aweme_id}&comment_id=${target.comment_id}`
    assert.deepEqual(await request(`/comment/ai-reply?${query}`), { ok: true, job: null })
    assert.equal((await request('/comment/ai-reply', { ...target, confirm: false })).needsConfirm, true)
    const first = await request('/comment/ai-reply', target)
    let result
    for (let i = 0; i < 10; i++) { result = await request(`/comment/ai-reply?${query}`); if (result.job.done) break; await pause() }
    assert.equal(result.job.id, first.job.id); assert.equal(result.job.status, 'failed'); assert.match(result.job.error, /登录/)
    const config = (await request('/config')).config
    assert.equal(config.autoSend, false); assert.equal(config.autoComment, false); assert.equal(config.chatWatch, false)
  } finally { f.close() }
})
