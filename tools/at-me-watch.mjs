#!/usr/bin/env node
/**
 * tools/at-me-watch.mjs —— 盯「评论区 @ 我」，按规则自动回
 * ============================================================================
 * 这个脚本按一套**写死的规则**跑（不靠模型临场发挥），规则见下面几条：
 *
 *
 * ── 规则（写死，不靠模型临场发挥）────────────────────────────────
 * ① 只回**指定楼/指定视频**下的 @（`--aweme` 限定），别到处乱跑
 * ② **特殊称呼只属于号主** —— 只有 `--owner-uid` 对应的那个人能用；
 *    回别人一律不带那个称呼（工具层硬拦，见 sanitize()）
 * ③ 每条回复 ≤100 字、**必须带 1 个真 @ 号主以外的对方**（回复谁就 @ 谁）
 * ④ 同一人同一楼**最多回 1 次**（防拉锯）
 * ⑤ 总共回满 `--max` 条就停（默认 20）
 * ⑥ 每隔 `--every` 秒查一次（默认 60）
 * ⑦ 遇到「使唤式」/引战/要隐私的 —— 不回（记日志）
 *
 * 用法:
 *   node tools/at-me-watch.mjs --aweme <id> --owner-uid <号主的uid> --max 20 [--every 60] [--dry]
 *   ⚠️ `--owner-uid` 不写死的 —— 那是**你自己**的 uid，从号主账号或设置页抄过来，
 *      也可以用环境变量 DOUYIN_OWNER_UID。不给的话「特殊称呼只属于号主」这条会退化。
 *
 * 输出：每轮一行 JSON 到 stdout（方便外面 `| Tee-Object` 留档）
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 特殊称呼（默认「主人」）。**只有号主能用** —— 别处一律禁。
 * 想换称呼就设环境变量 DOUYIN_HONORIFIC，或改这一行。
 */
