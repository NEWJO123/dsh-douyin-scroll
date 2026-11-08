/**
 * lib/toast.mjs —— Windows 通知（Toast）通道：真正把消息**弹到用户屏幕上**
 * ============================================================================
 * 为什么要有它：
 *   webhook（企业微信/飞书/钉钉）要用户先申请一个机器人，绝大多数人不会配；
 *   "只写报告"则等于没提醒 —— 报告躺在文件夹里没人知道。
 *   Windows 自带的通知中心是**零配置**的：不装 BurntToast、不连网、不要 token。
 *
 * 实现方式（务实版）：
 *   用 `powershell.exe`（5.1，WinRT 在它这里才稳）调 `Windows.UI.Notifications`，
 *   标题/正文走**临时 JSON 文件**传（命令行里塞中文和引号会被转义坑死）。
 *
 * 🔴 三条纪律：
 *   ① **永不抛异常**：通知发不出去只是"这一轮没提醒到"，不该把宿主或那一轮拖下水；
 *   ② **不联网、不装东西**：纯本地 WinRT 调用；
 *   ③ 正文**截断**：Toast 只显示前几行，长文没意义，完整报告留在 `out/<日期>.md`。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * AppUserModelID：桌面程序想弹 Toast 必须有个"身份"。
 * 借 PowerShell 自己的 AUMID —— 通知会以"Windows PowerShell"名义出现，
 * 这是不注册快捷方式时**唯一可靠**的做法（自己造 AUMID 而不注册 = 静默丢弃）。
 */
const AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

const PS_SCRIPT = String.raw`
param([string]$Json, [string]$Aumid)
$ErrorActionPreference = 'Stop'
try {
  $msg = (Get-Content -LiteralPath $Json -Raw -Encoding UTF8) | ConvertFrom-Json
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null

  $title = [System.Security.SecurityElement]::Escape([string]$msg.title)
  $body  = [System.Security.SecurityElement]::Escape([string]$msg.body)
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>' + $title + '</text><text>' + $body + '</text></binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>')

  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  # 同名 Tag 会覆盖上一条，避免刷屏（Tag 只允许 1-16 位字母数字）
  try { $toast.Tag = 'dyduty'; $toast.Group = 'dyduty' } catch {}
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid).Show($toast)
  Write-Output 'OK'
} catch {
  Write-Output ('ERR:' + $_.Exception.Message)
}
`

/** 把 toast.ps1 落盘（只写一次）+ 每次调用把内容写进 tmp json */
function ensureScript(dir) {
  mkdirSync(dir, { recursive: true })
  const ps1 = join(dir, 'toast.ps1')
  writeFileSync(ps1, PS_SCRIPT, 'utf8') // PowerShell 5.1 读 BOM-less UTF-8 的 .ps1 也没问题（内容全 ASCII）
  return ps1
}

/**
 * 发一条 Windows 通知。
 * @param {{ title?: string, body?: string, timeoutMs?: number, dryRun?: boolean }} o
 * @returns {{ ok: boolean, sent: boolean, error?: string, via?: string, skipped?: string }}
 *   永不抛异常。
 */
export function sendToast({ title = '刷抖音', body = '', timeoutMs = 20_000, dryRun = false, dir } = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, sent: false, skipped: 'not_windows', error: 'Toast 通道只在 Windows 上可用' }
  }
  // ⭐ 默认落在插件家目录的 toast/（用户要求所有东西在 D 盘；实在没有家目录才退到 TEMP）
  const workDir = dir
    || (process.env.DOUYIN_DUTY_HOME ? join(process.env.DOUYIN_DUTY_HOME, 'toast') : join(process.env.TEMP || process.cwd(), 'dsh-douyin-toast'))
  const jsonFile = join(workDir, `msg-${process.pid}-${Date.now()}.json`)
  try {
    const ps1 = ensureScript(workDir)
    // 正文太长 Toast 也显示不全，先截断（留余量给标题行）
    const payload = {
      title: String(title || '刷抖音').slice(0, 64),
      body: String(body || '').slice(0, 220),
    }
    if (dryRun) return { ok: true, sent: false, via: 'toast', body: payload.body }
    writeFileSync(jsonFile, JSON.stringify(payload), 'utf8')

    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Json', jsonFile, '-Aumid', AUMID],
      { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' },
    )
    const out = String(r.stdout || '') + String(r.stderr || '')
    if (r.error) return { ok: false, sent: false, via: 'toast', error: String(r.error.message || r.error) }
    if (r.status !== 0 || !/OK/.test(out)) {
      return { ok: false, sent: false, via: 'toast', error: (out.trim() || `powershell exit=${r.status}`).slice(0, 300) }
    }
    return { ok: true, sent: true, via: 'toast' }
  } catch (e) {
    return { ok: false, sent: false, via: 'toast', error: String(e?.message ?? e) }
  } finally {
    try { rmSync(jsonFile, { force: true }) } catch { /* 删不掉就算了 */ }
  }
}

/**
 * ⭐ 2026-11-08（数据和展示分家）：通知正文从**结构化 receipt**（result.picks）构造。
 *    旧版 toastSummary(reportText) 从报告文本反向解析标题/作者 —— 2026-10-22 因为
 *    「只认旧格式」炸过一次；格式再变还会炸。现在数据源唯一：receipt 里有什么就显示什么，
 *    报告纯粹给人看。
 * @param {Array<{title?:string, author?:string}>} picks 本轮推荐（receipt.picks）
 * @param {{recommendations?:number, reportUpdated?:boolean}} extra
 * @returns {string} Toast 正文（不带标题）
 */
export function picksBody(picks = [], { recommendations = 0, reportUpdated = false } = {}) {
  const list = [...(picks || [])]
  const lines = list.slice(0, 2).map((p, i) => {
    const t = String(p?.title || `第 ${i + 1} 条`).replace(/\*\*/g, '').slice(0, 40)
    const a = String(p?.author || '').replace(/^@/, '').slice(0, 12)
    return `· 《${t}》${a ? ` ·@${a}` : ''}`
  })
  if (list.length > 2) lines.push(`… 还有 ${list.length - 2} 条，见报告`)
  if (!lines.length) lines.push('这一轮没有挑出值得推的（详情见报告文件）')
  return [`本轮新增推荐 ${recommendations || 0} 条。${reportUpdated ? '报告已更新。' : ''}`, ...lines].join('\n').trim()
}
