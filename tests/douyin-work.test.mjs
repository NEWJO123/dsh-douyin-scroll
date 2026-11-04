import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { parseWork, prepareWorkPage, pageRequestSource, publishReceipt, openCommentsPanel, scrollComments } from '../lib/douyin-work.mjs'

const id = '7000000000000000001'
const root = '7000000000000000002'
const target = '7000000000000000003'
const note = `https://www.douyin.com/note/${id}`
const publishSource = readFileSync(new URL('../lib/comment-publish-ui.mjs', import.meta.url), 'utf8')
// Exercise the native publisher's actual control flow with immediate UI waits.
// Browser expressions still execute against the fake DOM, and CDP is entirely local.
const publishComment = vm.runInNewContext(
  publishSource.replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '') + ';publishComment',
  { sleep: async () => {}, openCommentsPanel, pageRequestSource, scrollComments,
    URL, URLSearchParams, Buffer, setTimeout, clearTimeout },
)

test('photo URL and type zero remain independent; unsafe/mismatched input rejected', () => {
  assert.equal(parseWork(note, '', 0).route, 'note')
  assert.equal(parseWork(id, '', 68).work_url, note)
  assert.equal(parseWork(id).aweme_type, null)
  assert.equal(parseWork(id, note).aweme_id, id)
  assert.throws(() => parseWork(id, 'https://example.com/note/' + id))
  assert.throws(() => parseWork(id, 'https://www.douyin.com/note/1111111111111111111'))
})

test('bare ID follows site redirect to note and uses authoritative type', async () => {
  const work = await prepareWorkPage({
    send: async () => {},
    ev: async expr => expr.includes('XMLHttpRequest.prototype.open')
      ? { url: note, sdk: true, content: true }
      : { status: 200, body: JSON.stringify({ status_code: 0, aweme_detail: { aweme_id: id, aweme_type: 0 } }) },
  }, { aweme: id })
  assert.equal(work.work_url, note)
  assert.equal(work.aweme_type, 0)
})

test('footer-only page refuses preparation before any request', async () => {
  let requests = 0
  await assert.rejects(() => prepareWorkPage({
    send: async () => {},
    ev: async expr => {
      if (!expr.includes('XMLHttpRequest.prototype.open')) requests++
      return { url: note, sdk: false, content: false }
    },
  }, { aweme: note }, { timeoutMs: 0 }), /未就绪/)
  assert.equal(requests, 0)
})

function fakeNode({ x = 0, y = 0, width = 50, height = 25, text = '', cid = '', replyId = '', replyTotal = 0, conflictCid = '' } = {}) {
  const node = {
    innerText: text, children: [], parentElement: null,
    getBoundingClientRect: () => ({ x, y, width, height, bottom: y + height, right: x + width }),
    getAttribute: key => key === 'data-cid' ? cid : null,
    scrollIntoView() {}, contains(other) { return this.children.includes(other) },
    querySelectorAll: () => [],
  }
  // 🔴 2026-11-05：发布器从行上的 React props 就地读楼层关系（replyId："0"=顶层），fixture 同步带 fiber
  node.__reactFiber$fixture = {
    memoizedProps: { commentInfo: { cid: conflictCid || cid, replyId, replyTotal } },
    stateNode: node, return: null,
  }
  return node
}