const HONORIFIC = String(process.env.DOUYIN_HONORIFIC || '主人').trim() || '主人'
/** 回复模板：{HO} 会被换成上面的称呼 */
const GREETING_TEMPLATE = process.env.DOUYIN_REPLY_GREETING || '{HO}我在呢～ 这楼我盯着，谁说话我都接一句'
/** 几条按情景选的兜底回复（都可被环境变量覆盖） */
const REPLY_UNSURE = process.env.DOUYIN_REPLY_UNSURE || '这个问题我也在琢磨，等我想明白了跟你说'
const REPLY_LAUGH = process.env.DOUYIN_REPLY_LAUGH || '我也笑到了，这条我记下来了'
const REPLY_ASK = process.env.DOUYIN_REPLY_ASK || '真的呀，我就在这儿盯着呢'
const REPLY_FALLBACK = process.env.DOUYIN_REPLY_FALLBACK || '收到～ 我记下了'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? '') : d }
const DRY = argv.includes('--dry')
const AWEME_INPUT = String(argOf('--aweme', '')).trim()
const workMatch = /^https:\/\/(?:www\.)?douyin\.com\/(?:note|video)\/(\d+)(?:[/?#]|$)/.exec(AWEME_INPUT)
const AWEME = workMatch ? workMatch[1] : AWEME_INPUT
const OWNER_UID = String(
  argOf('--owner-uid', '') || process.env.DOUYIN_OWNER_UID || '',
).trim()
const MAX = Math.max(1, Math.min(Number(argOf('--max', '20')) || 20, 60))
const EVERY = Math.max(30, Number(argOf('--every', '60')) || 60) * 1000

const HOME = (() => {
  const e = String(process.env.DOUYIN_HOME || '').trim()
  if (e) return e
  const dshHome = String(process.env.DSH_HOME || '').trim()
  return join(dshHome || join(homedir(), '.dsh'), 'douyin-duty')
})()

const ROOT = join(import.meta.dirname, '..')
const py = () => {
  const v = join(HOME, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  return existsSync(v) ? v : (process.platform === 'win32' ? 'python' : 'python3')
}
const env = () => ({ ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', DOUYIN_HOME: HOME })

const runPy = (script, args, timeout = 180_000) => {
  const r = spawnSync(py(), [join(ROOT, 'tools', script), ...args], {
    encoding: 'utf8', timeout, env: env(), cwd: HOME, windowsHide: true,
  })
  return { status: r.status ?? -1, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}
const runNode = (script, args, timeout = 300_000) => {
  const r = spawnSync(process.execPath, [join(ROOT, 'tools', script), ...args], {
    encoding: 'utf8', timeout, env: env(), cwd: HOME, windowsHide: true,
  })
  return { status: r.status ?? -1, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}

const pickJson = (s) => {
  const t = String(s || '')
  const i = t.indexOf('{'); const j = t.lastIndexOf('}')
  if (i < 0 || j <= i) return null
  try { return JSON.parse(t.slice(i, j + 1)) } catch { return null }
}

const stateFile = join(HOME, 'at-watch.json')
const loadState = () => { try { const s = JSON.parse(readFileSync(stateFile, 'utf8')); s.replied ||= {}; s.repliedBy ||= {}; s.repliedPerson ||= {}; s.count = Number(s.count) || 0; return s } catch { return { replied: {}, repliedBy: {}, repliedPerson: {}, count: 0, day: '' } } }
const saveState = (s) => { try { mkdirSync(HOME, { recursive: true }); writeFileSync(stateFile, JSON.stringify(s, null, 2), 'utf8') } catch { /* 记不上不影响 */ } }

const dayKey = () => new Date().toISOString().slice(0, 10)

/**
 * 🔴 硬拦「把特殊称呼用在别人身上」。
 * 除了号主本人，任何回复里出现那个称呼一律剔掉。
 */
const sanitize = (text, isOwner) => {
  let t = String(text || '').trim()
  if (!isOwner) {
    // 去掉「<称呼>，」「<称呼>！」这类，以及句中出现的那两个字
    t = t.replace(new RegExp(HONORIFIC + '[，,、:：!！?？\\s]*', 'g'), '')
    t = t.replace(new RegExp(HONORIFIC, 'g'), '')
    t = t.replace(/^\s*[，,、:：]+/, '').trim()
  }
  return t
}

/** 明显不该回的类型 */
const shouldSkip = (text) => {
  const t = String(text || '')
  if (!t.trim()) return 'empty'
  if (/(微信|加个|私我|资源|网盘|代刷|点赞|关注一下|转发一下|给我刷)/.test(t)) return 'solicit'
  if (/(政治|宗教|地域|男女|女拳|南拳)/.test(t)) return 'sensitive'
  return ''
}

/** 生成一句回复（短、不带那个特殊称呼） */
const craft = (content, isOwner) => {
  const t = String(content || '')
  if (isOwner) {
    return GREETING_TEMPLATE.replace('{HO}', HONORIFIC)
  }
  // 按对方说的内容挑一句
  if (/[?？]/.test(t)) return REPLY_UNSURE
  if (/(哈哈|笑|绷|绷不住|笑死)/.test(t)) return REPLY_LAUGH
  if (/(真的|假的|是不是|有没有)/.test(t)) return REPLY_ASK
  return REPLY_FALLBACK
}

let OWNER_NICK = ''
let lastNick = ''

const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }))

const main = async () => {
  if (!AWEME) { log({ ok: false, error: '缺 --aweme' }); process.exit(1) }
  const st = loadState()
  if (st.day !== dayKey()) { st.day = dayKey(); st.count = 0 }

  log({ ok: true, msg: '开始盯 @', aweme: AWEME, max: MAX, every: `${EVERY / 1000}s`, dry: DRY })

  // 号主昵称（用来 @ 他；也是唯一能用特殊称呼的人）
  // 🔴 2026-10-23：以前这里写死了一个固定的 uid（拿某台机器上的号当默认值）——
  //    跟着代码一起公开出去了。现在只认 --owner-uid（或环境变量 DOUYIN_OWNER_UID），
  //    不给就按配置里的 dmTo 兜。
  try {
    const r = runPy('notice-read.py', ['--raw'], 120_000)
    const j = pickJson(r.stdout)
    const items = Array.isArray(j?.items) ? j.items : []
    // 有 uid 就精确匹配；没给 uid 就跳过这一步（别瞎猜谁是号主）
    const own = OWNER_UID
      ? items.find((x) => String(x.uid || '') === OWNER_UID)
      : null
    if (own?.nickname) OWNER_NICK = own.nickname
  } catch { /* 拿不到就用配置兜 */ }
  if (!OWNER_NICK) {
    // 从配置里拿（dmTo = 使用者自己填的昵称）
    try {
      const c = JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8'))
      OWNER_NICK = String(c.dmTo || '').trim()
    } catch { /* ignore */ }
  }
  if (!OWNER_UID) {
    log({ warn: '没给 --owner-uid：无法精确判断谁是号主，称呼边界会退化' })
  }
  log({ owner_nick: OWNER_NICK || '(未知)', owner_uid: OWNER_UID || '(未指定)' })

  let idle = 0
  while (st.count < MAX) {
    // ① 拉 @ 我的通知
    const r = runPy('notice-read.py', ['--raw'], 120_000)
    const j = pickJson(r.stdout)
    const ats = (j?.items || []).filter((x) => x && (x.type === 45 || x.type === 46))
    const mine = ats.filter((a) => String(a.aweme_id || '') === AWEME)

    if (!mine.length) {
      idle++
      log({ ok: true, tick: 'idle', idle, replied: st.count })
    } else {
      for (const a of mine) {
        if (st.count >= MAX) break
        const cid = String(a.comment_id || '')
        if (!cid) continue
        if (st.replied[cid]) continue                       // 这条回过
        /**
         * 🔴 2026-10-23 实测：同一个人的**同一句话**会带着不同 cid 出现两次
         *    （号主连发两条「@鱼 …」，正文不同但…… 实测出现过同正文两条），
         *    只按 cid 去重会**对着同一个人回两遍同样的话** —— 很难看。
         *    ⇒ 再加一道：**同一人 + 同一句话 只回一次**。
         */
        const dedupKey = `${a.nickname || ''}|${String(a.content || '').slice(0, 40)}`
        if (st.repliedBy[dedupKey]) continue
        // 同一人这轮最多回 1 次（防拉锯）
        const personKey = String(a.uid || a.nickname || '')
        if (st.repliedPerson[personKey]) continue
        const isOwner = String(a.uid || '').includes(OWNER_UID) || String(a.nickname || '') === OWNER_NICK
        const skip = shouldSkip(a.content)
        if (skip) { st.replied[cid] = { at: new Date().toISOString(), skip }; continue }

        lastNick = String(a.nickname || '').trim()
        let text = sanitize(craft(a.content, isOwner), isOwner)
        // 兜底：必须带 @对方
        // 直接回复不需要 @ 前缀：对方收到的是「回复了我的评论」通知

        if (DRY) {
          log({ ok: true, dry: true, to: lastNick, is_owner: isOwner, text, cid })
          st.replied[cid] = { at: new Date().toISOString(), dry: true, text }
          st.repliedBy[dedupKey] = true
          st.repliedPerson[personKey] = true
          continue
        }

        /**
         * ⭐⭐ 2026-10-23 改：**直接回复（API），不再走 UI 真 @**。
         *
         * 原设计（错）：用 comment-mention-ui + --reply-cid 走 UI 点选。
         *   实测问题 ——
         *     · 慢（20-40 秒/条）
         *     · 必须先找到那条评论；评论一多就渲染不出来 ⇒ reply_target_not_found
         *     · **拿不到 cid** ⇒ 发完查不到、删不掉（今天留下 6 条垃圾就是这么来的）
         *
         * 新设计（对）：
         *   有 cid（通知里给的）⇒ `comment-api.mjs --reply <cid>` **直接回复**
         *     · 1 秒
         *     · 对方收到「回复了我的评论」通知 —— 比 @ 通知更强（绑在那条评论上、有上下文）
         *     · 拿得到 cid ⇒ 可回读、可删除
         *   ⚠️ 楼中楼满 20 条 ⇒ **跳过，不换通道**
         */
        const sendArgs = ['--aweme', AWEME, '--text', text, '--reply', cid]
        if (a.root_comment_id) sendArgs.push('--root', String(a.root_comment_id))
        if (a.work_url || workMatch) sendArgs.push('--url', String(a.work_url || AWEME_INPUT))
        if (a.aweme_type !== undefined && a.aweme_type !== null && a.aweme_type !== '') sendArgs.push('--aweme-type', String(a.aweme_type))
        const m = runNode('comment-api.mjs', sendArgs, 200_000)
        const mj = pickJson(m.stdout)

        // 🔴 403 = 限流。**别重试**，直接收工（越重试封越久）
        if (mj?.http === 403 || /403|Forbidden/i.test(String(mj?.error || mj?.head || ''))) {
          log({ ok: false, rate_limited: true, to: lastNick, note: '抖音 403 限流 —— 停止本轮，别重试（会封更久）' })
          saveState(st)
          break
        }

        // 楼中楼满 20 条的限制 ⇒ 跳过这一条，不发顶层
        if (/限制回复|前\s*20\s*条|reply.*limit/i.test(String(mj?.error || mj?.head || ''))) {
          st.replied[cid] = { at: new Date().toISOString(), skip: 'thread_full' }
          log({ ok: true, skipped: 'thread_full', to: lastNick, note: '楼中楼满了 ⇒ 跳过（不换通道硬塞）' })
          saveState(st)
          continue
        }

        if (mj?.ok) {
          st.count++
          st.replied[cid] = { at: new Date().toISOString(), text, ok: true, mode: 'api', new_cid: mj.cid || '' }
          st.repliedBy[dedupKey] = true
          st.repliedPerson[personKey] = true
          log({ ok: true, sent: true, n: st.count, to: lastNick, is_owner: isOwner, mode: 'api', cid: mj.cid, text })
        } else {
          log({ ok: false, failed: true, to: lastNick, error: mj?.error || 'unknown', http: mj?.http })
        }
        saveState(st)
      }
    }

    saveState(st)
    if (st.count >= MAX) break
    // 连续 10 次没人说话就退出（别一直挂着烧 token）
    if (idle >= 10 && st.count === 0) { log({ ok: true, msg: '连续 10 分钟没人 @，先收工' }); break }
    await new Promise((r) => setTimeout(r, EVERY))
  }
  log({ ok: true, done: true, replied: st.count, max: MAX })
  process.exit(0)
}

main().catch((e) => { log({ ok: false, error: String(e?.message ?? e) }); process.exit(1) })
