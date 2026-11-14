/**
 * lib/pet-memory-bridge.mjs —— 只读「桌宠小鱼」长期记忆的桥
 * ============================================================================
 * 背景（2026-11-14）：
 *   桌宠插件 dsh-deskpet-xiaoyu 里有唯一一份「小鱼」的长期记忆（atoms/profile，
 *   记着主人在电脑上做的事：写代码、看视频、游戏、电影、工作、跟豆包聊天…）。
 *   抖音插件里跟主人聊天的那个小鱼也要知道这些事，但**只能读、不能写**。
 *
 * 🔴 隐私红线（这条桥最重要的一条规定）：
 *   只允许 `/api/douyin-duty/pet/chat` 的**本地脑/模型兜底**（主人自己跟桌宠
 *   输入框说话）调用。**绝不接** duty / chatWatch / 评论 / 私信等任何对外发送路径。
 *   本模块只做读取，不写桌宠任何文件、不 import 桌宠代码。
 *
 * 两级数据源（先进程内服务，再本机 HTTP）：
 *   ① ctx.get('deskpetMemoryBrief') —— 可能是单个对象，也可能是数组；
 *      找 `{ name:'deskpet', recall(query, opts) }`，返回 { ok, text, items }。
 *   ② GET ${DSH_WEB_URL || 'http://127.0.0.1:54469'}/api/deskpet/pet/memory/brief
 *      ?q=<encode>&topK=4&maxChars=500
 *      1.5 秒 AbortController 超时；失败静默（整个 bridge 最多 log 一次），
 *      绝不影响抖音自己的任何功能。
 * ============================================================================
 */

const DEFAULT_TOP_K = 4
const DEFAULT_MAX_CHARS = 500
const HTTP_TIMEOUT_MS = 1500
const DEFAULT_BASE_URL = 'http://127.0.0.1:54469'

/** 桌宠记忆卡的类型 → 中文标签（与桌宠 formatMemoryCard 的观感保持一致）。 */
const TYPE_LABEL = {
  preference: '偏好',
  fact: '记得',
  commitment: '约定',
  relationship: '关系',
  event: '最近',
  self: '她自己',
  resonance: '留下的',
}

/** 纯函数：按字符数截断，超出以「…」结尾（maxChars 含省略号）。 */
function clipText(text, maxChars) {
  const s = String(text == null ? '' : text)
  const n = Number(maxChars)
  const max = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  if (!max) return ''
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + '…'
}

/**
 * 纯函数：把召回条目拼成给模型看的短卡。
 * 兼容 items 是字符串，或 `{ type, text }` 对象（桌宠 memory-vault 的形状）。
 * 去重、压掉多余空白、按 maxChars 截断。没有条目返回空串。
 *
 * @param {Array<string|{type?:string,text?:string}>} items
 * @param {number} [maxChars]
 * @returns {string}
 */
export function formatMemoryBrief(items, maxChars = DEFAULT_MAX_CHARS) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return ''
  const lines = []
  const seen = new Set()
  for (const item of list) {
    const rawText = typeof item === 'string'
      ? item
      : (item && typeof item.text === 'string' ? item.text : '')
    const text = String(rawText || '').replace(/\s+/g, ' ').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    const label = item && typeof item === 'object' && typeof item.type === 'string'
      ? (TYPE_LABEL[item.type] || '')
      : ''
    lines.push(label ? `- ${label}：${text}` : `- ${text}`)
  }
  if (!lines.length) return ''
  return clipText(lines.join('\n'), maxChars)
}

/** 校验数据源返回的形状：text 必须是字符串、items 必须是数组；否则视为拿不到。 */
function normalizeResult(raw, maxChars) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.ok === false) return null
  if (typeof raw.text !== 'string' || !Array.isArray(raw.items)) return null
  let text = raw.text.trim()
  // 服务没给 text 但给了结构化 items ⇒ 自己拼一份，别把可读记忆丢掉。
  if (!text && raw.items.length) text = formatMemoryBrief(raw.items, maxChars)
  return { ok: true, text: clipText(text, maxChars), items: raw.items }
}

