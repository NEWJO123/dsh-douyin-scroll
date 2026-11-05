/** Read-only setup facts and repair metadata shared by the setup step and doctor. */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

export const PY_PACKAGES = ['httpx', 'curl_cffi']
export const SIGNER_SDKS = ['webmssdk.js', 'secsdk-runtime.js', 'sdk-glue.js', 'slardar.js', 'bdms-signer.js', 'captcha-sdk.js', 'verifycenter.js']
export const PY_IMPORT_PROBE = `import importlib,json
out={}
for name in ('httpx','curl_cffi'):
 try:
  importlib.import_module(name)
  out[name]={'ok':True}
 except Exception as e:
  out[name]={'ok':False,'error':type(e).__name__+': '+str(e)}
print(json.dumps(out))`

/**
 * 🔴 2026-11-05：**真的跑一次 import**，别只看目录存不存在。
 *   实测：目录都在、但包是空壳（装了一半 / 装坏了）时，`pythonReady` 会误判成 true
 *   —— 面板显示「环境就绪」，用户点「跑一轮」才失败，报错还含糊。
 *   doctor.mjs 一直在跑真 import 探针，这里补上同一套口径。
 *   ⚠️ 会起一个 python 子进程（约 100ms），只在**需要确认就绪**的地方用；
 *      纯展示（列文件、算体积）仍用 setupFiles 的静态结果。
 */
export function probeImports(python, { timeoutMs = 30_000, env = process.env } = {}) {
  try {
    if (!existsSync(python)) return { ok: false, imports: {}, error: 'venv 里的 python 不存在' }
    const r = spawnSync(python, ['-c', PY_IMPORT_PROBE], {
      encoding: 'utf8', timeout: timeoutMs,
      env: { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    })
    let imports = {}
    try { if (r.status === 0) imports = JSON.parse(String(r.stdout || '')) } catch { /* 下面按失败处理 */ }
    const ok = PY_PACKAGES.every((name) => imports[name]?.ok === true)
    return { ok, imports, error: ok ? undefined : String(r.stderr || r.error?.message || '依赖无法导入').trim().slice(0, 240) }
  } catch (e) { return { ok: false, imports: {}, error: String(e?.message || e) } }
}

export function setupFiles(home, signerDir = process.env.DY_SIGNER_DIR || join(home, 'signer')) {
  const root = join(home, '.venv')
  const python = process.platform === 'win32' ? join(root, 'Scripts', 'python.exe') : join(root, 'bin', 'python')
  let site = join(root, 'Lib', 'site-packages')
  if (!existsSync(site)) {
    try { const version = readdirSync(join(root, 'lib')).find((name) => name.startsWith('python'))
      if (version) site = join(root, 'lib', version, 'site-packages') } catch { /* not installed */ }
  }
  const packages = Object.fromEntries(PY_PACKAGES.map((name) => [name, existsSync(join(site, name, '__init__.py'))]))
  const jsdom = existsSync(join(signerDir, 'node_modules', 'jsdom', 'package.json'))
  const sdkCount = SIGNER_SDKS.filter((name) => { try { return statSync(join(signerDir, 'sdk', name)).size > 1000 } catch { return false } }).length
  const pythonReady = existsSync(python) && PY_PACKAGES.every((name) => packages[name])
  return { python, pythonExists: existsSync(python), packages, pythonReady,
    signer: { ready: jsdom && sdkCount === SIGNER_SDKS.length, jsdom, sdkCount, sdkTotal: SIGNER_SDKS.length },
    ready: pythonReady && jsdom && sdkCount === SIGNER_SDKS.length }
}

export const REPAIR_ENVIRONMENT = { id: 'repair_environment', label: '修复运行环境', endpoint: '/api/douyin-duty/environment/repair' }
export const LOGIN_ACTION = { id: 'login', label: '扫码登录', endpoint: '/api/douyin-duty/login/qr' }

export function summarizeSetup(items) {
  const environment = items.filter((row) => row.category === 'environment')
  const account = items.filter((row) => row.category === 'account')
  const repairable = environment.some((row) => row.state !== 'ok' && row.action?.id === 'repair_environment')
  return { environment: { ready: environment.every((row) => !row.required || row.state === 'ok'), items: environment,
    repairable, actions: repairable ? [REPAIR_ENVIRONMENT] : [] },
    account: { ready: account.every((row) => row.state === 'ok'), items: account,
      actions: account.some((row) => row.state !== 'ok') ? [LOGIN_ACTION] : [] } }
}
