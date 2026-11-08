/** Offline regression tests for quota sources, host round receipts, schedules and reply deduplication. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beginRound, submitRoundResult, recommendationCounts, finishRound, writeRecord,
  readRecord, observeToolStart, observeToolResult, roundEvents, safeLog, roundIsBusy } from '../lib/run-record.mjs'
import { readRunProgress } from '../lib/run-status.mjs'
import { configuredWindows, autoEnabled, scheduledWindows, schedulePatchError, remapUsedWindows } from '../lib/schedule.mjs'
import { createCommentSender, commentOutcome } from '../lib/comment-send.mjs'

const ID = '7000000000000000001', OTHER = '7000000000000000002', THIRD = '7000000000000000003'
const DAY = '2026-11-02'
const testRoot = dirname(fileURLToPath(import.meta.url))
const withHome = async (fn) => {
  const home = mkdtempSync(join(testRoot, '.douyin-settings-test-'))
  try { return await fn(home) } finally {
    assert.equal(dirname(resolve(home)), resolve(testRoot)); assert.ok(basename(home).startsWith('.douyin-settings-test-'))
    rmSync(home, { recursive: true, force: true })
  }
}
function prepared(home, source, ids, reportBefore = '') {
  const round = beginRound(home, { why: source, budget: 3, day: DAY, reportBefore })
  round.candidates = ids.map((id) => ({ aweme_id: id, desc: 'fixture', web_url: `https://www.douyin.com/note/${id}` }))
  round.phase = 'running'; writeRecord(home, round)
  return round
}
test('daily ledger deduplicates first source and preserves unknown legacy history', () => withHome((home) => {
  const first = prepared(home, 'manual', [ID, OTHER], `### ${ID}\nlegacy`)
  assert.equal(submitRoundResult(home, first.id, { picks: [{ id: ID }, { id: OTHER }] }).added, 1)
  finishRound(home, first.id, { code: 0 })
  const auto = prepared(home, 'window:noon', [OTHER, THIRD])
  assert.equal(submitRoundResult(home, auto.id, { picks: [{ id: OTHER }, { id: THIRD }] }).added, 1)
  assert.deepEqual(recommendationCounts(home, DAY), { auto: 1, manual: 1, unknown: 1, total: 3 })
  // ⭐ 2026-11-08：计数只信 ledger —— 传报告文本不再被接受（签名里根本没有这个参数了）
  assert.deepEqual(recommendationCounts(home, DAY), { auto: 1, manual: 1, unknown: 1, total: 3 })
  writeFileSync(join(home, 'state.json'), JSON.stringify({ day: DAY, picked: 5 }))
  assert.deepEqual(recommendationCounts(home, DAY), { auto: 1, manual: 1, unknown: 3, total: 5 })
}))
test('result receipts reject stale rounds, unknown candidates, invalid schema and budget overflow', () => withHome((home) => {
  const round = prepared(home, 'manual', [ID]); round.budget = 0; writeRecord(home, round)
  assert.equal(submitRoundResult(home, round.id, { picks: [{ id: ID }] }).ok, false)
  round.budget = 3; writeRecord(home, round)
  for (const picks of [[null], [{ id: 123 }], [{ id: OTHER }]]) assert.equal(submitRoundResult(home, round.id, { picks }).ok, false)
  assert.equal(submitRoundResult(home, round.id, { roundId: 'old', picks: [] }).ok, false)
  assert.equal(submitRoundResult(home, round.id, { picks: [{ id: ID }] }).ok, true)
  assert.equal(submitRoundResult(home, round.id, { picks: [{ id: ID }] }).duplicate, true)
  assert.equal(submitRoundResult(home, round.id, { picks: [] }).ok, false)
  finishRound(home, round.id, { code: 0 })
  assert.equal(submitRoundResult(home, round.id, { picks: [] }).ok, false)
}))
test('zero recommendations and report off still complete only with valid structured receipt', () => withHome((home) => {
  const noResult = prepared(home, 'manual', [])
  assert.equal(finishRound(home, noResult.id, { code: 0, reportText: '# report exists' }).phase, 'unknown')
  const complete = prepared(home, 'manual', [])
  submitRoundResult(home, complete.id, { picks: [] })
  const result = finishRound(home, complete.id, { code: 0 })
  assert.equal(result.phase, 'completed'); assert.equal(result.result.reportUpdated, false)
  assert.equal(result.result.recommendations, 0)
  const timedOut = prepared(home, 'manual', [])
  submitRoundResult(home, timedOut.id, { picks: [] })
  assert.equal(finishRound(home, timedOut.id, { code: 0, timedOut: true }).phase, 'failed')
  const fail = prepared(home, 'manual', [])
  assert.equal(finishRound(home, fail.id, { code: null, error: 'ENOENT' }).phase, 'failed')
}))
test('actual send receipts remain independent of model report and process exit', () => withHome((home) => {
  const round = prepared(home, 'manual', [])
  observeToolResult(home, round.id, 'douyin_dm', { confirm: false }, { sent: true })
  observeToolResult(home, round.id, 'douyin_share_card', { confirm: true }, { results: [{ sent: true }, { sent: false }], reason: { sent: true } })
  observeToolResult(home, round.id, 'douyin_comment_reply', { confirm: true }, { ok: false, outcome_unknown: true })
  observeToolStart(home, round.id, 'douyin_dm', { confirm: true }) // Process interrupted before receipt.
  const duplicateAttempt = observeToolStart(home, round.id, 'douyin_comment_reply', { confirm: true })
  observeToolResult(home, round.id, 'douyin_comment_reply', { confirm: true }, { ok: true, sent: true, duplicate: true }, duplicateAttempt)
  submitRoundResult(home, round.id, { picks: [] })
  const result = finishRound(home, round.id, { code: 0, reportText: 'All messages sent, claims model' })
  assert.deepEqual(result.result.sends, { dm: { succeeded: 1, failed: 0, unknown: 1 }, card: { succeeded: 1, failed: 1, unknown: 0 }, comment: { succeeded: 0, failed: 0, unknown: 1 } })
  writeFileSync(join(home, 'state.json'), JSON.stringify({ roundId: round.id, lastRunAt: new Date(round.startedAt).toISOString() }))
  const progress = readRunProgress(home, DAY)
  assert.equal(progress.round.phase, 'completed'); assert.ok(progress.round.events.length)
  assert.equal(progress.round.result.sends.comment.unknown, 1)
  assert.equal(roundEvents(home, round.id).filter((e) => e.stage === 'send').length, 5)
}))
test('process ownership does not unlock merely because a round is old or reloaded', () => {
  assert.equal(roundIsBusy({ roundActive: true, ownerPid: process.pid, dutyRunningAt: 1 }), true)
  assert.equal(roundIsBusy({ roundActive: true }), true)
  assert.equal(roundIsBusy({ roundActive: true, ownerPid: -99, childPid: -99 }), false)
  assert.equal(roundIsBusy({ roundActive: false, ownerPid: process.pid }), false)
})
test('weekday schedules preserve windows and crossing midnight uses start date once', () => {
  const cfg = { perDay: 5, noon: true, night: false, scheduleDays: [1, 3, 5], windows: [{ start: '23:00', end: '02:00', label: 'custom' }] }
  assert.equal(autoEnabled(cfg), true); assert.equal(autoEnabled({ ...cfg, perDay: 0 }), false)
  assert.equal(autoEnabled({ ...cfg, autoEnabled: false }), false)
  assert.equal(configuredWindows(cfg).length, 2)
  const monday = new Date(2026, 10, 2, 23, 30)
  const first = scheduledWindows(cfg, monday).find((w) => w.active)
  assert.equal(first.key, '2026-11-02:custom:0')
  const afterMidnight = scheduledWindows(cfg, new Date(2026, 10, 3, 1, 0)).find((w) => w.active)
  assert.equal(afterMidnight.key, first.key)
  assert.equal(scheduledWindows(cfg, new Date(2026, 10, 3, 1), { [first.key]: true }).some((w) => w.active), false)
  assert.equal(scheduledWindows({ ...cfg, scheduleDays: [] }, monday).length, 0)
  assert.equal(configuredWindows({ noon: false, night: false, windows: [] }).length, 0)
})
test('schedule edits reject invalid times and conflicting intervals but allow touching endpoints', () => {
  const cfg = { autoEnabled: true, perDay: 5, noon: true, night: false, scheduleDays: [1], windows: [] }
  for (const [start, end] of [['24:00', '01:00'], ['12:60', '14:00'], ['9:00', '09:00'], ['', '14:00']]) {
    assert.ok(schedulePatchError(cfg, { windows: [{ start, end }] }), `${start}–${end}`)
  }
  assert.ok(schedulePatchError(cfg, { windows: [{ start: '13:00', end: '15:00' }] }))
  assert.ok(schedulePatchError(cfg, { windows: [{ start: '12:00', end: '14:00' }] }))
  assert.equal(schedulePatchError(cfg, { windows: [{ start: '14:00', end: '16:00' }] }), '')
  assert.equal(schedulePatchError(cfg, { noon: false, windows: [{ start: '9:00', end: '10:00' }] }), '')
  assert.equal(schedulePatchError(cfg, { scheduleDays: [], windows: [] }), '')
  for (const patch of [{ windows: null }, { windows: [null] }, { scheduleDays: [7] }, { scheduleDays: 'Monday' }, { noon: 'true' }, { autoEnabled: 1 }]) {
    assert.ok(schedulePatchError(cfg, patch))
  }
})
test('overnight conflict checks use actual selected start weekdays, including the week boundary', () => {
  const cfg = { autoEnabled: true, noon: false, night: false, scheduleDays: [0],
    windows: [{ start: '23:00', end: '02:00' }, { start: '01:00', end: '03:00' }] }
  assert.equal(schedulePatchError(cfg, { scheduleDays: [0] }), '', 'Sunday morning precedes Sunday night')
  assert.ok(schedulePatchError(cfg, { scheduleDays: [0, 1] }), 'Sunday night overlaps Monday morning')
  assert.equal(schedulePatchError(cfg, { windows: [{ start: '23:00', end: '02:00' }, { start: '02:00', end: '03:00' }], scheduleDays: [0, 1] }), '')
  assert.equal(schedulePatchError(cfg, { scheduleDays: [] }), '')
})
test('legacy bad schedules can be paused or preserved by unrelated settings, never enabled without correction', () => {
  const cfg = { autoEnabled: true, noon: false, night: false, scheduleDays: [1], windows: [{ start: '25:00', end: '26:00' }] }
  assert.equal(schedulePatchError(cfg, { autoEnabled: false }), '')
  assert.equal(schedulePatchError(cfg, { keywords: ['fixture'] }), '')
  assert.ok(schedulePatchError(cfg, { autoEnabled: true }))
  assert.ok(schedulePatchError(cfg, { scheduleDays: [1, 2] }))
})
test('consumed preset and reordered custom intervals cannot replay after saving a plan', () => {
  const now = new Date(2026, 10, 2, 12, 30)
  const before = { autoEnabled: true, perDay: 5, noon: true, night: false, scheduleDays: [1], windows: [{ start: '10:00', end: '11:00' }] }
  const after = { ...before, noon: false, windows: [{ start: '12:00', end: '14:00' }] }
  const used = { '2026-11-02:noon': true, '2026-10-30:custom:0': true }
  const remapped = remapUsedWindows(before, after, used, now)
  assert.equal(remapped['2026-11-02:custom:0'], true)
  assert.equal(remapped['2026-11-02:noon'], true)
  assert.equal(remapped['2026-10-30:custom:0'], true)
  assert.equal(scheduledWindows(after, now, remapped).some((w) => w.active), false)
  const reordered = { ...before, windows: [{ start: '15:00', end: '16:00' }, { start: '10:00', end: '11:00' }] }
  const shifted = remapUsedWindows(before, reordered, { '2026-11-02:custom:0': true }, now)
  assert.equal(shifted['2026-11-02:custom:1'], true)
  assert.equal(shifted['2026-11-02:custom:0'], true, 'old index remains conservative until the next date')
  assert.equal(used['2026-11-02:custom:0'], undefined, 'does not mutate input state')
})
test('replacing an already consumed overnight preset defers only new ranges and preserves other rows', () => {
  const before = { autoEnabled: true, perDay: 5, noon: true, night: true, scheduleDays: [1], windows: [{ start: '14:00', end: '15:00' }] }
  const after = { ...before, night: false, windows: [...before.windows, { start: '19:00', end: '08:00' }] }
  const now = new Date(2026, 10, 3, 1)
  const used = remapUsedWindows(before, after, { '2026-11-02:night': true }, now)
  assert.equal(used['2026-11-02:custom:1'], true)
  assert.equal(used['2026-11-02:custom:0'], undefined)
  assert.equal(used['2026-11-02:noon'], undefined)
  assert.equal(scheduledWindows(after, now, used).some((w) => w.active), false)
  assert.equal(scheduledWindows({ ...after, autoEnabled: false }, now, used).length, 0)
})
test('reply sender has an explicit confirmation gate and preserves exact original routing', () => withHome(async (home) => {
  let sent = 0, target
  const sender = createCommentSender({ home, execute: async (args) => {
    if (args.confirm !== true) return { ok: true, sent: false, needsConfirm: true, draft: args.text }
    sent++; target = args
    return { ok: true, cid: THIRD, placement: { verified: true, ok: true } }
  } })
  const args = { aweme_id: ID, comment_id: OTHER, root_comment_id: THIRD, work_url: `https://www.douyin.com/note/${ID}`, aweme_type: 0, text: 'fixture' }
  assert.equal((await sender(args)).needsConfirm, true); assert.deepEqual(readdirSync(home), [])
  const result = await sender({ ...args, confirm: true, autoSend: false, autoComment: false })
  assert.equal(result.sent, true); assert.equal(sent, 1); assert.equal(target.root_comment_id, THIRD); assert.equal(target.aweme_type, 0)
  assert.equal(target.work_url, args.work_url)
  assert.equal((await sender({ ...args, confirm: true })).duplicate, true); assert.equal(sent, 1)
}))
test('concurrent and uncertain replies cannot silently resend; misplaced replies stay distinct', () => withHome(async (home) => {
  let resolveSend, sent = 0
  const sender = createCommentSender({ home, execute: async () => { sent++; return new Promise((r) => { resolveSend = r }) } })
  const args = { aweme_id: ID, comment_id: OTHER, text: 'offline', confirm: true }
  const pending = sender(args)
  assert.equal((await sender(args)).busy, true)
  resolveSend({ ok: false, outcome_unknown: true })
  assert.equal((await pending).uncertain, true)
  assert.equal((await sender(args)).duplicate, true); assert.equal(sent, 1)
  const wrong = commentOutcome({ ok: true, cid: THIRD, placement: { verified: true, ok: false } })
  assert.equal(wrong.sent, true); assert.equal(wrong.ok, false)
}))
test('raw copied records redact credentials and sensitive URL paths', () => {
  const text = safeLog('Cookie: sessionid=hidden-one; abc=hidden-two\nAuthorization: Bearer hidden-three\n{"token":"hidden-four"}\nhttps://user:hidden-five@example.test/private/key?token=hidden-six\nhttps://www.douyin.com/note/7000000000000000001?secret=hidden-seven')
  for (const secret of ['hidden-one', 'hidden-two', 'hidden-three', 'hidden-four', 'hidden-five', 'hidden-six', 'hidden-seven']) assert.ok(!text.includes(secret), secret)
  assert.ok(text.includes('https://www.douyin.com/note/7000000000000000001'))
})
