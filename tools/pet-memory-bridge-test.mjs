/**
 * tools/pet-memory-bridge-test.mjs —— 桌宠记忆桥的离线单测（不需要 DSH、不联网）
 * ============================================================================
 * 覆盖：
 *   ① ctx 服务优先（单个对象 / 数组，挑 name=deskpet）
 *   ② ctx 服务失败 → HTTP 兜底（本地 http server，不用真网络）
 *   ③ HTTP 超时 / 500 / 坏 JSON ⇒ 返回空，不抛错；失败最多 log 一次
 *   ④ text 长度截断 + formatMemoryBrief 纯函数
 *   ⑤ pet-brain.askModel 的 memoryBrief 真的进 system（假 llm.stream 捕获）
 *   ⑥ 隐私边界：index.js 只有 /pet/chat 一处调用记忆桥
 *
 * 跑法：node tools/pet-memory-bridge-test.mjs
 * 退出码 0 = 全过。
 * ============================================================================
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMemoryBridge, formatMemoryBrief } from '../lib/pet-memory-bridge.mjs'
import { askModel } from '../lib/pet-brain.mjs'

const here = dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0
const ok = (m) => { pass++; console.log(`  ✅ ${m}`) }
const bad = (m) => { fail++; console.log(`  ❌ ${m}`) }

/** 起一个本地 http server（端口 0 = 系统随机分配）。 */
async function startServer(handler) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      try { server.closeAllConnections?.() } catch { /* 旧 Node 没有 */ }
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const empty = (r) => r && r.ok === false && r.text === '' && Array.isArray(r.items) && r.items.length === 0

