/**
 * lib/state.mjs —— 插件的"家"与配置（dsh-douyin-scroll）
 * ============================================================================
 * 从 dsh-bili-scroll 移植，规矩一致：**配置、凭证、报告、日志都放插件自己的家**
 * `$DSH_HOME/douyin-duty/`，**绝不写进插件包目录**（装进 node_modules 后可能只读、升级也会被覆盖）。
 *
 * ⭐ 抖音这边一个额外的小心处：凭证是**整串 Cookie**（不是 B站 那四个字段），
 *   里面有会话票据 ⇒ 写文件时权限收紧（0600 / Windows 上 ACL），并且**绝不进图片/日志**（见 redact）。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 谷时窗口（北京时间）—— 与 dsh-bili-scroll 同一口径。
 * DeepSeek 官方定价：**工作日 9:00–12:00 与 14:00–18:00 是高峰，其余全是谷时**
 * ⇒ 12:00–14:00 ✓、18:00 之后一整晚 ✓、以及整个周末 ✓ 都便宜。
 */
export const WINDOWS = {
  noon: { label: '中午谷时', start: '12:00', end: '14:00' },
  night: { label: '晚上/夜间谷时', start: '18:00', end: '09:00' },
}

/**
 * ⭐ 从 dsh-bili-scroll 抄来的坑：`ctx.get('dshHomePath')` 返回的是**函数**，不是字符串！
 *    形状：`dshHomePath(...segments) => join(resolveDshHome(), ...segments)`。
 *    当字符串用 ⇒ 路径变成「函数源码 + \douyin-duty」⇒ mkdir ENOENT ⇒ apply 抛错 ⇒ 插件不激活。
 */
export function stateDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('douyin-duty')                       // ← 函数形态：把目录名传进去
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'douyin-duty')
    }
  } catch { /* 拿不到就用下面的兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'douyin-duty')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 读 JSON 文件。
 *
 * 🔴 2026-10-26 凌晨补的 BOM 兼容（真实事故）：Windows 上用
 *   `PowerShell Set-Content -Encoding UTF8` 写出来的文件**带 UTF-8 BOM**
 *   （EF BB BF），而 `JSON.parse` 遇到 BOM 会直接抛错 ⇒ 这里静默返回 fallback
 *   ⇒ 上层读到的是"空配置"。表现极具欺骗性：文件内容肉眼完全正确，
 *   程序却当它不存在。
 *   实测踩到：把 chat-watch-intent.json 用 PS 写好、挂载自愈三个条件全满足，
 *   却永远不触发，日志里 `intent=undefined` —— 排查了两轮才定位到 BOM。
 *
 * 修法：读出来先剥 BOM（U+FEFF）再 parse。剥掉对正常文件无副作用。
 */
export function readJson(file, fallback) {
  try {
    const raw = readFileSync(file, 'utf8')
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
  } catch { return fallback }
}

/**
 * 🔴 2026-11-06：**容错读 JSON**（真实事故）。
 *   值班那一轮的小模型把 `runs/<id>.submission.json` 写成了**两段拼接**的 JSON
 *   （`{...}{...}`，同一份结果追加了两次）⇒ `JSON.parse` 抛错 ⇒ readJson 返回 null
 *   ⇒ 收尾时认为"没有提交结果"⇒ 整轮 phase=unknown、Toast「结果尚未确认」，
 *   可报告其实已经写好了。日志里看起来像"模型没交作业"，实际是**多写了一遍**。
 *
 *   ​修法：先按原样 parse；失败就从头扫第一个**括号配平**的 `{...}` 单独 parse；
 *   再失败就取最后一个配平的 `{...}`。字符串里的花括号/转义引号都要跳过。
 *   ⚠️ 只在"文件坏了"时才走这条路，正常文件的语义完全不变。
 */
export function readJsonLoose(file, fallback) {
  let raw = ''
  try { raw = readFileSync(file, 'utf8') } catch { return fallback }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  try { return JSON.parse(raw) } catch { /* 往下走容错 */ }
  const objects = []
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '{') continue
    let depth = 0
    let inStr = false
    let esc = false
    for (let j = i; j < raw.length; j++) {
      const c = raw[j]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') { inStr = true; continue }
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          try { objects.push(JSON.parse(raw.slice(i, j + 1))) } catch { /* 这一段不是合法 JSON，跳过 */ }
          i = j
          break
        }
      }
    }
  }
  if (!objects.length) return fallback
  return objects[objects.length - 1]
}

/**
 * 🔴 2026-11-05：**原子写**（先写临时文件再 rename）。
 *   原来的 `writeFileSync(file, ...)` 不是原子操作 —— 并发实测：
 *   另一个进程同时读时，2033 次里有 16 次读到坏 JSON（截断/半截）。
 *   而 `readJson` 遇到坏 JSON 会返回 fallback ⇒ **用户的配置会静默变回默认值**，
 *   表现就是「我明明设过了，怎么又变回去了」。多个 DSH 窗口/多个 profile 同时开时就会撞上。
 *   rename 在同一分区上是原子的：读者要么看到旧文件、要么看到完整的新文件，不会看到半截。
 *   ⚠️ 临时文件名带 pid + 随机，避免两个进程撞同一个 tmp。
 */
export function writeJson(file, value) {
  const text = JSON.stringify(value, null, 2)
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
  } catch (e) {
    // 临时文件写失败 / rename 失败（跨盘、权限）⇒ 回退成直接写，别让调用方炸
    try { rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
    writeFileSync(file, text, 'utf8')
  }
}

/**
 * ⭐ 写敏感文件（Cookie/凭证）：能收紧权限就收紧。
 *    POSIX 上直接 0600；Windows 上没有等价的简单位，跳过（但目录本身在用户 profile 下）。
 */
