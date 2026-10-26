/**
 * lib/notify.mjs —— 通知出口（默认只写本地报告；webhook 可选、可插拔）
 * ============================================================================
 * MVP 的默认投递渠道是**站外通知 / 本地报告**：
 *   ① 报告写进 `<家>/out/<日期>.md`（永远做，这是"事实来源"）；
 *   ② 可选的 webhook（企业微信 / 飞书 / 钉钉 / 自定义）—— **默认关闭**，
 *      只有使用者自己填了 URL 才会发，而且**只在用户点「测试通知」或一轮结束时**才联网。
 *
 * 🔴 两条跟安全有关的规矩：
 *   ① **webhook URL 一律脱敏后再进日志**（它常常含 bot key，等于 credential）；
 *   ② **报告正文里不写 Cookie / 家目录私钥信息** —— 它可能被推到群里。
 * ============================================================================
 */

/** URL 脱敏：把 query / 路径尾部的疑似 token 打码，别让整串 bot key 进日志 */
export function maskUrl(u) {
  const s = String(u ?? '')
  if (!s) return ''
  try {
    const url = new URL(s)
    if (url.search) url.search = '?' + [...url.searchParams.keys()].map((k) => `${k}=***`).join('&')
    // 路径末段长度 >= 16 的当成 token（飞书 / 企业微信的 bot hook 就是这种形状）
    const segs = url.pathname.split('/')
    if (segs.length && segs[segs.length - 1].length >= 16) segs[segs.length - 1] = '***'
    url.pathname = segs.join('/')
    return url.toString()
  } catch { return s.replace(/[A-Za-z0-9_-]{16,}/g, '***') }
}

/**
 * 各平台的消息体形状不一样，别用错（写错了对方会正常回 200、但群里什么都不出）：
 *   · 企业微信机器人：{ msgtype:'markdown', markdown:{ content } }  ← 注意是 `markdown`，不是 `text`
 *   · 飞书自定义机器人：{ msg_type:'text', content:{ text } }       ← 早期版本；v2 需 tenant_access_token
 *   · 钉钉机器人：{ msgtype:'markdown', markdown:{ title, text } }
 *   · custom：直接 POST 原始 JSON { title, text, markdown }
 * ⚠️ 这些都是**公开文档里的形状**；企业内网 / 自建的请直接用 `custom`。
 */
function payloadFor(preset, title, markdown) {
  const text = String(markdown ?? '')
  switch (String(preset || 'custom')) {
    case 'wecom':
      return { msgtype: 'markdown', markdown: { content: `## ${title}\n\n${text}` } }
    case 'feishu':
      return { msg_type: 'text', content: { text: `${title}\n\n${text}` } }
    case 'dingtalk':
      return { msgtype: 'markdown', markdown: { title, text: `## ${title}\n\n${text}` } }
    default:
      return { title, text, markdown }
  }
}

/**
 * 校验 webhook 目标地址，拦掉内网 / 回环 / 链路本地 / 云元数据端点（CWE-918 SSRF 防护）。
 * 只放行 http/https，且解析出的 IP 必须是公网地址。
 */
async function assertSafeWebhookTarget(target) {
  const { hostname, protocol } = new URL(target)
  if (protocol !== 'http:' && protocol !== 'https:') throw new Error(`不支持的协议：${protocol}`)
  const { isIP } = await import('node:net')
  const { lookup } = await import('node:dns/promises')
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true })
  for (const { address } of addresses) {
    const ip = address.toLowerCase()
    const isPrivate = ip === '::1' || ip === 'localhost' ||
      /^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip) ||
      /^169\.254\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
      ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80') || ip === '0.0.0.0'
    if (isPrivate) throw new Error(`目标地址解析到内网/本地 IP：${address}`)
  }
}

/**
 * 发一条 webhook。
 * @returns {Promise<{ok:boolean, sent:boolean, error?:string, status?:number, via?:string}>}
 * ⚠️ **绝不抛异常**：通知失败只该"这一轮没提醒成"，不该把宿主拉下水（10-14 定时器事故的教训）。
 */
export async function sendWebhook({ url, preset = 'custom', title = '', markdown = '', timeoutMs = 10_000 }) {
  const target = String(url || '').trim()
  if (!target) return { ok: true, sent: false, skipped: 'no_url', error: '没填 webhook 地址' }
  try {
    await assertSafeWebhookTarget(target)
  } catch (e) {
    return { ok: false, sent: false, error: String(e?.message ?? e), via: maskUrl(target) }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payloadFor(preset, title, markdown)),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    const body = await res.text().catch(() => '')
    // ⭐ 有些平台 HTTP 200 但业务失败（errcode != 0）—— 只看状态码会漏
    let errcode = null
    try { errcode = JSON.parse(body)?.errcode ?? JSON.parse(body)?.code ?? null } catch { /* 不是 JSON 就算了 */ }
    const ok = res.ok && (errcode === null || errcode === 0 || errcode === '0')
    return {
      ok,
      sent: res.ok,
      status: res.status,
      via: maskUrl(target),
      error: ok ? '' : `HTTP ${res.status} / errcode=${errcode} / ${String(body).slice(0, 200)}`,
    }
  } catch (e) {
    clearTimeout(timer)
    return { ok: false, sent: false, error: String(e?.message ?? e), via: maskUrl(target) }
  }
}

/**
 * 报告 → 通知正文（**薄**：群消息里放全文太吵）。
 * full 档 => 取每条的标题与理由；brief 档 => 就直接全文。
 */
export function condense(reportText, { maxChars = 1200, title = '' } = {}) {
  const src = String(reportText ?? '')
  if (!src.trim()) return { title, text: '（这一轮没有产出内容）' }
  if (src.length <= maxChars) return { title, text: src }
  // 截到 maxChars，但**尽量断在行末**（别把一个链接砍成半条）
  const cut = src.slice(0, maxChars)
  const i = cut.lastIndexOf('\n')
  return { title, text: (i > maxChars * 0.5 ? cut.slice(0, i) : cut) + '\n\n…（完整版见本地 out/<日期>.md）' }
}
