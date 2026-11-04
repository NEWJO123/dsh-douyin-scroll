/** Shared confirmation, cross-process duplicate guard and honest native comment outcomes. */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readJson } from './state.mjs'

export function commentOutcome(result = {}) {
  const accepted = result.ok === true && Boolean(result.cid || result.mode === 'ui' && result.mention_verified)
  const misplaced = result.placement?.ok === false
  const knownFailure = result.attempted === false || result.need_root || result.rate_limited || result.http === 403
    || Number(result.status_code) > 0 || result.unsupported || result.needsConfirm || result.wait_sec
  const uncertain = Boolean(result.outcome_unknown || result.uncertain || accepted && result.placement?.verified === false
    || !accepted && !knownFailure && result.attempted !== false)
  return { ...result, ok: accepted && !misplaced, sent: accepted, uncertain,
    ...(misplaced ? { error: result.placement.warn || '评论已发布，但没有回复到原评论下，请先核实，勿重复发送' } : {}) }
}

export function createCommentSender({ home, execute }) {
  return async (args = {}) => {
    // Drafts and invalid inputs never create a send reservation.
    if (args.confirm !== true || !String(args.aweme_id || '').trim() || !String(args.text || '').trim()
      || String(args.text).trim().length > 500) return execute(args)
    const key = createHash('sha256').update(JSON.stringify([
      String(args.aweme_id), String(args.comment_id || ''), String(args.root_comment_id || ''),
      String(args.mode || 'api'), String(args.text).trim(), String(args.mention_name || ''),
    ])).digest('hex')
    const dir = join(home, 'comment-sends'); mkdirSync(dir, { recursive: true })
    const file = join(dir, `${key}.json`)
    const previous = readJson(file, null)
    if (previous?.phase === 'finished' && previous.result?.sent) return { ...previous.result, duplicate: true }
    if (previous && previous.phase !== 'failed') return { ok: false, sent: false, uncertain: previous.phase === 'uncertain',
      duplicate: true, busy: previous.phase === 'sending', error: previous.phase === 'sending'
        ? '这条回复正在发送或尚未取得最终状态，请先核实，勿重复发送' : '上次发送结果尚未确认，请先在抖音核实，勿重复发送' }
    try {
      // A rejected, verified no-send attempt can be explicitly retried; an in-flight file cannot.
      writeFileSync(file + '.lock', '', { flag: 'wx' })
      const latest = readJson(file, null)
      if (latest && latest.phase !== 'failed') {
        rmSync(file + '.lock', { force: true })
        return latest.result?.sent ? { ...latest.result, duplicate: true }
          : { ok: false, sent: false, duplicate: true, uncertain: true, error: '该回复已有发送记录，请先核实，勿重复发送' }
      }
      writeFileSync(file, JSON.stringify({ phase: 'sending', at: Date.now() }), 'utf8')
    } catch { return { ok: false, sent: false, busy: true, duplicate: true, error: '这条回复已经在发送，请勿重复点击' } }
    let result
    try { result = commentOutcome(await execute(args)) }
    catch (e) { result = { ok: false, sent: false, uncertain: true, error: String(e?.message || e) } }
    const phase = result.sent ? 'finished' : result.uncertain ? 'uncertain' : 'failed'
    writeFileSync(file, JSON.stringify({ phase, at: Date.now(), result }), 'utf8')
    rmSync(file + '.lock', { force: true })
    return result
  }
}
