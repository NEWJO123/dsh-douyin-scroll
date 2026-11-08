/** Host-owned round records, validated result receipts and a daily first-source recommendation ledger. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readJson, dayKey } from './state.mjs'
import { reportPicks } from './run-status.mjs'

const validId = (id) => /^[a-zA-Z0-9-]{1,80}$/.test(String(id || ''))
const paths = (home, id) => {
  if (!validId(id)) throw new Error('无效的轮次 ID')
  return { record: join(home, 'runs', `${id}.json`), events: join(home, 'runs', `${id}.jsonl`), receipt: join(home, 'runs', `${id}.result.json`) }
}
const atomicJson = (file, data) => {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8'); renameSync(tmp, file)
}
export const safeLog = (text) => String(text || '')
  .replace(/(Cookie\s*:\s*)[^\r\n]+/gi, '$1[已脱敏]')
  .replace(/\b(sessionid(?:_ss)?|sid_guard|passport_csrf_token|ttwid|access_token|refresh_token|authorization|webhookurl|api[_-]?key|token|password|secret|cookie)["']?\s*[=:]\s*["']?[^\r\n;,"'}]+/gi, '$1=[已脱敏]')
  .replace(/https?:\/\/[^\s<>"']+/gi, (url) => {
    try { const u = new URL(url); return /(^|\.)douyin\.com$/.test(u.hostname) && /^\/(video|note)\/\d+\/?$/.test(u.pathname)
      ? `https://${u.hostname}${u.pathname}` : `${u.protocol}//${u.host}/[已脱敏]` } catch { return '[网址已脱敏]' }
  })
export function readRecord(home, id) { return validId(id) ? readJson(paths(home, id).record, null) : null }
export function writeRecord(home, round) { atomicJson(paths(home, round.id).record, round); return round }
export function recordEvent(home, id, event) {
  if (!readRecord(home, id)) return
  const out = { ...event, at: Date.now(), roundId: id, message: safeLog(event.message || ''), level: event.level || 'info' }
  appendFileSync(paths(home, id).events, JSON.stringify(out) + '\n', 'utf8')
}
export function roundEvents(home, id) {
  try { return readFileSync(paths(home, id).events, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { const e = JSON.parse(line); return e.roundId === id ? [e] : [] } catch { return [] }
  }) } catch { return [] }
}
const ledgerFile = (home) => join(home, 'recommendations.json')
const readLedger = (home) => readJson(ledgerFile(home), { version: 1, days: {} })
/**
 * ⭐ 2026-11-08（数据和展示分家）：计数**只信 ledger**（recommendations.json，
 * 由 submitRoundResult 的结构化 receipt 写入）。不再扫报告文本 —— 报告是给人看的，
 * 格式稍写歪数字就错（为此修过多次）。ledger 没有就是没挑过，不拿「报告里提到过」凑数。
 * 唯一例外是 importLegacyPicks：升级当天把旧版报告里已有的记录**显式**迁进来（named legacy）。
 */
