#!/usr/bin/env node
/**
 * tools/doctor.mjs —— 环境体检（**纯 Node，不依赖 Python**）
 * ============================================================================
 * 为什么必须纯 Node：
 *   这是"装完插件第一件事"要跑的东西。可 Python 环境正是「装主依赖」要建的目标 ——
 *   如果 doctor 自己依赖 Python，用户第一次点它必然得到「Python 没装好」，
 *   那就成了鸡生蛋：不知道缺什么 → 不敢装 → 还是不知道缺什么。
 *
 *   所以：Node 侧能查的全在这里查；Python/venv 只是**其中一项**，缺了就报缺，
 *   不影响其他项（浏览器、家目录、Cookie、端口）照常检查。
 *
 * 用法:
 *   node tools/doctor.mjs            # 人看的
 *   node tools/doctor.mjs --json     # 机器读的（设置页 / douyin_doctor 用）
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { homeDir, pluginDir } from '../lib/paths.mjs'
import { findBrowser } from '../lib/chrome.mjs'
import { setupFiles, PY_IMPORT_PROBE, PY_PACKAGES, summarizeSetup, REPAIR_ENVIRONMENT, LOGIN_ACTION } from '../lib/setup-health.mjs'

const asJson = process.argv.includes('--json')
const items = []
const metadata = {
  '家目录': { id: 'home', category: 'environment', required: true },
  Node: { id: 'node', category: 'environment', required: true },
  Python: { id: 'system_python', category: 'environment', required: false },
  '主依赖 venv': { id: 'venv', category: 'environment', required: true, action: REPAIR_ENVIRONMENT },
  httpx: { id: 'httpx', category: 'environment', required: true, action: REPAIR_ENVIRONMENT },
  curl_cffi: { id: 'curl_cffi', category: 'environment', required: true, action: REPAIR_ENVIRONMENT },
  'Cookie（登录态）': { id: 'cookie', category: 'account', required: true, action: LOGIN_ACTION },
  '浏览器': { id: 'browser', category: 'environment', required: true },
  '无头浏览器': { id: 'browser_process', category: 'environment', required: false },
  '签名器运行时': { id: 'signer', category: 'environment', required: true, action: REPAIR_ENVIRONMENT },
  '关键文件': { id: 'plugin_files', category: 'environment', required: true },
  '人设': { id: 'persona', category: 'info', required: false },
}
const row = (item, state, detail = '', fix = '') => {
  const info = metadata[item] || { category: 'info', required: false }
  items.push({ item, state, detail, fix, ...info,
    ...(state !== 'ok' && !info.action && fix ? { action: { id: 'manual', label: fix } } : {}) })
}

/* ── 1. 家目录 ── */
let home = ''
try {
  home = homeDir({ create: false })
  row('家目录', 'ok', home)
} catch (e) {
  row('家目录', 'bad', String(e?.message ?? e), '设置环境变量 DOUYIN_HOME 指向一个可写目录')
}

/* ── 2. Node ── */
const nodeVer = process.versions.node
const major = Number(nodeVer.split('.')[0])
if (major >= 22) row('Node', 'ok', nodeVer)
else row('Node', 'bad', `${nodeVer}（需要 ≥22）`, '升级 Node 到 22 或更新')

/* ── 3. Python（只是其中一项，缺了不影响别的） ── */
const pyCmd = process.platform === 'win32' ? 'python' : 'python3'
const pyProbe = spawnSync(pyCmd, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
if (pyProbe.status === 0) {
  row('Python', 'ok', String(pyProbe.stdout || pyProbe.stderr || '').trim())
} else {
  row('Python', 'warn', '系统里没有 python',
    '点「② 装主依赖」会自动建 venv（需要机器上有 uv 或 python 3.10+）')
}

/* ── 4. venv（装依赖之后才有） ── */
if (home) {
  const files = setupFiles(home)
  if (files.pythonExists) {
    row('主依赖 venv', 'ok', files.python)
    const probe = spawnSync(files.python, ['-c', PY_IMPORT_PROBE], {
      encoding: 'utf8', windowsHide: true, timeout: 20_000,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    })
    let imports = {}
    try { if (probe.status === 0) imports = JSON.parse(String(probe.stdout || '')) } catch { /* failed imports below */ }
    for (const name of PY_PACKAGES) row(name, imports[name]?.ok ? 'ok' : 'bad', imports[name]?.ok ? '可正常导入'
      : String(imports[name]?.error || probe.error?.message || probe.stderr || '无法导入').trim().slice(0, 240), '点击「修复运行环境」补齐依赖')
  } else {
    row('主依赖 venv', 'warn', '还没建',
      '点「② 装主依赖」—— 装 curl_cffi + httpx，约 30 秒。取候选/读评论/发私信都要它')
  }
}

/* ── 5. Cookie ── */
if (home) {
  const ck = join(home, 'douyin_cookie.txt')
  let ok = false
  try { ok = existsSync(ck) && readFileSync(ck, 'utf8').trim().length > 0 } catch { ok = false }
  if (ok) row('Cookie（登录态）', 'ok', '已保存')
  else row('Cookie（登录态）', 'bad', '没有',
    '下面「抖音 Cookie / 登录」那块扫码，或粘一条浏览器 Cookie')
}

/* ── 6. 浏览器 ── */
const br = findBrowser()
if (br) row('浏览器', 'ok', br)
else row('浏览器', 'bad', '找不到 Chrome / Edge / Chromium',
  '装一个就行；装在特殊位置的话把完整路径写进环境变量 DOUYIN_BROWSER')

/* ── 7. CDP 端口 ── */
try {
  let runtime = {}
  try { runtime = JSON.parse(readFileSync(join(home, 'runtime.json'), 'utf8')) } catch { /* no browser yet */ }
  const port = Number(runtime.cdpPort) || 9334
  let alive = false
  try { alive = (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })).ok } catch { /* optional process is idle */ }
  if (alive) row('无头浏览器', 'ok', `${port} 上已有实例（会自动复用）`)
  else row('无头浏览器', 'warn', '目前没有运行；需要时会自动启动，无需修复')
} catch (e) {
  row('无头浏览器', 'warn', String(e?.message ?? e), '跑一次取候选或发私信时会自动拉起')
}

