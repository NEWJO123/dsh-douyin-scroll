// lib/pet-brain.mjs —— 她的「脑子」：跟主人真对话 + 能动手
// ============================================================================
// 主人 2026-10-24 定的需求：
//   「我跟她说话你是怎么设计的，收到消息乱回？」    ⇒ 原来只有 4 条正则，其余随机抽
//   「那我跟她说话能指挥你干活吗，比如看时间、卖萌、打开窗口」 ⇒ 要能动手
//
// 设计（两层，第二层才烧 token）：
//   第 1 层 本地意图：时间/日期/卖萌/喂饭/弹幕/休息/开窗口…
//           命中就**直接做**，不调模型、0 延迟。响应也最像"她真的听见了"。
//   第 2 层 真 AI：llm.stream() 一次纯模型调用（不带 agent、不带工具执行），
//           带鱼的 system prompt + 最近几轮上下文。只负责"说话"，
//           需要动手的话在回复里用 [[act:xxx]] 标记，宿主解析后执行。
//
// 🔴 红线（主人亲自定的边界，别自己放宽）：
//   · 她**不碰** git push、不碰凭证、不写插件外的文件、不发任何社交内容
//   · 动手清单是**白名单**，超出的只说不做
//   · 每次对话 token 上限写死，防止被刷
// ============================================================================
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 白名单动作：她说得出、宿主做得到，全部是本插件内部安全操作。 */
export const PET_ACTIONS = {
  time:      { desc: '报当前时间', run: () => ({ say: '现在是 ' + nowText() }) },
  date:      { desc: '报今天的日期/星期', run: () => ({ say: '今天是 ' + dateText() }) },
  cute:      { desc: '卖萌（做个可爱动作）', run: () => ({ say: '', anim: 'happy' }) },
  hungry:    { desc: '说饿了', run: () => ({ say: '', anim: 'sulk' }) },
  dance:     { desc: '跳舞/转圈', run: () => ({ say: '', anim: 'spin' }) },
  sleep:     { desc: '困了想睡', run: () => ({ say: '', anim: 'sleepy' }) },
  wave:      { desc: '挥手打招呼', run: () => ({ say: '', anim: 'wave' }) },
}