function nativePage({ mutate = () => {}, responseBody, duplicate = false, rootId = '', replyTo = '', cloneRoot = false, conflictRow = false } = {}) {
  const calls = []
  const listeners = new Map()
  const state = { inserted: '', selected: '', intercepted: false, nativeRequests: 0, uiBegan: false }
  const list = fakeNode({ x: 0, y: 40, width: 600, height: 300 })
  const rootItem = fakeNode({ x: 10, y: 50, width: 500, height: 150, text: 'root text', cid: root, replyId: '0', replyTotal: 1 })
  const nestedItem = fakeNode({ x: 20, y: 110, width: 400, height: 70, text: 'nested text', cid: target, replyId: root })
  const rootButton = fakeNode({ x: 30, y: 80, text: '回复' })
  const nestedButton = fakeNode({ x: 40, y: 140, text: '回复' })
  const hiddenLegacy = fakeNode({ width: 0, height: 0, text: 'root text', cid: root })
  const rootClone = fakeNode({ x: 10, y: 250, width: 500, height: 100, text: 'root text', cid: root, replyId: '0' })
  const conflictItem = fakeNode({ x: 25, y: 180, width: 400, height: 70, text: 'conflicting row', cid: root, conflictCid: '7000000000000000009' })
  rootItem.children = [rootButton, nestedItem]
  nestedItem.children = [nestedButton]
  rootItem.querySelectorAll = () => [rootButton, nestedButton]
  nestedItem.querySelectorAll = () => [nestedButton]
  rootClone.querySelectorAll = () => [rootButton]
  const editor = fakeNode({ x: 10, y: 400, width: 500, height: 60 })
  const scope = fakeNode({ x: 0, y: 390, width: 600, height: 100 })
  const arrow = fakeNode({ x: 480, y: 450, width: 30, height: 30 })
  arrow.innerHTML = '<path fill="#FE2C55" />'
  scope.querySelectorAll = selector => selector === 'svg' ? [arrow] : []
  editor.parentElement = scope
  arrow.parentElement = scope
  const document = {
    querySelectorAll(selector) {
      state.uiBegan = true
      if (selector === '.public-DraftEditor-content') return [editor]
      if (selector.includes('comment-list') && selector.includes('comment-item')) return [list, hiddenLegacy, rootItem, nestedItem]
      if (selector === '[data-e2e="comment-item"]') return [hiddenLegacy, rootItem, nestedItem, ...(cloneRoot ? [rootClone] : []), ...(conflictRow ? [conflictItem] : [])]
      if (selector.includes('comment-list')) return [list]
      throw new Error('Unexpected DOM query: ' + selector)
    },
  }
  const emit = async (name, event) => {
    for (const listener of [...(listeners.get(name) || [])]) await listener(event)
  }
  const isPoint = (p, node) => {
    const r = node.getBoundingClientRect()
    return p.x === r.x + r.width / 2 && p.y === r.y + r.height / 2
  }
  const c = {
    ev: async expression => vm.runInNewContext(expression, { document, innerWidth: 900, innerHeight: 800 }),
    on(name, callback) {
      const handlers = listeners.get(name) || new Set()
      handlers.add(callback); listeners.set(name, handlers)
      return () => handlers.delete(callback)
    },
    async send(method, params = {}) {
      calls.push({ method, params })
      if (method === 'Fetch.enable') state.intercepted = true
      if (method === 'Fetch.disable') state.intercepted = false
      if (method === 'Input.insertText') state.inserted = params.text
      if (method === 'Network.getResponseBody') return { body: responseBody, base64Encoded: false }
      if (method === 'Fetch.continueRequest') {
        await emit('Network.responseReceived', { requestId: 'network-1', response: { status: 200, url: 'https://www.douyin.com/aweme/v1/web/comment/publish/' } })
        await emit('Network.loadingFinished', { requestId: 'network-1' })
      }
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
        if (isPoint(params, rootButton)) state.selected = root
        if (isPoint(params, nestedButton)) state.selected = target
        if (isPoint(params, arrow)) {
          assert.ok(state.inserted, 'Native request must follow editor text insertion')
          assert.equal(state.intercepted, true, 'Native request must be intercepted before release')
          assert.equal(state.selected, replyTo || rootId, 'Publisher must select the expected reply row')
          const body = new URLSearchParams({ aweme_id: id, text: state.inserted,
            reply_id: rootId || '0', reply_to_reply_id: replyTo || '0' })
          mutate(body)
          const request = { method: 'POST', url: 'https://www.douyin.com/aweme/v1/web/comment/publish/', postData: body.toString() }
          state.nativeRequests++
          await emit('Fetch.requestPaused', { requestId: 'paused-1', networkId: 'network-1', request })
          if (duplicate) {
            state.nativeRequests++
            await emit('Fetch.requestPaused', { requestId: 'paused-2', networkId: 'network-2', request })
          }
        }
      }
      return {}
    }
  }
  return { c, calls, state, listeners }
}

