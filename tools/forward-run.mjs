#!/usr/bin/env node
/**
 * tools/forward-run.mjs —— 「转发视频给我」一键：拉候选 → 出清单 → 弹 Windows 通知
 * ============================================================================
 * 用法：
 *   node tools/forward-run.mjs              # 拉一遍 + 弹通知
 *   node tools/forward-run.mjs --no-toast   # 只要清单
 *   node tools/forward-run.mjs --top 5      # 通知里放几条
 *
 * 出口：
 *   $DOUYIN_HOME/forward-pick.json     结构化结果（插件读这个）
 *   $DOUYIN_HOME/out/forward-*.md      人看的清单
 *   Windows 通知                        真正把消息送到用户眼前
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sendToast } from '../lib/toast.mjs'
import { homeDir, venvPython } from '../lib/paths.mjs'

const HOME = homeDir()
// 🔴 2026-11-05：跨平台 —— Windows 是 Scripts\python.exe，mac/Linux 是 bin/python
const VENV_PY = venvPython(HOME)
const SCRIPT = new URL('./forward-pick.py', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const argv = process.argv.slice(2)
const noToast = argv.includes('--no-toast')
const topIdx = argv.indexOf('--top')
const top = topIdx >= 0 ? Number(argv[topIdx + 1]) || 3 : 3

function run() {
  const r = spawnSync(VENV_PY, [SCRIPT], {
    encoding: 'utf8',
    timeout: 240_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    windowsHide: true,
  })
  if (r.status !== 0) {
    throw new Error('forward-pick.py 失败: ' + (r.stderr || r.error || `exit ${r.status}`).slice(0, 500))
  }
  return r.stdout || ''
}

function fmt(n) {
  n = Number(n) || 0
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
  return String(n)
}

const out = run()
const { meta, rows } = JSON.parse(readFileSync(join(HOME, 'forward-pick.json'), 'utf8'))

console.log('采集:', JSON.stringify(meta))
console.log(`清单 ${rows.length} 条`)
for (const [i, r] of rows.entries()) {
  console.log(`${String(i + 1).padStart(2)}. [${fmt(r.digg)}赞] ${r.desc.slice(0, 44)}`)
  console.log(`    ${r.share_url}`)
}

if (noToast) process.exit(0)

const picked = rows.slice(0, Math.max(1, Math.min(top, 4)))
const lines = picked.map((r, i) => `· ${fmt(r.digg)}赞｜${r.desc.replace(/\s+/g, ' ').slice(0, 34)}`)
const body = lines.join('\n') + (rows.length > picked.length ? `\n… 还有 ${rows.length - picked.length} 条，见 out/` : '')
const res = sendToast({
  title: `刷抖音 · 挑到 ${rows.length} 条`,
  body,
  dir: join(HOME, 'toast'),
})
console.log('通知:', JSON.stringify(res))
process.exitCode = res.ok ? 0 : 3
