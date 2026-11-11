#!/usr/bin/env node
/**
 * tools/chat-watch.mjs —— 盯私信：每隔 N 秒读一次会话，把**对方新说的话**写到文件里
 * ============================================================================
 * 为什么要有它：
 *   2026-10-22 用户要求「跟我聊五分钟，检查频率大概十秒一次」。
 *   每次聊天都起一个新进程去连 Chrome 太慢/太重；这里**开一个页面、一直连着**，
 *   每 N 秒读一次 DOM，只把新的「对方消息」追加到 chat-inbox.jsonl。
 *
 * 用法：
 *   node tools/chat-watch.mjs --to "示例好友" --to-id <sec_uid> [--every 10] [--seconds 300]
 *
 * 输出：
 *   每轮一行 JSON 到 stdout（面板/调用方看进度）
 *   新消息追加到 <家>/chat-inbox.jsonl（一行一条，带 ts / text / from / item）
 *
 * ⚠️ 只读：这个脚本**不发任何消息**。发消息走 im-send.mjs。
 * ============================================================================
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homeDir } from '../lib/paths.mjs'
import { openPage, sleep } from '../lib/chrome.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const TO = String(argOf('--to', '')).trim()
const TOID = String(argOf('--to-id', '')).trim()
const EVERY = Math.max(3, Math.min(Number(argOf('--every', '10')) || 10, 120))
const SECONDS = Math.max(30, Math.min(Number(argOf('--seconds', '300')) || 300, 3600))

const HOME = homeDir()
const INBOX = join(HOME, 'chat-inbox.jsonl')
// 每次开新的一轮就清空 inbox（只关心这一轮的新消息）
try { writeFileSync(INBOX, '', 'utf8') } catch { /* 清不掉就追加 */ }

const out = (o) => console.log(JSON.stringify(o))

/**
 * 读会话消息（复用 im-send.mjs 里那套「头像落在左/右半边」判据）。
 * 这里内联一份，因为 im-send.mjs 是 CLI、不导出函数。
 */
const readMessages = async (ev) => {
  const raw = await ev(`(function(){
    var listNode = document.querySelector('[class*="messageMessageList"]')
      || document.querySelector('[class*="componentsRightPanel"]') || document.body;
    var lb = listNode.getBoundingClientRect();
    var mid = lb.left + lb.width / 2;
    var nodes = Array.prototype.slice.call(document.querySelectorAll('[class*="messageMessageBox"]'));
    var out = [], seenObj = new WeakSet();
    nodes.forEach(function(n){
      var fk = Object.keys(n).find(function(k){ return k.indexOf('__reactFiber$') === 0 });
      if (!fk) return;
      var f = n[fk], d = 0, found = null;
      while (f && d < 24) {
        var p = f.memoizedProps;
        if (p && p.message && typeof p.message === 'object' && p.message.parsedContent) { found = p.message; break }
        f = f.return; d++;
      }
      if (!found) return;
      if (seenObj.has(found)) return;
      seenObj.add(found);
      var r = n.getBoundingClientRect(), side = '';
      var im = Array.prototype.slice.call(n.querySelectorAll('img')).filter(function(img){
        var b = img.getBoundingClientRect();
        if (b.width < 28 || b.width > 48) return false;
        if (Math.abs(b.width - b.height) > 6) return false;
        var cy = b.top + b.height / 2;
        return cy >= r.top - 2 && cy <= r.bottom + 2;
      })[0];
      if (im) {
        var ib = im.getBoundingClientRect();
        side = ((ib.left + ib.width / 2) < mid) ? 'them' : 'me';
      }
      var pc = found.parsedContent || {};
      var text = String(pc.text || pc.content_title || '').replace(/\\s+/g, ' ').trim();
      out.push({ own: side, text: text, awe: pc.aweType || 0, item: pc.itemId ? String(pc.itemId) : '' });
    });
    return JSON.stringify(out);
  })()`)
  let list = []
  try { list = JSON.parse(raw) || [] } catch { return [] }
  let carry = ''
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].own) carry = list[i].own
    list[i].from = list[i].own || carry || 'unknown'
  }
  return list
}