const text = 'offline test'
const cid = '7000000000000000004'
const success = JSON.stringify({ status_code: 0, comment: { cid, reply_id: root, reply_to_reply_id: target, level: 2 } })
const countCalls = (page, method) => page.calls.filter(call => call.method === method).length

test('native publisher releases exact top-level, root reply and nested reply requests', async () => {
  for (const [rootId, replyTo] of [['', ''], [root, ''], [root, target]]) {
    const page = nativePage({ rootId, replyTo, responseBody: success })
    const result = await publishComment(page.c, { aweme_id: id, root: rootId, reply_to: replyTo, text })
    assert.equal(result.cid, cid)
    assert.equal(result.status_code, 0)
    assert.equal(result.http, 200)
    assert.equal(result.error, undefined)
    assert.equal(result.attempted, true)
    assert.equal(countCalls(page, 'Fetch.continueRequest'), 1)
    assert.equal(countCalls(page, 'Fetch.failRequest'), 0)
    assert.equal(page.state.nativeRequests, 1)
    assert.equal(page.state.intercepted, false)
    assert.ok([...page.listeners.values()].every(handlers => handlers.size === 0))
  }
})

test('dry native publishing inspects matching IDs and blocks the request', async () => {
  const page = nativePage({ rootId: root, replyTo: target })
  const result = await publishComment(page.c, { aweme_id: id, root, reply_to: target, text, dry: true })
  assert.equal(result.dry, true)
  assert.equal(result.blocked, true)
  assert.equal(result.attempted, false)
  assert.equal(result.payload.aweme_id, id)
  assert.equal(result.payload.reply_id, root)
  assert.equal(result.payload.reply_to_reply_id, target)
  assert.equal(result.payload.text, text)
  assert.equal(countCalls(page, 'Fetch.continueRequest'), 0)
  assert.equal(countCalls(page, 'Fetch.failRequest'), 1)
})

test('same-ID visible clones select the original once; conflicting identity stops before editor input', async () => {
  const page = nativePage({ rootId: root, cloneRoot: true, responseBody: success })
  assert.equal((await publishComment(page.c, { aweme_id: id, root, text })).attempted, true)
  assert.equal(countCalls(page, 'Fetch.continueRequest'), 1)
  const ambiguous = nativePage({ rootId: root, conflictRow: true })
  const result = await publishComment(ambiguous.c, { aweme_id: id, root, text })
  assert.equal(result.attempted, false)
  assert.match(result.error, /身份记录不一致/)
  assert.equal(countCalls(ambiguous, 'Input.insertText'), 0)
  assert.equal(countCalls(ambiguous, 'Fetch.continueRequest'), 0)
})

test('derive mode reads the floor relationship from the row itself, never from list requests', async () => {
  // ① 目标是顶层行：就地判定 root=它自己
  const top = nativePage({ rootId: root, responseBody: success })
  const topResult = await publishComment(top.c, { aweme_id: id, root: root, reply_to: '', derive: true, text })
  assert.equal(topResult.attempted, true)
  assert.equal(topResult.root, root)
  assert.equal(topResult.reply_to, '')
  assert.equal(['found-level1', 'has-replies'].includes(topResult.how), true)
  // ② 目标是楼中楼行：就地判定 root=行上的 replyId，不用调用方传
  const nested = nativePage({ rootId: root, replyTo: target, responseBody: success })
  const nestedResult = await publishComment(nested.c, { aweme_id: id, root: target, reply_to: '', derive: true, text })
  assert.equal(nestedResult.attempted, true)
  assert.equal(nestedResult.root, root)
  assert.equal(nestedResult.reply_to, target)
  assert.equal(nestedResult.how, 'found-in-thread')
  // ③ 页面上根本找不到目标 ⇒ need_root 拒绝，绝不瞎猜
  const missing = nativePage({ rootId: root, replyTo: target, responseBody: success })
  const ghost = '7000000000000000099'
  const missingResult = await publishComment(missing.c, { aweme_id: id, root: ghost, reply_to: '', derive: true, text })
  assert.equal(missingResult.attempted, false)
  assert.match(missingResult.error, /没有找到目标评论/)
  assert.equal(countCalls(missing, 'Input.insertText'), 0)
})

