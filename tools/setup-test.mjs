/** Offline setup repair and QR regressions; all subprocesses, browser/CDP and credentials are mocked. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { summarizeSetup, REPAIR_ENVIRONMENT, LOGIN_ACTION, PY_IMPORT_PROBE, PY_PACKAGES } from '../lib/setup-health.mjs'

const root = new URL('../', import.meta.url)
const source = (file) => readFileSync(new URL(file, root), 'utf8')
const noEffect = () => { throw new Error('unexpected external operation') }
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

test('environment and account diagnostics have separate readiness and repair actions', () => {
  const cookie = { id: 'cookie', category: 'account', required: true, state: 'bad', action: LOGIN_ACTION }
  const python = { id: 'httpx', category: 'environment', required: true, state: 'ok', action: REPAIR_ENVIRONMENT }
  const idle = { category: 'environment', required: false, state: 'warn' }
  const healthy = summarizeSetup([cookie, python, idle])
  assert.equal(healthy.environment.ready, true); assert.equal(healthy.environment.repairable, false)
  assert.equal(healthy.account.ready, false); assert.equal(healthy.account.actions[0].id, 'login')
  const missing = summarizeSetup([cookie, { ...python, state: 'bad' }])
  assert.equal(missing.environment.ready, false)
  assert.equal(missing.environment.actions[0].endpoint, '/api/douyin-duty/environment/repair')
  assert.ok(!missing.environment.items.some((item) => item.id === 'cookie'))
})

async function doctor({ httpx = true, curl = true, cookie = false } = {}) {
  const captured = []
  const code = source('tools/doctor.mjs').replace(/^#![^\n]*\n/, '').replace(/^import .*$/gm, '')
  const context = {
    process: { argv: ['node', 'doctor', '--json'], platform: 'win32', env: {}, versions: { node: '24.0.0' } },
    join, homeDir: () => '/fixture', pluginDir: () => '/plugin', findBrowser: () => '/browser',
    existsSync: (path) => String(path).includes('douyin_cookie') ? cookie : true,
    readFileSync: () => 'fixture', statSync: () => ({ size: 2000 }),
    setupFiles: () => ({ python: '/venv/python', pythonExists: true }),
    PY_IMPORT_PROBE, PY_PACKAGES, summarizeSetup, REPAIR_ENVIRONMENT, LOGIN_ACTION,
    spawnSync: (cmd, args) => args[0] === '--version' ? { status: 0, stdout: 'Python 3.12' }
      : { status: 0, stdout: JSON.stringify({ httpx: { ok: httpx }, curl_cffi: { ok: curl, error: 'mock import failure' } }) },
    fetch: async () => ({ ok: false }), AbortSignal,
    console: { log(value) { captured.push(value) } },
  }
  await vm.runInNewContext(`(async () => {${code}\n})()`, context)
  return JSON.parse(captured[0])
}
test('actual doctor requires both package imports while missing Cookie belongs only to account', async () => {
  const healthy = await doctor()
  assert.equal(healthy.environment.ready, true)
  assert.equal(healthy.account.ready, false)
  assert.ok(healthy.must_fix.some((row) => row.id === 'cookie'), 'legacy combined result remains compatible')
  const broken = await doctor({ curl: false })
  assert.equal(broken.environment.ready, false)
  assert.equal(broken.environment.repairable, true)
  assert.equal(broken.environment.items.find((row) => row.id === 'curl_cffi').state, 'bad')
})

function installer({ packages = true, signer = true, signerExit = 0 } = {}) {
  const calls = [], cfg = { pythonPath: '/venv/python' }
  const text = source('index.js')
  const begin = text.indexOf('  let installing = false')
  const end = text.indexOf('  /* ─────────────── MCP', begin)
  const context = {
    join, process: { execPath: 'mock-node', versions: { electron: '44' } }, pluginDir: '/plugin', stateDir: '/fixture',
    cfg, PY_IMPORT_PROBE, PY_PACKAGES, MIRRORS: ['mock-mirror'], installLogFile: '/fixture/install.log',
    venvPython: () => '/venv/python', existsSync: () => true, setupFiles: () => ({ signer: { ready: signer } }),
    resolveUv: async () => { calls.push('uv'); return 'mock-uv' }, appendInstall() {}, log() {}, pyEnv: (extra) => extra,
    safeLog: String, persistCfg: async (patch) => { calls.push('persist'); Object.assign(cfg, patch) },
    spawnCapture: async () => ({ status: 0, stdout: JSON.stringify(Object.fromEntries(PY_PACKAGES.map((name) => [name, { ok: packages }]))) }),
    spawnTo: async (cmd, args, options) => {
      const isSigner = args.some((arg) => String(arg).endsWith('signer-setup.mjs'))
      calls.push({ cmd, args, options })
      if (isSigner) { signer = signerExit === 0; return signerExit }
      packages = true; return 0
    },
  }
  vm.runInNewContext(text.slice(begin, end) + '\nglobalThis.api={runInstall,state:()=>({installing,install})}', context)
  return { ...context.api, calls }
}
test('environment repair skips healthy components and never attempts account login', async () => {
  const mock = installer()
  assert.equal(mock.runInstall().started, true)
  await flush()
  assert.equal(mock.state().install.phase, 'completed')
  assert.deepEqual(mock.calls, [])
})
test('targeted repair installs missing packages and signer, and reports signer failure truthfully', async () => {
  const mock = installer({ packages: false, signer: false })
  mock.runInstall(); assert.equal(mock.runInstall().busy, true)
  await flush()
  assert.equal(mock.state().install.phase, 'completed')
  const sign = mock.calls.find((call) => call.args?.some((arg) => String(arg).endsWith('signer-setup.mjs')))
  assert.equal(sign.options.env.DOUYIN_HOME, '/fixture')
  assert.equal(sign.options.env.ELECTRON_RUN_AS_NODE, '1')
  assert.ok(!mock.calls.some((call) => call.args?.some((arg) => /qr-login|cookie/i.test(String(arg)))))
  const failure = installer({ signer: false, signerExit: 7 })
  failure.runInstall(); await flush()
  assert.equal(failure.state().install.phase, 'failed')
  assert.match(failure.state().install.error, /签名器/)
})

async function qr({ headless = false, owners = true, qrBox = true, alreadyLoggedIn = false, platform = 'win32' } = {}) {
  const outputs = [], files = new Map(), commands = [], launches = []
  const HOME = 'C:\\fixture', PROFILE = join(HOME, 'chrome-profile')
  files.set(join(HOME, 'runtime.json'), JSON.stringify({ cdpPort: 9334, custom: 'preserve' }))
  const context = {
    process: { argv: ['node', 'qr-login', '__test__'], env: {}, platform, pid: 999 }, join, Buffer, homeDir: () => HOME,
    findBrowser: () => '/mock-browser', existsSync: () => true, mkdirSync() {},
    readFileSync: (file) => { if (!files.has(file)) throw new Error('missing'); return files.get(file) },
    writeFileSync: (file, value) => files.set(file, String(value)),
    execFileSync: (cmd, args) => {
      const script = args.at(-1); commands.push(script)
      if (script.includes('Get-Process -Id')) return 'front 123'
      if (cmd === 'ps') return owners ? `123 browser --remote-debugging-port=9374 --user-data-dir="${PROFILE}"${headless ? ' --headless=new' : ''}\n` : ''
      return owners ? JSON.stringify([{ ProcessId: 123, CommandLine: `browser --remote-debugging-port=9374 --user-data-dir="${PROFILE}"${headless ? ' --headless=new' : ''}` }]) : ''
    },
    spawn: owners ? noEffect : (cmd, args, options) => {
      launches.push({ cmd, args, options })
      return { pid: 321, unref() {}, once(event, fn) { if (event === 'spawn') queueMicrotask(fn); return this } }
    }, fetch: async () => ({ ok: true }), AbortSignal,
    console: { log(...args) { outputs.push(args.join(' ')) } },
    setTimeout: (fn) => { queueMicrotask(fn); return 1 }, clearTimeout() {},
    WebSocket: class {},
    mockPage: {
      close() {},
      send: async (method) => method === 'Network.getAllCookies' ? { cookies: alreadyLoggedIn ? [{ name: 'sessionid', domain: '.douyin.com' }] : [] }
        : method === 'Page.captureScreenshot' ? { data: Buffer.from('mock-png').toString('base64') } : { result: { value: 'clicked' } },
      ev: async (expression) => expression.includes('hasQrText') ? JSON.stringify({ hasQrText: true }) : qrBox ? { x: 10, y: 10, width: 200, height: 200, scale: 1 } : null,
    },
  }
  const code = source('tools/qr-login.mjs').replace(/^#![^\n]*\n/, '').replace(/^import .*$/gm, '')
  await vm.runInNewContext(`(async()=>{${code}\npageConn=async()=>mockPage; findFreePort=async()=>9375; doCheck=async()=>({ok:true,logged_in:true}); globalThis.api={runStart,saveQrPort,loadQrPort,connect};})()`, context)
  await context.api.runStart()
  return { result: JSON.parse(outputs.at(-1)), files, commands, launches, context, HOME }
}
test('fresh QR startup requests a visible owned browser instead of a headless instance', async () => {
  const mock = await qr({ owners: false })
  assert.equal(mock.result.ok, true); assert.equal(mock.result.reused, false)
  assert.equal(mock.launches.length, 1)
  assert.ok(!mock.launches[0].args.some((arg) => String(arg).startsWith('--headless')))
  assert.equal(mock.launches[0].options.windowsHide, undefined)
  assert.ok(mock.launches[0].args.some((arg) => String(arg).startsWith('--user-data-dir=')))
  assert.ok(mock.commands.some((script) => script.includes('Get-Process -Id 321')))
})
test('existing owned headed login window is reused, has actual QR and preserves runtime fields', async () => {
  const mock = await qr()
  assert.equal(mock.result.ok, true); assert.equal(mock.result.reused, true)
  assert.equal(mock.result.port, 9374); assert.ok(mock.result.qr)
  const runtime = JSON.parse(mock.files.get(join(mock.HOME, 'runtime.json')))
  assert.equal(runtime.custom, 'preserve'); assert.equal(runtime.cdpPort, 9334)
  assert.ok(mock.commands.some((script) => script.includes('Get-Process -Id 123')))
})
test('headless profile conflict is explicit and no QR is fabricated', async () => {
  const mock = await qr({ headless: true })
  assert.equal(mock.result.ok, false); assert.equal(mock.result.conflict, 'profile_in_use')
  assert.equal(mock.result.browser_open, false); assert.equal(mock.result.qr, undefined)
})

test('macOS and Linux keep upstream process discovery and reuse only headed login windows', async () => {
  for (const platform of ['darwin', 'linux']) {
    const mock = await qr({ platform })
    assert.equal(mock.result.ok, true); assert.equal(mock.result.reused, true)
    assert.equal(mock.result.port, 9374); assert.ok(mock.result.qr)
    assert.ok(mock.commands.includes('pid=,command='))
    assert.ok(!mock.commands.some((script) => script.includes('Get-CimInstance')))
    const headless = await qr({ platform, headless: true })
    assert.equal(headless.result.conflict, 'profile_in_use')
    assert.equal(headless.launches.length, 0)
  }
})
test('visible window without QR remains checkable and existing login has no fake image', async () => {
  const noQr = (await qr({ qrBox: false })).result
  assert.equal(noQr.ok, false); assert.equal(noQr.no_qr_element, true)
  assert.equal(noQr.browser_open, true); assert.equal(noQr.can_check, true); assert.equal(noQr.qr, undefined)
  const logged = (await qr({ alreadyLoggedIn: true })).result
  assert.equal(logged.already_logged_in, true); assert.equal(logged.qr, '')
})
test('CDP connection exposes the evaluator used by QR and verification probes', async () => {
  const mock = await qr({ headless: true })
  mock.context.WebSocket = class {
    listeners = {}
    constructor() { queueMicrotask(() => this.listeners.open()) }
    addEventListener(name, fn) { this.listeners[name] = fn }
    send(raw) { const { id } = JSON.parse(raw); queueMicrotask(() => this.listeners.message({ data: JSON.stringify({ id, result: { result: { value: 'mock-value' } } }) })) }
    close() {}
  }
  const connection = await mock.context.api.connect('mock-ws')
  assert.equal(await connection.ev('mock-expression'), 'mock-value'); connection.close()
})
test('QR route provides image URL only for a real saved QR and keeps no-QR states intact', async () => {
  const host = source('index.js')
  const begin = host.indexOf("    if (req.method === 'POST' && path === '/api/douyin-duty/login/qr')")
  const end = host.indexOf('    // 二维码图片本身', begin)
  const route = async (result, fileExists) => {
    const context = { req: { method: 'POST' }, res: {}, path: '/api/douyin-duty/login/qr', stateDir: '/fixture',
      readBody: async () => ({}), runNodeTool: async () => ({ status: 0, stdout: JSON.stringify(result) }),
      pickJson: JSON.parse, sendJson: (res, status, value) => value, existsSync: () => fileExists, join, log() {}, safeLog: String }
    return vm.runInNewContext(`(async()=>{${host.slice(begin, end)}})()`, context)
  }
  assert.equal((await route({ ok: true, already_logged_in: true, qr: '' }, true)).qr_url, undefined)
  assert.equal((await route({ ok: true, qr: '/fixture/login-qr.png' }, false)).qr_url, undefined)
  assert.match((await route({ ok: true, qr: '/fixture/login-qr.png' }, true)).qr_url, /^\/api\/douyin-duty\/login\/qr.png/)
  const missing = await route({ ok: false, browser_open: true, no_qr_element: true, can_check: true }, false)
  assert.equal(missing.can_check, true); assert.equal(missing.qr_url, undefined)
})
