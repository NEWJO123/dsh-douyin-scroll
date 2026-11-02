#!/usr/bin/env node
/** 只读验收：作品页、签名器、评论面板与回复目标；从不发布。 */
import { openPage } from '../lib/chrome.mjs'
import { prepareWorkPage, openCommentsPanel } from '../lib/douyin-work.mjs'

const [aweme, needle = ''] = process.argv.slice(2)
let c
try {
  c = await openPage({ isolated: true })
  const work = await prepareWorkPage(c, { aweme })
  await openCommentsPanel(c)
  const read = () => c.ev(`(() => {
    const items = [...document.querySelectorAll('[data-e2e="comment-item"]')]
    const hit = items.find(e => (e.innerText || '').includes(${JSON.stringify(needle)}))
    return { count: items.length, matched: ${Boolean(needle)} && Boolean(hit),
      reply_button: Boolean(hit && [...hit.querySelectorAll('div,span,button')].some(e => (e.innerText || '').trim() === '回复')) }
  })()`)
  let comments = await read()
  for (let i = 0; i < 10 && !comments.count; i++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    comments = await read()
  }
  console.log(JSON.stringify({ ok: comments.count > 0, ...work, comments, sent: false }, null, 2))
  if (!comments.count) process.exitCode = 1
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error.message, sent: false }))
  process.exitCode = 1
} finally { if (c) await c.close() }