export function writeSecret(file, text) {
  writeFileSync(file, text, 'utf8')
  try { if (process.platform !== 'win32') chmodSync(file, 0o600) } catch { /* 收不紧也不致命 */ }
  return file
}

/**
 * 🔴 脱敏：**任何要打进日志 / 报告 / 报错的 Cookie 串，都得先过这里**。
 *    理由：Cookie 里含会话票据，泄露等于账号被拿走；而日志是会被使用者整段贴给别人排错的。
 *
 * ⭐ 只打码 **value**、**保留 key 名** —— 排错时"是哪些 key 在不在"正是要看的信息
 *   （第一版把 key 也打码成 `sess***=abcd***`，等于把排错线索也一起毁了）。
 */
export function redactCookie(s) {
  const str = String(s ?? '')
  if (!str) return ''
  // `a=1; b=2` / `Cookie: a=1; b=2` 这种形状 ⇒ 逐个 value 打码，key 原样留着
  if (str.includes('=')) {
    return str.replace(/(=\s*)([^;]*)/g, (_m, eq, val) => {
      const v = String(val)
      return eq + (v.length > 4 ? v.slice(0, 4) + '***' : v ? '***' : '')
    })
  }
  // 不是 cookie 形状（比如一串裸 token）⇒ 退回整体打码
  return str.replace(/([A-Za-z0-9_-]{4})[A-Za-z0-9_-]{4,}/g, (_m, head) => head + '***')
}

/**
 * 首次运行：铺好家目录里的东西。
 *
 * ⚠️ 2026-10-21：这里以前会把 `vendor/douyin-mcp` 整棵树（mcp_server / prescreen /
 *    comment_executor / drivers/*）拷进家里 —— 那套内置 MCP 已经整个删掉了，
 *    现在采集和发送都直接调 `tools/*.py` / `tools/*.mjs`，不需要往家里铺任何脚本。
 */
export function ensureHomeFiles(pluginDir, stateDir, log = () => {}) {
  // ⭐ 示例候选：只在**没有**时铺一份，别覆盖用户自己的数据
  try {
    const exFrom = join(pluginDir, 'prompts', 'sample-candidates.json')
    const exTo = join(stateDir, 'inbox', 'candidates.example.json')
    mkdirSync(join(stateDir, 'inbox'), { recursive: true })
    if (existsSync(exFrom) && !existsSync(exTo)) {
      copyFileSync(exFrom, exTo)
      log('已铺好示例候选（inbox/candidates.example.json）')
    }
  } catch { /* 铺不了就算了，不影响主流程 */ }

  // ⭐ 手动喂料的收件箱目录 —— 那一轮被沙箱关着，只能写"启动前就已存在"的目录 ⇒ 宿主预建
  for (const d of ['inbox', 'out', 'digest']) {
    try { mkdirSync(join(stateDir, d), { recursive: true }) } catch { /* 建不了也别拦着插件加载 */ }
  }
}

/** 值班章程放哪一份 —— 家里那份优先，没有才用插件里那份 */
export function charterPath(pluginDir, stateDir) {
  const home = join(stateDir, 'duty.md')
  try { if (existsSync(home)) return home } catch { /* 兜底：用插件里那份 */ }
  return join(pluginDir, 'prompts', 'duty.md')
}

/**
 * ⭐ 值班章程怎么升级 —— 记账制（抄 dsh-bili-scroll，M6 那条审查意见的修法）：
 *    上次铺的是哪一版（sha256）记在 `charter.sha256`：
 *      · 家里那份 === 我们上次铺的 ⇒ 他没动过 ⇒ 直接用 shipped 覆盖（升级 ✓）
 *      · 家里那份变过            ⇒ 他改过 ⇒ **一个字都不动**，新版另存 `duty.md.new` 让他自己合 ✓
 *      · 没有账本（带账本的第一个版本刚跑起来）⇒ 分不清 ⇒ 按「改过」处理 ✓
 */
export function ensureCharter(pluginDir, stateDir, log = () => {}) {
  const shipped = join(pluginDir, 'prompts', 'duty.md')
  const home = join(stateDir, 'duty.md')
  const ledger = join(stateDir, 'charter.sha256')
  const fresh = join(stateDir, 'duty.md.new')
  const readIf = (f) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
  try {
    if (!existsSync(shipped)) { log(`缺文件：${shipped}`); return }
    const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
    const newText = readFileSync(shipped, 'utf8')
    const hShip = sha(newText)
    const hLast = readIf(ledger).trim()
    if (!existsSync(home)) {
      writeFileSync(home, newText, 'utf8'); writeFileSync(ledger, hShip, 'utf8')
      log('已铺好值班章程')
      return
    }
    const hHome = sha(readFileSync(home, 'utf8'))
    if (hHome === hShip) {
      if (hLast !== hShip) writeFileSync(ledger, hShip, 'utf8')
      return
    }
    if (!hLast || hHome !== hLast) {
      if (hShip !== hLast && readIf(fresh) !== newText) {
        writeFileSync(fresh, newText, 'utf8')
        log(`值班章程有新版、但家里那份你改过 ⇒ 新版另存为 ${fresh}，自己合一下`)
      }
      return
    }
    writeFileSync(home, newText, 'utf8'); writeFileSync(ledger, hShip, 'utf8')
    log('值班章程已更新到插件里这一版')
  } catch (e) { log(`铺值班章程失败：${e?.message ?? e}`) }
}

/** 'HH:MM' → 当天的分钟数 */
function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** 现在在不在这个窗口里（支持跨零点，比如 23:00–02:00） */
export function inWindow(now, win) {
  const start = minutesOf(win.start); const end = minutesOf(win.end)
  if (start === null || end === null) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end)
}

/** 本地日期 YYYY-MM-DD */
export function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}