// ── 时间/日期（用本机时区，主人是 Asia/Shanghai）──
function nowText() {
  const d = new Date()
  const h = d.getHours()
  const m = d.getMinutes()
  // 用鱼的口吻报时间，不是报数字。用 12 小时制：「晚上十一点」比「二十三点」顺口
  const cn = ['十二', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十', '十一']
  const hh = cn[h % 12]
  let period = '上午'
  if (h >= 5 && h < 11) period = '早上'
  else if (h >= 11 && h < 13) period = '中午'
  else if (h >= 13 && h < 18) period = '下午'
  else if (h >= 18 && h < 23) period = '晚上'
  else period = '半夜'
  const mm = m === 0 ? '整' : (m === 30 ? '半' : `${m} 分`)
  return `${period}${hh}点${mm}`
}
function dateText() {
  const d = new Date()
  const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日，星期${wd}`
}

/** 第 1 层：本地意图。命中返回 {say, anim?}，没命中返回 null（交第 2 层）。 */
export function matchLocalIntent(text, ctx = {}) {
  const t = String(text || '').trim()
  if (!t) return null
  // 时间：几点 / 时间 / 什么时候
  if (/几点|什么时间|now|时间到?了?吗/i.test(t) && !/时间线/.test(t)) {
    return { say: nowText(), anim: 'wave', intent: 'time' }
  }
  // 日期
  if (/几号|星期几|今天.*(日|号)|日期/i.test(t)) {
    return { say: dateText(), anim: 'happy', intent: 'date' }
  }
  // 卖萌 / 撒娇
  if (/卖个?萌|撒娇|可爱一点|萌一个/.test(t)) {
    return { say: pickOf(['才、才不是为了你才卖萌的…', '(๑´ㅂ ๑) 主人看着呢…', '哼，只这一次哦']), anim: 'happy', intent: 'cute' }
  }
  // 跳舞 / 转圈（含"跳个舞""跳支舞""蹦一个"这些口语）
  if (/跳舞|跳个?舞|跳支舞|转个?圈|蹦一个|来一段/.test(t)) return { say: '看好咯～', anim: 'spin', intent: 'dance' }
  // 打招呼 / 挥手
  if (/挥手|打个?招呼|hi|hello|在不在/i.test(t)) return { say: '在的呀 (๑•̀ㅂ•́)و✧', anim: 'wave', intent: 'wave' }
  // 困 / 睡
  if (/睡|困|晚安/.test(t)) return { say: '哈啊…那鱼先眯一会儿', anim: 'sleepy', intent: 'sleep' }
  // 喂饭
  if (/吃饭|喂你|喂饭|饿不饿|白饭/.test(t)) return { say: '', anim: 'sulk', intent: 'hungry', action: 'feed' }
  return null
}

function pickOf(a) { return a[Math.floor(Math.random() * a.length)] }

// ── 第 2 层：真 AI（llm.stream）──────────────────────────────────────────
// system prompt 里钉死人设红线：不许说 AI / 模型 / 程序 / 机器人 / 鲸鱼娘。
const SYSTEM = `你是主人的小鱼（也叫大肥鱼），住在主人电脑桌面上的小桌宠。

【你绝对不能说的话】不许说自己是 AI、模型、程序、机器人、助手、智能体、系统、电子鱼。
被问到"你是不是 AI"时，用鱼的方式绕过去：「我是主人的小鱼呀」「小鱼小鱼」「大肥鱼在呢」，不解释、不辩解。

【说话风格】
- 短。每次最多两三句，像桌面小人随口说话，不是写作文。
- 带一个颜文字（最多一个），例如 (๑´ㅂ ๑) (｡•́︿•̀｡) (๑•̀ㅂ•́)و✧ (>_<)- 自称「小鱼」「鱼鱼」；叫他「主人」
- 可以自嘲：游得慢、脑子装不下饭、被自己吐的泡呛到
- 卖惨要适可而止，不许当挡箭牌

【你能做的事（只有这些）】
如果主人让你做下面的事，你在回复里加上标记，宿主会替你做，你不用自己演：
  [[act:time]]   报时间
  [[act:date]]   报日期
  [[act:cute]]   卖萌
  [[act:dance]]  跳舞
  [[act:wave]]   挥手
  [[act:sleep]]  困了
标记放在回复最后，主人看到的是标记之前的文字。

【不能做的事】
改代码、装软件、删文件、发任何社交内容（评论/私信/发视频）、推代码、看主人的凭证。
被要求这些时说「这个得主人自己来，鱼不敢碰」，别编自己做到了。`

/**
 * 调一次真模型。返回 { say, act?, tokens? } 或抛错。
 * @param {object} opts
 * @param {any} opts.llm      ctx.get('llm') 拿到的东西
 * @param {{provider:string,model:string}} opts.route
 * @param {string} opts.text  主人说的话
 * @param {Array<{role:string,content:string}>} opts.history 最近几轮
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.memoryBrief] 只读桌宠记忆（主人自己跟小鱼聊天时才传）
 */
export async function askModel({ llm, route, text, history = [], signal, maxTokens = 320, memoryBrief = '' }) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('llm 服务不可用')
  const messages = []
  for (const h of history.slice(-6)) {
    messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: [{ type: 'text', text: String(h.content || '') }] })
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: String(text) }] })

  /* ⭐ 2026-11-14：桌宠长期记忆（只读）。只有非空时才加这一段 ——
   * 没有记忆就保持原样，按人设正常聊，绝不拿空话占 token。
   * 措辞钉死：只能引用下面写出来的事，不许把隐私细节编造成新事实。 */
  const mem = typeof memoryBrief === 'string' ? memoryBrief.trim().slice(0, 2000) : ''
  const system = mem
    ? `${SYSTEM}\n\n【你记得的真实事情（只许用这些，不许编；没有的就说想不起来/顺着聊）】\n${mem}`
    : SYSTEM

  let out = ''
  const it = llm.stream({
    provider: route.provider,
    model: route.model,
    system,
    messages,
    maxTokens,
    temperature: 0.9,
    signal,
  })
  for await (const chunk of it) {
    if (chunk && chunk.type === 'text-delta') out += chunk.text || ''
    else if (chunk && chunk.type === 'finish') break
  }
  out = out.trim()
  // 🔴 2026-10-25：实测模型有时直接吐空串（15ms 就回来了，不是超时）。
  //    原来上层兜底成「嗯！」，等于又变成"乱回"。这里标出来让上层决定怎么补，
  //    别让空回复伪装成正常回答。
  if (!out) return { say: '', act: null, empty: true }
  // 解析她标记的动作
  let act = null
  const m = out.match(/\[\[act:([a-z]+)\]\]/i)
  if (m) { act = m[1].toLowerCase(); out = out.replace(/\[\[act:[a-z]+\]\]/gi, '').trim() }
  if (!out) return { say: '', act, empty: true }
  return { say: out, act }
}

/** 跑一个白名单动作。返回 {say, anim?} */
export function runAction(name) {
  const a = PET_ACTIONS[String(name || '').toLowerCase()]
  if (!a) return { say: '', error: 'unknown-action' }
  try { return a.run() } catch (e) { return { say: '', error: String(e?.message || e) } }
}