test('wrong work, text, root or nested target never releases a request', async () => {
  for (const [key, value] of [['aweme_id', '1111111111111111111'], ['text', 'wrong text'], ['reply_id', target], ['reply_to_reply_id', root]]) {
    const page = nativePage({ rootId: root, replyTo: target, mutate: body => body.set(key, value) })
    const result = await publishComment(page.c, { aweme_id: id, root, reply_to: target, text })
    assert.equal(result.blocked, true, key)
    assert.equal(result.attempted, false, key)
    assert.match(result.error, /不一致/, key)
    assert.equal(result.cid, '')
    assert.equal(countCalls(page, 'Fetch.continueRequest'), 0, key)
    assert.equal(countCalls(page, 'Fetch.failRequest'), 1, key)
  }
})

test('reply to a root refuses an unexpected nested reply field', async () => {
  const page = nativePage({ rootId: root, mutate: body => body.set('reply_to_reply_id', target) })
  const result = await publishComment(page.c, { aweme_id: id, root, text })
  assert.equal(result.blocked, true)
  assert.equal(countCalls(page, 'Fetch.continueRequest'), 0)
})

test('duplicate native request is blocked after only one release', async () => {
  const page = nativePage({ rootId: root, replyTo: target, responseBody: success, duplicate: true })
  await publishComment(page.c, { aweme_id: id, root, reply_to: target, text })
  assert.equal(page.state.nativeRequests, 2)
  assert.equal(countCalls(page, 'Fetch.continueRequest'), 1)
  assert.equal(countCalls(page, 'Fetch.failRequest'), 1)
})

test('empty HTTP 200 is unknown, never success and never a second publish', async () => {
  const page = nativePage({ rootId: root, responseBody: '' })
  const result = await publishComment(page.c, { aweme_id: id, root, text })
  assert.equal(result.cid, '')
  assert.equal(result.http, 200)
  assert.equal(result.attempted, true)
  assert.match(result.error, /未知.*勿重发/)
  assert.equal(page.state.nativeRequests, 1)
  assert.equal(countCalls(page, 'Fetch.continueRequest'), 1)
  const receipt = publishReceipt({ status: 200, body: '' })
  assert.equal(receipt.ok, false)
  assert.equal(receipt.outcome_unknown, true)
  assert.equal(publishReceipt({ status: 200, body: '{"status_code":1,"comment":{"cid":"123"}}' }).ok, false)
  assert.equal(publishReceipt({ status: 200, body: '{"status_code":0,"comment":{"cid":"123"}}' }).ok, true)
})

test('hidden legacy comment list does not make a closed native panel ready', async () => {
  let opened = false
  let clicks = 0
  const hidden = fakeNode({ width: 0, height: 0 })
  const tab = fakeNode({ x: 30, y: 40, text: '评论(16)' })
  const list = { getBoundingClientRect: () => ({ width: opened ? 500 : 0, height: opened ? 300 : 0 }) }
  const document = {
    querySelectorAll: selector => selector.includes('comment-list') ? [hidden, list]
      : selector === 'div,span,button' ? [tab] : [],
  }
  await openCommentsPanel({
    ev: async expression => vm.runInNewContext(expression, { document }),
    send: async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') { clicks++; opened = true }
    },
  })
  assert.equal(clicks, 1)
  assert.equal(opened, true)
})

test('host work schema uses a single supported scalar type', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const declaration = source.slice(source.indexOf('const workParameters'), source.indexOf('// ⭐ 这两样'))
  const schema = vm.runInNewContext(declaration + ';workParameters')
  assert.equal(schema.aweme_type.type, 'integer')
})