/** ctx 服务可能是单个对象，也可能是数组；优先名称为 deskpet 的那个。 */
function pickService(raw) {
  const list = Array.isArray(raw) ? raw : [raw]
  const usable = list.filter((x) => x && typeof x.recall === 'function')
  if (!usable.length) return null
  return usable.find((x) => x.name === 'deskpet') || usable[0]
}

/**
 * 创建只读记忆桥。一个插件实例创建一次，不要在每次请求里 new。
 *
 * @param {object} [opts]
 * @param {any} [opts.ctx]      Cordis ctx（只用于 ctx.get('deskpetMemoryBrief')）
 * @param {(msg:string)=>void} [opts.log] 可选日志器（失败最多调用一次）
 * @param {string} [opts.baseUrl] HTTP 兜底地址（默认读 DSH_WEB_URL）
 * @returns {{recall:(query:string, opts?:{topK?:number,maxChars?:number})=>Promise<{ok:boolean,text:string,items:any[]}>}}
 */
export function createMemoryBridge({ ctx, log, baseUrl } = {}) {
  const base = String(baseUrl || process.env.DSH_WEB_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
  let warned = false
  /** 失败静默：整个 bridge 生命周期最多 log 一次，避免每次聊天刷日志。 */
  const warnOnce = (msg) => {
    if (warned) return
    warned = true
    try { if (typeof log === 'function') log(`桌宠记忆桥：${msg}`) } catch { /* 日志失败也不能影响回复 */ }
  }

  /** ② HTTP 兜底：1.5 秒超时，失败返回 null。 */
  const fromHttp = async (query, opts) => {
    const url = `${base}/api/deskpet/pet/memory/brief?q=${encodeURIComponent(query)}`
      + `&topK=${encodeURIComponent(String(opts.topK))}&maxChars=${encodeURIComponent(String(opts.maxChars))}`
    const controller = new AbortController()
    const timer = setTimeout(() => { try { controller.abort() } catch { /* 忽略 */ } }, HTTP_TIMEOUT_MS)
    try {
      const res = await globalThis.fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
      if (!res || !res.ok) {
        warnOnce(`HTTP ${res ? res.status : 'unavailable'}`)
        return null
      }
      const raw = await res.json()
      const out = normalizeResult(raw, opts.maxChars)
      if (!out) warnOnce('HTTP 返回形状不对')
      return out
    } catch (e) {
      // 只记错误类型，不带 URL / 消息正文 —— 查询词是主人的话，不能进日志。
      warnOnce(`HTTP 失败：${String(e?.name || 'error')}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    /**
     * 召回跟 query 有关的桌宠记忆。永不抛错；拿不到就是 ok:false + 空。
     * @param {string} query
     * @param {{topK?:number,maxChars?:number}} [opts]
     */
    async recall(query, opts = {}) {
      const q = String(query == null ? '' : query).trim()
      if (!q) return { ok: false, text: '', items: [] }

      const reqOpts = opts && typeof opts === 'object' ? opts : {}
      const topKNum = Number(reqOpts.topK)
      const maxCharsNum = Number(reqOpts.maxChars)
      const topK = Math.max(1, Math.min(20, Number.isFinite(topKNum) && topKNum > 0 ? Math.floor(topKNum) : DEFAULT_TOP_K))
      const maxChars = Math.max(40, Math.min(4000, Number.isFinite(maxCharsNum) && maxCharsNum > 0 ? Math.floor(maxCharsNum) : DEFAULT_MAX_CHARS))
      const safeOpts = { ...reqOpts, topK, maxChars }

      // ① 进程内服务优先。ctx.get 抛错 / 服务抛错 / 形状不对 ⇒ 都落到 HTTP。
      try {
        const raw = ctx && typeof ctx.get === 'function' ? ctx.get('deskpetMemoryBrief') : null
        const service = pickService(raw)
        if (service) {
          try {
            const out = normalizeResult(await service.recall(q, safeOpts), maxChars)
            if (out) return out
          } catch { /* 服务坏了不吭声，试 HTTP */ }
        }
      } catch { /* ctx 不可用不吭声，试 HTTP */ }

      // ② 本机 HTTP 兜底。
      const out = await fromHttp(q, safeOpts)
      if (out) return out

      // ③ 全失败：返回空，调用方按「没有记忆」正常聊。
      return { ok: false, text: '', items: [] }
    },
  }
}
