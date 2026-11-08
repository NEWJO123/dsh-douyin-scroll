#!/usr/bin/env node
/**
 * tools/reload-panel.mjs —— 改完 client.js 之后，让面板**真的**换上新代码
 * ============================================================================
 * 为什么需要它（2026-10-22 踩了很久）：
 *   改 `client.js` 之后，只重启 dsh 或只改配置**不一定**能让浏览器换新 bundle ——
 *   浏览器会缓存 `/plugins/.../client.js?rev=<旧rev>`，
 *   而 DSH 的 HMR 只在 `pnpm run dev:web` 跑着的时候才推更新。
 *   结果就是：**代码明明改了，面板上还是老样子**，让人以为"按钮没做出来"。
 *
 * 这个脚本做三件事：
 *   ① 算出当前 client.js 的 rev（跟 DSH 内部算法一致：mtime+ctime+size 的 sha1 前 12 位）
 *   ② 检查服务端返回的 bundle 里有没有新代码的特征
 *   ③ 打印**该怎么让浏览器换掉**（不同情况给不同办法）
 *
 * 用法：
 *   node tools/reload-panel.mjs                 # 查状态
 *   node tools/reload-panel.mjs --expect 自动发送  # 断言 bundle 里必须有这个词
 * ============================================================================
 */
import { statSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLIENT = join(ROOT, 'client.js')

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const EXPECT = String(argOf('--expect', '')).trim()
const PORT = Number(argOf('--port', process.env.DSH_PORT || 0)) || 0

/** DSH 内部算 bundle rev 的算法（见 dsh-client-modules: artifactRevision） */
const framedHash = (domain, parts) => {
  const h = createHash('sha1').update(domain).update('\0')
  for (const p of parts) h.update(`${String(Buffer.byteLength(p))}:`).update(p)
  return h.digest('hex').slice(0, 12)
}

const st = statSync(CLIENT)
const rev = framedHash('plugin-artifact', [String(st.mtimeMs), String(st.ctimeMs), String(st.size)])
const src = readFileSync(CLIENT, 'utf8')

console.log('client.js')
console.log('  大小:', st.size, '字节')
console.log('  修改:', st.mtime.toLocaleString('zh-CN'))
console.log('  rev :', rev)
console.log('')

// 面板构建标识已自动化（2026-11-08）：不再有手写 PANEL_BUILD 常量，
// 面板 /status 用 client.js 的文件修改时间当构建号（mtime 尾 6 位）。
console.log('面板构建标识: b' + String(st.mtimeMs).slice(-6) + '（client.js mtime，自动生成）')
console.log('')

// 关键特征自检（确认源码里真有这些块）
const features = [
  ['自动发送开关', '自动发送'],
  ['看日志', '看日志'],
  ['消息收件箱', '看看谁找我'],
  ['聊天模式', '跟 '],
  ['对话记忆', '对话记忆'],
]
console.log('源码特征:')
let missing = 0
for (const [name, needle] of features) {
  const has = src.includes(needle)
  if (!has) missing++
  console.log(`  ${has ? '✅' : '❌'} ${name}`)
}
if (EXPECT) {
  const has = src.includes(EXPECT)
  console.log(`\n--expect "${EXPECT}": ${has ? '✅ 源码里有' : '❌ 源码里没有'}`)
  if (!has) process.exitCode = 1
}
console.log('')

// 问服务端：它返回的 bundle 里有没有
if (PORT) {
  const url = `http://127.0.0.1:${PORT}/plugins/??dsh-douyin-scroll/client.js&rev=${rev}`
  try {
    const r = await fetch(url)
    const text = await r.text()
    console.log(`服务端 bundle（${r.status}，${text.length} 字节）:`)
    for (const [name, needle] of features) {
      console.log(`  ${text.includes(needle) ? '✅' : '❌'} ${name}`)
    }
  } catch (e) {
    console.log('服务端查询失败（端口对不对？）:', String(e?.message ?? e))
  }
  console.log('')
}

console.log('要让浏览器换上新 bundle，按顺序试：')
console.log('  1. 浏览器里 **Ctrl+Shift+R** 强制刷新（最简单，先试这个）')
console.log('  2. 关掉设置面板再打开')
console.log('  3. 重启 dsh')
console.log('')
console.log('确认换没换：面板右上角应该显示  v<当前版本>·b' + (b ? b[1] : '?'))
console.log('（如果还是旧数字 b<?>，说明浏览器还在用旧缓存）')