async function main() {
  /* ── 1. formatMemoryBrief 纯函数 ── */
  console.log('1. formatMemoryBrief（纯函数）')
  {
    const t = formatMemoryBrief(['在杭州', '养了一只橘猫'])
    if (t === '- 在杭州\n- 养了一只橘猫') ok('字符串条目按行拼接')
    else bad(`字符串条目拼错了：${JSON.stringify(t)}`)

    const t2 = formatMemoryBrief([
      { type: 'preference', text: '喜欢晚上写代码' },
      { type: 'fact', text: '在杭州' },
    ])
    if (t2.includes('- 偏好：喜欢晚上写代码') && t2.includes('- 记得：在杭州')) ok('对象条目带中文类型标签')
    else bad(`对象条目拼错了：${JSON.stringify(t2)}`)

    const dup = formatMemoryBrief(['在杭州', '  在杭州  ', '养了一只橘猫'])
    if (dup === '- 在杭州\n- 养了一只橘猫') ok('重复条目去重（含多余空白）')
    else bad(`去重不对：${JSON.stringify(dup)}`)

    const clipped = formatMemoryBrief(['一二三四五六七八九十', '甲乙丙丁戊己庚辛壬癸'], 10)
    if (clipped.length <= 10 && clipped.endsWith('…')) ok(`按 maxChars 截断（${clipped.length} ≤ 10，带省略号）`)
    else bad(`截断不对：len=${clipped.length} ${JSON.stringify(clipped)}`)

    if (formatMemoryBrief([], 100) === '') ok('空数组返回空串')
    else bad('空数组没返回空串')
  }

  /* ── 2. ctx 服务优先 + 数组兼容 ── */
  console.log('\n2. ctx 服务优先 / 数组兼容')
  {
    const calls = []
    const ctx = {
      get(name) {
        if (name !== 'deskpetMemoryBrief') throw new Error('取错服务名：' + name)
        return [
          { name: 'other', recall() { calls.push('other'); return { ok: true, text: '- 错的服务', items: [] } } },
          { name: 'deskpet', recall() { calls.push('deskpet'); return { ok: true, text: '- 偏好：喜欢猫', items: [{ type: 'preference', text: '喜欢猫' }] } } },
        ]
      },
    }
    const bridge = createMemoryBridge({ ctx })
    const r = await bridge.recall('我今天干嘛了', { topK: 4, maxChars: 500 })
    if (r.ok && r.text.includes('喜欢猫')) ok('ctx 数组里取到 deskpet 的记忆')
    else bad(`ctx 数组没取到记忆：${JSON.stringify(r)}`)
    if (calls.join(',') === 'deskpet') ok('数组里优先挑 name=deskpet，不误调别的同名服务')
    else bad(`挑错服务：${calls.join(',') || '(没调用)'}`)

    const single = createMemoryBridge({
      ctx: { get: () => ({ name: 'deskpet', recall: () => ({ ok: true, text: '- 记得：主人在写代码', items: [{ type: 'event', text: '主人在写代码' }] }) }) },
    })
    const r2 = await single.recall('我在写代码吗')
    if (r2.ok && r2.text.includes('在写代码')) ok('ctx 单个对象也兼容')
    else bad(`ctx 单个对象失败：${JSON.stringify(r2)}`)
  }

  /* ── 3. ctx 服务失败 → HTTP 兜底（并验证查询参数） ── */
  console.log('\n3. HTTP 兜底')
  {
    const seen = []
    const srv = await startServer((req, res) => {
      const u = new URL(req.url, 'http://x')
      seen.push({
        path: u.pathname,
        q: u.searchParams.get('q'),
        topK: u.searchParams.get('topK'),
        maxChars: u.searchParams.get('maxChars'),
      })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, text: '- 最近：主人在写代码', items: [{ type: 'event', text: '主人在写代码' }] }))
    })
    try {
      const bridge = createMemoryBridge({
        baseUrl: srv.baseUrl,
        ctx: { get: () => ({ name: 'deskpet', recall: () => { throw new Error('服务炸了') } }) },
      })
      const r = await bridge.recall('我 在 干嘛 & 写代码?', { topK: 4, maxChars: 500 })
      if (r.ok && r.text.includes('主人在写代码')) ok('ctx 服务抛错时 HTTP 兜底成功')
      else bad(`HTTP 兜底失败：${JSON.stringify(r)}`)
      const s = seen[0] || {}
      if (s.path === '/api/deskpet/pet/memory/brief') ok('请求路径正确')
      else bad(`请求路径不对：${s.path}`)
      if (s.q === '我 在 干嘛 & 写代码?') ok('q 参数编码后原样解码')
      else bad(`q 参数不对：${JSON.stringify(s.q)}`)
      if (s.topK === '4' && s.maxChars === '500') ok('topK / maxChars 参数传对')
      else bad(`参数不对：topK=${s.topK} maxChars=${s.maxChars}`)

      const bridge2 = createMemoryBridge({
        baseUrl: srv.baseUrl,
        ctx: { get: () => ({ name: 'deskpet', recall: () => ({ ok: false, text: '', items: [] }) }) },
      })
      const r2 = await bridge2.recall('再查一次')
      if (r2.ok && r2.text.includes('主人在写代码')) ok('ctx 返回 ok:false 时也会走 HTTP 兜底')
      else bad(`ok:false 没兜底：${JSON.stringify(r2)}`)
    } finally { await srv.close() }
  }

  /* ── 4. HTTP 失败 / 超时 → 空，不抛错，最多 log 一次 ── */
  console.log('\n4. HTTP 失败与超时')
  {
    const srv500 = await startServer((req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('boom')
    })
    try {
      const logs = []
      const bridge = createMemoryBridge({ baseUrl: srv500.baseUrl, log: (m) => logs.push(m) })
      const r1 = await bridge.recall('第一次失败')
      const r2 = await bridge.recall('第二次失败')
      if (empty(r1) && empty(r2)) ok('HTTP 500 返回空结果（不抛错）')
      else bad(`HTTP 500 结果不对：${JSON.stringify([r1, r2])}`)
      if (logs.length === 1) ok('连续失败只 log 一次（不刷屏）')
      else bad(`log 次数不对：${logs.length}`)
    } finally { await srv500.close() }

    const srvBadJson = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{不是 JSON')
    })
    try {
      const bridge = createMemoryBridge({ baseUrl: srvBadJson.baseUrl })
      const r = await bridge.recall('坏 JSON')
      if (empty(r)) ok('坏 JSON 返回空结果')
      else bad(`坏 JSON 结果不对：${JSON.stringify(r)}`)
    } finally { await srvBadJson.close() }

    const srvSlow = await startServer(() => { /* 故意永不响应，等 bridge 自己 abort */ })
    try {
      const bridge = createMemoryBridge({ baseUrl: srvSlow.baseUrl })
      const t0 = Date.now()
      const r = await bridge.recall('慢查询')
      const elapsed = Date.now() - t0
      if (empty(r)) ok('超时返回空结果（不抛错）')
      else bad(`超时结果不对：${JSON.stringify(r)}`)
      if (elapsed >= 1000 && elapsed < 5000) ok(`超时约 1.5 秒（实测 ${elapsed}ms）`)
      else bad(`超时时间不对：${elapsed}ms`)
    } finally { await srvSlow.close() }
  }

  /* ── 5. text 长度截断（bridge 层再兜一次） ── */
  console.log('\n5. text 长度截断')
  {
    const longText = '甲'.repeat(1000)
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, text: longText, items: [{ type: 'fact', text: longText }] }))
    })
    try {
      const bridge = createMemoryBridge({ baseUrl: srv.baseUrl })
      const r = await bridge.recall('长记忆', { topK: 4, maxChars: 100 })
      if (r.ok && r.text.length <= 100 && r.text.endsWith('…')) ok(`bridge 把超长 text 截到 ≤ 100（实际 ${r.text.length}）`)
      else bad(`bridge 没截断：len=${r.text.length}`)
    } finally { await srv.close() }
  }

  /* ── 6. pet-brain：memoryBrief 会进 system ── */
  console.log('\n6. pet-brain.askModel 的 memoryBrief')
  {
    const HEADER = '【你记得的真实事情（只许用这些，不许编；没有的就说想不起来/顺着聊）】'
    const captured = []
    const llm = {
      stream(opts) {
        captured.push(opts)
        return (async function* () {
          yield { type: 'text-delta', text: '记得呢' }
          yield { type: 'finish' }
        })()
      },
    }
    const r = await askModel({
      llm,
      route: { provider: 'p', model: 'm' },
      text: '主人还记得我吗',
      memoryBrief: '- 偏好：喜欢晚上写代码',
    })
    const system = captured[0]?.system || ''
    if (system.includes(HEADER)) ok('memoryBrief 非空时，system 末尾带记忆标题')
    else bad('system 里没有记忆标题')
    if (system.includes('- 偏好：喜欢晚上写代码')) ok('记忆正文真的进了 system')
    else bad('记忆正文没进 system')
    if (system.indexOf(HEADER) > system.indexOf('不能做的事')) ok('记忆段追加在 system 末尾（人设之后）')
    else bad('记忆段位置不对（不在末尾）')
    if (r.say === '记得呢') ok('模型回复正常返回')
    else bad(`模型回复异常：${JSON.stringify(r)}`)

    const captured2 = []
    const llm2 = {
      stream(opts) {
        captured2.push(opts)
        return (async function* () { yield { type: 'text-delta', text: '好' } })()
      },
    }
    await askModel({ llm: llm2, route: { provider: 'p', model: 'm' }, text: '没有记忆时' })
    if (!String(captured2[0]?.system || '').includes(HEADER)) ok('没有 memoryBrief 时不加记忆段（正常按人设聊）')
    else bad('没有 memoryBrief 却加了记忆段')
  }

  /* ── 7. 隐私边界：记忆桥只接到 /pet/chat ── */
  console.log('\n7. 隐私边界（静态检查）')
  {
    const idx = readFileSync(join(here, '..', 'index.js'), 'utf8')
    const start = idx.indexOf("path === '/api/douyin-duty/pet/chat'")
    const end = idx.indexOf("path === '/api/douyin-duty/inbox'")
    const block = start >= 0 && end > start ? idx.slice(start, end) : ''
    if (start >= 0 && block.includes('memoryBridge.recall(')) ok('memoryBridge.recall 在 /pet/chat 路由块内')
    else bad('memoryBridge.recall 不在 /pet/chat 路由块内（隐私边界破了）')
    const allCalls = (idx.match(/memoryBridge\.recall\(/g) || []).length
    if (allCalls === 1) ok('index.js 全文件只有 /pet/chat 一处调用记忆桥')
    else bad(`记忆桥被调用了 ${allCalls} 处 —— 只许 /pet/chat 一处`)
    if (/import \{ createMemoryBridge \} from '\.\/lib\/pet-memory-bridge\.mjs'/.test(idx)) ok('index.js 从本插件 lib 导入 bridge（没 import 桌宠代码）')
    else bad('index.js 没有正确导入 bridge')
    const briefRefs = (idx.match(/\bmemoryBrief\b/g) || []).length
    if (briefRefs === 1) ok('memoryBrief 只传给那一次 askModel')
    else bad(`memoryBrief 在 index.js 出现 ${briefRefs} 次 —— 只该有 /pet/chat 那一次`)
  }

  console.log(`\n${fail ? '❌' : '✅'} 通过 ${pass} 项，失败 ${fail} 项`)
  process.exitCode = fail ? 1 : 0
}

main().catch((e) => {
  console.error('测试脚本自身炸了：', e)
  process.exitCode = 1
})
