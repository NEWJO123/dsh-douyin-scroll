/** Local weekday schedules. A crossing-midnight window belongs to its start date. */
import { WINDOWS } from './state.mjs'

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
export const scheduleDays = (days) => Array.isArray(days)
  ? [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [...ALL_DAYS]
const minutes = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''))
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null
}
export function configuredWindows(cfg) {
  const rows = []
  if (cfg.noon) rows.push({ key: 'noon', ...WINDOWS.noon })
  if (cfg.night) rows.push({ key: 'night', ...WINDOWS.night })
  for (const [i, w] of (Array.isArray(cfg.windows) ? cfg.windows : []).entries()) {
    if (minutes(w?.start) === null || minutes(w?.end) === null || minutes(w.start) === minutes(w.end)) continue
    rows.push({ ...w, key: `custom:${i}`, label: String(w.label || `${w.start}–${w.end}`) })
  }
  return rows
}
export const autoEnabled = (cfg) => typeof cfg.autoEnabled === 'boolean' ? cfg.autoEnabled
  : Number(cfg.perDay) > 0 && configuredWindows(cfg).length > 0

/** Validate before either configuration store is written; existing legacy plans remain readable. */
export function schedulePatchError(current, patch = {}) {
  const timingFields = ['noon', 'night', 'windows', 'scheduleDays']
  if (!timingFields.some((key) => key in patch) && !('autoEnabled' in patch)) return ''
  for (const key of ['autoEnabled', 'noon', 'night']) {
    if (key in patch && typeof patch[key] !== 'boolean') return '自动运行和时段开关必须是开启或关闭'
  }
  // Pausing must always work, including when an older plan contains invalid/overlapping rows.
  if (!timingFields.some((key) => key in patch) && patch.autoEnabled === false) return ''
  const cfg = { ...current, ...patch }
  if (!Array.isArray(cfg.scheduleDays) || cfg.scheduleDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return '运行星期必须在周一至周日内选择'
  }
  if (!Array.isArray(cfg.windows)) return '运行时段必须是列表'
  for (const [i, row] of cfg.windows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.start !== 'string' || typeof row.end !== 'string'
      || minutes(row.start) === null || minutes(row.end) === null) {
      return `第 ${i + 1} 个自定义时段的时间无效，请填写 00:00–23:59`
    }
    if (minutes(row.start) === minutes(row.end)) return `第 ${i + 1} 个自定义时段的开始和结束时间不能相同`
    if (row.label !== undefined && typeof row.label !== 'string') return `第 ${i + 1} 个自定义时段的名称必须是文字`
  }
  const rows = configuredWindows(cfg)
  const intervals = []
  for (const day of scheduleDays(cfg.scheduleDays)) {
    for (const [row, w] of rows.entries()) {
      const start = day * 1440 + minutes(w.start)
      const end = day * 1440 + minutes(w.end) + (minutes(w.end) < minutes(w.start) ? 1440 : 0)
      intervals.push({ row, start, end })
    }
  }
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length; j++) {
      const a = intervals[i], b = intervals[j]
      if (a.row === b.row) continue
      // Include the adjacent week so a Sunday overnight window is compared with Monday.
      if ([-10080, 0, 10080].some((offset) => a.start < b.end + offset && b.start + offset < a.end)) {
        return `「${rows[a.row].label}」与「${rows[b.row].label}」的时段重叠，请调整后保存`
      }
    }
  }
  return ''
}

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Keep consumed intervals consumed when settings rows move or presets become custom rows. */
export function remapUsedWindows(previous, next, used = {}, now = new Date()) {
  const before = configuredWindows(previous), after = configuredWindows(next)
  const sameRange = (a, b) => minutes(a.start) === minutes(b.start) && minutes(a.end) === minutes(b.end)
  const result = { ...used }
  for (const offset of [-1, 0]) {
    const date = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset))
    const consumed = before.filter((w) => used[`${date}:${w.key}`])
    for (const w of after) {
      if (consumed.some((old) => sameRange(old, w))) result[`${date}:${w.key}`] = true
    }
    // An edited preset loses its source key. With no persistent row IDs, defer only newly
    // introduced ranges when a consumed source disappears, rather than replay its replacement.
    const replaced = consumed.some((old) => !after.some((w) => w.key === old.key || sameRange(old, w)))
    if (replaced) {
      for (const w of after) if (!before.some((old) => sameRange(old, w))) result[`${date}:${w.key}`] = true
    }
  }
  return result
}

export function scheduledWindows(cfg, now = new Date(), used = {}) {
  if (!autoEnabled(cfg)) return []
  const days = scheduleDays(cfg.scheduleDays)
  const result = []
  for (let offset = -1; offset < 8; offset++) {
    const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
    if (!days.includes(startDay.getDay())) continue
    for (const w of configuredWindows(cfg)) {
      const s = minutes(w.start), e = minutes(w.end)
      const start = new Date(startDay), end = new Date(startDay)
      start.setMinutes(s)
      end.setDate(end.getDate() + (e < s ? 1 : 0)); end.setMinutes(e)
      const key = `${localDay(startDay)}:${w.key}`
      if (end <= now || used[key]) continue
      result.push({ ...w, key, startsAt: +start, endsAt: +end, active: start <= now && now < end })
    }
  }
  return result.sort((a, b) => a.startsAt - b.startsAt)
}
