#!/usr/bin/env node
/**
 * tools/im-send.mjs —— 信信发送器（插件调这个）
 * ============================================================================
 * 全程**无窗口**：跑的是无头 Chrome 里抖音自己的前端，连接/签名/编解码都由它完成。
 * 我们只做三件事：点开会话 → 粘正文 → 回车。
 *
 * 用法：
 *   node tools/im-send.mjs --to "示例好友" --text "你好"
 *   node tools/im-send.mjs --to "示例好友" --file <txt路径>
 *   node tools/im-send.mjs --to "示例好友" --file x.txt --dry   # 只验证不发送
 *   node tools/im-send.mjs --to "示例好友" --read               # 只读：把会话读出来（带「谁发的」）
 *
 * 输出：一行 JSON
 *   发送：{ok, sent, to, len, readback, my_msg_before, my_msg_after, newest_from, msgs_sample, …}
 *   只读：{ok, mode:'read', count, mine, them, unknown, messages:[{from,text,…}]}（messages 旧的在前）
 *
 * ⚠️ 「谁发的」判据是**头像落在列表左半边还是右半边**，不是 `isMyMessage`
 *    （`isMyMessage` 恒为 true，连对方发的也是 true —— 实测过，别再用）。
 * ============================================================================
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openPage, sleep } from '../lib/chrome.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok ? 0 : 1 }

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? '') : d }
const TO = argOf('--to', '')
const TOID = argOf('--to-id', '')
const FILE = argOf('--file', '')
const TEXT = argOf('--text', '')
const DRY = argv.includes('--dry')
const READ = argv.includes('--read')
/** ⭐ --list：只列出会话里的人（昵称 + sec_uid），不发东西 */
const LIST = argv.includes('--list')

const bodyText = async (ev) => (await ev(`(document.body?document.body.innerText:'')||''`)) || ''

/**
 * ⭐ 回读消息列表 + 判定「这条到底是谁发的」。
 *
 * ── 判据：**头像落在列表的哪半边** ────────────────────────────────────────
 *   我的消息靠右打 ⇒ 36×36 头像的 x≈1354（列表中线 ≈860 的右边）
 *   对方的消息靠左 ⇒ 头像的 x≈320（左边）
 *
 * ── 为什么只能用这个（2026-10-21 逐条试过，别的全是死路） ────────────────
 *   ✗ `message.isMyMessage` —— **恒为 true**，连使用者发的那几条也是 true
 *   ✗ 三层祖先的 class 名 —— 我发的和对方发的完全一样
 *   ✗ 消息行的几何 —— 都是整行宽（x=304 w=1102），没有左右布局之分
 *   ✗ `parsedContent` 里也没有 sender 字段（只有 type/text/aweType/createdAt/is_card）
 *   ✓ 头像的横向落点 —— 唯一稳定可用的信号；头像 URL 也固定（我方 …d7VAiREY / 对方 …yZQrf6lE）
 *
 * ── 两个坑 ────────────────────────────────────────────────────────────────
 *   1. 同一人连发几条时，**只有组里最早那条带头像**，后面几条没有
 *      ⇒ 从旧往新扫，缺的继承上一条（不是"下一条"）
 *   2. DOM 顺序是「新的在上」、视觉是「旧的在上」（容器是 column-reverse）
 *      ⇒ 必须**倒着遍历**才能让继承方向正确
 *   3. 一条都扫不到头像（比如最顶上被裁掉的那条）⇒ 给 `unknown`，**不猜**
 *
 * 输出每条：{ from: 'me'|'them'|'unknown', text, awe, item, own }
 */
const readMessages = async (ev) => {
  const raw = await ev(`(function(){
    var listNode = document.querySelector('[class*="messageMessageList"]')
      || document.querySelector('[class*="componentsRightPanel"]') || document.body;
    var lb = listNode.getBoundingClientRect();
    var mid = lb.left + lb.width / 2;
    // ⚠️ 一条消息在 DOM 里有 3 层 class 都含 "messageMessageBox"（outer / selectableRow / contentBox），
    //    直接 querySelectorAll 会**一条算三条** ⇒ 用 **对象引用** 去重（同一层消息被多个节点共享同一个
    //    message 对象）。别用位置去重：三层节点的 top 差几个像素，会漏掉。
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
      // 这一条自己带的那枚头像落在哪边（只认 36×36 的正方形；分享卡片缩略图是 108px、已读标记是 20px，都排除）
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
      /**
       * ⭐ 2026-11-12（收衍生仓库 kHolmesXX/dsh-fish_live_in_douyin fish.11 的做法）：
       *   群聊场景 parsedContent 里没有 sender，但 React fiber 的 message 对象上
       *   （或它的 sender/user/author/fromUser/userInfo 里）可能带着昵称 ——
       *   存在都试一遍，取不到就 sender:''（不猜、不编）。≤40 字。
       *   私信（1v1）场景 from 已有方向，sender 锦上添花；群聊是刚需（谁发的）。
       */
      var sender = '';
      (function(){
        var KEYS = ['nickname','nickName','nick','displayName','userName','username'];
        var cands = [found.sender, found.user, found.author, found.fromUser, found.userInfo];
        for (var k in found) {
          if (k === 'parsedContent' || k === 'sender' || k === 'user' || k === 'author') continue;
          var v = found[k];
          if (v && typeof v === 'object' && !Array.isArray(v)) cands.push(v);
        }
        for (var i = 0; i < cands.length && !sender; i++) {
          var o = cands[i];
          if (!o || typeof o !== 'object') continue;
          for (var j = 0; j < KEYS.length; j++) {
            var v2 = o[KEYS[j]];
            if (typeof v2 === 'string' && v2.trim()) { sender = v2.trim().slice(0, 40); break; }
          }
          if (sender) break;
          var u = o.user || o.author || o.sender;
          if (u && typeof u === 'object') {
            for (var j2 = 0; j2 < KEYS.length; j2++) {
              var v3 = u[KEYS[j2]];
              if (typeof v3 === 'string' && v3.trim()) { sender = v3.trim().slice(0, 40); break; }
            }
          }
        }
      })();
      out.push({ own: side, text: text, awe: pc.aweType || 0, item: pc.itemId ? String(pc.itemId) : '', sender: sender });
    });
    return JSON.stringify(out);
  })()`)
  let list = []
  try { list = JSON.parse(raw) || [] } catch { return [] }
  // 分组继承：倒着走 = 从旧到新
  let carry = ''
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].own) carry = list[i].own
    list[i].from = list[i].own || carry || 'unknown'
  }
  return list
}

