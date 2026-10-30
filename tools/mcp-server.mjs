#!/usr/bin/env node
/**
 * tools/mcp-server.mjs —— 把「刷抖音」这套能力开放成 **标准 MCP server**（stdio）
 * ============================================================================
 * 为什么要有它：
 *   插件本体是 DSH 的 bundle —— 只有在 DSH 里才看得见 `douyin_*` 工具。
 *   但使用者可能还想让**别的 agent 工具**（Claude Code / Codex / Cursor / Cline /
 *   另一个 DSH profile …）也能用同一套能力。MCP 是这些工具共同的接口。
 *
 * 🔴 三条设计约束（别改）：
 *   ① **零依赖**：只用 Node 内置模块。这个包没有 node_modules，也不能为了 MCP
 *      再拉一个 SDK 进来（那会把"装插件"变成"装前端工程"）。
 *   ② **stdout 只许出 JSON-RPC**：任何调试信息一律走 stderr。
 *      MCP 的 stdio 传输就是"一行一个 JSON"，多打一个字都会把客户端弄崩。
 *   ③ **和插件共用同一批 tools/* 脚本** —— 不复制业务逻辑，行为跟 DSH 里那份一致。
 *
 * 协议：MCP 2025-06-18（legacy initialize 流程）。
 *   新客户端（如 DSH 的 dsh-mcp-client）会先探一次 `server/discover`（2026-07-28）；
 *   我们明确回 `-32601 Method not found`，它就会自动回落到 legacy —— 这是标准做法。
 *
 * 用法（别的 agent 工具的配置里写）：
 *   command: node
 *   args:    ["<插件目录>/tools/mcp-server.mjs"]
 *   env:     { "DOUYIN_HOME": "<插件家目录>" }
 *
 * 自测（不接任何客户端）：
 *   node tools/mcp-server.mjs --selftest
 * ============================================================================
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SERVER_NAME = 'douyin-scroll'
const SERVER_VERSION = (() => {
  try { return String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || '0') } catch { return '0' }
})()

/** 插件家目录：DOUYIN_HOME → DSH_HOME/douyin-duty → ~/.dsh/douyin-duty（和 lib/paths.mjs 同一口径） */
const HOME = (() => {
  const fromEnv = String(process.env.DOUYIN_HOME || '').trim()
  if (fromEnv) return resolve(fromEnv)
  const dshHome = String(process.env.DSH_HOME || '').trim()
  return resolve(join(dshHome || join(homedir(), '.dsh'), 'douyin-duty'))
})()

/* ─────────────────────────── 子进程小工具 ─────────────────────────── */

const pyEnv = (extra = {}) => ({
  ...process.env,
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
  DOUYIN_HOME: HOME,
  ...extra,
})

const venvPython = () => process.platform === 'win32'
  ? join(HOME, '.venv', 'Scripts', 'python.exe')
  : join(HOME, '.venv', 'bin', 'python')

const hasVenv = () => existsSync(venvPython())

const PY = () => (hasVenv() ? venvPython() : (process.platform === 'win32' ? 'python' : 'python3'))

const run = (cmd, args, timeout = 240_000) => {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout,
    env: pyEnv(),
    cwd: HOME,
    windowsHide: true,
  })
  return {
    status: r.status ?? -1,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || r.error || ''),
  }
}

const runNode = (script, args = [], timeout = 240_000) => run(process.execPath, [join(ROOT, 'tools', script), ...args], timeout)
const runPy = (script, args = [], timeout = 240_000) => run(PY(), [join(ROOT, 'tools', script), ...args], timeout)

const readJson = (file, fallback = null) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

const pickJson = (s) => {
  const t = String(s || '')
  const i = t.indexOf('{')
  const j = t.lastIndexOf('}')
  if (i < 0 || j <= i) return null
  try { return JSON.parse(t.slice(i, j + 1)) } catch { return null }
}

