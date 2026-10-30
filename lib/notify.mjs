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
 * 🔴 目的地址校验（Issue #5，CWE-918）。
 *
 * webhook 地址是使用者在设置里填的，正常用当然没事；但这一层原来**什么地址都收**，
 * 于是「自定义地址」可以指向 `127.0.0.1` / `169.254.169.254` / 云元数据 ——
 * 本机就成了打内网的跳板（报告正文、家目录路径都可能被带出去）。
 *
 * 这里只做**不联网**的静态判断（scheme + 字面量地址 + 已知元数据主机名）：
 *   · 非 http(s) 一律拒；
 *   · 回环 / link-local / 云元数据 / 组播 一律拒（除非显式放开）；
 *   · 局域网私有段（10/172.16/192.168、IPv6 ULA）**放行**并标 `private`
 *     —— 企业内网自建机器人是真实用法，一刀切会把正常功能砍掉。
 *
 * ⚠️ 不做 DNS 解析：解析完再连是 TOCTOU，防不住 rebinding ——
 *    真要更强只能靠固定白名单或出网代理，那是部署层的事，不该由这个函数假装做到了。
 * 放开内网：环境变量 `DOUYIN_WEBHOOK_ALLOW_LOCAL=1`。
 */
export function checkWebhookTarget(raw, { allowLocal = false } = {}) {
  const s = String(raw ?? '').trim()
  if (!s) return { ok: true, skip: 'no_url' }
  let u
  try { u = new URL(s) } catch { return { ok: false, error: '不是合法 URL（要带 http:// 或 https://）' } }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: `不支持的协议 ${u.protocol}（只允许 http / https）` }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const deny = (why) => ({
    ok: false,
    error: `webhook 地址指向 ${host} —— ${why}`,
    hint: '换成外网的机器人地址；确实要发到本机 / 内网，就设环境变量 DOUYIN_WEBHOOK_ALLOW_LOCAL=1',
  })
  const pass = (private_ = false) => ({ ok: true, private: private_ })

  if (allowLocal) return pass(true)

  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal' || host === 'metadata') {
    return deny('这是本机 / 云元数据地址')
  }

  // IPv4 字面量
  const m4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (m4) {
    const [a, b] = [Number(m4[1]), Number(m4[2])]
    if (a === 127 || a === 0) return deny('这是回环 / 保留地址')
    if (a === 169 && b === 254) return deny('这是 link-local（含云元数据 169.254.169.254）')
    if (a >= 224) return deny('这是组播 / 保留地址')
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
      return pass(true)   // 局域网：放行但标出来
    }
    return pass(false)
  }

  // IPv6 字面量
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return deny('这是回环 / 未指定地址')
    if (/^fe[89ab][0-9a-f]:/.test(host)) return deny('这是 IPv6 link-local')
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return pass(true)   // ULA：当私有
    return pass(false)
  }

  return pass(false)   // 普通域名：交给 TLS / 代理去管
}

/**
 * 发一条 webhook。
 * @returns {Promise<{ok:boolean, sent:boolean, error?:string, status?:number, via?:string}>}
 * ⚠️ **绝不抛异常**：通知失败只该"这一轮没提醒成"，不该把宿主拉下水（10-14 定时器事故的教训）。
 */
export async function sendWebhook({ url, preset = 'custom', title = '', markdown = '', timeoutMs = 10_000 }) {
  const target = String(url || '').trim()
  if (!target) return { ok: true, sent: false, skipped: 'no_url', error: '没填 webhook 地址' }
  const gate = checkWebhookTarget(target, {
    allowLocal: /^(1|true|yes)$/i.test(String(process.env.DOUYIN_WEBHOOK_ALLOW_LOCAL || '')),
  })
  if (!gate.ok) {
    // 不静默：日志和返回值都要说清「为什么没发」
    return { ok: false, sent: false, skipped: 'blocked_target', error: gate.error, hint: gate.hint }
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