const hasEditor = async (ev) => await ev(`(function(){
  var eds=Array.prototype.slice.call(document.querySelectorAll('[contenteditable="true"], textarea'));
  return eds.some(function(e){var r=e.getBoundingClientRect(); return r.width>80 && r.height>10;});
})()`)

/**
 * 列出会话列表里的每一项：昵称（显示用）+ **sec_uid（稳定 id）** + 点击坐标。
 * ⚠️ sec_uid 从会话项的 React fiber 里读 `conversation.toParticipantSecUserId` ——
 *    昵称会重名，这个不会（2026-10-21 用户指出「光靠昵称不安全」后改的）。
 */
const listConversations = (ev) => ev(`(function(){
  var out = [];
  var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-e2e="conversation-item"]'));
  nodes.forEach(function(n){
    var fk = Object.keys(n).find(function(k){ return k.indexOf('__reactFiber$') === 0 });
    var sec = '';
    var unread = 0;
    if (fk) {
      var f = n[fk], d = 0;
      while (f && d < 14) {
        var p = f.memoizedProps;
        if (p && p.conversation && p.conversation.toParticipantSecUserId) {
          sec = String(p.conversation.toParticipantSecUserId);
          // ⭐ 未读数：React fiber 里的 unreadCount 与 DOM 红点徽标**实测完全一致**（14/14 会话核过）。
          //    DOM 里也有 .ConversationItemUnReadCount 徽标，但 fiber 更稳（徽标会随滚动虚拟化消失）。
          unread = Number(p.conversation.unreadCount) || 0;
          break;
        }
        f = f.return; d++;
      }
    }
    var r = n.getBoundingClientRect();
    var t = (n.innerText || '').replace(/\\s+/g, ' ').trim();
    /**
     * ⭐ 昵称要**单独取**，不能拿整段 text 去掉重。
     *    text 是「昵称 时间 最后一句话」，用 text.includes(who) 会把
     *    "别人最后一句话里出现的词" 当成那个人 —— 实测：
     *    用「大肥鱼」当收件人（没有任何人叫这个名字），会匹配到 3 个人。
     *    这里给两个候选：昵称元素里的文本 → 没有就退回第一段。
     */
    var nickEl = n.querySelector('[class*="ConversationItemTitle"], [class*="conversationItemTitle"], [class*="nickname"], [class*="Nickname"]');
    var nick = nickEl ? (nickEl.innerText || '').replace(/\\s+/g, ' ').trim() : '';
    if (!nick) nick = t.split(' ')[0] || '';
    /**
     * ⚠️ 左侧面板有**两个列表**："会话列表 和 「陌生人消息」列表。
     *    当前激活哪个，另一个的项仍然在 DOM 里，但被横向平移到屏外（left 为负）。
     *    实测：陌生人面板开着时，"列表里私信对象那条 left=-303 ⇒ 点它毫无反应。
     *    ⇒ 把 in_view 一起报上去，让调用方知道这个坐标点不到。
     */
    var inView = r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
    /**
     * ⭐ 这条属于哪个列表：'main'（"会话列表）/ 'stranger'（陌生人消息）/ ''
     *    两个列表在同一块区域里横向滑动，非激活的会被平移到屏外（left 为负）。
     *    知道归属才能"切过去"，光靠 scrollIntoView 救不回来（那是横向平移，不是滚动）。
     *    ⚠️ 判定顺序不能反：陌生人列表的 class 里**同时**含
     *       StrangerConversationList 和 ConversationList，必须先判 stranger。
     */
    var panel = '';
    var boxEl = n.parentElement, dd = 0;
    while (boxEl && dd < 10) {
      var bc = String(boxEl.className || '');
      if (/StrangerConversationList/.test(bc)) { panel = 'stranger'; break }
      if (/ConversationListwrapper/.test(bc)) { panel = 'main'; break }
      boxEl = boxEl.parentElement; dd++;
    }
    out.push({
      sec_uid: sec,
      nick: nick.slice(0, 40),
      text: t.slice(0, 70),
      unread: unread,
      in_view: inView,
      panel: panel,
      x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
      w: Math.round(r.width), h: Math.round(r.height),
    });
  });
  return JSON.stringify(out);
})()`)