/**
 * ⭐ Issue #8②（2026-10-30）：子脚本失败时，「为什么」必须**原样透出**。
 *
 * 原来 `douyin_share_card` 只挑 `ok / sent` 两个字段，`error` 一丢，
 * 排障就从分钟级变成小时级 —— 实测那个案例真因是「profile 被残留进程占着」，
 * 可返回里只有一个 `ok: false`，谁看都得猜。
 */
const stderrTail = (r, lines = 3) => String(r?.stderr || '')
  .trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-lines).join(' | ').slice(0, 400)

const explain = (j, r) => {
  const out = {}
  const err = String(j?.error || j?.err || '').trim()
  const tail = stderrTail(r)
  // 子脚本连 JSON 都没吐（崩溃 / 起不来）时，stderr 尾巴就是唯一的真因
  if (err) out.error = err
  else if (tail) out.error = tail
  if (j?.hint) out.hint = j.hint
  if (j?.detail) out.detail = j.detail
  if (err && tail) out.stderr_tail = tail
  return out
}

/** 等一会儿（异步，不占 CPU —— 别用 busy-wait，那会把宿主烤热） */
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))

const dayKey = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const config = () => readJson(join(HOME, 'config.json'), {}) || {}

const cookieOk = () => {
  try { return existsSync(join(HOME, 'douyin_cookie.txt')) && readFileSync(join(HOME, 'douyin_cookie.txt'), 'utf8').trim().length > 0 } catch { return false }
}

const PICK_RE = /^#{2,3}[ \t]*(\d{15,25})/gm
const countPicks = (file) => {
  try {
    const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '')
    const ids = new Set()
    for (const m of text.matchAll(PICK_RE)) ids.add(m[1])
    return ids.size
  } catch { return 0 }
}

/* ─────────────────────────── 工具实现 ─────────────────────────── */

const needSetup = () => {
  if (!hasVenv()) return { ok: false, error: '还没装运行环境', hint: '在 DSH 设置页「刷抖音 → ② 装主依赖」点一下（建 venv，装 curl_cffi + httpx）' }
  return null
}

const needLogin = () => {
  if (!cookieOk()) return { ok: false, error: '还没有登录', hint: '在 DSH 设置页扫码，或命令行跑 node tools/qr-login.mjs start；也可以直接粘 Cookie' }
  return null
}