const openConversation = async (ev, send, nick, secUid) => {
  // 会话列表已经开着的话，直接点那个人
  const clicked = await ev(`(function(){
    var NICK = ${JSON.stringify(nick)}, SEC = ${JSON.stringify(secUid)};
    var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-e2e="conversation-item"]'));
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var fk = Object.keys(n).find(function(k){ return k.indexOf('__reactFiber$') === 0 });
      var got = '';
      if (fk) {
        var f = n[fk], d = 0;
        while (f && d < 14) {
          var p = f.memoizedProps;
          if (p && p.conversation && p.conversation.toParticipantSecUserId) { got = String(p.conversation.toParticipantSecUserId); break }
          f = f.return; d++;
        }
      }
      var txt = (n.innerText || '').replace(/\\s+/g, ' ').trim();
      var hit = (SEC && got === SEC) || (!SEC && txt.indexOf(NICK) === 0);
      if (!hit) continue;
      var r = n.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    }
    return '';
  })()`)
  if (!clicked) return false
  const b = JSON.parse(clicked)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none', buttons: 0 })
  await sleep(120)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(2200)
  return true
}

const startedAt = Date.now()
out({ ok: true, phase: 'start', to: TO, to_id: TOID, every_s: EVERY, seconds: SECONDS, inbox: INBOX })

// ⭐ 2026-11-11（Issue #19 根因 1）：isolated 独占页面 —— 不加的话这里复用共享页面，
//    10 秒一次的 /chat 导航会把值班/发卡片的页面当场顶掉（实测「时好时坏」的真凶）。
const c = await openPage({ url: 'https://www.douyin.com/chat', isolated: true })
try {
  const url = String(await c.ev('location.href'))
  if (!url.includes('/chat')) {
    await c.send('Page.navigate', { url: 'https://www.douyin.com/chat' })
    await sleep(6000)
  }
  await sleep(2500)
  const opened = await openConversation(c.ev, c.send, TO, TOID)
  out({ ok: true, phase: 'opened', conversation_opened: opened })

  // 基线：现在已有多少条（只把之后新增的算"新消息"）
  let prev = await readMessages(c.ev)
  const known = new Set(prev.map((m) => `${m.from}|${String(m.text).slice(0, 60)}`))
  out({ ok: true, phase: 'baseline', count: prev.length })

  let ticks = 0
  let newCount = 0
  const deadline = startedAt + SECONDS * 1000

  while (Date.now() < deadline) {
    await sleep(EVERY * 1000)
    ticks++
    let msgs = []
    try { msgs = await readMessages(c.ev) } catch (e) {
      out({ ok: false, phase: 'tick', tick: ticks, error: String(e?.message ?? e) })
      continue
    }
    const fresh = []
    for (const m of msgs) {
      const key = `${m.from}|${String(m.text).slice(0, 60)}`
      if (known.has(key)) continue
      known.add(key)
      fresh.push(m)
    }
    // 只关心**对方**说的话（我自己发的不需要通知）
    const theirs = fresh.filter((m) => m.from === 'them')
    if (theirs.length) {
      newCount += theirs.length
      for (const m of theirs) {
        const rec = { ts: new Date().toISOString(), from: 'them', text: m.text, item: m.item || undefined }
        try { appendFileSync(INBOX, JSON.stringify(rec) + '\n', 'utf8') } catch { /* 写不进去也要继续 */ }
        out({ ok: true, phase: 'new', tick: ticks, text: m.text, item: m.item || undefined })
      }
    }
    // 每 6 轮报一次心跳（免得日志太吵）
    if (ticks % 6 === 0) out({ ok: true, phase: 'heartbeat', tick: ticks, elapsed_s: Math.round((Date.now() - startedAt) / 1000), total_msgs: msgs.length, new_theirs: newCount })
  }

  out({ ok: true, phase: 'done', ticks, new_theirs: newCount, elapsed_s: Math.round((Date.now() - startedAt) / 1000) })
} catch (e) {
  out({ ok: false, phase: 'error', error: String(e?.message ?? e) })
} finally {
  try { c.close() } catch { /* 已经关了 */ }
}
