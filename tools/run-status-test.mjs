/**
 * 运行状态与推荐列表的离线测试：核对阶段判断、旧记录隔离和日报去重。
 * 仅使用模拟数据和临时文件，不启动 DSH，不联网或发送消息。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { summarizeRun as summarize, readRunProgress, reportPicks } from '../lib/run-status.mjs'

const at = '2026-10-31T09:16:00.000Z'
const summarizeRun = (...args) => summarize(...args, Date.parse(at) + 20_000)
const state = { lastRunAt: at, roundActive: false }
const log = (seconds, message) => `${new Date(Date.parse(at) + seconds * 1000).toISOString()}  ${message}\n`
const evidence = { builtAt: at, list: [{ comment: 100, top_comments: [] }] }
const report = { exists: true, updatedAt: Date.parse(at) + 3000 }

test('cleared running flag and model prose cannot claim completion', () => {
  const text = log(1, '刷抖音开跑（manual）：fixture') + log(2, '插件重新加载：清掉了上次残留的运行中标记')
    + '本轮成功了，所有消息均已发送\n'
  const r = summarizeRun(state, evidence, text, report)
  assert.equal(r.phase, 'running')
  assert.equal(r.endedAt, 0)
  assert.equal(r.commentsMissing, true)
  assert.equal(r.reportUpdated, true)
})
test('only this round contributes evidence and outcome', () => {
  const old = { ...evidence, builtAt: '2026-10-31T08:00:00Z' }
  const r = summarizeRun(state, old, log(-10, '刷抖音结束（manual，code=0）'), { exists: true, updatedAt: 1 })
  assert.equal(r.phase, 'unknown')
  assert.equal(r.candidates, null)
  assert.equal(r.commentsMissing, false)
  assert.equal(r.reportUpdated, false)
})
test('normal exit, failed launch and timeout remain distinct', () => {
  assert.equal(summarizeRun(state, evidence, log(2, '刷抖音结束（manual，code=0）'), report).phase, 'unknown')
  for (const message of ['刷抖音结束（manual，code=1）', '刷抖音开跑失败（manual）：no binary', '刷抖音起不来：no binary']) {
    assert.equal(summarizeRun(state, evidence, log(2, message), report).phase, 'failed')
  }
  const timeout = log(2, '⚠️ 这一轮超过 15 分钟没结束 ⇒ 强制结束（报告可能已经写了）')
  assert.equal(summarizeRun(state, evidence, timeout + log(3, '刷抖音结束（manual，code=0）'), report).phase, 'failed')
})
test('never run, preparing and no-comments-needed are not warnings', () => {
  assert.equal(summarizeRun({}, {}, '', {}).phase, 'idle')
  const r = summarizeRun({ ...state, roundActive: true }, { builtAt: at, list: [{ comment: 0 }] }, '', {})
  assert.equal(r.phase, 'preparing')
  assert.equal(r.commentsMissing, false)
  assert.equal(summarize(state, evidence, log(1, '刷抖音开跑（manual）：fixture'), {}, Date.parse(at) + 121 * 60_000).phase, 'unknown')
})
test('daily recommendations deduplicate IDs and exclude fenced examples', () => {
  const picks = reportPicks('# 日报\n### 1234567890123456789 猫\n**推荐理由**：可爱\n```\n### 9999999999999999999\n```\n### 1234567890123456789\n更新后的说明\n## 其他\n不属于推荐\n### 2234567890123456789\n<script>not executed</script>')
  assert.equal(picks.length, 2)
  assert.equal(picks[0].title, '更新后的说明')
  assert.ok(!picks[0].text.includes('不属于推荐'))
  assert.equal(picks[1].text, '<script>not executed</script>') // Rendered as a React text node, never HTML.
})
test('legacy recommendations retain observed note routes and never guess mismatched work links', () => {
  const picks = reportPicks('### 7000000000000000001\n[图文](https://www.douyin.com/note/7000000000000000001?from=notice)\n### 7000000000000000002\nhttps://www.douyin.com/video/7000000000000000099')
  assert.equal(picks[0].url, 'https://www.douyin.com/note/7000000000000000001')
  assert.equal(picks[1].url, undefined)
})
test('reading progress preserves runtime files and uses the round day', () => {
  const home = mkdtempSync(join(tmpdir(), 'douyin-run-status-'))
  try {
    mkdirSync(join(home, 'out'))
    writeFileSync(join(home, 'state.json'), JSON.stringify(state))
    writeFileSync(join(home, 'round-evidence.json'), JSON.stringify(evidence))
    writeFileSync(join(home, 'duty.log.1'), log(2, '刷抖音结束（manual，code=0）'))
    writeFileSync(join(home, 'duty.log'), log(3, '日志超过 2MB，旧的滚到 duty.log.1'))
    writeFileSync(join(home, 'out', '2026-10-31.md'), '# 完成')
    const before = readFileSync(join(home, 'state.json'), 'utf8')
    const r = readRunProgress(home, '2026-11-01')
    assert.equal(r.round.phase, 'unknown')
    assert.equal(r.report.exists, false)
    assert.equal(r.round.reportUpdated, true)
    assert.equal(readFileSync(join(home, 'state.json'), 'utf8'), before)
  } finally {
    assert.equal(dirname(resolve(home)), resolve(tmpdir()))
    assert.ok(basename(home).startsWith('douyin-run-status-'))
    rmSync(home, { recursive: true, force: true })
  }
})