const TOOLS = [
  /* ── 体检 / 状态 ── */
  {
    name: 'douyin_status',
    title: '刷抖音 · 今日状态',
    description: '看今天跑了没跑、挑了几条、额度剩多少、报告在哪、登录/环境是否就绪。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      const cfg = config()
      const st = readJson(join(HOME, 'state.json'), {}) || {}
      const report = join(HOME, 'out', `${dayKey()}.md`)
      return {
        ok: true,
        home: HOME,
        loggedIn: cookieOk(),
        venvReady: hasVenv(),
        perDay: Number(cfg.perDay ?? 5),
        pickedToday: countPicks(report),
        lastRunAt: st.lastRunAt || null,
        lastWhy: st.lastWhy || null,
        report,
        hasReport: existsSync(report),
        note: '这只是状态；要真的刷一轮，请让使用者在 DSH 设置页点「现在跑一轮」，或调 douyin_forward 取候选。',
      }
    },
  },
  {
    name: 'douyin_doctor',
    title: '刷抖音 · 环境体检',
    description: '检查家目录、Node、Python、venv、Cookie、浏览器、CDP、关键文件、人设。装完插件第一件事就跑它。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      const r = runNode('doctor.mjs', ['--json'], 90_000)
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '体检脚本没返回可解析结果', stderr_tail: stderrTail(r) }
      return { ...j, hint: (j.must_fix || []).length ? '先把 must_fix 里的修掉' : '没有硬伤' }
    },
  },
  {
    name: 'douyin_whoami',
    title: '刷抖音 · 登录状态',
    description: '看抖音登录还在不在、当前是哪个号。只读，不影响登录态。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      const bad = needLogin()
      if (bad) return bad
      const r = runPy('session-guard.py', ['check'], 90_000)
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '体检没返回结果', stderr_tail: stderrTail(r) }
      return { ok: true, logged_in: j.alive === true, ...j }
    },
  },

  /* ── 取候选 ── */
  {
    name: 'douyin_forward',
    title: '刷抖音 · 取一轮候选',
    description: '拉推荐流候选并打分，返回清单（含官方分享链接 share_url）。只用只读接口，不碰写接口，不影响登录态。',
    inputSchema: {
      type: 'object',
      properties: {
        top: { type: 'number', description: '返回前几条（默认 10，最多 30）' },
      },
      additionalProperties: false,
    },
    handler: (args) => {
      const bad = needLogin() || needSetup()
      if (bad) return bad
      const top = Math.max(1, Math.min(Number(args?.top) || 10, 30))
      const r = runPy('forward-pick.py', ['--limit', String(top)], 300_000)
      if (r.status !== 0) return { ok: false, error: '取候选失败', stderr: String(r.stderr || '').slice(0, 400) }
      const picked = readJson(join(HOME, 'forward-pick.json'), {}) || {}
      const rows = (Array.isArray(picked.rows) ? picked.rows : []).slice(0, top)
      return {
        ok: true,
        picked: rows.length,
        sources: picked.meta || [],
        dropped: picked.dropped || {},
        list: rows.map((x) => ({
          aweme_id: x.aweme_id,
          desc: x.desc,
          author: x.author,
          duration_s: x.duration_s,
          age_h: x.age_h,
          digg: x.digg,
          comment: x.comment,
          collect: x.collect,
          share: x.share,
          share_url: x.share_url,
          web_url: x.web_url,
        })),
      }
    },
  },
  {
    name: 'douyin_comments',
    title: '刷抖音 · 读评论',
    description: '取一个作品下的评论（签名的只读接口，带楼中楼）。判断「好不好玩」的主要文本依据。',
    inputSchema: {
      type: 'object',
      properties: { aweme_id: { type: 'string', description: '作品/图文 ID' } },
      required: ['aweme_id'],
      additionalProperties: false,
    },
    handler: (args) => {
      const bad = needLogin() || needSetup()
      if (bad) return bad
      const id = String(args?.aweme_id || '').trim()
      if (!id) return { ok: false, error: '缺 aweme_id' }
      const r = runPy('api-comments.py', [id], 300_000)
      const lines = String(r.stdout || '').split('\n')
      const items = lines.filter((l) => /^\s{2}cid=|^\s{6}└ /.test(l)).map((s) => s.replace(/^\s+/, ''))
      if (r.status !== 0) return { ok: false, error: '拉评论失败', stderr_tail: stderrTail(r) }
      return {
        ok: true,
        aweme_id: id,
        count: items.filter((s) => s.startsWith('cid=')).length,
        comments: items,
      }
    },
  },
  {
    name: 'douyin_notices',
    title: '刷抖音 · 互动通知',
    description: '读抖音互动通知：谁 @ 了你（含别人评论区里的 @）、谁关注/评论/点赞。只读，不改已读状态。',
    inputSchema: {
      type: 'object',
      properties: { raw: { type: 'boolean', description: '连原始条目一起返回（默认 false）' } },
      additionalProperties: false,
    },
    handler: (args) => {
      const bad = needLogin() || needSetup()
      if (bad) return bad
      const argv = [join(ROOT, 'tools', 'notice-read.py')]
      if (args?.raw) argv.push('--raw')
      const r = run(venvPython(), argv, 150_000)
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '没读到通知', stderr_tail: stderrTail(r) }
      return j
    },
  },

  /* ── 发送（全部要 confirm） ── */
  {
    name: 'douyin_share_card',
    title: '刷抖音 · 分享卡片给好友',
    description: '把视频以抖音分享卡片发给好友（不是文字链接 —— 文字链接在抖音里点不开）。'
      + '先发卡片、隔几秒再发 reason。🔴 必须先问使用者，他点头后传 confirm:true。',
    inputSchema: {
      type: 'object',
      properties: {
        aweme_id: { type: 'string', description: '视频 ID（19 位）；不给就用最近一轮清单里的' },
        to: { type: 'string', description: '好友昵称（只用于显示）；留空用配置 dmTo' },
        to_id: { type: 'string', description: '好友稳定 id（sec_uid）；重名时必须给；留空用配置 dmToId' },
        top: { type: 'number', description: '不给 aweme_id 时发清单前 N 条（默认 1，最多 3）' },
        reason: { type: 'string', description: '卡片之后单独发的一条正文：为什么值得看（≤300 字）' },
        reason_delay_sec: { type: 'number', description: '卡片发出后隔几秒再发 reason（默认 5）' },
        confirm: { type: 'boolean', description: '🔴 必须由使用者当场同意后传 true，否则只回预览' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const bad = needLogin() || needSetup()
      if (bad) return bad
      const cfg = config()
      const to = String(args?.to || cfg.dmTo || '').trim()
      const toId = String(args?.to_id || cfg.dmToId || '').trim()
      if (!to && !toId) return { ok: false, error: '不知道发给谁', hint: '传 to / to_id，或让使用者在设置里填「私信发给谁」+「稳定 ID」' }
      let ids = []
      if (args?.aweme_id) ids = [String(args.aweme_id).trim()]
      else {
        const rows = readJson(join(HOME, 'forward-pick.json'), {})?.rows || []
        ids = rows.slice(0, Math.max(1, Math.min(Number(args?.top) || 1, 3))).map((r) => String(r.aweme_id))
      }
      if (!ids.length) return { ok: false, error: '没有可用视频 ID', hint: '先调 douyin_forward 拉一轮' }
      if (args?.confirm !== true) {
        const rows = readJson(join(HOME, 'forward-pick.json'), {})?.rows || []
        return {
          ok: true, sent: false, needsConfirm: true, to, count: ids.length,
          preview: ids.map((id) => {
            const r = rows.find((x) => String(x.aweme_id) === id) || {}
            return { aweme_id: id, desc: String(r.desc || '').slice(0, 60), author: r.author || '', share_url: r.share_url || '' }
          }),
          reason: String(args?.reason || '').trim() || undefined,
          note: '没发送 —— 先把预览给使用者看，他点头后再用 confirm:true 调一次',
        }
      }
      const sent = []
      for (let i = 0; i < ids.length; i++) {
        const argv = [ids[i], to]
        if (toId) argv.push('--to-id', toId)
        const r = runNode('card-share.mjs', argv, 200_000)
        const j = pickJson(r.stdout) || { ok: false, aweme_id: ids[i] }
        sent.push({ j, r })
        if (!(j && j.ok)) break
        if (i < ids.length - 1) await sleep(2200)
      }
      const okN = sent.filter((x) => x.j && x.j.sent).length
      const reasonText = String(args?.reason || '').trim()
      let reason = null
      if (okN && reasonText) {
        const gap = Math.max(0, Math.min(Number(args?.reason_delay_sec ?? 5) || 0, 60))
        if (gap > 0) await sleep(gap * 1000)
        const rArgs = []
        if (to) rArgs.push('--to', to)
        if (toId) rArgs.push('--to-id', toId)
        rArgs.push('--text', reasonText)
        const r3 = runNode('im-send.mjs', rArgs, 240_000)
        reason = pickJson(r3.stdout) || { ok: false, error: '理由那一条没返回可解析结果', ...explain(null, r3) }
      }
      const failed = sent.filter((x) => !(x.j && x.j.sent)).map((x) => explain(x.j, x.r))
      return {
        ok: okN === ids.length && (!reason || reason.ok),
        sent: okN, total: ids.length, to,
        results: sent.map(({ j, r }) => ({ aweme_id: j.aweme_id, ok: !!j.ok, sent: !!j.sent, ...explain(j, r) })),
        // ⭐ 失败原因同时提到顶层：调用方（人）不会挨个翻 results
        ...(failed[0]?.error ? { error: failed[0].error } : {}),
        ...(failed[0]?.hint ? { hint: failed[0].hint } : {}),
        reason: reason || undefined,
        note: '卡片是否真的落地，请让使用者自己在抖音里看一眼（这个 MCP 版没做回读）',
      }
    },
  },
  {
    name: 'douyin_dm',
    title: '刷抖音 · 发私信',
    description: '发一条私信给抖音好友（无头浏览器，页面自己签名）。🔴 先问使用者，confirm:true 才发。'
      + '要给视频请用 douyin_share_card（先卡片后文字）。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '好友昵称（只用于显示）；留空用配置 dmTo' },
        to_id: { type: 'string', description: '好友稳定 id（sec_uid）；留空用配置 dmToId' },
        text: { type: 'string', description: '私信正文' },
        dry: { type: 'boolean', description: '只验证通道，不真发' },
        confirm: { type: 'boolean', description: '🔴 必须由使用者当场同意后传 true，否则只回草稿' },
      },
      additionalProperties: false,
    },
    handler: (args) => {
      const bad = needLogin() || needSetup()
      if (bad) return bad
      const cfg = config()
      const to = String(args?.to || cfg.dmTo || '').trim()
      const toId = String(args?.to_id || cfg.dmToId || '').trim()
      if (!to && !toId) return { ok: false, error: '不知道发给谁', hint: '传 to / to_id，或让使用者在设置里填私信对象' }
      const text = String(args?.text || '').trim()
      if (!text) return { ok: false, error: '正文为空' }
      if (args?.confirm !== true) {
        return { ok: true, sent: false, needsConfirm: true, to, to_id: toId || undefined, draft: text.slice(0, 1500), len: text.length, note: '没发送 —— 先把草稿给使用者看' }
      }
      const argv = []
      if (to) argv.push('--to', to)
      if (toId) argv.push('--to-id', toId)
      argv.push('--text', text)
      if (args?.dry) argv.push('--dry')
      const r = runNode('im-send.mjs', argv, 240_000)
      return pickJson(r.stdout) || { ok: false, error: '发送器没返回可解析结果', stderr_tail: stderrTail(r) }
    },
  },
  {
    name: 'douyin_comment_reply',
    title: '刷抖音 · 发评论 / 回复评论',
    description: '在评论区发一条评论，或回复某条评论（一条 fetch，不点 UI，不弹短信验证，1 秒）。'
      + '⚠️ 这条发的是**普通评论/回复**：正文里的「@昵称」只是文字，对方收不到 @ 通知；'
      + '但**回复**会让对方收到「回复了我的评论」通知。'
      + '⭐ 对方那条在**楼中楼**里（别人楼下）时，还要传 root_comment_id（楼根）—— '
      + '不然通知会发给楼主而不是他。楼根从 douyin_notices / douyin_at_me 的返回里直接拿。'
      + '🔴 要真 @ 用 douyin_comment_mention。🔴 先问使用者，confirm:true 才发。',
    inputSchema: {
      type: 'object',
      properties: {
        aweme_id: { type: 'string', description: '作品/图文 id' },
        text: { type: 'string', description: '评论正文（≤500 字）' },
        comment_id: { type: 'string', description: '要回复的评论 cid；留空 = 发顶层评论。可以是顶层评论，也可以是楼中楼里的某条' },
        root_comment_id: {
          type: 'string',
          description: '【可选】楼根 cid（这栋楼第一条顶层评论）。回复**楼中楼**时用；'
            + '不给会自动判，判不出来会拒绝发送（不会瞎猜）。',
        },
        confirm: { type: 'boolean', description: '🔴 必须由使用者当场同意后传 true，否则只回草稿' },
      },
      required: ['aweme_id', 'text'],
      additionalProperties: false,
    },
    handler: (args) => {
      const bad = needLogin() || needSetup()
      if (bad) return bad
      const aweme = String(args?.aweme_id || '').trim()
      const text = String(args?.text || '').trim()
      const replyTo = String(args?.comment_id || '').trim()
      const rootCid = String(args?.root_comment_id || '').trim()
      if (!aweme) return { ok: false, error: '缺 aweme_id' }
      if (!text) return { ok: false, error: '正文是空的' }
      if (text.length > 500) return { ok: false, error: `正文太长（${text.length} 字）` }
      if (args?.confirm !== true) {
        return {
          ok: true, sent: false, needsConfirm: true, aweme_id: aweme,
          comment_id: replyTo || '(顶层评论)',
          root_comment_id: rootCid || '(自动判)',
          draft: text, len: text.length,
          how: replyTo
            ? (rootCid ? `楼中楼回复：reply_id=${rootCid}、reply_to_reply_id=${replyTo}`
              : `楼中楼回复：楼根自动判、reply_to_reply_id=${replyTo}`)
            : '顶层普通评论：**不会通知任何人**',
          note: '没发送 —— 先把草稿给使用者看',
        }
      }
      const argv = ['--aweme', aweme, '--text', text]
      if (replyTo) argv.push('--reply', replyTo)
      if (rootCid) argv.push('--root', rootCid)
      const r = runNode('comment-api.mjs', argv, 260_000)
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '发送器没返回可解析结果', stderr_tail: stderrTail(r) }
      if (j.need_root) {
        return {
          ok: false, need_root: true, ...j,
          hint: '这条 cid 在楼中楼里，但判不出楼根 ⇒ **没发出**。'
            + '先 douyin_notices / douyin_at_me 读一次拿 root_comment_id，再传进来。',
        }
      }
      // 核实"真的进了楼没有"（脚本发完会重读那一楼）
      if (j.ok && j.placement && j.placement.ok === false) {
        j.warning = j.placement.warn
      }
      return j
    },
  },

  /* ── 读私信 / 说明 ── */
  {
    name: 'douyin_im_read',
    title: '刷抖音 · 读私信',
    description: '读最近一个会话的消息，每条带 from（me/them/unknown），能分清谁说的。只读。'
      + '⭐ 会自动带上记忆（context）：之前聊过什么、这个人的长期事实。回话前先看它。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '会话昵称；留空用配置 dmTo' },
        to_id: { type: 'string', description: '稳定 id（sec_uid）；重名时给' },
        limit: { type: 'number', description: '返回最近几条（默认 30，最多 60）' },
      },
      additionalProperties: false,
    },
    handler: (args) => {
      const bad = needLogin() || needSetup()
      if (bad) return bad
      const cfg = config()
      const to = String(args?.to || cfg.dmTo || '').trim()
      const toId = String(args?.to_id || cfg.dmToId || '').trim()
      if (!to && !toId) return { ok: false, error: '不知道读谁的会话' }
      const argv = ['--read']
      if (to) argv.push('--to', to)
      if (toId) argv.push('--to-id', toId)
      const r = runNode('im-send.mjs', argv, 240_000)
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '读不到会话', stderr_tail: stderrTail(r) }
      if (!j.ok) return j
      const all = Array.isArray(j.messages) ? j.messages : []
      const limit = Math.max(1, Math.min(Number(args?.limit) || 30, 60))
      return {
        ok: true, to: j.to, to_sec_uid: j.to_sec_uid, count: j.count,
        mine: j.mine, them: j.them, unknown: j.unknown,
        messages: all.slice(-limit),
        their_latest: all.filter((m) => m.from === 'them').slice(-3).reverse(),
      }
    },
  },
  {
    name: 'douyin_at_me',
    title: '刷抖音 · 谁在评论区 @ 了我',
    description: '把「谁 @ 的 / 在哪个视频 / 说了什么 / 我回过没有」整理好，带记忆上下文。只读。'
      + '想回就用返回里的 aweme_id + comment_id 调 douyin_comment_reply。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多看几条（默认 10，最多 30）' },
        include_seen: { type: 'boolean', description: '连已经回过的也列出来' },
      },
      additionalProperties: false,
    },
    handler: (args) => {
      const bad = needLogin() || needSetup()
      if (bad) return bad
      const argv = [join(ROOT, 'tools', 'notice-read.py'), '--raw']
      const r = run(venvPython(), argv, 150_000)
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '没读到通知', stderr_tail: stderrTail(r) }
      const ats = (Array.isArray(j.items) ? j.items : []).filter((x) => x && (x.type === 45 || x.type === 46))
      const limit = Math.max(1, Math.min(Number(args?.limit) || 10, 30))
      return {
        ok: true,
        at_n: ats.length,
        list: ats.slice(0, limit).map((a) => ({
          nickname: a.nickname || '', content: String(a.content || '').slice(0, 300),
          aweme_id: a.aweme_id || undefined, comment_id: a.comment_id || undefined,
          video_url: a.video_url || undefined,
        })),
        hint: ats.length ? '要回：douyin_comment_reply { aweme_id, comment_id, text }，先给用户看草稿' : '最近没有新的 @',
      }
    },
  },
  {
    /**
     * ⭐⭐ 真 @ 评论（2026-10-23 加，因使用者反馈"@ 不出来"）
     *
     * 🔴 背景：抖音的 @ 只有**UI 点选**才作数 —— API 直发时服务端会把 mention 的
     *    sec_uid 剥掉（名字变蓝、点开空页、对方收不到通知）。
     *    所以 `douyin_comment_reply` 只能发普通评论；**真 @ 必须走这个工具**，
     *    它内部跑 tools/comment-mention-ui.mjs：滚输入框 → 真实点开 DraftJS →
     *    CDP 键盘打 @ → 真实鼠标点弹层里那一行 → 补正文 → 点红色箭头发布。
     *
     * ⚠️ 前提：必须已登录、必须装了 Chrome（要起无头浏览器）、昵称要能在弹层里搜到。
     */
    name: 'douyin_comment_mention',
    title: '刷抖音 · 评论区真 @（UI 点选）',
    description: '在别人视频的评论区发一条**真正 @ 到某人**的评论（名字可点、对方收到通知）。'
      + '⚠️ 比普通评论慢（要起无头 Chrome 点选弹层），且要求昵称能在 @ 弹层里搜到。'
      + '🔴 先问使用者，confirm:true 才发。',
    inputSchema: {
      type: 'object',
      properties: {
        aweme_id: { type: 'string', description: '作品/图文 id' },
        name: { type: 'string', description: '要 @ 的人的抖音昵称（必须和对方昵称完全一致）' },
        text: { type: 'string', description: '评论正文（≤500 字；不用自己写 @昵称，工具会自动加）' },
        confirm: { type: 'boolean', description: '🔴 必须由使用者当场同意后传 true，否则只回草稿' },
        dry: { type: 'boolean', description: 'true = 只走到点选完就停（不发布），用于验证昵称搜不搜得到' },
      },
      required: ['aweme_id', 'name', 'text'],
      additionalProperties: false,
    },
    handler: (args) => {
      const bad = needLogin() || needSetup()
      if (bad) return bad
      const aweme = String(args?.aweme_id || '').trim()
      const name = String(args?.name || '').trim()
      const text = String(args?.text || '').trim()
      if (!aweme) return { ok: false, error: '缺 aweme_id' }
      if (!name) return { ok: false, error: '缺 name（要 @ 的昵称）' }
      if (!text) return { ok: false, error: '正文是空的' }
      if (text.length > 500) return { ok: false, error: `正文太长（${text.length} 字）` }
      if (args?.confirm !== true && args?.dry !== true) {
        return {
          ok: true, sent: false, needsConfirm: true, aweme_id: aweme, mention: name,
          draft: `@${name} ${text}`, len: text.length,
          note: '没发送 —— 先把草稿给使用者看；想先验证昵称能不能 @ 到，可传 dry:true（只点选不发布）',
        }
      }
      const argv = ['--aweme', aweme, '--name', name, '--text', text]
      if (args?.dry === true) argv.push('--dry')
      const r = runNode('comment-mention-ui.mjs', argv, 300_000)
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '真 @ 执行器没返回可解析结果', stdout: String(r.stdout || '').slice(0, 400), stderr_tail: stderrTail(r) }
      return j
    },
  },
  {
    name: 'douyin_guide',
    title: '刷抖音 · 使用说明',
    description: '返回这个插件给别的 agent 看的使用说明（工具清单、安全红线、MCP 配置）。第一次接进来先读它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      try {
        return { ok: true, doc: readFileSync(join(ROOT, 'AI-USAGE.md'), 'utf8') }
      } catch (e) {
        return { ok: false, error: '找不到 AI-USAGE.md（插件包不完整）', detail: String(e?.message ?? e) }
      }
    },
  },
]

