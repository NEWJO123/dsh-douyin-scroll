#!/usr/bin/env node
/**
 * tools/comment-api.mjs —— 视频/图文评论回复：原生前端构造请求，校验目标后放行一次。
 * ============================================================================
 * 写接口的 ticket-guard 等凭据由抖音自己的前端生成；仅在页面里 fetch/XHR 不够。
 * 找到回复目标后检查真实请求中的作品/正文/楼根/回复 ID，一致才发送；响应必须有 cid。
 * 若站点要求短信/滑块，报告未确认并停止，不绕过验证，不自动重发。
 *
 * ── 🔴 2026-10-23 修的 bug：reply_id 和 reply_to_reply_id 不是一回事 ──────────
 *   旧代码：
 *       body.reply_id = REPLY; body.reply_to_reply_id = REPLY;   // ← 两个塞同一个值
 *   后果（实测到的服务端落库）：
 *       「回复」号主的顶层评论 → 结果 level=1、root_comment_id=它自己
 *       **变成了另一条顶层评论，压根没进楼**。看着成功，其实位置全错。
 *   真实结构（从别人的正常回复里读出来的）：
 *       回顶层评论 X  ⇒ reply_id = X        ，reply_to_reply_id = 0（不传）
 *       回楼中楼   Y  ⇒ reply_id = Y.reply_id，reply_to_reply_id = Y
 *       也就是：**reply_id 永远是"楼根"，reply_to_reply_id 才是"具体回哪条"**。
 *
 *   所以现在参数拆成两个：
 *       --reply <cid>   要回的那条（可以给顶层，也可以给楼中楼）
 *       --root  <cid>   楼根（level1）。不给就自动判定；判不出来**拒绝发送**，绝不瞎猜
 *   判不出来还硬发，就会变成一条悄悄冒出来的顶层评论 —— 那是最坏的一种错。
 *
 * 用法:
 *   node tools/comment-api.mjs --aweme <id> --text "..."                      # 顶层评论
 *   node tools/comment-api.mjs --aweme <id> --text "..." --reply <cid>        # 回某人（自动判楼根）
 *   node tools/comment-api.mjs --aweme <id> --text "..." --reply <cid2> --root <cid1>
 *   node tools/comment-api.mjs --aweme <id> --text "..." --reply <cid> --dry  # 只解析不发送
 *
 * 输出一行 JSON：{ ok, http, cid, reply_to, root, text, raw?, error? }
 */
import { readFileSync } from 'node:fs'
import { openPage, sleep } from '../lib/chrome.mjs'
import { parseWork, prepareWorkPage, pageRequestSource, publishReceipt } from '../lib/douyin-work.mjs'
import { publishComment } from '../lib/comment-publish-ui.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const DRY = argv.includes('--dry')
const WORK = parseWork(argOf('--aweme', ''), argOf('--url', ''), argOf('--aweme-type', ''))
const AWEME = WORK.aweme_id
const REPLY = String(argOf('--reply', '')).trim()
const ROOT = String(argOf('--root', '')).trim()
const FILE = String(argOf('--file', '')).trim()
const TEXT = FILE ? readFileSync(FILE, 'utf8').trim() : String(argOf('--text', '')).trim()

/**
 * 🔴 2026-10-22：这里以前**静默忽略** `--mention-*`（根本不读这几个参数）。
 *    调用方以为传了就能真 @，实际发出去的是普通评论：名字不变蓝、对方收不到通知，
 *    工具却报成功 —— 最坏的一种错（不是失败，是"看起来成功"）。
 *
 * ⭐ 但**这个脚本做不了真 @**（原因见 tools/comment-mention-ui.mjs 顶部：
 *    API 直发时服务端会把 mention 的 sec_uid 剥掉，只有前端点选才认）。
 *    ⇒ 现在选择**明确拒绝**，不再静默降级。要真 @ 请用 comment-mention-ui.mjs。
 */
const MENTION = {
  name: String(argOf('--mention-name', '')).trim(),
  uid: String(argOf('--mention-uid', '')).trim(),
  secUid: String(argOf('--mention-secuid', '')).trim(),
}
const wantsMention = Boolean(MENTION.name || MENTION.uid || MENTION.secUid)

const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok ? 0 : 1 }