/** 从会话项文本里猜昵称（第一段；"示例好友 12:12 最后一句话" → "示例好友"） */
const nickOf = (text) => String(text || '').split(/\s+/)[0] || ''

/** ⭐ 0.5.5b 群：右栏头部对群是「群名(成员数)」—— 比对前把尾部 (数字) 归一化掉。
 *  模块层定义：openConversation 和 main 里的发送前闸都要用。 */
const baseNick = (s) => String(s || '').replace(/\(\d+\)\s*$/, '').trim()

/** 读「当前打开的这个会话」的对端 sec_uid —— 用来校验身份（不同层级包法不一样，多试几种） */
const currentConvId = (ev) => ev(`(function(){
  function tp(o){
    if (!o || typeof o !== 'object') return '';
    var cands = [
      o.curConversation && o.curConversation.toParticipantSecUserId,
      o.conversation && o.conversation.toParticipantSecUserId,
      o.msgConfig && o.msgConfig.conversation && o.msgConfig.conversation.toParticipantSecUserId,
      o.message && o.message.msgConfig && o.message.msgConfig.conversation && o.message.msgConfig.conversation.toParticipantSecUserId,
    ];
    for (var i = 0; i < cands.length; i++) if (cands[i]) return String(cands[i]);
    return '';
  }
  var node = document.querySelector('[class*="messageMessageBox"]') || document.querySelector('[data-e2e="msg-item-content"]');
  if (!node) return '';
  var fk = Object.keys(node).find(function(k){ return k.indexOf('__reactFiber$') === 0 });
  if (!fk) return '';
  var f = node[fk], d = 0;
  while (f && d < 30) {
    var got = tp(f.memoizedProps);
    if (got) return got;
    f = f.return; d++;
  }
  return '';
})()`)

/**
 * ⭐ 等会话列表真的渲染出来（**别拿"URL 已经是 /chat"当加载完成**）。
 *
 * 🔴 2026-10-23 实测踩到的坑：
 *    冷启动（无头 Chrome 刚起来）时 `location.href` 可能**已经是 /chat**，
 *    于是原来那句 `if (!url.includes('/chat')) { navigate; sleep(5000) }` 被跳过，
 *    紧接着就去 listConversations —— 此时列表还没渲染，`querySelectorAll` 返回 **0 个**，
 *    或者只返回几个 —— 于是"找不到人"，报成 `not-found`。
 *    实测：冷启动后 `--read 枫眠` 直接失败，candidates 里只有 1 个人（应该有 14 个）。
 *
 * 所以：**轮询等列表出现**，并在拿到第一次之后再多等一会儿让它稳定（虚拟列表会分批渲染）。
 * 返回最后看到的条数（0 = 等超时了，列表真的没出来）。
 */
async function waitList(ev, { timeoutMs = 15000, settleMs = 600 } = {}) {
  const t0 = Date.now()
  let last = 0
  let stable = 0
  while (Date.now() - t0 < timeoutMs) {
    const n = Number(await ev(`document.querySelectorAll('[data-e2e="conversation-item"]').length`)) || 0
    if (n > 0) {
      // 拿到之后就等它"不再变多"，避免只渲染了一部分就往下走
      if (n === last) stable++
      else { stable = 0; last = n }
      if (stable >= 2) return n
    }
    await sleep(settleMs)
  }
  return last
}

/**
 * 打开会话。返回 { status, matched }
 *   status: 'already-open' | 'clicked' | 'not-found' | 'ambiguous' | 'no-list'
 *           | 'unverifiable' | 'mismatch' | 'offscreen'
 *   ⚠️ 只在「昵称唯一」或「给了稳定 id」时才点 —— 重名一律 ambiguous，不猜。
 *   ⚠️ 已经打开着也不轻信：给了 whoId 就必须核对当前会话的对端 id，不然会「发给错的人还报成功」。
 *
 * 🔴 2026-10-23 修了三个会把信信发错人的 bug（都是实测复现的）：
 *
 *   ① 【already-open 判断用了整个页面文本】
 *      原来：`const t = await bodyText(ev); ... else if (who && t.includes(who))`
 *      `bodyText` 是 `document.body.innerText` —— **包含左边的会话列表**，
 *      而列表里永远列着所有人 ⇒ `t.includes(who)` 几乎永真。
 *      后果：只要界面上有**任何一个**会话开着（上次读过谁就是谁），
 *            再让工具发给另一个人，它会直接返回 `already-open`，
 *            并把**当前那个人的 sec_uid** 当成你要找的人 —— 于是消息发进别人的对话框，
 *            而返回值里 `to` 写的是你要发的那个人。**调用方完全看不出错。**
 *      实测：界面开着「枫眠」，`--to 示例好友`（只给昵称）⇒
 *            ok:true, to:"示例好友", to_sec_uid: 枫眠的 id。
 *      ⇒ 现在：**只看右栏头部**（真正表示"当前对端"的那一小块），且必须与昵称**精确相等**；
 *              对不上就老老实实去列表里点。
 *
 *   ② 【昵称用 includes 匹配】
 *      原来 `list.filter(c => c.text.includes(who))`，text 里含"最后一句话"。
 *      实测：用「大肥鱼」当收件人（没有任何人叫这个名字）会匹配到 3 个人，
 *            最后发给「哈基米斯基」。用「你好」会匹配到 6 个。
 *      ⇒ 现在：**先比 nick 是否相等**，再用 text 兜底（并标注 matched_by）。
 *
 *   ③ 【屏外元素点不到，却报成功】
 *      左侧面板有两个列表（"列表 / 陌生人消息）。非激活的那个被横向平移到屏外。
 *      实测：陌生人面板开着时，"列表里私信对象那条 left=-303，
 *            派发 mousePressed 到 x=-156 **毫无反应、也不报错**，
 *            点完右栏还是原来那个人 ⇒ 后续 acCurrentConvId 校验用的是旧会话……
 *      最坏情况是"看起来切换了、其实没切"。
 *      ⇒ 现在：点击前先要求 `in_view`；不在可视区**先把它滚进可视区**，滚不进来就
 *              返回 `status:'offscreen'` —— 明确失败，不假装成功。
 */