/* ─────────────────────────── JSON-RPC / MCP 传输 ─────────────────────────── */

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const send = (msg) => {
  try { process.stdout.write(JSON.stringify(msg) + '\n') } catch { /* 管道断了就随它去 */ }
}

const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })

/** 工具结果统一包成 MCP content */
const asContent = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return {
    content: [{ type: 'text', text }],
    isError: value && typeof value === 'object' && value.ok === false ? true : undefined,
  }
}

const handleRequest = async (msg) => {
  const { id, method, params } = msg || {}
  const isNotification = id === undefined || id === null

  switch (method) {
    /* ⭐ 新客户端（2026-07-28）会先探这个；明确回"没有" ⇒ 它自动回落 legacy initialize */
    case 'server/discover':
      return fail(id, -32601, 'Method not found: server/discover (this server speaks MCP 2025-06-18)')

    case 'initialize': {
      const asked = String(params?.protocolVersion || '')
      const version = SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0]
      return reply(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: '刷抖音插件（dsh-douyin-scroll）的 MCP 入口。第一次用先调 douyin_guide 读说明；发任何东西前必须先问使用者，得到同意才传 confirm:true。',
      })
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined

    case 'ping':
      return reply(id, {})

    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      })

    case 'tools/call': {
      const name = String(params?.name || '')
      const tool = TOOLS.find((t) => t.name === name)
      if (!tool) return fail(id, -32602, `Unknown tool: ${name}`)
      try {
        const value = await tool.handler(params?.arguments || {})
        return reply(id, asContent(value))
      } catch (e) {
        return reply(id, asContent({ ok: false, error: String(e?.message ?? e) }))
      }
    }

    default:
      if (isNotification) return undefined
      return fail(id, -32601, `Method not found: ${method}`)
  }
}

