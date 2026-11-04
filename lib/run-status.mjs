/**
 * 设置页的只读数据整理：从本轮日志、证据和日报提取运行状态及推荐列表。
 * 只负责展示，不清理运行标记，也不修改任务、额度或发送行为。
 */
import { openSync, readSync, closeSync, fstatSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readRecord, roundEvents, recommendationCounts, safeLog } from './run-record.mjs'

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return {} } }
const reportInfo = (file) => {
  try { const stat = statSync(file); return { exists: true, updatedAt: stat.mtimeMs, stamp: `${stat.mtimeMs}:${stat.size}` } }
  catch { return { exists: false, updatedAt: 0, stamp: '' } }
}
const readTail = (file) => {
  let fd
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    const bytes = Buffer.alloc(Math.min(size, 128 * 1024))
    readSync(fd, bytes, 0, bytes.length, size - bytes.length)
    return bytes.toString('utf8')
  } catch { return '' }
  finally { if (fd !== undefined) closeSync(fd) }
}

export function summarizeRun(state, evidence, log, report, now = Date.now()) {
  const started = Date.parse(state.lastRunAt) || 0
  const out = { phase: started ? 'unknown' : 'idle', startedAt: started, endedAt: 0,
    activityAt: started, candidates: null, commentsMissing: false, reportUpdated: false }
  if (!started) return out
  let failed = false
  // Only fixed host messages from this round count. Model prose and cleared flags do not prove completion.
  for (const line of log.split(/\r?\n/)) {
    const match = /^(\d{4}-\d\d-\d\dT\S+)  (.*)$/.exec(line)
    if (!match) continue
    const at = Date.parse(match[1])
    if (!at || at < started) continue
    const message = match[2]
    if (/^证据包已备好：/.test(message)) out.phase = 'preparing'
    else if (/^刷抖音开跑（/.test(message)) out.phase = 'running'
    else if (/^刷抖音结束（/.test(message)) {
      out.phase = !failed && /，code=0）$/.test(message) ? 'unknown' : 'failed'
      out.endedAt = at
    } else if (/^刷抖音(?:开跑失败|起不来)(?:（|：)|^⚠️ 这一轮超过 \d+ 分钟没结束/.test(message)) {
      failed = true
      out.phase = 'failed'
      out.endedAt = at
    } else continue
    out.activityAt = at
  }
  if (out.phase === 'unknown' && state.roundActive) out.phase = 'preparing'
  // The existing watchdog is capped at 120 minutes. An older start alone cannot prove a live task.
  if (['preparing', 'running'].includes(out.phase) && now - out.activityAt > 120 * 60_000) out.phase = 'unknown'
  // Evidence left over from an earlier round must not be attributed to this one.
  const built = Date.parse(evidence.builtAt) || 0
  if (built >= started && (!out.endedAt || built <= out.endedAt)) {
    const list = Array.isArray(evidence.list) ? evidence.list : []
    out.candidates = list.length
    out.commentsMissing = list.slice(0, 5).some((item) => Number(item.comment) > 0 && !item.top_comments?.length)
  }
  out.reportUpdated = Boolean(report.exists && report.updatedAt >= started)
  return out
}

export function readRunProgress(home, today) {
  const state = readJson(join(home, 'state.json'))
  const started = Date.parse(state.lastRunAt)
  const roundDay = Number.isFinite(started)
    ? `${new Date(started).getFullYear()}-${String(new Date(started).getMonth() + 1).padStart(2, '0')}-${String(new Date(started).getDate()).padStart(2, '0')}` : today
  const report = reportInfo(join(home, 'out', `${today}.md`))
  const log = readTail(join(home, 'duty.log.1')) + '\n' + readTail(join(home, 'duty.log'))
  const record = readRecord(home, state.roundId)
  let round = record ? { ...record } : summarizeRun(state, readJson(join(home, 'round-evidence.json')), log,
    roundDay === today ? report : reportInfo(join(home, 'out', `${roundDay}.md`)))
  if (record) {
    const events = roundEvents(home, record.id)
    round.events = events
    round.activityAt = events.at(-1)?.at || record.startedAt
    round.warnings = [...new Set([...(record.warnings || []), ...events.filter((e) => e.level === 'warning' || e.level === 'error').map((e) => e.message)])]
    round.commentsMissing = events.some((e) => e.stage === 'comments' && e.level === 'warning')
    round.candidates = record.candidates?.length ?? null
    round.reportUpdated = Boolean(record.result?.reportUpdated)
    if (!state.roundActive && !record.endedAt) {
      round.phase = 'unknown'
      round.warnings.push('未取得本轮完整结束状态')
    }
    delete round.reportBefore; delete round.reportText; delete round.ownerPid; delete round.childPid
  }
  round.events ||= []
  round.warnings ||= round.commentsMissing ? ['本轮部分评论未读取到'] : []
  let reportText = ''
  try { reportText = readFileSync(join(home, 'out', `${today}.md`), 'utf8') } catch { /* no report */ }
  return { round, report, tail: safeLog(log.slice(-8000)), counts: recommendationCounts(home, today, reportText), resultRoundId: state.lastResultRoundId || '' }
}

/** Same numeric-heading / unique-ID convention as the existing daily quota counter. */
export function reportPicks(text) {
  const picks = new Map()
  let current = null
  const clean = String(text || '').replace(/```[\s\S]*?```/g, '')
  for (const line of clean.split(/\r?\n/)) {
    const heading = /^#{2,3}[ \t]*(\d{15,25})(.*)$/.exec(line)
    if (heading) {
      current = { id: heading[1], heading: heading[2].trim(), lines: [] }
      picks.set(current.id, current)
    } else if (/^#{1,3}\s/.test(line)) current = null
    else if (current) current.lines.push(line)
  }
  const plain = (value) => value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').replace(/^\s*[-#>]+\s*/gm, '').trim()
  return [...picks.values()].map((pick) => {
    const raw = `${pick.heading}\n${pick.lines.join('\n')}`
    const link = [...raw.matchAll(/https:\/\/(?:www\.)?douyin\.com\/(note|video)\/(\d{15,25})(?=[/?#\s)\]>]|$)/g)]
      .find((match) => match[2] === pick.id)
    const text = plain(pick.lines.join('\n'))
    const first = text.split('\n').find((line) => line.trim() && !/^https?:\/\//.test(line.trim())) || ''
    return { id: pick.id, title: plain(pick.heading).replace(/^[-—:：\s]+/, '') || first.slice(0, 90) || '推荐视频', text,
      ...(link ? { url: `https://www.douyin.com/${link[1]}/${pick.id}` } : {}) }
  })
}
