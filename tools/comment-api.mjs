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
   * ⭐ 楼根判定**不再发任何列表请求**（2026-11-05）。
   *   原来先在页面里翻 /comment/list/ 解析楼根 —— A/B 实测这会把站点自己的评论分页打毒
   *   （发过查询后怎么滚都不再加载新楼层，0.6.0 / 0.6.1 / 0.7.0 全中，2026-11-03 起必挂）。
   *   现在楼层关系由发布器在目标行上就地读（replyId："0"=顶层，非 0 = 楼根），三种页面结论：
   *   found-level1（顶层）/ found-in-thread（楼中楼里）/ has-replies（顶层且有人回过）。
   *   · --root 给了 ⇒ 原样信（通知里的 root_comment_id 与它同源），发布器会拿目标行核对
   *   · 没给 ⇒ 就地推导；推不出来就 need_root 拒绝，**不瞎猜**
   */
  const KNOWN_HOW = new Set(['found-level1', 'found-in-thread', 'has-replies'])
  const plan = {
    ok: true,
    // derive 模式（没给 --root）先把目标行本身当 root 传下去，发布器在行上就地判定真实楼根
    root: ROOT || REPLY || '',
    reply_to: ROOT && REPLY && ROOT !== REPLY ? REPLY : '',
    how: ROOT ? 'explicit' : (REPLY ? 'derive-in-dom' : 'top-level'),
    derive: !ROOT && Boolean(REPLY),
  }

  if (DRY) {
    await c.close(); c = null
    await sleep(200)
    out({
      ok: true, dry: true, aweme_id: AWEME,
      reply_to: REPLY || '(顶层评论)',
      root: plan.root || '(无 — 发布器在页面上就地判定)',
      resolved_by: plan.how,
      work_url: work.work_url, aweme_type: work.aweme_type, transport: 'page-frontend',
      len: TEXT.length, chrome: chromed,
    })
    process.exit(0)
  }

  const published = await publishComment(c, { aweme_id: AWEME, root: plan.root || '', reply_to: plan.reply_to || '', derive: Boolean(plan.derive), text: TEXT })

  // 🔴 判不出楼根 ⇒ 明确拒绝（不瞎猜）：derive 模式下发布器在页面上没找到/没判定出目标行
  if (plan.derive && !published.attempted && /没有找到目标评论|判不出/.test(String(published.error || ''))) {
    await c.close(); c = null
    await sleep(200)
    out({
      ok: false, need_root: true,
      error: '判不出这条 cid 的楼根（页面上没滚到它），已中止 —— 不瞎猜',
      aweme_id: AWEME, reply_to: REPLY,
      detail: String(published.error || ''),
      why: 'reply_id 必须是"楼根"。给错了会变成一条冒出来的顶层评论，位置全错还看起来成功。',
      how_to: '传 --root <顶层评论 cid>（= 这条回复所在那栋楼的第一条）；通知里的 root_comment_id 就是它',
      resolved_by: plan.how, work_url: work.work_url, aweme_type: work.aweme_type, transport: 'page-frontend', chrome: chromed,
      len: TEXT.length,
    })
    process.exit(1)
  }

  // 发布器可能在页面上就地判定出楼根（没传 --root 时）；核实与落位判断都用最终值
  const usedRoot = String(published.root || plan.root || '')
  const usedReplyTo = String(published.reply_to || plan.reply_to || '')
  const js = `(async function(){
    var request = ${pageRequestSource};
    var AWEME = ${JSON.stringify(AWEME)};
    var ROOT = ${JSON.stringify(usedRoot)};
    var REPLYTO = ${JSON.stringify(usedReplyTo)};
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
    } else if (o.cid) {
      /**
       * ⭐ 2026-11-12：顶层普通评论也回读确认**可见性**（真发验证发现：publish 200 +
       *    有 cid，但重读评论列表可能读不到 —— 疑似平台审核/过滤）。3 次重试，
       *    读到 ⇒ visible=true；3 次都没读到 ⇒ visible=false（如实带出，宿主会标注
       *    两种可能：热度排够不着 / 被平台过滤 —— 不武断）。
       */
      for (var attempt3 = 1; attempt3 <= 3; attempt3++) {
        await new Promise(function(z){ setTimeout(z, attempt3 === 1 ? 1200 : 1800) });
        var tl2 = await request('GET', '/aweme/v1/web/comment/list/?' + qs(Object.assign({}, COMMON, {
          aweme_id: AWEME, count: '20', cursor: '0', item_type: '0'
        }))).then(function(x){ return x.body }).catch(function(){ return '' });
        var tjj2 = null; try { tjj2 = JSON.parse(tl2) } catch(e) {}
        if (tjj2 && tjj2.comments) {
          for (var k3 = 0; k3 < tjj2.comments.length; k3++) {
            if (String(tjj2.comments[k3].cid) === o.cid) { o.visible = true; break; }
          }
        }
        if (o.visible) break;
      }
      if (o.visible !== true) o.visible = false;
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
  if (usedRoot && cid) {
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
    } else if (!usedRoot && cid) {
      // ⭐ 2026-11-12：顶层普通评论的可见性回读结果（页面 JS 已带 o.visible）
      if (res.visible === true) {
        placement = { verified: true, level: 1, ok: true, note: '已回读评论列表确认可见' }
      } else if (res.visible === false) {
        placement = { verified: false, ok: null,
          warn: '发布接口 200 且有 cid，但重读 3 次评论列表都没读到 —— 两种可能：'
            + '评论列表按热度排（0 赞的够不着），或内容被平台审核/过滤。'
            + '不等于发送失败，也不能确认对方可见 —— 请人工核对或稍后回读。',
        }
      } else {
        placement = { verified: false, ok: null, note: '回读没得出结论（列表读取失败）—— 不等于失败' }
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
    root: usedRoot || undefined,
    resolved_by: KNOWN_HOW.has(published.how) ? published.how : plan.how,
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
