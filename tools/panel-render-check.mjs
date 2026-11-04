/**
 * Render the real non-ESM client with a small React/HTTP host. No network, config
 * writes, browsers or messages leave this process. Effects track dependencies
 * and timers are controlled so polling and duplicate clicks can be exercised.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
const EPOCH = Date.parse('2026-11-03T12:20:00Z')
const clone = (value) => structuredClone(value)
const emptySends = () => Object.fromEntries(['dm', 'card', 'comment'].map((key) => [key, { succeeded: 0, failed: 0, unknown: 0 }]))
const round = (phase = 'completed', extra = {}) => ({
  id: 'round-one', phase, startedAt: EPOCH, endedAt: phase === 'completed' ? EPOCH + 60_000 : null,
  activityAt: EPOCH + 55_000, source: 'manual', budget: 3,
  events: [
    { at: EPOCH, stage: 'start', level: 'info', message: '开始获取候选' },
    { at: EPOCH + 15_000, stage: 'comments', level: 'warning', message: '部分评论未读到' },
    { at: EPOCH + 60_000, stage: 'end', level: 'info', message: '本轮已完成' },
  ],
  warnings: ['部分评论未读到'], result: { recommendations: 1, reportUpdated: true, sends: emptySends() }, ...extra,
})
const fixtureConfig = () => ({
  perDay: 5, manualPerRun: 3, autoEnabled: true, maxPerRun: 12, noon: true, night: true,
  scheduleDays: [0, 1, 2, 3, 4, 5, 6], windows: [{ start: '09:00', end: '11:00', label: '上午' }],
  keywords: ['猫', '搞笑'], autoSend: true, commentAtMe: false, dmPeers: [], atPeers: [], chatWatch: false,
})
const fixturePersona = () => ({ ok: true, custom: false, text: '', effective: '# 插件口吻\n自然、简短。', effective_label: '插件自带的那份', default_text: '# 中性默认\n简洁。' })
const fixtureDoctor = (state) => {
  const dependency = { id: 'dependencies', category: 'environment', required: true,
    item: state.venvReady ? '运行环境' : '主依赖', state: state.venvReady ? 'ok' : 'bad',
    detail: state.venvReady ? '可以使用' : '未安装',
    ...(state.venvReady ? {} : { fix: '点击「修复环境」补齐依赖。', action: { id: 'repair_environment', label: '修复运行环境', endpoint: '/api/douyin-duty/environment/repair' } }) }
  const cookie = { id: 'cookie', category: 'account', required: true, item: 'Cookie', state: state.loggedIn ? 'ok' : 'bad',
    detail: state.loggedIn ? '已保存' : '未登录', ...(state.loggedIn ? {} : { fix: '扫码登录抖音。', action: { id: 'login', label: '扫码登录' } }) }
  return { ok: state.venvReady && state.loggedIn, items: [dependency, cookie], must_fix: [dependency, cookie].filter((item) => item.state !== 'ok').map((item) => item.item), warns: [],
    environment: { ready: state.venvReady, items: [dependency], repairable: !state.venvReady, actions: dependency.action ? [dependency.action] : [] },
    account: { ready: state.loggedIn, items: [cookie], actions: cookie.action ? [cookie.action] : [] } }
}
const inboxItem = (extra = {}) => ({
  nickname: '测试好友', content: '出来一下', before: '没回过', aweme_id: '7693806860863802662',
  comment_id: '7699090731688952613', root_comment_id: '7699090731688952600', aweme_type: 68,
  work_url: 'https://www.douyin.com/note/7693806860863802662',
  my_comments_here: [{ text: '我之前在这说过一句' }], ...extra,
})

function harness(options = {}) {
  let config = { ...fixtureConfig(), ...options.config }
  const state = { loggedIn: true, venvReady: true, installing: false, install: { phase: 'idle' }, ...options.state }
  const calls = [], copies = [], instances = new Map(), intervals = new Map(), timeouts = new Map()
  let cursor = null, current = null, dirty = true, tree = null, effects = [], nextTimer = 1, disposed = false
  const data = {
    round: round(), counts: { auto: 5, manual: 1, unknown: 2, total: 8 }, persona: fixturePersona(),
    inbox: { ok: true, at_n: 1, dm_n: 1, at: [inboxItem()], dm: [{ nick: '测试好友', sec_uid: 'MS4wLjABAAAA_test1', preview: '你好', remembered: 11, needs_reply: true, their_last: { text: '我也爱你' } }], errors: [] },
    reports: {
      recent: { ok: true, scope: 'recent', exists: true, text: '### 7401234567890123401\n**最近的理由**', roundId: 'round-one', picks: [{ id: '7401234567890123401', title: '最近的作品', text: '**值得看**，这是理由。', url: 'https://www.douyin.com/note/7401234567890123401' }] },
      today: { ok: true, scope: 'today', exists: true, text: '# 今日报告\n\n**加粗理由**\n- 一条推荐\n[打开作品](https://www.douyin.com/note/7401234567890123401)\n<script>malicious()</script>\n[危险](javascript:alert(1))', picks: [{ id: '7401234567890123401', title: '今日的作品', text: '今日理由。', url: 'https://www.douyin.com/note/7401234567890123401' }] },
    },
    reportStamp: 'stamp-one', progressError: false, reportError: false, configError: false, statusError: false,
    tail: '旧轮次日志\nCookie: sessionid=SECRET_COOKIE\nwebhook=https://secret.example/hook/SECRET_HOOK\n证据包已备好\nhttps://www.douyin.com/note/7401234567890123401',
    reply: { ok: true, sent: true, cid: '7699090731688952699' }, run: { ok: true },
    doctor: () => fixtureDoctor(state), qr: { ok: true, qr_url: '/api/douyin-duty/login/qr.png' },
    installStart: { ok: true, started: true, install: { phase: 'running', stage: 'dependencies', startedAt: EPOCH } },
    install404: false, ...options.data,
  }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children: children.flat(Infinity) } }),
    useState(initial) {
      const i = cursor++, host = current
      if (!(i in host.hooks)) host.hooks[i] = typeof initial === 'function' ? initial() : initial
      return [host.hooks[i], (value) => { host.hooks[i] = typeof value === 'function' ? value(host.hooks[i]) : value; dirty = true }]
    },
    useRef(initial) {
      const i = cursor++
      if (!(i in current.hooks)) current.hooks[i] = { current: initial }
      return current.hooks[i]
    },
    useEffect(fn, deps) {
      const i = cursor++, host = current, before = host.hooks[i]
      if (!before || !deps || deps.some((value, index) => !Object.is(value, before.deps?.[index]))) {
        effects.push(() => { before?.cleanup?.(); const cleanup = fn(); host.hooks[i] = { deps, cleanup } })
      }
    },
    Component: class { constructor(props) { this.props = props; this.state = {} } setState(next) { Object.assign(this.state, next); dirty = true } },
  }
  const document = {
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, select() {}, remove() {} }),
    head: { appendChild() {} }, body: { appendChild() {} }, querySelector: () => null, execCommand: () => true,
  }
  const navigator = { clipboard: { writeText: async (text) => copies.push(text) } }
  const fetch = async (address, opts = {}) => {
    const url = new URL(address, 'http://fixture.local'), path = url.pathname.replace('/api/douyin-duty', '')
    const method = opts.method || 'GET', body = opts.body ? JSON.parse(opts.body) : null
    calls.push({ path, query: url.search, method, body })
    let response
    if (path === '/config') {
      if (method === 'POST') {
        if (data.configError) throw new Error('设置写入失败')
        const { __clearKeys, ...patch } = body
        config = { ...config, ...patch }
      }
      response = { ok: true, config: clone(config) }
    } else if (path === '/status') {
      if (data.statusError) throw new Error('读取设置失败')
      response = { ok: true, version: '9.9.9', home: 'H:/dy', ...state, counts: data.counts, pickedToday: data.counts.total, report: 'H:/dy/out/today.md', nextWindow: { startsAt: EPOCH + 86_400_000, endsAt: EPOCH + 90_000_000, label: '中午' } }
    } else if (path === '/progress') {
      if (data.progressError) throw new Error('状态读取失败')
      response = { ok: true, round: clone(data.round), counts: data.counts, running: data.running ?? ['preparing', 'running', 'unknown'].includes(data.round.phase), report: { exists: true, stamp: data.reportStamp }, ...(url.searchParams.has('log') ? { tail: data.tail } : {}) }
      if (data.progress) response = await data.progress(clone(response))
    } else if (path === '/report') {
      if (data.reportError) throw new Error('结果读取失败')
      response = clone(data.reports[url.searchParams.get('scope') || 'today'])
    } else if (path === '/persona') {
      if (method === 'POST') data.persona = { ...data.persona, text: body.text, custom: Boolean(body.text.trim()), effective_label: body.text ? '我写的人设' : '插件自带的那份' }
      response = data.persona
    } else if (path === '/run') response = typeof data.run === 'function' ? await data.run(body) : data.run
    else if (path === '/comment/reply') response = typeof data.reply === 'function' ? await data.reply(body) : data.reply
    else if (path === '/comment/ai-reply') {
      if (method === 'POST') {
        response = typeof data.commentAI === 'function' ? await data.commentAI(body) : data.commentAI || {ok:true,job:{id:'comment-job-one',status:'sent',done:true,sent:true,text:'DSH 评论回复'}}
        if (response?.job) data.commentJob = response.job
      } else {
        if (data.commentStatusError) throw new Error('状态暂不可用')
        response = {ok:true,job:data.commentJob || null}
      }
    }
    else if (path === '/inbox') response = typeof data.inbox === 'function' ? await data.inbox(url.searchParams.get('scope')) : data.inbox
    else if (path === '/account') response = { ok: true, logged_in: state.loggedIn, account: state.loggedIn ? { nick: '测试账号昵称', uid: '9999000011112222' } : null }
    else if (path === '/install' || path === '/environment/repair') {
      if (path === '/environment/repair' && data.install404) return { ok: false, status: 404, json: async () => ({ ok: false }) }
      response = typeof data.installStart === 'function' ? await data.installStart(body) : data.installStart
      if (response.ok && (response.started || response.busy || response.install?.phase === 'running')) {
        state.installing = true; state.install = response.install || { phase: 'running' }
      }
    }
    else if (path === '/login/qr') {
      response = typeof data.qr === 'function' ? await data.qr(body) : data.qr
      if (response.ok && response.already_logged_in) state.loggedIn = true
    }
    else if (path === '/login/check' || path === '/login/wait') { state.loggedIn = true; response = { ok: true } }
    else if (path === '/login/clear') { state.loggedIn = false; response = { ok: true } }
    else if (path === '/login/close') response = { ok: true }
    else if (path === '/guide') {
      if (data.guideError) throw new Error('说明读取失败')
      response = { ok: true, text: '# 新手流程\n\n1. 装环境\n2. 扫码登录\n3. 跑一轮' }
    }
    else if (path === '/doctor') response = typeof data.doctor === 'function' ? await data.doctor(body) : data.doctor
    else if (path === '/dm/people') response = { ok: true, people: [
      { nick: '测试好友', sec_uid: 'MS4wLjABAAAA_test1', preview: '最近聊过', has_id: true },
      { nick: '另一个朋友', sec_uid: 'MS4wLjABAAAA_test2', duplicate: true, preview: '好的', has_id: true },
      { nick: '测试群聊', sec_uid: '', is_group: true, preview: '群里在说话' },
    ], hint: '重名时看最近消息区分' }
    else if (path === '/chat/read') response = data.chatRead || { ok: true, to: body.to, to_sec_uid: body.to_id,
      messages: [{ from: 'me', text: '爱你哟。' }, { from: 'them', text: '我也爱你' }, { from: 'unknown', text: '无法确认方向', awe: 800 }], context: { facts: ['喜欢猫', '在杭州'] } }
    else if (path === '/chat/send') response = { ok: true, sent: true }
    else if (path === '/chat/reply') {
      if (method === 'POST') {
        if (data.aiReply) response = await data.aiReply(body)
        else { data.aiJob = { id: 'job-one', status: 'sent', done: true, sent: true, text: 'DSH 生成的回复' }; response = { ok: true, job: data.aiJob } }
      } else {
        if (data.aiStatusError) throw new Error('暂时断线')
        response = { ok: true, job: data.aiJob || null }
      }
    }
    else if (path === '/chat/fix') response = { ok: true, human: '检查完成' }
    else if (path === '/memory') response = { ok: true, stats: { dm: 2, comment: 1, bytes: 4096 } }
    else if (path === '/memory/clear') response = { ok: true, stats: { dm: 0, comment: 0, bytes: 0 } }
    else if (path === '/update') response = { ok: true, current: '9.9.9', latest: '9.9.9', checked: true, hasUpdate: false, source: 'npm registry', tried: [] }
    else if (path === '/ai-usage') response = { ok: true, doc: '# 接入说明', mcp: { exists: true, server: 'H:/dy/tools/mcp-server.mjs', selfTest: 'node mcp-server.mjs --selftest', configText: '{"mcpServers":{}}' } }
    else if (path === '/chat/watch') response = { ok: true, health: 'ok', human: '正在等待新消息', sec: 30, checks: 1 }
    else throw new Error('未模拟的接口：' + method + ' ' + path)
    return { ok: true, status: 200, json: async () => clone(response) }
  }
  let mod, registered, overlay = false
  const window = { navigator, __ModuleLoader__: { load(def) { mod = def.factory((name) => { assert.equal(name, 'react'); return React }) } } }
  const setInterval = (fn, delay) => { const id = nextTimer++; intervals.set(id, { fn, delay }); return id }
  const setTimeout = (fn, delay) => { const id = nextTimer++; if (!delay) queueMicrotask(fn); else timeouts.set(id, { fn, delay }); return id }
  new Function('window', 'document', 'navigator', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', source)(
    window, document, navigator, fetch, setInterval, (id) => intervals.delete(id), setTimeout, (id) => timeouts.delete(id))
  assert.ok(mod, 'client must self-register')
  mod.apply({ effect() {}, get: () => ({ inject: (_, fn) => fn(), register: (meta, component) => {
    if (meta.name === 'settings.section') registered = component
    if (meta.name === 'shell.overlay') overlay = true
    return () => {}
  } }) })
  assert.ok(registered, 'settings section must register')
  assert.equal(overlay, false, 'pet overlay must not register')
  function render(element, path = 'root') {
    if (element == null || typeof element === 'boolean') return null
    if (Array.isArray(element)) return element.map((child, i) => render(child, path + '.' + i)).flat(Infinity).filter((child) => child != null)
    if (typeof element === 'string' || typeof element === 'number') return String(element)
    const { type, props } = element
    if (typeof type === 'function') {
      if (type.prototype?.render) return render(new type(props).render(), path + '.class')
      const previous = current, previousCursor = cursor
      current = instances.get(path) || { hooks: [] }; instances.set(path, current); cursor = 0
      const output = type(props)
      current = previous; cursor = previousCursor
      return render(output, path + '.' + (type.name || 'component'))
    }
    return { tag: type, props, children: render(props.children || [], path + '.children') }
  }
  async function flush() {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve(); await Promise.resolve()
      if (dirty) {
        dirty = false
        tree = render(React.createElement(registered, {}))
        const pending = effects; effects = []; for (const effect of pending) effect()
      }
    }
    return tree
  }
  const nodes = (node = tree) => node == null ? [] : Array.isArray(node) ? node.flatMap((item) => nodes(item)) : typeof node === 'string' ? [] : [node, ...nodes(node.children)]
  const text = (node = tree) => node == null ? '' : Array.isArray(node) ? node.map((item) => text(item)).join(' ') : typeof node === 'string' ? node : text(node.children)
  const area = (name) => nodes().find((node) => node.props?.['data-dy-area'] === name)
  const button = (label, scope = tree) => nodes(scope).find((node) => node.tag === 'button' && (text(node) === label || node.props['aria-label'] === label))
  const attr = (name, scope = tree) => nodes(scope).find((node) => name in (node.props || {}))
  const setupRow = (name) => nodes(area('setup')).find((node) => node.props['data-dy-setup-row'] === name)
  const change = async (node, value) => { assert.ok(node, 'input must exist'); node.props.onChange({ target: { value } }); await flush() }
  const clickNode = async (node) => { assert.ok(node, 'button must exist'); assert.ok(!node.props.disabled, 'button must be enabled: ' + text(node)); await node.props.onClick({ target: { value: '' } }); await flush() }
  const click = async (label, section) => clickNode(button(label, section ? area(section) : tree))
  const poll = async (delay = 4000) => { for (const timer of [...intervals.values()]) if (timer.delay === delay) await timer.fn(); await flush() }
  const timeout = async (delay) => { for (const [id, timer] of [...timeouts]) if (timer.delay === delay) { timeouts.delete(id); await timer.fn() } await flush() }
  const dispose = () => { disposed = true; for (const instance of instances.values()) for (const hook of instance.hooks) hook?.cleanup?.(); intervals.clear(); timeouts.clear() }
  return { data, state, calls, copies, flush, nodes, text, area, setupRow, button, attr, change, click, clickNode, poll, timeout, dispose,
    get config() { return config }, get tree() { return tree }, get disposed() { return disposed } }
}

let passed = 0
async function scenario(name, test) {
  try { await test(); passed++; console.log('  ✅ ' + name) }
  catch (error) { console.error('  ❌ ' + name + '\n' + error.stack); process.exitCode = 1 }
}

console.log('【首次使用与常用入口】')
await scenario('常用功能与独立关于区可见，不写配置或读取消息', async () => {
  const h = harness({ state: { loggedIn: false, venvReady: false } }); await h.flush()
  assert.deepEqual(h.nodes().filter((node) => 'data-dy-area' in node.props).map((node) => node.props['data-dy-area']), ['setup', 'run', 'sending', 'messages', 'persona', 'prefs', 'help', 'about'])
  assert.equal(h.nodes().filter((node) => 'data-dy-card' in node.props).length, 8)
  assert.ok(h.nodes().every((node) => !('onClick' in node.props) || typeof node.props.onClick === 'function'))
  assert.deepEqual(h.nodes(h.area('setup')).filter((node) => 'data-dy-setup-row' in node.props).map((node) => node.props['data-dy-setup-row']), ['environment', 'account'])
  assert.match(h.text(h.setupRow('environment')), /运行环境.*首次使用安装一次.*安装环境/)
  assert.match(h.text(h.setupRow('account')), /抖音账号.*将在浏览器中打开扫码页面.*扫码登录/)
  assert.ok(h.button('检查环境', h.area('setup')))
  assert.ok(!h.attr('data-dy-steps', h.area('setup')))
  assert.ok(!h.button('刷新就绪状态', h.area('setup')))
  assert.ok(h.button('现在跑一轮').props.disabled)
  assert.ok(!h.button('保存日期'))
  assert.ok(!h.attr('data-dy-reply-text'))
  assert.ok(!h.attr('data-dy-raw-log'))
  assert.ok(!h.nodes(h.area('persona')).some((node) => node.tag === 'textarea'))
  assert.match(h.text(h.area('persona')), /当前生效：插件自带的那份/)
  assert.ok(h.button('读取消息').props.disabled)
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 0)
  assert.equal(h.calls.filter((call) => ['/inbox', '/chat/read'].includes(call.path)).length, 0)
  assert.ok(h.calls.every((call) => !call.query.includes('log=1')))
  assert.equal(h.config.autoSend, true, 'opening settings preserves the existing sending configuration')
  h.dispose()
})
await scenario('装环境、二维码和登录反馈在操作处更新', async () => {
  const h = harness({ state: { loggedIn: false, venvReady: false } }); await h.flush()
  await h.click('安装环境')
  assert.match(h.text(h.setupRow('environment')), /安装中/)
  h.state.installing = false; h.state.venvReady = true; h.state.install = { phase: 'completed', stage: 'done', endedAt: EPOCH + 60_000 }
  await h.poll(3000)
  assert.match(h.text(h.attr('data-dy-toast')), /运行环境已就绪/)
  assert.ok(h.calls.some((call) => call.path === '/doctor'), 'installation completion refreshes the full check')
  await h.click('扫码登录')
  assert.equal(h.calls.find((call) => call.path === '/login/qr').body.force, '')
  assert.ok(h.attr('data-dy-qr')); assert.match(h.text(h.area('setup')), /短信验证码.*拖动滑块/)
  await h.click('我扫完了')
  assert.ok(!h.attr('data-dy-qr')); assert.ok(!h.button('现在跑一轮').props.disabled)
  assert.match(h.text(h.attr('data-dy-toast')), /登录成功/)
  assert.match(h.text(h.area('run')), /测试账号昵称/)
  assert.ok(!h.text().includes('9999000011112222'))
  h.dispose()
})
await scenario('Cookie 缺失只影响账号，环境检查仍通过且可重新检查', async () => {
  const h = harness({ state: { loggedIn: false, venvReady: true } }); await h.flush()
  await h.click('检查环境', 'setup')
  assert.match(h.text(h.setupRow('environment')), /运行环境 已就绪/)
  assert.ok(!h.attr('data-dy-sub', h.setupRow('environment')), 'ready environment has no redundant explanation')
  assert.ok(!h.text(h.setupRow('environment')).includes('Cookie'))
  assert.ok(!h.attr('data-dy-environment-issues'))
  assert.match(h.text(h.setupRow('account')), /将在浏览器中打开扫码页面/)
  assert.match(h.text(h.attr('data-dy-toast')), /运行环境检查通过/)
  assert.ok(!h.text(h.area('setup')).includes('运行环境检查通过'), 'success does not occupy a persistent row')
  assert.ok(h.button('重新检查', h.area('setup')))
  assert.ok(!h.button('修复环境', h.area('setup')))
  assert.ok(!h.calls.some((call) => call.path === '/environment/repair'))
  await h.timeout(3000)
  assert.ok(!h.attr('data-dy-toast'), 'success toast dismisses automatically')
  assert.match(h.text(h.setupRow('environment')), /已就绪/, 'persistent state remains after toast disappears')
  h.dispose()
})
await scenario('环境缺项在操作处显示处理方法，能直接修复并展开完整检查', async () => {
  const doctor = fixtureDoctor({ loggedIn: true, venvReady: true })
  const signer = { id: 'signer', category: 'environment', required: true, item: '签名器组件', state: 'bad', detail: '缺少 ws',
    fix: '点击「修复环境」安装评论读取组件。', action: { id: 'repair_environment', label: '修复运行环境' } }
  const dsh = { id: 'dsh', category: 'environment', required: true, item: 'DSH 入口', state: 'bad', detail: '找不到后台入口',
    fix: '在帮助与排查中填写 DSH 入口路径，然后重新检查。', action: { id: 'manual', label: '填写 DSH 入口' } }
  doctor.items.push(signer, dsh); doctor.environment = { ready: false, items: [...doctor.environment.items, signer, dsh], repairable: true }
  const h = harness({ data: { doctor } }); await h.flush(); await h.click('检查环境', 'setup')
  assert.match(h.text(h.attr('data-dy-environment-issues')), /签名器组件.*缺少 ws.*修复环境.*DSH 入口.*填写 DSH 入口路径/)
  assert.ok(h.button('修复环境', h.area('setup')))
  await h.click('查看完整检查与处理方法 ↓')
  assert.ok(h.button('看接入方式', h.area('help')), 'the help card was expanded by the inline fix link')
  assert.match(h.text(h.area('help')), /签名器组件.*缺少 ws.*DSH 入口/)
  await h.click('修复环境', 'setup')
  assert.equal(h.calls.filter((call) => call.path === '/environment/repair').length, 1)
  assert.match(h.text(h.setupRow('environment')), /正在安装运行依赖.*安装中/)
  h.dispose()
})
await scenario('修复启动返回 ok:false 时保留可重试入口，不显示乐观安装状态', async () => {
  const h = harness({ state: { loggedIn: false, venvReady: false }, data: { installStart: { ok: false, error: 'Python 不可用，请先安装' } } }); await h.flush()
  await h.click('安装环境')
  assert.match(h.text(h.area('setup')), /装依赖失败：Python 不可用，请先安装/)
  assert.ok(!h.text(h.setupRow('environment')).includes('安装中'))
  assert.ok(!h.text(h.area('setup')).includes('正在补齐运行依赖'))
  assert.ok(!h.button('安装环境').props.disabled)
  assert.equal(h.state.installing, false)
  assert.equal(h.calls.filter((call) => call.path === '/doctor').length, 0)
  h.dispose()
})
await scenario('只有新修复接口为404时回退旧安装入口，安装完成自动重查', async () => {
  const h = harness({ state: { loggedIn: false, venvReady: false }, data: { install404: true } }); await h.flush()
  await h.click('安装环境')
  assert.deepEqual(h.calls.filter((call) => ['/environment/repair', '/install'].includes(call.path)).map((call) => call.path), ['/environment/repair', '/install'])
  h.state.installing = false; h.state.venvReady = true; h.state.install = { phase: 'completed', stage: 'done', endedAt: EPOCH + 60_000 }
  await h.poll(3000)
  assert.match(h.text(h.setupRow('environment')), /已就绪/)
  assert.equal(h.calls.filter((call) => call.path === '/doctor').length, 1)
  assert.match(h.text(h.setupRow('account')), /将在浏览器中打开扫码页面/)
  h.dispose()
})
await scenario('没有二维码元素时仍可确认登录、关闭窗口和重新打开', async () => {
  for (const qr of [
    { ok: false, no_qr_element: true, browser_open: true, can_check: true, hint: '请直接在浏览器扫码' },
    { ok: true, no_qr_element: true, qr_url: '/stale-image.png', hint: '请直接在浏览器扫码' },
  ]) {
    const h = harness({ state: { loggedIn: false }, data: { qr } }); await h.flush()
    await h.click('扫码登录')
    assert.ok(!h.attr('data-dy-qr'), 'no_qr_element takes precedence over an obsolete qr_url')
    assert.match(h.text(h.setupRow('account')), /请直接在浏览器扫码/)
    for (const label of ['我扫完了', '关闭登录窗口', '重新打开登录窗口']) assert.ok(!h.button(label).props.disabled)
    await h.click('我扫完了')
    assert.match(h.text(h.setupRow('account')), /已保存登录态.*测试账号昵称/)
    h.dispose()
  }
})
await scenario('占用冲突或启动失败时，无图片也能强制重新打开登录窗口', async () => {
  for (const initial of [
    { ok: false, conflict: 'profile_in_use', error: '配置正在占用' },
    { ok: false, error: 'Chrome 未能打开', hint: '请检查浏览器安装后重试' },
  ]) {
    const h = harness({ state: { loggedIn: false }, data: { qr: initial } }); await h.flush(); await h.click('扫码登录')
    assert.ok(!h.attr('data-dy-qr'))
    assert.ok(!h.button('重新打开登录窗口').props.disabled)
    assert.match(h.text(h.setupRow('account')), initial.conflict ? /正常关闭插件的后台浏览器/ : /Chrome 未能打开.*检查浏览器安装/)
    h.data.qr = { ok: true, qr_url: '/api/douyin-duty/login/qr.png' }
    await h.click('重新打开登录窗口')
    assert.equal(h.calls.filter((call) => call.path === '/login/qr').at(-1).body.force, '1')
    assert.ok(h.attr('data-dy-qr')); h.dispose()
  }
})
await scenario('已登录响应优先于二维码URL，不让使用者重复扫码', async () => {
  const h = harness({ state: { loggedIn: false }, data: { qr: { ok: true, already_logged_in: true, qr_url: '/stale-image.png' } } }); await h.flush()
  await h.click('扫码登录')
  assert.ok(!h.attr('data-dy-qr')); assert.ok(!h.button('我扫完了'))
  assert.match(h.text(h.setupRow('account')), /已保存登录态.*测试账号昵称/)
  assert.match(h.text(h.attr('data-dy-toast')), /已经直接登录好了/)
  assert.ok(!h.button('现在跑一轮').props.disabled)
  h.dispose()
})
await scenario('登录窗口异步打开期间禁用重复点击，旧事件也不能重复请求', async () => {
  let release
  const h = harness({ state: { loggedIn: false }, data: { qr: () => new Promise((resolve) => { release = resolve }) } }); await h.flush()
  const login = h.button('扫码登录')
  const first = login.props.onClick(); const second = login.props.onClick(); await h.flush()
  assert.equal(h.calls.filter((call) => call.path === '/login/qr').length, 1)
  assert.ok(h.button('打开中…').props.disabled)
  release({ ok: true, qr_url: '/api/douyin-duty/login/qr.png' }); await first; await second; await h.flush()
  assert.ok(h.attr('data-dy-qr')); h.dispose()
})
await scenario('环境修复异步启动期间不重复安装，二维码图片失败仍可继续登录', async () => {
  let release
  const h = harness({ state: { loggedIn: false, venvReady: false }, data: { installStart: () => new Promise((resolve) => { release = resolve }) } }); await h.flush()
  const install = h.button('安装环境')
  const first = install.props.onClick(); const second = install.props.onClick(); await h.flush()
  assert.equal(h.calls.filter((call) => call.path === '/environment/repair').length, 1)
  assert.match(h.text(h.setupRow('environment')), /安装中/)
  assert.ok(h.button('扫码登录').props.disabled)
  release({ ok: true, started: true, install: { phase: 'running', stage: 'dependencies' } }); await first; await second; await h.flush()
  h.state.installing = false; h.state.venvReady = true; h.state.install = { phase: 'completed', stage: 'done' }; await h.poll(3000)
  await h.click('扫码登录'); h.attr('data-dy-qr').props.onError(); await h.flush()
  assert.ok(!h.attr('data-dy-qr'))
  assert.match(h.text(h.setupRow('account')), /二维码图片未加载/)
  assert.ok(!h.button('我扫完了').props.disabled)
  assert.ok(!h.button('重新打开登录窗口').props.disabled)
  h.dispose()
})
await scenario('设置读取失败有重试，结果读取失败与空结果分开', async () => {
  const h = harness({ data: { statusError: true } }); await h.flush()
  assert.match(h.text(), /暂时没能读取设置/)
  h.data.statusError = false; await h.click('重新读取')
  assert.ok(h.area('setup'))
  h.data.reportError = true; await h.click('刷新结果')
  assert.match(h.text(h.area('run')), /暂时无法读取推荐结果/)
  h.dispose()
})

console.log('\n【运行、额度与结果】')
await scenario('自动额度用完或计划暂停仍可一键手动运行，发送范围明确', async () => {
  const h = harness({ config: { autoEnabled: false, perDay: 0, autoSend: false } }); await h.flush()
  assert.match(h.text(h.area('run')), /手动每轮最多推荐 3 条，不占自动额度/)
  assert.match(h.text(h.area('run')), /本轮只生成推荐，不自动发送/)
  assert.ok(!h.button('现在跑一轮').props.disabled)
  await h.click('现在跑一轮')
  assert.equal(h.calls.filter((call) => call.path === '/run').length, 1)
  assert.equal(h.calls.filter((call) => call.path === '/config' && call.method === 'POST').length, 0)
  h.dispose()
})
await scenario('启动中禁重入，运行期间保留上一轮，结束自动更新结果', async () => {
  let release
  const h = harness({ data: { run: () => new Promise((resolve) => { release = resolve }) } }); await h.flush()
  const start = h.button('现在跑一轮')
  const pending = start.props.onClick(); await h.flush()
  const duplicate = start.props.onClick(); await h.flush()
  assert.equal(h.calls.filter((call) => call.path === '/run').length, 1)
  assert.match(h.text(h.area('run')), /正在准备这一轮/)
  h.data.round = round('running', { id: 'round-two', startedAt: Date.now(), endedAt: null, result: null })
  await h.poll()
  assert.match(h.text(h.area('run')), /上一轮推荐 · 本轮结果尚未生成/)
  assert.match(h.text(h.area('run')), /最近的作品/)
  h.data.round = round('completed', { id: 'round-two', startedAt: h.data.round.startedAt, endedAt: Date.now() + 60_000, warnings: [] })
  h.data.counts = { auto: 5, manual: 2, unknown: 2, total: 9 }
  h.data.reports.recent = { ...h.data.reports.recent, roundId: 'round-two', picks: [{ id: '7401234567890123402', title: '新的作品', text: '新理由', url: 'https://www.douyin.com/video/7401234567890123402' }] }
  h.data.reportStamp = 'stamp-two'; release({ ok: true }); await pending; await duplicate; await h.flush(); await h.poll()
  assert.match(h.text(h.area('run')), /本轮已完成/)
  assert.match(h.text(h.area('run')), /新的作品/)
  assert.match(h.text(h.attr('data-dy-stats')), /手动推荐\s+2\s+条/)
  assert.ok(!h.button('现在跑一轮').props.disabled)
  const completedReads = h.calls.filter((call) => call.path === '/progress').length
  await h.poll(); await h.poll()
  assert.equal(h.calls.filter((call) => call.path === '/progress').length, completedReads, 'completed runs return to slower polling')
  h.dispose()
})
await scenario('刷新等待在途轮询后重读今日计数，旧日结果不会覆盖今日统计', async () => {
  const h = harness({ data: { round: round('running'), counts: { auto: 0, manual: 0, unknown: 0, total: 0 } } }); await h.flush()
  let release
  h.data.progress = (snapshot) => new Promise((resolve) => { release = () => resolve(snapshot) })
  const polling = h.poll(); await h.flush()
  const before = h.calls.filter((call) => call.path === '/progress').length
  h.data.progress = null
  h.data.counts = { auto: 0, manual: 1, unknown: 0, total: 1 }
  h.data.reports.recent = { ...h.data.reports.recent, day: '2026-11-02', counts: { auto: 9, manual: 9, total: 18 } }
  const refresh = h.click('刷新结果'); await h.flush()
  assert.ok(h.button('读取中…').props.disabled)
  release(); await polling; await refresh
  assert.ok(h.calls.filter((call) => call.path === '/progress').length > before, 'a fresh progress read follows the in-flight poll')
  assert.match(h.text(h.attr('data-dy-stats')), /今日推荐\s+1\s+条.*手动推荐\s+1\s+条/)
  assert.ok(!h.text(h.attr('data-dy-stats')).includes('18'))
  h.dispose()
})
await scenario('0 条是有效完成；推荐、日报和三种发送结果分别展示', async () => {
  const h = harness({ data: { round: round('completed', { warnings: [], result: { recommendations: 0, reportUpdated: false, sends: { dm: { succeeded: 1, failed: 2, unknown: 3 }, card: { succeeded: 0, failed: 0, unknown: 1 }, comment: { succeeded: 1, failed: 0, unknown: 0 } } } }) } })
  h.data.reports.recent.picks = []; await h.flush()
  assert.match(h.text(h.area('run')), /本轮已完成，暂无新的合适内容/)
  assert.match(h.text(h.area('run')), /新增 0 条推荐 · 本轮未更新日报/)
  assert.match(h.text(h.area('run')), /私信：成功 1，失败 2，未确认 3/)
  assert.match(h.text(h.area('run')), /卡片：成功 0，失败 0，未确认 1/)
  assert.match(h.text(h.area('run')), /旧记录未区分 2 条/)
  h.dispose()
})
await scenario('状态未知不自动宣称成功，不允许重复启动', async () => {
  const h = harness({ data: { round: round('unknown', { result: null }) } }); await h.flush()
  assert.match(h.text(h.area('run')), /暂未确认本轮是否结束/)
  assert.ok(h.button('运行中…').props.disabled)
  assert.equal(h.calls.filter((call) => call.path === '/run').length, 0)
  h.dispose()
})
await scenario('进程已结束但结果未确认时保留旧结果，仍可明确手动重跑', async () => {
  const h = harness({ data: { running: false, round: round('unknown', { result: { validated: false, recommendations: 0, reportUpdated: false, sends: emptySends() } }) } })
  await h.flush()
  assert.match(h.text(h.area('run')), /本轮推荐结果尚未确认，保留最近一次结果/)
  assert.ok(!h.text(h.area('run')).includes('新增 0 条推荐'))
  assert.ok(!h.button('现在跑一轮').props.disabled)
  h.dispose()
})
await scenario('最近/今日范围、笔记链接和 Markdown 安全排版', async () => {
  const h = harness(); await h.flush()
  assert.match(h.text(h.area('run')), /最近的作品/)
  assert.equal(h.nodes().find((node) => node.tag === 'a' && h.text(node) === '打开作品 ↗').props.href, 'https://www.douyin.com/note/7401234567890123401')
  await h.click('今日全部'); assert.match(h.text(h.area('run')), /今日的作品/)
  await h.click('完整日报')
  assert.ok(h.nodes().some((node) => node.tag === 'strong' && h.text(node) === '加粗理由'))
  assert.ok(h.nodes().some((node) => node.tag === 'li' && h.text(node) === '一条推荐'))
  assert.ok(!h.nodes().some((node) => node.tag === 'script' || node.props?.dangerouslySetInnerHTML))
  assert.ok(!h.nodes().some((node) => node.tag === 'a' && String(node.props.href).startsWith('javascript:')))
  assert.ok(!h.text().includes('**加粗理由**'))
  h.dispose()
})
await scenario('本轮记录与原始日志默认折叠，提醒过滤和复制均脱敏', async () => {
  const h = harness(); await h.flush()
  assert.ok(!h.attr('data-dy-events'))
  await h.click('本轮记录')
  assert.match(h.text(h.attr('data-dy-events')), /开始获取候选.*部分评论未读到/)
  assert.ok(!h.nodes().some((node) => node.tag === 'pre' && h.text(node).includes('SECRET_COOKIE')))
  await h.click('只看提醒')
  assert.ok(!h.text(h.attr('data-dy-events')).includes('开始获取候选'))
  const raw = h.attr('data-dy-raw-log'); raw.props.onToggle({ currentTarget: { open: true } }); await h.flush()
  assert.match(h.text(h.area('run')), /旧轮次日志/)
  assert.ok(!h.text().includes('SECRET_COOKIE') && !h.text().includes('SECRET_HOOK'))
  await h.click('复制原始日志')
  assert.ok(!h.copies.at(-1).includes('SECRET_COOKIE') && !h.copies.at(-1).includes('SECRET_HOOK'))
  assert.match(h.copies.at(-1), /douyin\.com\/note/)
  await h.click('本轮记录'); await h.click('现在跑一轮')
  assert.ok(!h.calls.filter((call) => call.path === '/progress').at(-1).query.includes('log=1'), 'closing records stops raw log reads')
  h.dispose()
})

console.log('\n【DSH 评论回复】')
await scenario('评论无手工输入，阅读只查状态；一次点击交给 DSH 并保留作品、评论和楼根', async () => {
  let release
  const h=harness({config:{autoSend:false},data:{commentAI:()=>new Promise(resolve=>{release=resolve})}});await h.flush();await h.click('读取消息');await h.click('评论区 @ 与回复')
  assert.equal(h.nodes(h.area('messages')).filter(n=>['textarea','input'].includes(n.tag)).length,0)
  assert.doesNotMatch(h.text(h.area('messages')),/写下要回复|确认回复|没回过/)
  assert.match(h.text(h.area('messages')),/过往发言/)
  assert.equal(h.calls.filter(c=>c.path==='/comment/ai-reply'&&c.method==='POST').length,0)
  const action=h.attr('data-dy-ai-comment');const first=action.props.onClick(),second=action.props.onClick();await h.flush()
  assert.equal(h.calls.filter(c=>c.path==='/comment/ai-reply'&&c.method==='POST').length,1)
  assert.deepEqual(h.calls.find(c=>c.path==='/comment/ai-reply'&&c.method==='POST').body,{
    aweme_id:'7693806860863802662',comment_id:'7699090731688952613',root_comment_id:'7699090731688952600',work_url:'https://www.douyin.com/note/7693806860863802662',aweme_type:68,confirm:true})
  release({ok:true,job:{id:'comment-job-one',status:'sent',done:true,sent:true,text:'DSH 评论回复'}});await first;await second;await h.flush()
  assert.match(h.text(h.area('messages')),/DSH 已回复.*DSH 评论回复/)
  assert.ok(h.attr('data-dy-ai-comment').props.disabled)
  assert.equal(h.calls.filter(c=>c.path==='/comment/reply').length,0)
  h.dispose()
})
await scenario('评论生成失败可重试，发送结果未确认只查询不重发', async () => {
  const h=harness({data:{commentAI:{ok:true,job:{id:'comment-fail',status:'failed',done:true,error:'模型不可用，没有发送'}}}});await h.flush();await h.click('读取消息');await h.click('评论区 @ 与回复')
  await h.click('DSH 回复');assert.match(h.text(h.area('messages')),/模型不可用/);assert.ok(!h.attr('data-dy-ai-comment').props.disabled)
  h.data.commentAI={ok:true,job:{id:'comment-unknown',status:'uncertain',done:true,error:'发送结果无法确认'}}
  await h.click('DSH 回复');assert.ok(h.attr('data-dy-ai-comment').props.disabled)
  await h.click('查询处理结果');assert.match(h.text(h.area('messages')),/发送结果无法确认/)
  assert.equal(h.calls.filter(c=>c.path==='/comment/ai-reply'&&c.method==='POST').length,2)
  h.dispose()
})
await scenario('已发送但落位存疑保留正文和说明，恢复状态不再启动任务', async () => {
  const h=harness({data:{commentJob:{id:'saved-job',status:'sent-warning',done:true,sent:true,text:'已发出的正文',note:'回复位置未确认，请核对原评论'}}});await h.flush();await h.click('读取消息');await h.click('评论区 @ 与回复')
  assert.match(h.text(h.area('messages')),/已发送，回复位置待核对.*已发出的正文/)
  assert.ok(h.attr('data-dy-ai-comment').props.disabled)
  assert.equal(h.calls.filter(c=>c.path==='/comment/ai-reply'&&c.method==='POST').length,0)
  h.dispose()
})
await scenario('评论缺少标识禁止生成；状态读取失败可只读重试', async () => {
  const h=harness();h.data.inbox.at=[inboxItem({comment_id:''})];await h.flush();await h.click('读取消息');await h.click('评论区 @ 与回复')
  assert.ok(h.attr('data-dy-ai-comment').props.disabled);assert.match(h.text(h.area('messages')),/缺少原评论标识/)
  assert.equal(h.calls.filter(c=>c.path==='/comment/ai-reply').length,0);h.dispose()
  const e=harness({data:{commentStatusError:true}});await e.flush();await e.click('读取消息');await e.click('评论区 @ 与回复')
  assert.ok(e.attr('data-dy-ai-comment').props.disabled);assert.match(e.text(e.area('messages')),/回复状态暂不可用/)
  e.data.commentStatusError=false;await e.click('查询处理结果');assert.ok(!e.attr('data-dy-ai-comment').props.disabled)
  assert.equal(e.calls.filter(c=>c.path==='/comment/ai-reply'&&c.method==='POST').length,0);e.dispose()
})

console.log('\n【计划与原有能力回归】')
await scenario('计划草稿统一保存；默认时段与自定义共同生效，清空自定义不影响默认', async () => {
  const h = harness(); await h.flush(); await h.click('运行偏好')
  const selector = h.nodes().find((node) => node.tag === 'select' && node.props['aria-label'] === '重复日期')
  await h.change(selector, 'weekdays')
  assert.equal(h.calls.filter(c=>c.path==='/config'&&c.method==='POST').length,0)
  await h.click('保存计划')
  assert.deepEqual(h.config.scheduleDays, [1, 2, 3, 4, 5])
  await h.change(h.nodes().find(n=>n.props['aria-label']==='重复日期'),'custom')
  const monday = h.nodes().find((node) => node.tag === 'button' && node.props['aria-label'] === '周一')
  await h.clickNode(monday); await h.click('保存计划')
  assert.deepEqual(h.config.scheduleDays, [2, 3, 4, 5])
  assert.equal(h.nodes().filter(n=>n.props['data-dy-plan-window']!==undefined).length,1)
  await h.clickNode(h.nodes().find(n=>n.props['aria-label']==='移除自定义时段 1'))
  await h.click('保存计划'); assert.deepEqual(h.config.windows, [])
  assert.equal(h.config.noon,true);assert.equal(h.config.night,true)
  assert.deepEqual(h.calls.filter((call) => call.path === '/config' && call.body?.windows).at(-1).body.__clearKeys, ['windows'])
  assert.match(h.text(h.area('prefs')), /跨午夜.*开始日期/)
  h.dispose()
})
await scenario('关闭的两个默认时段仍可见，切换只改草稿；失败保留，重新启用可检查冲突', async () => {
  const h=harness({config:{noon:false,night:false,windows:[{start:'13:00',end:'15:00',label:'午后'}]}})
  await h.flush();await h.click('运行偏好')
  const toggle=name=>h.nodes().find(n=>n.props.role==='switch'&&n.props['aria-label']===name)
  assert.equal(toggle('中午时段').props['aria-checked'],false)
  assert.equal(toggle('夜间时段').props['aria-checked'],false)
  assert.match(h.text(h.area('prefs')),/12:00–14:00/);assert.match(h.text(h.area('prefs')),/18:00–次日 09:00/)
  await h.clickNode(toggle('中午时段'))
  assert.match(h.text(h.area('prefs')),/中午与自定义时段 1重叠/)
  assert.ok(h.button('保存计划').props.disabled);assert.equal(h.config.noon,false)
  await h.clickNode(toggle('中午时段'));await h.clickNode(toggle('夜间时段'))
  assert.equal(h.calls.filter(c=>c.method==='POST'&&c.path==='/config').length,0)
  h.data.configError=true;await h.click('保存计划');assert.equal(h.config.night,false)
  assert.equal(toggle('夜间时段').props['aria-checked'],true)
  h.data.configError=false;await h.click('保存计划');assert.equal(h.config.night,true)
  assert.equal(h.config.noon,false);assert.deepEqual(h.config.windows,[{start:'13:00',end:'15:00',label:'午后'}])
  await h.clickNode(toggle('夜间时段'));await h.click('保存计划')
  assert.equal(toggle('夜间时段').props['aria-checked'],false)
  assert.equal(h.nodes().filter(n=>n.props['data-dy-plan-preset']!==undefined).length,2)
  h.dispose()
})
await scenario('保存失败保留数量/时段草稿，反馈留在运行偏好', async () => {
  const h = harness(); await h.flush(); await h.click('运行偏好')
  const input = h.nodes().find((node) => node.tag === 'input' && node.props['aria-label'] === '手动每轮最多推荐')
  await h.change(input, '7'); h.data.configError = true; await h.click('保存手动数量')
  assert.equal(h.nodes().find((node) => node.props['aria-label'] === '手动每轮最多推荐').props.value, '7')
  assert.match(h.text(h.area('prefs')), /保存失败/)
  h.data.configError = false; await h.click('保存手动数量'); assert.equal(h.config.manualPerRun, 7)
  await h.clickNode(h.nodes().find(n=>n.props['aria-label']==='移除自定义时段 1'))
  h.data.configError = true; await h.click('保存计划'); assert.ok(!h.button('保存计划').props.disabled)
  assert.match(h.text(h.attr('data-dy-plan')), /保存失败/)
  h.dispose()
})
await scenario('计划冲突与跨午夜校验；编辑草稿不会提前生效，收起后保留', async () => {
  const h=harness({config:{noon:true,night:false,windows:[],scheduleDays:[1]}});await h.flush();await h.click('运行偏好')
  const field=label=>h.nodes().find(n=>n.props['aria-label']===label)
  await h.click('添加自定义时段');assert.ok(h.button('保存计划').props.disabled)
  await h.change(field('自定义时段 1 开始'),'13:00');await h.change(field('自定义时段 1 结束'),'15:00')
  assert.match(h.text(h.area('prefs')),/重叠/);assert.ok(h.button('保存计划').props.disabled)
  await h.change(field('自定义时段 1 开始'),'23:00');await h.change(field('自定义时段 1 结束'),'01:00')
  assert.match(h.text(h.area('prefs')),/结束 · 次日/);assert.ok(!h.button('保存计划').props.disabled)
  await h.click('运行偏好');await h.click('运行偏好')
  assert.equal(field('自定义时段 1 开始').props.value,'23:00')
  assert.equal(h.calls.filter(c=>c.path==='/config'&&c.method==='POST').length,0)
  await h.click('保存计划');assert.deepEqual(h.config.windows,[{start:'23:00',end:'01:00',label:''}])
  await h.change(field('自定义时段 1 开始'),'01:00');assert.match(h.text(h.area('prefs')),/开始与结束不能相同/)
  h.dispose()
})
await scenario('原有重叠计划仍能单独暂停，保存失败保留原计划和草稿', async () => {
  const h=harness({config:{windows:[{start:'13:00',end:'15:00'}]}});await h.flush();await h.click('运行偏好')
  await h.click('暂停当前计划')
  assert.equal(h.config.autoEnabled,false);assert.equal(h.config.windows[0].start,'13:00')
  assert.deepEqual(h.calls.filter(c=>c.path==='/config'&&c.method==='POST').at(-1).body,{autoEnabled:false})
  h.dispose()
})
await scenario('人设草稿可扩大、收起、撤销；只保存明确编辑的内容', async () => {
  const h=harness();await h.flush();await h.click('编辑人设')
  assert.ok(h.button('保存人设').props.disabled)
  await h.click('扩大编辑区');assert.equal(h.attr('data-dy-persona-text').props['data-large'],'')
  await h.change(h.attr('data-dy-persona-text'),'新的表达边界')
  await h.click('收起编辑');await h.click('编辑人设')
  assert.equal(h.attr('data-dy-persona-text').props.value,'新的表达边界')
  assert.equal(h.calls.filter(c=>c.path==='/persona'&&c.method==='POST').length,0)
  await h.click('撤销修改','persona');assert.match(h.attr('data-dy-persona-text').props.value,/插件口吻/)
  await h.change(h.attr('data-dy-persona-text'),'新的表达边界');await h.click('保存人设')
  assert.equal(h.calls.filter(c=>c.path==='/persona'&&c.method==='POST').length,1)
  assert.match(h.text(h.attr('data-dy-toast')),/人设已保存/);h.dispose()
})

await scenario('联系人、群聊限制、主动 @ 多选与手动联系人仍可用', async () => {
  const h = harness(); await h.flush(); await h.click('选择接收人')
  assert.match(h.text(h.attr('data-dy-recipients')), /重名/)
  const option = (name) => h.nodes().find((node) => node.props.role === 'checkbox' && node.props['aria-label'] === name)
  await h.clickNode(option('测试群聊'))
  assert.match(h.text(h.area('sending')), /网页端群聊.*手机端正常/)
  assert.equal(h.config.dmPeers.at(-1).nick, '测试群聊')
  await h.clickNode(h.nodes().find((node) => node.tag === 'summary' && h.text(node) === '手动添加接收人'))
  await h.change(h.nodes().find((node) => node.tag === 'input' && node.props.placeholder === '比如：示例好友'), '手动好友')
  await h.change(h.nodes().find((node) => node.tag === 'input' && node.props.placeholder === 'MS4wLjABAAAA…'), 'MS4wLjABAAAA_manual')
  await h.click('添加接收人'); assert.equal(h.config.dmPeers.at(-1).nick, '手动好友')
  await h.click('完成')
  const atSwitch = h.nodes(h.area('sending')).find((node) => node.props.role === 'switch' && node.props['aria-label'] === '评论区 @ 提醒')
  await h.clickNode(atSwitch); assert.equal(h.config.commentAtMe, true)
  await h.click('选择 @ 对象')
  assert.equal(option('测试群聊').props.disabled, true)
  const atCandidates = h.nodes().filter((node) => node.props.role === 'checkbox' && !node.props.disabled)
  await h.clickNode(atCandidates[0]); assert.ok(h.config.atPeers.length)
  await h.clickNode(h.nodes().find((node) => node.props.role === 'checkbox' && node.props['aria-checked']))
  assert.equal(h.config.atPeers.length, 0)
  assert.deepEqual(h.calls.filter((call) => call.path === '/config' && call.method === 'POST').at(-1).body.__clearKeys, ['atPeers'])
  assert.equal(h.calls.filter((call) => call.path === '/dm/people').length, 1, 'both pickers reuse the loaded conversations')
  assert.equal(h.calls.filter((call) => /\/chat\/send|\/comment\/reply|\/run$/.test(call.path)).length, 0)
  h.dispose()
})
await scenario('发送设置保存失败保留选中状态，搜索和关闭弹窗不修改配置', async () => {
  const h = harness(); await h.flush(); await h.click('选择接收人')
  h.data.configError = true
  await h.clickNode(h.nodes().find((node) => node.props.role === 'checkbox' && !node.props.disabled))
  assert.equal(h.config.dmPeers.length, 0)
  assert.match(h.text(h.attr('data-dy-recipients')), /保存失败/)
  const count = h.calls.filter((call) => call.path === '/config' && call.method === 'POST').length
  await h.change(h.nodes().find((node) => node.props['aria-label'] === '搜索会话昵称'), '没有这个名字')
  assert.match(h.text(h.attr('data-dy-recipients')), /没有匹配的会话/)
  await h.click('完成')
  assert.equal(h.calls.filter((call) => call.path === '/config' && call.method === 'POST').length, count)
  assert.equal(h.attr('data-dy-recipients'), undefined)
  h.dispose()
})
await scenario('私信按分类读取，评论慢或失败不阻塞私信；刷新失败保留原会话', async () => {
  const h=harness();await h.flush();await h.click('读取消息')
  assert.deepEqual(h.calls.filter(c=>c.path==='/inbox').map(c=>c.query),['?scope=dm'])
  const old=h.data.inbox;let finish
  h.data.inbox=scope=>scope==='comment'?new Promise(resolve=>{finish=resolve}):{ok:false,error:'暂时断线'}
  await h.click('评论区 @ 与回复');assert.match(h.text(h.area('messages')),/正在读取最近的消息/)
  await h.click('私信 · 1');assert.ok(h.attr('data-dy-inbox-dm'))
  await h.click('刷新消息');assert.ok(h.attr('data-dy-inbox-dm'));assert.match(h.text(h.area('messages')),/暂时断线/)
  finish({ok:false,error:'评论读取失败'});await h.flush()
  assert.doesNotMatch(h.text(h.area('messages')),/评论读取失败/)
  h.data.inbox=old;await h.click('刷新消息');assert.doesNotMatch(h.text(h.area('messages')),/暂时断线/)
  h.dispose()
})
await scenario('私信阅读只读，显式点击才让 DSH 生成并发送；不受自动发送开关影响', async () => {
  const h = harness({ config: { autoSend: false, chatWatch: false } }); await h.flush(); await h.click('读取消息')
  await h.clickNode(h.attr('data-dy-inbox-dm'))
  assert.match(h.text(h.area('messages')), /关于对方：喜欢猫、在杭州/)
  const bubbles = h.nodes().filter((node) => 'data-dy-bubble' in node.props)
  assert.ok(bubbles.some((node) => node.props['data-mine'] !== undefined))
  assert.ok(bubbles.some((node) => node.props['data-them'] !== undefined))
  assert.ok(bubbles.some((node) => h.text(node).includes('分享卡片')))
  assert.equal(h.calls.filter((c) => c.path === '/chat/reply' && c.method === 'POST').length, 0)
  assert.equal(h.nodes(h.area('messages')).filter((n) => n.tag === 'input').length, 0)
  await h.click('DSH 回复')
  assert.deepEqual(h.calls.find((c) => c.path === '/chat/reply' && c.method === 'POST').body, {to:'测试好友',to_id:'MS4wLjABAAAA_test1',confirm:true})
  assert.match(h.text(h.area('messages')), /DSH 已回复.*DSH 生成的回复/)
  assert.equal(h.calls.filter((c) => c.path === '/chat/send').length, 0)
  assert.equal(h.config.autoSend, false); assert.equal(h.config.chatWatch, false)
  h.dispose()
})
await scenario('DSH 回复进行中防连点，断线后只查询；结果不明不能重发', async () => {
  const h = harness({data:{aiReply: async () => { throw new Error('连接中断') }}}); await h.flush(); await h.click('读取消息'); await h.clickNode(h.attr('data-dy-inbox-dm'))
  const action=h.button('DSH 回复'); await action.props.onClick(); await action.props.onClick(); await h.flush()
  assert.equal(h.calls.filter(c=>c.path==='/chat/reply'&&c.method==='POST').length,1)
  assert.match(h.text(h.area('messages')), /暂未确认处理结果/)
  h.data.aiJob={id:'job-one',status:'uncertain',done:true,error:'发送结果未确认，请核对原会话'}
  await h.click('查询处理结果')
  assert.ok(h.button('DSH 回复').props.disabled)
  assert.match(h.text(h.area('messages')), /发送结果待核对/)
  h.data.aiJob.inbound = { text: '我也爱你', at: 'old' }
  h.data.chatRead = { ok: true, messages: [{ from: 'them', text: '新的问题', at: 'new' }] }
  await h.click('刷新对话')
  assert.ok(!h.button('DSH 回复').props.disabled, 'new inbound may be handled without retrying old uncertain send')
  assert.match(h.text(h.area('messages')), /对方又发来了新消息/)
  h.dispose()
})
await scenario('模型明确失败可重试，关闭对话或切分类不会触发发送', async () => {
  const h=harness({data:{aiReply:async()=>({ok:false,error:'请先选择模型'})}});await h.flush();await h.click('读取消息');await h.clickNode(h.attr('data-dy-inbox-dm'))
  await h.click('DSH 回复');assert.match(h.text(h.area('messages')),/请先选择模型/)
  assert.ok(!h.button('DSH 回复').props.disabled)
  await h.click('返回私信');await h.clickNode(h.button('评论区 @ 与回复 · 1') || h.button('评论区 @ 与回复'))
  assert.equal(h.calls.filter(c=>c.path==='/chat/reply'&&c.method==='POST').length,1)
  h.dispose()
})
await scenario('人设来源常驻、插件正文与中性回退可编辑保存；记忆按需展开', async () => {
  const h = harness(); await h.flush(); await h.click('编辑人设')
  const editor = h.nodes(h.area('persona')).find((node) => node.tag === 'textarea')
  assert.match(editor.props.value, /插件口吻/)
  await h.change(editor, '我的新口吻')
  assert.match(h.text(h.area('persona')), /当前生效：插件自带的那份/, 'editing is not an effective source change')
  await h.click('保存人设', 'persona')
  assert.match(h.text(h.area('persona')), /当前生效：我写的人设/)
  await h.click('填入中性默认'); assert.match(h.nodes(h.area('persona')).find((node) => node.tag === 'textarea').props.value, /中性默认/)
  await h.click('读取统计')
  assert.match(h.text(h.area('messages')), /私信 2 人.*评论 1 条作品/)
  await h.click('清空全部记忆'); assert.equal(h.calls.filter(c=>c.path==='/memory/clear').length,0)
  await h.click('取消'); assert.ok(h.button('清空全部记忆'))
  assert.ok(!h.text().includes('不上传'))
  h.dispose()
})
await scenario('帮助保留环境检查、DSH 路径、MCP、更新和使用说明', async () => {
  const h = harness(); await h.flush(); await h.click('帮助与排查')
  await h.click('检查环境', 'help'); assert.match(h.text(h.area('help')), /运行环境.*可以使用/)
  await h.click('看接入方式'); assert.match(h.text(h.area('help')), /mcpServers/)
  await h.click('复制 MCP 配置'); assert.match(h.copies.at(-1), /mcpServers/)
  assert.ok(h.nodes(h.area('help')).some((node) => node.tag === 'input' && String(node.props.placeholder).includes('cli.js')))
  await h.click('检查更新'); assert.match(h.text(h.area('about')), /已是最新版本/)
  assert.equal(h.nodes().filter(n=>n.tag==='button'&&h.text(n)==='检查更新').length,1)
  await h.click('使用指南')
  assert.equal(h.attr('data-dy-guide').tag, 'dialog')
  assert.match(h.text(h.attr('data-dy-guide')), /新手流程/)
  assert.doesNotMatch(h.text(h.area('run')), /新手流程/)
  await h.click('关闭'); assert.ok(!h.attr('data-dy-guide'))
  h.dispose()
})
await scenario('使用指南读取失败在弹窗内重试，Escape 关闭', async () => {
  const h = harness({ data: { guideError: true } }); await h.flush(); await h.click('使用指南')
  assert.match(h.text(h.attr('data-dy-guide')), /使用指南读取失败/)
  h.data.guideError = false; await h.click('重新读取指南')
  assert.match(h.text(h.attr('data-dy-guide')), /新手流程/)
  h.attr('data-dy-guide').props.onCancel({ preventDefault() {} }); await h.flush()
  assert.ok(!h.attr('data-dy-guide'))
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 0)
  h.dispose()
})
await scenario('桌宠隔离与真 @ 工具约定继续有效', async () => {
  const backend = readFileSync(join(ROOT, 'index.js'), 'utf8')
  const code = backend.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  assert.match(code, /petStateOf/); assert.match(code, /deskpetStateSource/)
  assert.doesNotMatch(code, /petWinWrite|pet-window-state\.json|spawn\(hostExe|PetHost\.exe/)
  assert.doesNotMatch(source, /onChange:.*patch\(\{ petLinkTo/)
  assert.doesNotMatch(source, /slots\.inject\('shell\.overlay'/)
  assert.match(backend, /douyin_comment_mention/)
  assert.doesNotMatch(backend, /mode = "ui"|mode="ui"/)
  const h = harness(); await h.flush(); assert.ok(!h.text().includes('联动桌宠')); h.dispose()
})

console.log(`\n渲染检查：${passed} 个场景通过${process.exitCode ? '，存在失败' : ''}`)