if (!AWEME) { out({ ok: false, error: '缺 --aweme' }); process.exit(1) }
if (!TEXT) { out({ ok: false, error: '正文是空的' }); process.exit(1) }
if (TEXT.length > 500) { out({ ok: false, error: `正文太长（${TEXT.length} 字），抖音评论放不下` }); process.exit(1) }
if (wantsMention) {
  out({
    ok: false,
    unsupported: 'mention',
    error: '这个脚本做不了真 @（API 直发会被服务端剥掉 sec_uid：名字变蓝但点开是空页、对方收不到通知）',
    use_instead: 'tools/comment-mention-ui.mjs --aweme <id> --name <昵称> --text <正文>',
    hint: '想发"@ 只是文字"的普通评论：去掉 --mention-* 三个参数再调',
  })
  process.exit(1)
}

let c
try {
  c = await openPage({ isolated: true })
  await c.send('Network.enable')
  const chromed = c.status
  const work = await prepareWorkPage(c, { aweme: AWEME, work_url: WORK.route ? WORK.work_url : '', aweme_type: WORK.aweme_type, comment_id:REPLY })

  /**
   * ⭐ 解析「楼根」和「具体回哪条」。
   *   判据来源只有权威数据：翻 `/comment/list/`（顶层）找这条 cid 到底在哪、`reply_id` 是什么。
   *   判不出来就返回 need_root，**不猜**。
   */
  const resolveJs = `(async function(){
    var request = ${pageRequestSource};
    var AWEME = ${JSON.stringify(AWEME)};
    var TARGET = ${JSON.stringify(REPLY)};
    var ROOTIN = ${JSON.stringify(ROOT)};
    var COMMON = {
      device_platform:'webapp', aid:'6383', channel:'channel_pc_web',
      pc_client_type:'1', version_code:'190500', version_name:'19.5.0',
      cookie_enabled:'true', screen_width:'1920', screen_height:'1080',
      browser_language:'zh-CN', browser_platform:'Win32',
      browser_name:'Chrome', browser_version:'141.0.0.0',
      engine_name:'Blink', engine_version:'141.0.0.0',
      os_name:'Windows', os_version:'10', platform:'PC'
    };
    function qs(d){ return Object.keys(d).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(d[k]);}).join('&'); }
    async function get(rel){
      var r = await request('GET', rel);
      var t = r.body;
      try { return JSON.parse(t) } catch(e) { return null }
    }
    // 不给 --reply = 发顶层评论，不需要判楼
    if (!TARGET) return JSON.stringify({ ok:true, root:'', reply_to:'', how:'top-level' });

    // ① 调用方明确给了楼根 ⇒ 直接信
    if (ROOTIN) {
      var rp = (TARGET === ROOTIN) ? '' : TARGET;
      return JSON.stringify({ ok:true, root:ROOTIN, reply_to:rp, how:'explicit' });
    }

    // ② 翻顶层列表找 TARGET：确定它是 level1 还是 level2
    var cursor = 0, pages = 0;
    while (pages < 8) {
      var j = await get('/aweme/v1/web/comment/list/?' + qs(Object.assign({}, COMMON, {
        aweme_id: AWEME, count: '20', cursor: String(cursor), item_type: '0'
      })));
      if (!j) break;
      var cs = j.comments || [];
      for (var i = 0; i < cs.length; i++) {
        var x = cs[i];
        if (String(x.cid) === TARGET) {
          // 找到了，它是一条顶层评论 ⇒ root = 它自己
          return JSON.stringify({ ok:true, root:String(x.cid), reply_to:'', how:'found-level1' });
        }
        // 也在它的楼中楼里找（接口会带前几条）
        var rs = x.reply_comment || [];
        for (var k = 0; k < rs.length; k++) {
          if (String(rs[k].cid) === TARGET) {
            return JSON.stringify({ ok:true, root:String(x.cid), reply_to:TARGET, how:'found-in-thread' });
          }
        }
      }
      if (!j.has_more) break;
      var next = Number(j.cursor || 0);
      if (!next || next === cursor) break;
      cursor = next; pages++;
      await new Promise(function(r){ setTimeout(r, 700) });
    }

    // ③ 顶层翻不到 ⇒ 直接问接口"这条底下有没有楼中楼"：有 ⇒ 它自己就是楼根
    var rj = await get('/aweme/v1/web/comment/list/reply/?' + qs(Object.assign({}, COMMON, {
      item_id: AWEME, comment_id: TARGET, cursor: '0', count: '1', item_type: '0'
    })));
    if (rj && Number(rj.total || 0) > 0) {
      return JSON.stringify({ ok:true, root:TARGET, reply_to:'', how:'has-replies' });
    }

    // ④ 判不出来 ⇒ 拒绝（不许瞎猜，猜错就变成一条悄悄冒出来的顶层评论）
    return JSON.stringify({ ok:false, need_root:true,
      hint:'判不出这条 cid 的楼根。请传 --root <顶层评论cid>（= 这条回复所在那栋楼的第一条）' });
  })()`

  let plan = null
  try { plan = JSON.parse(await c.ev(resolveJs)) } catch { plan = { ok: false, hint: '楼根解析没返回可解析结果' } }

  if (!plan.ok) {
    await c.close(); c = null
    await sleep(200)
    out({
      ok: false,
      error: plan.hint || '判不出楼根，已中止（不瞎猜）',
      aweme_id: AWEME,
      reply_to: REPLY,
      why: 'reply_id 必须是"楼根"。给错了会变成一条冒出来的顶层评论，位置全错还看起来成功。',
      how_to: '传 --root <顶层评论 cid>；或先跑 tools/comment-read-dom.mjs 看这条属于哪栋楼',
    })
    process.exit(1)
  }

  if (DRY) {
    await c.close(); c = null
    await sleep(200)
    out({
      ok: true, dry: true, aweme_id: AWEME,
      reply_to: REPLY || '(顶层评论)',
      root: plan.root || '(无 — 发顶层)',
      resolved_by: plan.how,
      work_url: work.work_url, aweme_type: work.aweme_type, transport: 'page-frontend',
      len: TEXT.length, chrome: chromed,
    })
    process.exit(0)
  }

  const published = await publishComment(c, { aweme_id: AWEME, root: plan.root || '', reply_to: plan.reply_to || '', text: TEXT })
  const js = `(async function(){
    var request = ${pageRequestSource};
    var AWEME = ${JSON.stringify(AWEME)};
    var ROOT = ${JSON.stringify(plan.root || '')};
    var REPLYTO = ${JSON.stringify(plan.reply_to || '')};
    var TEXT = ${JSON.stringify(TEXT)};
    var COMMON = {
      device_platform:'webapp', aid:'6383', channel:'channel_pc_web',
      pc_client_type:'1', version_code:'190500', version_name:'19.5.0',
      cookie_enabled:'true', screen_width:'1920', screen_height:'1080',
      browser_language:'zh-CN', browser_platform:'Win32',
      browser_name:'Chrome', browser_version:'141.0.0.0',
      engine_name:'Blink', engine_version:'141.0.0.0',
      os_name:'Windows', os_version:'10', platform:'PC'
    };
    function qs(d){ return Object.keys(d).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(d[k]);}).join('&'); }
    var o = ${JSON.stringify(published)};

    /**
     * ⭐⭐ 发完**重读那一楼**核实落位（2026-10-23 加的，这是唯一可靠的判据）。
     *   · 顶楼（ROOT）下能读到这条 ⇒ level=2、真的进了楼
     *   · 顶楼里读不到、但顶层列表里有它 ⇒ 它变成了一条独立顶层评论（**楼根填错了**）
     * 重读要等页面刷新一会儿，所以带 3 次重试。
     */
    if (o.cid && ROOT) {
      for (var attempt = 1; attempt <= 3; attempt++) {
        await new Promise(function(z){ setTimeout(z, attempt === 1 ? 1200 : 1800) });
        var rj = await request('GET', '/aweme/v1/web/comment/list/reply/?' + qs(Object.assign({}, COMMON, {
          item_id: AWEME, comment_id: ROOT, cursor: '0', count: '20', item_type: '0'
        }))).then(function(x){ return x.body }).catch(function(){ return '' });
        var rjj = null; try { rjj = JSON.parse(rj) } catch(e) {}
        if (rjj && rjj.comments) {
          for (var i2 = 0; i2 < rjj.comments.length; i2++) {
            if (String(rjj.comments[i2].cid) === o.cid) {
              o.verified = true;
              o.verified_level = rjj.comments[i2].level;
              o.verified_reply_id = String(rjj.comments[i2].reply_id || '');
              o.verified_reply_to = String(rjj.comments[i2].reply_to_reply_id || '');
              break;
            }
          }
        }
        if (o.verified) break;
      }
      if (!o.verified) {
        // 楼里没有 ⇒ 去看看它是不是跑到顶层列表去了
        var tl = await request('GET', '/aweme/v1/web/comment/list/?' + qs(Object.assign({}, COMMON, {
          aweme_id: AWEME, count: '20', cursor: '0', item_type: '0'
        }))).then(function(x){ return x.body }).catch(function(){ return '' });
        var tjj = null; try { tjj = JSON.parse(tl) } catch(e) {}
        if (tjj && tjj.comments) {
          for (var k2 = 0; k2 < tjj.comments.length; k2++) {
            if (String(tjj.comments[k2].cid) === o.cid) { o.found_at_top = true; break; }
          }
        }
      }
    }
    return JSON.stringify(o);
  })()`

  const raw = await c.ev(js)
  await c.close(); c = null
  await sleep(200)   // 等 WebSocket 真正关掉再退出，否则 libuv 会断言

  let res
  try { res = JSON.parse(raw) } catch { out({ ok: false, error: '页面没返回可解析结果', raw: String(raw).slice(0, 400), chrome: chromed }); process.exit(1) }

  const cid = String(res.cid || '')
  const receipt = publishReceipt({ status: res.http, body: JSON.stringify({ status_code: res.status_code, comment: { cid } }) })
  const ok = receipt.ok

  /**
   * ⭐⭐ 落位判据（2026-10-23 定稿）：
   *   ① 优先用**重读楼**拿到的 verified_*（唯一可靠 —— publish 的响应有时不带 level）
   *   ② 重读没读到、但顶层列表里出现了 ⇒ 它变成独立顶层评论了（楼根填错）
   *   ③ 两边都读不到 ⇒ unknown（评论列表按热度排，0 赞的可能够不着）**不许当成失败**
   */
  let placement = null
  if (plan.root && cid) {
    if (res.verified) {
      const lv = Number(res.verified_level)
      placement = {
        verified: true, level: lv,
        reply_id: res.verified_reply_id || undefined,
        reply_to_reply_id: res.verified_reply_to || undefined,
        ok: lv === 2,
        warn: lv === 2 ? undefined
          : `⚠️ 已核实：它是 **level=${lv}** 的独立顶层评论，不是楼中楼回复 —— 楼根填错了`,
      }
    } else if (res.found_at_top) {
      placement = {
        verified: true, level: 1, ok: false, found_at_top: true,
        warn: '⚠️ 已核实：这条跑到了**顶层评论列表**里 —— 楼根填错，它没进楼。'
          + '虽然发出去了，但位置在评论区第一层，不是回在对方楼下。',
      }
    } else {
      placement = {
        verified: false, ok: null,
        note: '重读那栋楼没读到它（评论列表按热度排，0 赞的够不着）—— '
          + '**不等于没进楼**，也不等于进错了。想确认就过几分钟用 comment-read-dom.mjs 再读一次。',
      }
    }
  }

  out({
    ok,
    http: res.http,
    cid: cid || undefined,
    reply_to: REPLY || '(顶层评论)',
    root: plan.root || undefined,
    resolved_by: plan.how,
    /** ⭐ publish 响应里的位置（有时是 null —— 别只靠它） */
    server_level: res.has_lv ? res.lv : undefined,
    server_reply_id: res.rt || undefined,
    server_reply_to_reply_id: res.rtt || undefined,
    /** ⭐⭐ 真正的核实结果（重读楼拿到的） */
    placement,
    aweme_id: AWEME,
    work_url: work.work_url, aweme_type: work.aweme_type, transport: 'page-frontend',
    len: TEXT.length,
    chrome: chromed,
    status_code: res.status_code === null ? undefined : res.status_code,
    attempted: Boolean(res.attempted),
    outcome_unknown: ok ? undefined : Boolean(res.attempted && receipt.outcome_unknown),
    error: ok ? undefined : (res.error || receipt.error),
    head: ok ? undefined : String(res.head || '').slice(0, 300),
  })
} catch (e) {
  out({ ok: false, error: String(e?.message ?? e) })
} finally {
  if (c) { await c.close(); await sleep(200) }
}
