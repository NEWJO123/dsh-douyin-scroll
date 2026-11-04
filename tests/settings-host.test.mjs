/** Exercise actual plugin activation and settings routes in a temporary home, without credentials or external sends. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { apply, Config } from '../index.js'

function host(saved = {}) {
  const home = mkdtempSync(join(tmpdir(), 'douyin-settings-host-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify({ autoSend: false, autoComment: false,
    chatWatch: false, petLinkTo: false, perDay: 0, noon: false, night: false, ...saved }))
  const cleanup = [], tools = []
  let route
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register(tool) { tools.push(tool); return () => {} } },
    get(name) {
      if (name === 'dshHomePath') return () => home
      if (name === 'webServer') return { register(spec) { route = spec.handler; return () => {} } }
      return undefined
    },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose) },
    inject(names, fn) { fn(ctx) },
    provide() {},
  }
  apply(ctx, {})
  // The tests exercise routes directly; no scheduled tick or background greeting should run.
  for (const dispose of cleanup.reverse()) dispose()
  assert.equal(typeof route, 'function', 'settings routes activate')
  const request = async (path, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    req.method = body === undefined ? 'GET' : 'POST'
    req.url = '/api/douyin-duty' + path
    req.headers = {}
    let status, output
    const res = { setHeader() {}, writeHead(code) { status = code }, end(value = '') { output = String(value) } }
    await route(req, res)
    assert.equal(status || 200, 200, output)
    return JSON.parse(output)
  }
  return { home, request, tools, close() {
    assert.equal(dirname(resolve(home)), resolve(tmpdir()))
    assert.ok(basename(home).startsWith('douyin-settings-host-'))
    rmSync(home, { recursive: true, force: true })
  } }
}

test('plugin activates with new configuration and preserves disabled legacy automation', async () => {
  const h = host()
  try {
    assert.ok(Config)
    const config = await h.request('/config')
    assert.equal(config.config.manualPerRun, 3)
    assert.equal(config.config.autoEnabled, false)
    assert.equal(config.config.autoSend, false)
    const status = await h.request('/status')
    assert.equal(status.loggedIn, false)
    assert.deepEqual(status.counts, { auto: 0, manual: 0, unknown: 0, total: 0 })
    const progress = await h.request('/progress')
    assert.equal(progress.round.phase, 'idle')
    assert.equal(progress.tail, undefined, 'raw logs are opt-in')
  } finally { h.close() }
})

test('settings route saves weekdays and an empty final window without changing sending', async () => {
  const h = host({ windows: [{start:'10:00',end:'11:00',label:'test'}] })
  try {
    const saved = await h.request('/config', {manualPerRun:7,autoEnabled:false,scheduleDays:[1,3,5],windows:[]})
    assert.equal(saved.ok, true)
    const again = await h.request('/config')
    assert.equal(again.config.manualPerRun, 7)
    assert.deepEqual(again.config.scheduleDays, [1,3,5])
    assert.deepEqual(again.config.windows, [])
    assert.equal(again.config.autoSend, false)
    assert.equal(again.config.autoComment, false)
    const disk = JSON.parse(readFileSync(join(h.home, 'config.json'), 'utf8'))
    assert.deepEqual(disk.scheduleDays, [1,3,5])
  } finally { h.close() }
})

test('invalid and overlapping schedules reject the entire settings save without changing persisted state', async () => {
  const h = host({ noon: true, perDay: 5, autoEnabled: false, scheduleDays: [1] })
  try {
    const configBefore = readFileSync(join(h.home, 'config.json'), 'utf8')
    const stateBefore = readFileSync(join(h.home, 'state.json'), 'utf8')
    for (const windows of [[{ start: '13:00', end: '15:00' }], [{ start: '24:00', end: '25:00' }], [{ start: '12:00', end: '12:00' }]]) {
      const result = await h.request('/config', { autoEnabled: true, manualPerRun: 8, windows })
      assert.equal(result.ok, false)
      assert.ok(result.error)
      assert.equal(readFileSync(join(h.home, 'config.json'), 'utf8'), configBefore)
      assert.equal(readFileSync(join(h.home, 'state.json'), 'utf8'), stateBefore)
    }
    const config = await h.request('/config')
    assert.equal(config.config.autoEnabled, false)
    assert.equal(config.config.manualPerRun, 3)
  } finally { h.close() }
})

test('legacy overlapping settings stay readable and can be paused without rewriting their plan', async () => {
  const windows = [{ start: '13:00', end: '15:00', label: 'legacy' }]
  const h = host({ noon: true, perDay: 5, autoEnabled: true, windows })
  try {
    assert.deepEqual((await h.request('/config')).config.windows, windows)
    const unrelated = await h.request('/config', { manualPerRun: 6 })
    assert.equal(unrelated.ok, true)
    assert.deepEqual(unrelated.config.windows, windows)
    const paused = await h.request('/config', { autoEnabled: false })
    assert.equal(paused.ok, true)
    assert.equal(paused.config.autoEnabled, false)
    assert.deepEqual(paused.config.windows, windows)
    assert.equal((await h.request('/config', { autoEnabled: true })).ok, false)
  } finally { h.close() }
})

test('saving a reordered plan retains consumed rows on disk without requiring login or running tasks', async () => {
  const h = host({ noon: true, perDay: 5, autoEnabled: false })
  try {
    const now = new Date()
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const stateFile = join(h.home, 'state.json')
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    writeFileSync(stateFile, JSON.stringify({ ...state, windows: { [`${date}:noon`]: true } }))
    const result = await h.request('/config', { autoEnabled: false, noon: false, night: false,
      scheduleDays: [0, 1, 2, 3, 4, 5, 6], windows: [{ start: '12:00', end: '14:00' }] })
    assert.equal(result.ok, true)
    const after = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(after.windows[`${date}:noon`], true)
    assert.equal(after.windows[`${date}:custom:0`], true)
    assert.equal(after.roundActive, state.roundActive)
    assert.equal((await h.request('/status')).loggedIn, false)
  } finally { h.close() }
})

test('manual comment route requires explicit confirmation and preserves photo reply metadata', async () => {
  const h = host()
  try {
    const body = { aweme_id:'7000000000000000001',comment_id:'7000000000000000002',root_comment_id:'7000000000000000003',
      work_url:'https://www.douyin.com/note/7000000000000000001',aweme_type:68,text:'offline draft' }
    assert.equal((await h.request('/comment/reply', body)).sent, false)
    writeFileSync(join(h.home, 'douyin_cookie.txt'), 'sessionid=offline-fixture-only;')
    const draft = await h.request('/comment/reply', body)
    assert.equal(draft.sent, false)
    assert.equal(draft.needsConfirm, true)
    assert.equal(draft.work_url, body.work_url)
    assert.equal(draft.comment_id, body.comment_id)
    const empty = await h.request('/comment/reply', {...body, text:'', confirm:true})
    assert.equal(empty.ok, false)
    assert.ok(empty.error)
  } finally { h.close() }
})