/* ─────────────────────────── 入口 ─────────────────────────── */

if (process.argv.includes('--selftest')) {
  // 不接客户端，自己跑一遍协议握手 + tools/list —— selfcheck.mjs 也用它
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'douyin_status', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'server/discover', params: {} },
  ]
  for (const l of lines) {
    const out = []
    const orig = process.stdout.write.bind(process.stdout)
    process.stdout.write = (s) => { out.push(String(s)); return true }
    await handleRequest(l)
    process.stdout.write = orig
    const text = out.join('').trim().split('\n')[0] || '{}'
    const j = JSON.parse(text)
    if (j.error) console.log(`#${l.id} ${l.method} -> error ${j.error.code} ${j.error.message.slice(0, 60)}`)
    else if (j.result?.tools) console.log(`#${l.id} ${l.method} -> ${j.result.tools.length} tools: ${j.result.tools.map((t) => t.name).join(', ')}`)
    else console.log(`#${l.id} ${l.method} -> ok ${JSON.stringify(j.result).slice(0, 120)}`)
  }
  process.exitCode = 0
} else {
  process.stderr.write(`[douyin-mcp] ${SERVER_NAME} v${SERVER_VERSION} 已启动（家=${HOME}，${TOOLS.length} 个工具）\n`)
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const t = String(line || '').trim()
    if (!t) return
    let msg
    try { msg = JSON.parse(t) } catch { process.stderr.write('[douyin-mcp] 收到非 JSON 行，已忽略\n'); return }
    Promise.resolve(handleRequest(msg)).catch((e) => {
      process.stderr.write(`[douyin-mcp] 处理 ${msg?.method} 出错：${e?.message ?? e}\n`)
      if (msg?.id !== undefined) fail(msg.id, -32603, String(e?.message ?? e))
    })
  })
  rl.on('close', () => { process.exitCode = 0 })
}