async function openConversation(ev, send, who, whoId) {
  /**
   * ⭐ 判断"当前会话是不是就是他"要用**右栏头部**，不是 bodyText。
   *    右栏头部 = `[class*="componentsRightPanel"]` 的第一行文本，那才是对端昵称。
   *    （bodyText 含左侧列表，任何人都在里面 —— 那正是 bug ① 的根源）
   * ⭐ 0.5.5b 群：比对用模块层的 baseNick（群名带 "(N)" 后缀也能对上）。
   */
  const currentWho = async () => {
    const nick = String(await ev(`(function(){
      var r = document.querySelector('[class*="componentsRightPanel"]');
      if (!r) return '';
      var lines = (r.innerText || '').split('\\n').map(function(s){return s.trim()}).filter(Boolean);
      return lines.length ? lines[0] : '';
    })()`) || '').trim()
    const id = String(await currentConvId(ev) || '')
    return { nick, id }
  }

  if (await hasEditor(ev)) {
    const cur = await currentWho()
    if (whoId) {
      if (cur.id && cur.id === whoId) return { status: 'already-open', matched: { sec_uid: cur.id, nick: who || cur.nick } }
      if (!cur.id) return { status: 'unverifiable', matched: null, hint: '会话开着但读不到对端 id，不敢确认发给谁 —— 请关掉会话重试，或改用昵称' }
      // 当前开着的是别人 ⇒ 继续往下走，去列表里点对的那个
    } else if (who) {
      /**
       * ⭐ 只有昵称时的判据：右栏头部**精确等于**昵称才算已打开。
       *    ⚠️ 不要用 includes：昵称 "拣" 是 "拣东西" 的前缀；而且这里以前是整个 bodyText。
       *    ⭐ 0.5.5b：比对走 baseNick（群名带 "(N)" 后缀也能对上）
       */
      if (cur.nick && baseNick(cur.nick) === baseNick(who) && cur.id) {
        return { status: 'already-open', matched: { sec_uid: cur.id, nick: cur.nick } }
      }
      // 右栏读不到昵称 ⇒ 不能想当然，落到下面去点列表
    }
  }
  // ⭐ 别急着找 —— 先等列表真的渲染出来（冷启动时 URL 已是 /chat 但列表还没好）
  await waitList(ev)
  const raw = await listConversations(ev)
  let list = []
  try { list = JSON.parse(raw) || [] } catch { list = [] }
  if (!list.length) return { status: 'no-list', matched: null }

  let hits = []
  let how = ''
  /** 精确匹配不到时的兜底候选（只做提示，**不自动选**） */
  let nearMisses = []
  if (whoId) {
    hits = list.filter((c) => c.sec_uid === whoId)
    how = 'sec_uid'
  } else if (who) {
    /**
     * 🔴 三级匹配，**越往后越保守**（2026-10-23 重做）：
     *   ① 昵称**完全相等**      → 直接用
     *   ② 昵称**以输入开头**    → 允许（"某帅气" → "示例好友"），仍算唯一命中才用
     *   ③ 整段 text 包含        → ❌ **不再自动采用**，只当作"你可能想找"的提示
     *
     *    为什么砍掉 ③：
     *      text 是「昵称 时间 最后一句话」。用「大肥鱼」当收件人时会命中 3 个人
     *      （哈基米斯基 / zPz / 拣 —— 因为他们的**最后一句话**里都有"大肥鱼"），
     *      报错还写成"有多个同名的人"，让人以为真的有 3 个同名。
     *      实测确认过：一个叫「大肥鱼」的都没有。
     *      ⇒ 找不到就叫找不到，别拿别人的话当名字。
     */
    hits = list.filter((c) => c.nick === who)
    how = 'nickname(精确)'
    if (!hits.length) {
      const pref = list.filter((c) => c.nick && c.nick.startsWith(who))
      if (pref.length === 1) { hits = pref; how = 'nickname(前缀)' }
      else if (pref.length > 1) nearMisses = pref
    }
    if (!hits.length && !nearMisses.length) {
      // ③ 只用来给提示，绝不自动选
      nearMisses = list.filter((c) => c.text.includes(who)).slice(0, 6)
    }
  } else {
    return { status: 'not-found', matched: null }
  }

  if (!hits.length) {
    return {
      status: 'not-found', matched: null, matched_by: how,
      /** ⭐ 模糊候选单独放，明确标注"没有一个人叫这个名字" */
      near_misses: nearMisses.map((c) => ({ sec_uid: c.sec_uid, nick: c.nick, unread: c.unread })),
      hint: nearMisses.length
        ? `没有任何人的昵称是「${who}」。`
          + `下面这些人的**最后一句话**里出现了这几个字（不是名字）：`
          + nearMisses.map((c) => c.nick).join('、')
          + ' —— 要发给谁请用 --to-id 指定。'
        : `会话列表里没有昵称为「${who}」的人。`,
      candidates: list.map((c) => ({ sec_uid: c.sec_uid, nick: c.nick, unread: c.unread })),
    }
  }
  if (hits.length > 1) {
    // 同名多个 ⇒ 绝不猜（猜错就是把信信发给陌生人）
    return {
      status: 'ambiguous',
      matched: null,
      candidates: hits.map((c) => ({ sec_uid: c.sec_uid, nick: c.nick, unread: c.unread })),
      hint: '会话列表里有多个同名的人 —— 请改用 --to-id <sec_uid> 指定',
    }
  }
  const b = hits[0]

  /**
   * ⭐ 点击前先把它**弄到可视区里**。
   *
   *    左侧面板有两个列表（"会话列表 / 「陌生人消息」），它们在同一块区域里
   *    **横向滑动**：非激活的那个被平移到屏外（left 为负）。
   *    对屏外坐标派发 mousePressed **没有任何反应、也不报错** —— 点了等于白点。
   *
   *    救法有两层（顺序不能反）：
   *      ① 它在"另一个列表"里 ⇒ 先点那个面板的返回箭头/入口，把面板切过去
   *      ② 只是滚出了纵向可视区 ⇒ scrollIntoView
   *    两层都救不回来 ⇒ 返回 offscreen，**明确失败，不假装成功**。
   *
   *    ⚠️ 为什么不能只用 scrollIntoView：
   *       横向平移是 transform/left 位移，不是滚动条 ⇒ scrollIntoView 对 x<0 完全无效
   *       （实测 before [−303,126] → after [−303,126]，一点没动）。
   */
  if (!b.in_view) {
    const want = b.panel || 'main'
    // ① 切列表：目标在 main、但当前屏外 ⇒ 点「返回」箭头退出陌生人面板
    if (want === 'main') {
      const hasStrangerTitle = await ev(`!!document.querySelector('[class*="StrangerConversationListtitle"]')`)
      if (hasStrangerTitle) {
        const back = JSON.parse(String(await ev(`(function(){
          var best = null;
          Array.prototype.slice.call(document.querySelectorAll('div,svg,span')).forEach(function(e){
            var cls = String((e.className && e.className.baseVal !== undefined) ? e.className.baseVal : e.className || '');
            if (!/StrangerConversationListicon/.test(cls)) return;
            var r = e.getBoundingClientRect();
            if (r.width < 10 || r.width > 40 || r.height < 10 || r.height > 40) return;
            if (r.left < 0 || r.top < 0) return;
            best = { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
          });
          return JSON.stringify(best);
        })()`) || 'null'))
        if (back && typeof back.x === 'number') {
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: back.x, y: back.y, button: 'none', buttons: 0 })
          await sleep(80)
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: back.x, y: back.y, button: 'left', buttons: 1, clickCount: 1 })
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: back.x, y: back.y, button: 'left', buttons: 0, clickCount: 1 })
          await sleep(1200)
        }
      }
    } else if (want === 'stranger') {
      // 目标在陌生人面板里，但当前不在 ⇒ 点「陌生人消息」入口切过去
      const entry = JSON.parse(String(await ev(`(function(){
        var best = null;
        Array.prototype.slice.call(document.querySelectorAll('div,span')).forEach(function(e){
          var cls = String((e.className && e.className.baseVal !== undefined) ? e.className.baseVal : e.className || '');
          if (!/conversationStrangerBoxtitle/.test(cls)) return;
          var r = e.getBoundingClientRect();
          if (r.left < 0 || r.top < 0) return;
          best = { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
        });
        return JSON.stringify(best);
      })()`) || 'null'))
      if (entry && typeof entry.x === 'number') {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: entry.x, y: entry.y, button: 'none', buttons: 0 })
        await sleep(80)
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: entry.x, y: entry.y, button: 'left', buttons: 1, clickCount: 1 })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: entry.x, y: entry.y, button: 'left', buttons: 0, clickCount: 1 })
        await sleep(1500)
      }
    }

    // ② 切完再算一次坐标（顺便处理纵向滚出可视区的情况）
    const rescanned = JSON.parse(String(await ev(`(function(){
      var want = ${JSON.stringify(String(b.nick || ''))};
      var wantSec = ${JSON.stringify(String(b.sec_uid || ''))};
      var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-e2e="conversation-item"]'));
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var keys = Object.keys(n), fk = null;
        for (var k = 0; k < keys.length; k++) if (keys[k].indexOf('__reactFiber$') === 0) { fk = keys[k]; break }
        var sec = '';
        if (fk) { var f = n[fk], d = 0; while (f && d < 14) { var p = f.memoizedProps; if (p && p.conversation && p.conversation.toParticipantSecUserId) { sec = String(p.conversation.toParticipantSecUserId); break } f = f.return; d++; } }
        var nickEl = n.querySelector('[class*="ConversationItemTitle"], [class*="conversationItemTitle"], [class*="nickname"], [class*="Nickname"]');
        var nk = nickEl ? (nickEl.innerText || '').replace(/\\s+/g, ' ').trim() : ((n.innerText || '').replace(/\\s+/g, ' ').trim().split(' ')[0] || '');
        if (wantSec ? sec !== wantSec : nk !== want) continue;
        var r = n.getBoundingClientRect();
        var ok = r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
        if (!ok) { n.scrollIntoView({ block: 'center', inline: 'center' }); r = n.getBoundingClientRect(); ok = r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight; }
        return JSON.stringify({ ok: ok, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), left: Math.round(r.left) });
      }
      return JSON.stringify({ ok: false, reason: 'gone' });
    })()`) || '{}'))
    if (!rescanned.ok) {
      return {
        status: 'offscreen', matched: null,
        hint: `「${b.nick}」在会话列表里，但切换列表后仍然不在可视区（left=${rescanned.left ?? '?'}）。`
          + ' 对屏外坐标派发鼠标事件不会生效 —— 已中止，没发出去。',
        want_nick: b.nick, want_sec_uid: b.sec_uid || '', left: rescanned.left ?? null,
      }
    }
    b.x = rescanned.x
    b.y = rescanned.y
    await sleep(250)
  }

  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none', buttons: 0 })
  await sleep(80)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(2200)

  /**
   * 点完再核对一次：开着的是不是真的是他。
   * ⚠️ 两个判据都要过：
   *    · 有 whoId ⇒ 对端 id 必须相等
   *    · 只有昵称 ⇒ 右栏头部必须**精确等于**昵称（这是防"点了没反应还报成功"的兜底）
   */
  const after = await currentWho()
  if (whoId && after.id && after.id !== whoId) {
    return { status: 'mismatch', matched: null, want: whoId, got: after.id, hint: '点开的会话对端不是要发的那个人，已中止' }
  }
  if (!whoId && who && after.nick && baseNick(after.nick) !== baseNick(who)) {
    return {
      status: 'mismatch', matched: null, want: who, got: after.nick,
      hint: '点了「' + who + '」但右栏变成「' + after.nick + '」，对不上，已中止',
    }
  }
  return { status: 'clicked', matched: { sec_uid: after.id || b.sec_uid, nick: after.nick || b.nick }, matched_by: how }
}