export function recommendationCounts(home, day = dayKey()) {
  const ledger = readLedger(home)
  const picks = { ...(ledger.days?.[day] || {}) }
  const counts = { auto: 0, manual: 0, unknown: 0, total: 0 }
  for (const pick of Object.values(picks)) { counts[['auto', 'manual'].includes(pick.source) ? pick.source : 'unknown']++; counts.total++ }
  const state = readJson(join(home, 'state.json'), {})
  const legacy = state.day === day ? Number(state.picked) || 0 : 0
  if (legacy > counts.total) { counts.unknown += legacy - counts.total; counts.total = legacy }
  return counts
}
export function importLegacyPicks(home, day, text) {
  const ledger = readLedger(home); ledger.days ||= {}; ledger.days[day] ||= {}
  for (const pick of reportPicks(text)) if (!ledger.days[day][pick.id]) ledger.days[day][pick.id] = { ...pick, source: 'unknown' }
  atomicJson(ledgerFile(home), ledger)
}
export function dayRecommendations(home, day = dayKey()) {
  // ⭐ 2026-11-08：只回 ledger 里的（结构化 receipt）；报告是展示层，不再反向并入
  return [...Object.values(readLedger(home).days?.[day] || {})]
}
export function beginRound(home, { why, budget, day = dayKey(), reportBefore = '' }) {
  mkdirSync(join(home, 'runs'), { recursive: true })
  importLegacyPicks(home, day, reportBefore)
  const round = { id: randomUUID(), phase: 'preparing', startedAt: Date.now(), endedAt: 0,
    day, why, source: why === 'manual' ? 'manual' : 'auto', budget, ownerPid: process.pid, childPid: 0,
    reportBefore, candidates: [], warnings: [], result: null }
  writeRecord(home, round)
  recordEvent(home, round.id, { stage: 'starting', message: '正在准备本轮候选' })
  return round
}
/** Validate a structured per-round artifact; prose and process exits never count as this receipt. */
export function submitRoundResult(home, id, args = {}) {
  const round = readRecord(home, id)
  if (!round || !['preparing', 'running'].includes(round.phase)) return { ok: false, error: '这一轮已经结束或不存在' }
  if (!Array.isArray(args.picks)) return { ok: false, error: 'picks 必须是数组；没有推荐时传 []' }
  if (args.roundId && args.roundId !== id) return { ok: false, error: '结果不属于这一轮' }
  if (args.picks.some((p) => !p || typeof p !== 'object' || Array.isArray(p) || typeof p.id !== 'string')) return { ok: false, error: '每条推荐必须包含字符串作品 ID' }
  const picks = [...new Map(args.picks.map((p) => [String(p?.id || ''), p])).values()]
  if (picks.length > round.budget) return { ok: false, error: `本轮最多推荐 ${round.budget} 条` }
  const candidates = new Map((round.candidates || []).map((c) => [String(c.aweme_id), c]))
  if (picks.some((p) => !/^\d{15,25}$/.test(String(p.id)) || !candidates.has(String(p.id)))) return { ok: false, error: '推荐 ID 必须来自本轮候选证据包' }
  const old = readJson(paths(home, id).receipt, null)
  if (old) return JSON.stringify(old.picks.map((p) => p.id)) === JSON.stringify(picks.map((p) => p.id))
    ? { ok: true, duplicate: true, recommendations: old.picks.length }
    : { ok: false, error: '本轮结果已提交，不能再次改写' }
  const ledger = readLedger(home); ledger.days ||= {}; ledger.days[round.day] ||= {}
  const normalized = picks.map((p) => {
    const evidence = candidates.get(String(p.id))
    return { id: String(p.id), title: String(p.title || evidence.desc || '推荐内容').slice(0, 200),
      text: String(p.reason || p.text || '').slice(0, 4000), url: evidence.web_url || evidence.work_url || '',
      source: ledger.days[round.day][String(p.id)]?.source || round.source, roundId: id }
  })
  let added = 0
  for (const p of normalized) if (!ledger.days[round.day][p.id]) { ledger.days[round.day][p.id] = p; added++ }
  atomicJson(ledgerFile(home), ledger)
  atomicJson(paths(home, id).receipt, { roundId: id, submittedAt: Date.now(), picks: normalized, added })
  recordEvent(home, id, { stage: 'result', message: `本轮结果已记录：${normalized.length} 条推荐，其中新增 ${added} 条` })
  return { ok: true, recommendations: normalized.length, added }
}
export function finishRound(home, id, { code = null, signal = null, error = '', timedOut = false, reportText = '' } = {}) {
  const round = readRecord(home, id)
  if (!round || round.endedAt) return round
  const receipt = readJson(paths(home, id).receipt, null)
  const events = roundEvents(home, id)
  const sends = Object.fromEntries(['dm', 'card', 'comment'].map((key) => [key, { succeeded: 0, failed: 0, unknown: 0 }]))
  for (const e of events) if (e.stage === 'send' && sends[e.channel] && ['succeeded', 'failed', 'unknown'].includes(e.outcome)) sends[e.channel][e.outcome]++
  const observed = new Set(events.filter((e) => e.stage === 'send').map((e) => e.attemptId).filter(Boolean))
  for (const e of events) if (e.stage === 'send-start' && sends[e.channel] && !observed.has(e.attemptId)) sends[e.channel].unknown++
  const failed = Boolean(error || timedOut || signal || (code !== null && code !== 0))
  round.phase = failed ? 'failed' : receipt && code === 0 ? 'completed' : 'unknown'
  round.endedAt = Date.now(); round.exitCode = code; round.signal = signal
  round.reportText = reportText
  round.result = { validated: Boolean(receipt), recommendations: receipt?.added ?? 0, picks: receipt?.picks || [], reportUpdated: Boolean(reportText && reportText !== round.reportBefore), sends }
  if (error) round.warnings.push(safeLog(error))
  if (timedOut) round.warnings.push('本轮超时，未确认的发送不会自动重试')
  if (!receipt) round.warnings.push('尚未取得本轮完整结果，不能确认任务完成')
  writeRecord(home, round)
  recordEvent(home, id, { stage: 'ended', level: failed ? 'error' : round.phase === 'unknown' ? 'warning' : 'info', message: failed ? '本轮异常结束' : round.phase === 'completed' ? '本轮已完成' : '进程已退出，尚未确认完整结果' })
  return round
}
/** Observe actual tool return values, independently of model-written reports. */
const sendChannel = (name) => ({ douyin_dm: 'dm', douyin_share_card: 'card', douyin_comment_reply: 'comment', douyin_comment_mention: 'comment' })[name]
export function observeToolStart(home, id, name, args) {
  const channel = sendChannel(name)
  if (!id || !channel || args?.confirm !== true || args?.dry) return ''
  const attemptId = randomUUID()
  recordEvent(home, id, { stage: 'send-start', attemptId, channel, message: '已收到确认，正在调用发送器' })
  return attemptId
}
export function observeToolResult(home, id, name, args, result, attemptId = '') {
  if (!id || args?.confirm !== true || args?.dry || result?.needsConfirm) return
  const channel = sendChannel(name)
  if (!channel) return
  if (result?.duplicate || result?.busy) {
    recordEvent(home, id, { stage: 'send', attemptId, channel, outcome: 'skipped', message: '重复发送已拦下，未再次调用发送器' })
    return
  }
  const emit = (kind, r) => {
    const succeeded = r?.sent === true || typeof r?.sent === 'number' && r.sent > 0 || kind === 'comment' && r?.ok && Boolean(r.cid || r.mention_verified || name === 'douyin_comment_mention')
    const uncertain = r?.outcome_unknown || r?.uncertain || kind === 'dm' && r?.readback === false && r?.clicked
    const outcome = uncertain ? 'unknown' : succeeded ? 'succeeded' : r?.sent === undefined ? 'unknown' : 'failed'
    const misplaced = kind === 'comment' && r?.placement?.ok === false
    recordEvent(home, id, { stage: 'send', attemptId, channel: kind, outcome, level: outcome === 'succeeded' && !misplaced ? 'info' : 'warning',
      message: misplaced ? '评论已发布，但回复位置与预期不符，请先核实，勿重复发送'
        : `${kind === 'dm' ? '私信' : kind === 'card' ? '分享卡片' : '评论'}：${outcome === 'succeeded' ? '已取得发送回执' : outcome === 'failed' ? '未发送成功' : '发送结果未确认'}` })
  }
  if (channel === 'card' && Array.isArray(result?.results)) {
    for (const r of result.results) emit('card', r)
    if (result.reason) emit('dm', result.reason)
  } else emit(channel, result)
}
export function pidAlive(pid) { if (!Number.isInteger(Number(pid)) || Number(pid) < 1) return false
  try { process.kill(Number(pid), 0); return true } catch (e) { return e?.code === 'EPERM' } }
export function roundIsBusy(state) {
  if (!state?.roundActive) return false
  // Missing/uncertain ownership must not silently permit a duplicate run.
  return !state.ownerPid && !state.childPid || pidAlive(state.childPid) || pidAlive(state.ownerPid)
}
