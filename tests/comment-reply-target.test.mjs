/** Production selector evaluated against local DOM/fiber fixtures; no browser or outbound requests. */
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { commentReplyCandidates } from '../lib/comment-publish-ui.mjs'

const target = '7000000000000000011', other = '7000000000000000012'
const targetText = '@测试账号 新的测试消息'
function row({ cid = '', props = {}, parentProps = [], text = targetText, children = [], hidden = false } = {}) {
  const node = {
    innerText: text, children,
    getAttribute: (name) => name === 'data-cid' ? cid : null,
    getBoundingClientRect: () => ({ width: hidden ? 0 : 300, height: hidden ? 0 : 100 }),
    contains(candidate) { return children.some((child) => child === candidate || child.contains?.(candidate)) },
  }
  let fiber = { memoizedProps: props, return: null }, last = fiber
  for (const parent of parentProps) { last.return = { memoizedProps: parent, return: null }; last = last.return }
  node.__reactFiber$fixture = { memoizedProps: { 'data-e2e': 'comment-item' }, stateNode: node, return: fiber }
  return node
}
function probe(nodes, options = {}) {
  return vm.runInNewContext(`(${commentReplyCandidates.toString()})(${JSON.stringify({ target, text: targetText, ...options })})`, {
    document: { querySelectorAll(selector) { assert.equal(selector, '[data-e2e="comment-item"]'); return nodes } },
  })
}

test('live regression: a shared commentList never makes sibling rows match the target', () => {
  const collection = [{ cid: target }, { cid: other }]
  const correct = row({ props: { commentInfo: { cid: target }, commentList: collection } })
  const sibling = row({ props: { commentInfo: { cid: other }, commentList: collection }, text: 'different public comment' })
  const result = probe([correct, sibling])
  assert.equal(result.error, undefined)
  assert.equal(result.matched_by, 'comment-id')
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0], correct)
})

test('nearest own identity blocks parent target IDs and identical-text fallback', () => {
  const sibling = row({ props: { commentInfo: { cid: other } }, parentProps: [{ commentInfo: { cid: target } }], text: targetText })
  const result = probe([sibling])
  assert.equal(result.matches.length, 0)
})

test('nested replyInfo owns the row; originCommentInfo and parent commentInfo do not', () => {
  const nested = row({ props: { replyInfo: { cid: target }, originCommentInfo: { cid: other } }, parentProps: [{ commentInfo: { cid: other } }] })
  const parent = row({ props: { commentInfo: { cid: other } }, children: [nested], text: `parent plus ${targetText}` })
  const result = probe([parent, nested])
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0], nested)
})

test('a row with no own identity stops at another DOM comment row boundary', () => {
  const parent = row({ cid: target })
  const nested = row({ text: 'different nested comment' })
  nested.__reactFiber$fixture.return.return = { memoizedProps: {}, stateNode: parent,
    return: { memoizedProps: { commentInfo: { cid: target } } } }
  const result = probe([parent, nested])
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0], parent)
})

test('ancestor duplicates and separate clones with the same own ID remain provably the same comment', () => {
  const inner = row({ props: { commentInfo: { cid: target } } })
  const wrapper = row({ props: { commentInfo: { cid: target } }, children: [inner] })
  const clone = row({ props: { commentInfo: { cid: target } } })
  const result = probe([wrapper, inner, clone, row({ cid: target, hidden: true })])
  assert.equal(result.matched_by, 'comment-id')
  assert.equal(result.matches.length, 3)
  const deepest = result.matches.filter((node) => !result.matches.some((other) => other !== node && node.contains(other)))
  assert.equal(deepest.length, 2)
  assert.ok(deepest.includes(inner)); assert.ok(deepest.includes(clone))
})

test('conflicting own IDs or attribute/record mismatch is rejected', () => {
  for (const candidate of [
    row({ props: { commentInfo: { cid: target }, replyInfo: { cid: other } } }),
    row({ cid: target, props: { commentInfo: { cid: other } } }),
  ]) {
    const result = probe([candidate])
    assert.match(result.error, /身份记录不一致/)
    assert.equal(result.matches.length, 0)
  }
})

test('exact target identity wins over unknown duplicate text; collection-only references prove nothing', () => {
  const correct = row({ props: { commentInfo: { cid: target } } })
  const unknown = row({ props: { commentList: [{ cid: target }] }, text: targetText })
  const result = probe([unknown, correct])
  assert.equal(result.matches.length, 1); assert.equal(result.matches[0], correct)
  const noText = probe([unknown], { text: '' })
  assert.equal(noText.matches.length, 0)
})