/* ── 8. 签名器运行时（读评论要用；Issue #2① / #4） ── */
if (home) {
  const signerDir = process.env.DY_SIGNER_DIR || join(home, 'signer')
  const jsdomOk = existsSync(join(signerDir, 'node_modules', 'jsdom', 'package.json'))
  const sdkNames = ['webmssdk.js', 'secsdk-runtime.js', 'sdk-glue.js', 'slardar.js', 'bdms-signer.js', 'captcha-sdk.js', 'verifycenter.js']
  const haveSdk = sdkNames.filter((n) => { try { return statSync(join(signerDir, 'sdk', n)).size > 1000 } catch { return false } }).length
  if (jsdomOk && haveSdk === sdkNames.length) {
    row('签名器运行时', 'ok', `已装（jsdom + ${haveSdk} 个 SDK）`)
  } else if (!jsdomOk && haveSdk === 0) {
    row('签名器运行时', 'warn', '还没装 —— 读评论/回评论会走无头浏览器兜底（能用，但每次慢几秒）',
      '点「② 装主依赖」会自动带上；或手动 node tools/signer-setup.mjs')
  } else {
    row('签名器运行时', 'warn', `装了一半（jsdom:${jsdomOk ? '有' : '缺'}，SDK ${haveSdk}/${sdkNames.length}）`,
      'node tools/signer-setup.mjs 补齐；真签自检：node tools/signer-setup.mjs --check')
  }
}

/* ── 9. 关键文件 ── */
const pdir = pluginDir()
const need = ['index.js', 'client.js', 'lib/chrome.mjs', 'lib/paths.mjs',
  'tools/forward-pick.py', 'tools/im-send.mjs', 'tools/card-share.mjs',
  'tools/comment-api.mjs', 'tools/comment-mention-ui.mjs', 'tools/dy-signer.mjs']
const missing = need.filter((f) => !existsSync(join(pdir, f)))
if (missing.length) row('关键文件', 'bad', '缺 ' + missing.join(', '), '重新安装插件包')
else row('关键文件', 'ok', `${need.length} 个都在`)

/* ── 9. 人设（顺手报一下用的是哪层） ── */
if (home) {
  const mine = join(home, 'persona.md')
  if (existsSync(mine)) row('人设', 'ok', '用你自己写的那份（$DOUYIN_HOME/persona.md）')
  else if (existsSync(join(pdir, 'prompts', 'persona.md'))) row('人设', 'ok', '用插件自带那份')
  else if (existsSync(join(pdir, 'prompts', 'persona.default.md'))) row('人设', 'ok', '用默认中性人设')
  else row('人设', 'warn', '一份都没有', '插件包不完整，重装')
}

/* ── 汇总 ── */
const bad = items.filter((r) => r.state === 'bad')
const warn = items.filter((r) => r.state === 'warn')
const okAll = bad.length === 0
const setup = summarizeSetup(items)

if (asJson) {
  console.log(JSON.stringify({ ok: okAll, items, must_fix: bad, warns: warn, ...setup }, null, 2))
} else {
  const icon = { ok: '✅', warn: '⚠️ ', bad: '❌' }
  for (const r of items) {
    console.log(`${icon[r.state] || '?'} ${r.item}：${r.detail}`)
    if (r.state !== 'ok' && r.fix) console.log(`      → ${r.fix}`)
  }
  console.log()
  console.log(`结果：${items.length - bad.length - warn.length} 项正常 / ${warn.length} 项待办 / ${bad.length} 项必须修`)
  if (bad.length) {
    console.log('先把标 ❌ 的修掉，再装依赖 / 跑值班。')
  } else if (warn.length) {
    console.log('没有硬伤。标 ⚠️ 的装完依赖、登完录就会自己变绿。')
  } else {
    console.log('全绿，可以跑值班了。')
  }
}
process.exitCode = okAll ? 0 : 1
