/** Read-only setup facts and repair metadata shared by the setup step and doctor. */
import { existsSync, readdirSync, statSync } from 'node:fs'
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