async function main() {
  /**
   * ⭐ `--list`：把**会话列表里的人**列出来（昵称 + sec_uid + 头像）。
   *    为什么要有：设置页原来让人手填「信信发给谁」和「稳定 ID」——
   *    新手根本不知道 sec_uid 是什么，更找不到。现在直接点选。
   *    只读，不发任何东西。
   */
  if (LIST) {
    const c = await openPage({ url: 'https://www.douyin.com/chat', isolated: true })
    try {
      const url = String(await c.ev('location.href'))
      if (!url.includes('/chat')) {
        await c.send('Page.navigate', { url: 'https://www.douyin.com/chat' })
        await sleep(5000)
      }
      await sleep(2500)
      // ⭐ 等列表渲染出来再读（冷启动时 2500ms 可能不够）
      await waitList(c.ev)
      const raw = await listConversations(c.ev)
      let list = []
      try { list = JSON.parse(raw) || [] } catch { list = [] }
      const people = list.map((x) => {
        // ⭐ 优先用 DOM 里真正的昵称字段；没有才退回「整段文本的第一段」
        const nick = String(x.nick || '').trim() || nickOf(x.text)
        // 会话项文本是「昵称 时间 最后一句话」，去掉昵称和时间，剩下的是预览
        const preview = String(x.text || '').slice(nick.length).trim()
          .replace(/^\d{1,2}:\d{2}\s*/, '')
          .replace(/^(昨天|前天|\d+月\d+日)\s*/, '')
          .slice(0, 50)
        return {
          nick, sec_uid: x.sec_uid || '', preview, has_id: Boolean(x.sec_uid),
          /** ⭐ 未读条数：fiber 里的 unreadCount，实测与红点徽标 14/14 一致 */
          unread: Number(x.unread) || 0,
          /** ⚠️ 是否在可视区 —— false 的话点它没用（另一个列表被平移到屏外） */
          in_view: x.in_view !== false,
          /** ⭐ 0.5.5b 群：没有 sec_uid 的会话项就是群（或服务号）—— 如实标出来，
           *  面板靠这个显示「群聊」，不再吓唬用户「没有稳定 id」 */
          is_group: !x.sec_uid,
        }
      }).filter((p) => p.nick)
      // 同名的人标出来（这种必须用 sec_uid 区分）
      const counts = {}
      for (const p of people) counts[p.nick] = (counts[p.nick] || 0) + 1
      for (const p of people) p.duplicate = counts[p.nick] > 1
      const unreadTotal = people.reduce((s, p) => s + p.unread, 0)
      return out({
        ok: true, mode: 'list', read_only: true,
        count: people.length,
        people,
        no_id_count: people.filter((p) => !p.has_id).length,
        /** ⭐ 未读总数 / 有未读的人数 —— 这才是"谁找过我"的可靠信号 */
        unread_total: unreadTotal,
        unread_people: people.filter((p) => p.unread > 0).length,
        offscreen_count: people.filter((p) => !p.in_view).length,
        hint: people.length
          ? (people.some((p) => p.duplicate)
            ? '有同名的人 —— 选的时候看「最近一条消息」区分，别选错'
            : '这些都是你最近聊过的人，直接选一个就行')
          : '会话列表是空的 —— 先在抖音里跟要发的人聊一句，再回来这里选',
      })
    } finally { c.close() }
  }

  const text = FILE ? readFileSync(FILE, 'utf8').trim() : String(TEXT || '').trim()
  if (!READ) {
    if (!text) return out({ ok: false, error: '没有正文（用 --text 或 --file）' })
    if (text.length > 1800) return out({ ok: false, error: `正文太长（${text.length} 字），抖音信信放不下，拆开发` })
  }

  const c = await openPage({ url: 'https://www.douyin.com/chat', isolated: true })
  const chromed = c.status
  try {
    // 确保停在 /chat
    const url = await c.ev('location.href')
    if (!String(url).includes('/chat')) {
      await c.send('Page.navigate', { url: 'https://www.douyin.com/chat' })
      await sleep(5000)
    }
    const opened = await openConversation(c.ev, c.send, TO, TOID)
    if (opened.status === 'ambiguous') {
      return out({
        ok: false, error: '会话列表里有多个同名的人，不敢猜（猜错就是把信信发给陌生人）',
        nick: TO, candidates: opened.candidates, hint: opened.hint,
      })
    }
    if (opened.status === 'no-list') return out({ ok: false, error: '会话列表没加载出来（可能还没登录）', chrome: chromed })
    if (opened.status === 'offscreen') {
      return out({
        ok: false, error: opened.hint || '那个人的会话项不在可视区，点了不会生效，已中止',
        nick: opened.want_nick, sec_uid: opened.want_sec_uid, detail: opened, chrome: chromed,
      })
    }
    if (opened.status === 'unverifiable' || opened.status === 'mismatch') {
      return out({ ok: false, error: opened.hint || '核对会话身份失败，已中止', detail: opened })
    }
    if (opened.status === 'not-found') {
      return out({
        ok: false,
        error: opened.hint || (TOID ? `会话列表里没有 sec_uid=${TOID} 这个人` : `在会话列表里没找到「${TO}」`),
        // ⚠️ near_misses 是"最后一句话里碰巧出现这几个字"的人，**不是**候选收件人
        near_misses: opened.near_misses || [],
        candidates: opened.candidates || [], chrome: chromed,
      })
    }
    if (!(await hasEditor(c.ev))) return out({ ok: false, error: '会话没打开（找不到输入框）', opened, chrome: chromed })
    const target = opened.matched || { sec_uid: TOID || '', nick: TO }
    /** 到底靠什么认的人：sec_uid / 昵称精确 / 昵称模糊 —— 如实带出去，别让调用方猜 */
    const matchedBy = opened.matched_by || (TOID ? 'sec_uid' : 'nickname(精确)')

    // ── 只读模式：把会话读出来（带「谁发的」）──
    if (READ) {
      const msgs = await readMessages(c.ev)
      const ordered = msgs.slice().reverse()          // DOM 是新的在上 ⇒ 翻过来 = 旧→新
      const cnt = (k) => msgs.filter((m) => m.from === k).length
      return out({
        ok: true, mode: 'read', read_only: true,
        to: target.nick, to_sec_uid: target.sec_uid || undefined,
        matched_by: matchedBy,
        // ⚠️ 明写出来：读的是"当前打开的会话"，而 to 是"认出来的人"——两者已经核过一致
        verified_open: true,
        count: msgs.length, mine: cnt('me'), them: cnt('them'), unknown: cnt('unknown'),
        sender_attribution: 'avatar-side（36px 头像落在列表左/右半边；unknown = 该组没有头像可继承）',
        // ⭐ 2026-11-12（收衍生仓库 fish.11）：群聊场景从 fiber 挖到的发言人昵称
        //    （1v1 私信里 from 已有方向，此字段多为空 —— 群聊是刚需）
        // 最新的在最后一条
        messages: ordered.slice(-60).map((m) => ({
          from: m.from,
          sender: m.sender || undefined,
          text: String(m.text || '').slice(0, 160),
          awe: m.awe || undefined,
          item: m.item || undefined,
        })),
      })
    }

    const before = (await bodyText(c.ev)).length
    const beforeMsgs = await readMessages(c.ev)
    if (DRY) return out({ ok: true, sent: false, dry: true, to: target.nick, to_sec_uid: target.sec_uid || undefined, len: text.length, matched_by: matchedBy, msgs_in_view: beforeMsgs.length, chrome: chromed })

    /**
     * 🔴 打字前的最后一道身份核对（2026-10-23 加）。
     *    前面 openConversation 已经核过一次，但"点输入框"这一步本身也可能
     *    因为页面重渲染而落到别的会话上。**真发之前再确认右栏是不是他** ——
     *    这一步很便宜（一次 evaluate），但它是"发错人"的最后一道闸。
     */
    const gateNick = String(await c.ev(`(function(){
      var r = document.querySelector('[class*="componentsRightPanel"]');
      if (!r) return '';
      var lines = (r.innerText || '').split('\\n').map(function(s){return s.trim()}).filter(Boolean);
      return lines.length ? lines[0] : '';
    })()`) || '').trim()
    if (gateNick && target.nick && baseNick(gateNick) !== baseNick(target.nick)) {
      return out({
        ok: false, sent: false, error: '发送前核对失败：右栏是「' + gateNick + '」，不是「' + target.nick + '」，已中止（没发出去）',
        want: target.nick, got: gateNick, chrome: chromed,
      })
    }

    // 点输入框
    const pos = JSON.parse(await c.ev(`(function(){
      var eds=Array.prototype.slice.call(document.querySelectorAll('[contenteditable="true"], textarea'));
      for (var i=0;i<eds.length;i++){var e=eds[i];var r=e.getBoundingClientRect();if(r.width>80&&r.height>10)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}
      return '{}';
    })()`))
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await sleep(400)
    await c.send('Input.insertText', { text })
    await sleep(800)

    const typed = await c.ev(`(function(){
      var e=document.querySelector('[contenteditable="true"], textarea');
      return e ? String(e.innerText||e.value||'').replace(/[\\u200b\\r]/g,'') : '';
    })()`)
    if (!String(typed).trim()) return out({ ok: false, error: '正文没进输入框（可能被风控拦截）', chrome: chromed })

    await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await sleep(2600)

    const bodyNow = await bodyText(c.ev)
    const leftInBox = await c.ev(`(function(){
      var e=document.querySelector('[contenteditable="true"], textarea');
      return (e?String(e.innerText||e.value||''):'').replace(/[\\u200b\\s]/g,'').length;
    })()`)
    // ⭐ 第 ③ 步：**回读消息列表**，而且只数 `from === 'me'` 的
    //
    // 2026-10-21 上半场还以为"读不出谁发的"，当时是错用了 `isMyMessage`（恒 true）。
    // 后来挖到头像左右这个判据，回读才算真的完整：
    //   「这段正文在**我发的**消息里从 N 条变成 N+1 条」—— 这才叫发成功了。
    // 如果光数总数，别人刚好发了同样的话就会假阳性。
    const afterMsgs = await readMessages(c.ev)
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const sentText = norm(text)
    const head = sentText.slice(0, 20)
    const isMine = (m) => m.from === 'me' && m.text
      && (norm(m.text) === sentText || norm(m.text).startsWith(head))
    const beforeCnt = beforeMsgs.filter(isMine).length
    const afterCnt = afterMsgs.filter(isMine).length
    const readback = afterCnt > beforeCnt
    // 列表里最新那条是谁发的（我发完，这里应该翻成 'me'）
    const newest = afterMsgs[0] || null
    // 页面上出现过（弱证据，留作参考）
    const appeared = String(bodyNow).replace(/\s+/g, ' ').includes(text.replace(/\s+/g, ' ').slice(0, 24))
    const ok = Number(leftInBox) === 0 && readback
    /**
     * ⭐ 0.5.6 实测**渠道限制**（2026-10-26，主人+作者双方确认）：
     *    **网页端发群，服务端收下但没分发**（回执 im_callback_status_code=7523）——
     *    自己账号重新登录能看到消息，群里其他成员**没收到**；手机端发同一账号正常。
     *    ⚠️ **只在这一个号上试过** —— 别的号会不会一样，不知道，别当成铁律。
     *    ⇒ 发群"成功"只代表本地回显，要在返回里写明这个限制，调用方/值班别拿它当真发了。
     *    私聊不受影响（同一条链路实测一直通）。
     */
    const isGroupSend = !target.sec_uid
    return out({
      ok, sent: ok, to: target.nick, to_sec_uid: target.sec_uid || undefined, len: text.length,
      matched_by: TOID ? 'sec_uid' : 'nickname(唯一)',
      from: before, to_len: String(bodyNow).length, clicked: opened.status, chrome: chromed,
      // ⭐ 回读证据（只数我发的）
      readback,
      my_msg_before: beforeCnt, my_msg_after: afterCnt,
      sender_attribution: 'avatar-side（36px 头像落在列表左/右半边）',
      newest_from: newest ? newest.from : undefined,
      newest_text: newest ? String(newest.text || '').slice(0, 40) : undefined,
      msgs_in_view_before: beforeMsgs.length, msgs_in_view_after: afterMsgs.length,
      // DOM 顺序是「新的在上」，所以前 3 条就是最新的 3 条
      msgs_sample: afterMsgs.slice(0, 3).map((m) => `${m.from}: ${String(m.text || '').slice(0, 36)}`),
      appeared, box_left: Number(leftInBox),
      // 🔴 渠道限制：网页端发群可能不分发（7523）—— 发群时必带，别当真发了
      ...(isGroupSend ? {
        account_limit: 'web_group_no_fanout',
        warning: '⚠️ 网页端发的群里人可能收不到（回执 7523）—— 这是我这边号上测到的，手机端发正常；别的号不一定这样。'
          + '要在群里说话建议用手机端。',
        delivered_to_others: false,
      } : {}),
      error: ok ? undefined
        : (!readback ? '回读没在「我发的」消息里找到这条（可能没发出去）' : '输入框没清空'),
    })
  } finally { c.close() }
}

main().catch((e) => out({ ok: false, error: String(e?.message ?? e) }))
