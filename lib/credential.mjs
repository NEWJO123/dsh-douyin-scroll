/**
 * lib/credential.mjs —— 抖音登录态（本地 Cookie / 凭证文件，不上传）
 * ============================================================================
 * ⚠️ 这里跟 dsh-bili-scroll 的 lib/login.mjs 有**本质区别**，别照抄它的扫码流程：
 *
 *   B站：有 passport 二维码 tickets vendor.services 三方商家都要…算了，说重点 ——
 *        passport 有公开的 web 二维码接口 + `bilibili-api-python` 里有 QrCodeLogin ⇒ **能扫码** ✓
 *   抖音：**没有**公开稳定的 web 二维码登录接口，也没有维护中的 Python 登录库。
 *        现成的开源采集器（MediaCrawler / TikTokDownloader 等）清一色是**让用户从浏览器里粘贴 Cookie** ✓
 *        ⇒ 我们也走这条路：**粘贴 Cookie**（这是 MVP 里唯一诚实可靠的做法，不虚构 API）。
 *
 * 🔴 三条铁律：
 *   ① 凭证只落在本机 `douyin_cookie.txt`，**绝不上传**任何地方；
 *   ② **不硬编码**任何 Cookie / token / 签名密钥；
 *   ③ 日志 / 报错里的 Cookie 一律先过 `redactCookie()` —— 使用者会把日志整段贴给别人排错。
 *
 * Cookie 怎么拿（README 里会写）：浏览器进 douyin.com 登录 → F12 → Network → 随便点一条
 *   douyin.com 的请求 → Request Headers → Cookie → 整行复制过来。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeSecret, redactCookie } from './state.mjs'

export const COOKIE_FILE = 'douyin_cookie.txt'

/** 抖音会话里真正要紧的几个 key（用于"这份 Cookie 有没有用"的自检，以及 UI 显示） */
export const IMPORTANT_KEYS = [
  'sessionid', 'sessionid_ss', 'sid_tt', 'ssid_ucp_v1',
  'passport_csrf_token', 'uid_tt', 'uid_tt_ss', 'ttwid', 'msToken', 'odin_tt',
]

export const cookiePath = (stateDir) => join(stateDir, COOKIE_FILE)

/**
 * 解析 Cookie 串 → { name: value }
 * 三种输入都收：
 *   · 完整请求头形式：`Cookie: a=1; b=2`
 *   · 裸串：`a=1; b=2`
 *   · ⭐ 2026-11-08：JSON 形状 —— F12 的 Application → Cookies 面板一复制就是
 *     `[{"name":..,"value":..},…]` 或 `{"cookies":[…]}`（im-http.py 先支持过，这里收编统一）。
 */
export function parseCookie(raw) {
  let s = String(raw ?? '').trim()
  if (!s) return {}
  s = s.replace(/^cookie:\s*/i, '')            // 容忍用户连 header 名一起复制
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      const j = JSON.parse(s)
      const arr = Array.isArray(j) ? j : (Array.isArray(j?.cookies) ? j.cookies : [])
      if (arr.length && arr.every((c) => c && typeof c.name === 'string')) {
        return Object.fromEntries(arr.map((c) => [String(c.name), String(c.value ?? '')]))
      }
    } catch { /* 不是合法 JSON，按 header 形式继续 */ }
  }
  const jar = {}
  for (const part of s.split(';')) {
    const seg = String(part).trim()
    if (!seg) continue
    const i = seg.indexOf('=')
    if (i <= 0) continue
    const name = seg.slice(0, i).trim()
    const value = seg.slice(i + 1).trim()
    if (name) jar[name] = value
  }
  return jar
}

/** { name: value } → `a=1; b=2`（给 HTTP 请求头用） */
export function serializeCookie(jar) {
  return Object.entries(jar || {}).map(([k, v]) => `${k}=${v}`).join('; ')
}

/**
 * 存 Cookie。
 * ⭐ 先校验"像不像有用的抖音会话"再落盘 —— 不然用户粘错一串，后面每个工具都报"未登录"，
 *    排查成本高；早失败早提示。
 * ⚠️ 校验只做**形状**检查（有没有那几个 key），**不发请求**（贴完就立刻联网反而危险）。
 */
export function saveCookie(stateDir, raw, log = () => {}) {
  const jar = parseCookie(raw)
  const keys = Object.keys(jar)
  if (!keys.length) {
    return { ok: false, error: '这段里没解析出任何 Cookie —— 应该是复制得不完整（要把 `Cookie:` 后面那一长串整个复制过来）' }
  }
  const hit = IMPORTANT_KEYS.filter((k) => k in jar)
  const file = cookiePath(stateDir)
  writeSecret(file, String(raw).trim())
  log(`凭证已写入 ${file}（识别出 ${keys.length} 个 key，其中关键项：${hit.join(', ') || '无'}）`)
  return {
    ok: true,
    file,
    keys: keys.length,
    important: hit,
    // ⚠️ 一个 key 都没有 ⇒ 多半是粘了广告/埋点 Cookie，或没登录
    warn: hit.length === 0
      ? '没看到 sessionid / sid_tt / passport_csrf_token 这类会话票据 —— 多半是没登录、或者复制错了'
      : '',
  }
}

/** 读当前 Cookie 串（没有就返回空串） */
export function readCookie(stateDir) {
  try {
    if (!existsSync(cookiePath(stateDir))) return ''
    return readFileSync(cookiePath(stateDir), 'utf8').trim()
  } catch { return '' }
}

export function hasCredential(stateDir) {
  return readCookie(stateDir).length > 0
}

/** 给 UI / 状态接口用的凭证概览（**脱敏**，不含真实值） */
export function credentialInfo(stateDir) {
  const raw = readCookie(stateDir)
  if (!raw) return { hasCredential: false, keys: [], important: [], redacted: '', bytes: 0, at: null }
  const jar = parseCookie(raw)
  return {
    hasCredential: true,
    keys: Object.keys(jar),
    important: IMPORTANT_KEYS.filter((k) => k in jar),
    redacted: redactCookie(raw),
    bytes: (() => { try { return statSync(cookiePath(stateDir)).size } catch { return raw.length } })(),
    at: (() => { try { return statSync(cookiePath(stateDir)).mtime.toISOString() } catch { return null } })(),
  }
}

/** 删凭证（"退出登录"按钮） */
export function clearCredential(stateDir) {
  try {
    const f = cookiePath(stateDir)
    if (existsSync(f)) writeSecret(f, '')
    return { ok: true }
  } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
}
