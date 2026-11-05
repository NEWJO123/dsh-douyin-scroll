/**
 * dsh-douyin-scroll —— 浏览器半端（设置在「设置」里的一页，中文名「刷抖音」）
 * ============================================================================
 * 功能区：开始使用、运行与结果、自动发送、消息与记忆、我的人设、运行偏好、帮助和关于。
 * 偏好、帮助、人设正文和日志按需展开。运行与发送状态只使用后端可核实的记录。
 *
 * ⭐ 关键设计：整个面板包在 Boundary（error boundary）里 ——
 *    任何子组件抛错只显示"这页出错了 + 重试"，不会再整块消失。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-douyin-scroll',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/douyin-duty'

    /**
     * ⭐ 面板构建号 —— **每次改完 client.js 就 +1**。
     *    为什么需要它：改 client.js 后如果不重启/刷新，浏览器会一直用缓存的旧 bundle，
     *    面板看起来"没变化"，很难判断是代码错了还是没加载。
     *    对一下面板右上角显示的 `v<版本>·b<N>` 就知道。
     */
    const PANEL_BUILD = 41

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p, options = {}) => asJson(await fetch(API + p, { credentials: 'same-origin', ...options }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))
    // jpost 但失败/404 返回 null（用在新旧宿主兼容探测上，不炸面板）
    const jpostSoft = async (p, body) => { try { return await jpost(p, body) } catch { return null } }

    const safeLink = (value) => {
      try {
        const url = new URL(String(value || ''))
        return ['https:', 'http:'].includes(url.protocol) ? url.href : ''
      } catch { return '' }
    }
    const workLink = (item) => {
      const url = safeLink(item?.url || item?.work_url || item?.video_url)
      try {
        const parsed = new URL(url)
        return /(^|\.)douyin\.com$/.test(parsed.hostname) ? url : ''
      } catch { return '' }
    }
    const redactLog = (value) => String(value || '')
      .replace(/((?:cookie|authorization|token|webhook|password|secret|sessionid|sid_guard|sid_tt|uid_tt|ttwid|msToken|csrf)[\w-]*\s*[:=]\s*)([^\r\n]+)/gi, '$1[已脱敏]')
      .replace(/\bBearer\s+[\w.\-+/=]+/gi, 'Bearer [已脱敏]')
      .replace(/https?:\/\/[^\s<>"')]+/gi, (url) => {
        try {
          const parsed = new URL(url)
          return /(^|\.)douyin\.com$/.test(parsed.hostname) && /^\/(video|note)\/\d+\/?$/.test(parsed.pathname)
            ? parsed.origin + parsed.pathname : '[链接已脱敏]'
        } catch { return '[链接已脱敏]' }
      })

    // Markdown becomes React text/elements only: report content can never inject HTML.
    function inlineMarkdown(value) {
      const parts = String(value || '').split(/(\[[^\]\n]+\]\([^\s)]+\)|\*\*[^*\n]+\*\*|`[^`\n]+`)/g)
      return parts.map((part, i) => {
        const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
        if (link && safeLink(link[2])) return h('a', { key: i, href: safeLink(link[2]), target: '_blank', rel: 'noopener noreferrer' }, link[1])
        if (/^\*\*.+\*\*$/.test(part)) return h('strong', { key: i }, part.slice(2, -2))
        if (/^`.+`$/.test(part)) return h('code', { key: i }, part.slice(1, -1))
        return part
      })
    }
    function Markdown({ text }) {
      const lines = String(text || '').replace(/\r/g, '').split('\n')
      const blocks = []
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!line.trim()) continue
        if (/^```/.test(line)) {
          const code = []
          while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i])
          blocks.push(h('pre', { key: i, 'data-dy-pre': '' }, code.join('\n')))
        } else if (/^#{1,6}\s+/.test(line)) {
          blocks.push(h('h4', { key: i }, inlineMarkdown(line.replace(/^#{1,6}\s+/, ''))))
        } else if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
          const items = []
          const ordered = /^\s*\d+[.)]\s+/.test(line)
          const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/
          do { items.push(h('li', { key: i }, inlineMarkdown(lines[i].replace(re, '')))); i++ } while (i < lines.length && re.test(lines[i]))
          i--
          blocks.push(h(ordered ? 'ol' : 'ul', { key: i }, items))
        } else if (/^>\s?/.test(line)) {
          blocks.push(h('blockquote', { key: i }, inlineMarkdown(line.replace(/^>\s?/, ''))))
        } else blocks.push(h('p', { key: i }, inlineMarkdown(line)))
      }
      return h('div', { 'data-dy-markdown': '' }, blocks)
    }

    const shortTime = (at) => {
      if (!at) return ''
      const date = new Date(at)
      if (!Number.isFinite(date.getTime())) return ''
      return `${date.getMonth() + 1} 月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }
    const commentKey = (item) => `${item.aweme_id || ''}:${item.comment_id || ''}`
    const personaData = (r) => ({
      text: String(r?.text || ''), custom: Boolean(r?.custom), effective: String(r?.effective || ''),
      effectiveLabel: String(r?.effective_label || ''), defaultText: String(r?.default_text || ''), hint: r?.hint || '',
    })

    const CSS = `
[data-dy-page]{display:flex;flex-direction:column;gap:16px;padding:4px 2px 10px;max-width:660px;font-size:13px;}
[data-dy-card]{display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.06));}
[data-dy-title]{font-size:13px;font-weight:600;}
[data-dy-sub]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-dy-grow]{flex:1;min-width:0;}
[data-dy-btn]{padding:7px 13px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;}
[data-dy-btn]:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-dy-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-dy-btn][disabled]{opacity:.5;cursor:default;}
[data-dy-input]{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-dy-input]:focus{outline:none;border-color:#3b82f6;}
[data-dy-badge]{font-size:11px;padding:3px 8px;border-radius:6px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));
  color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-dy-badge][data-on]{background:rgba(34,197,94,.16);color:#22c55e;}
[data-dy-badge][data-off]{background:rgba(245,158,11,.16);color:#f59e0b;}
[data-dy-msg]{font-size:11px;line-height:17px;padding:8px 10px;border-radius:8px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-msg][data-good]{color:#22c55e;}
[data-dy-msg][data-warn]{color:#f59e0b;}
[data-dy-kv]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-dy-sw][data-on]{background:#3b82f6;}
[data-dy-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;
  background:#fff;transition:left .15s;display:block;}
[data-dy-sw][data-on] i{left:19px;}
[data-dy-seg]{display:inline-flex;flex:none;border-radius:8px;overflow:hidden;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));}
[data-dy-segbtn]{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#c9ccd1);
  font-size:11px;padding:4px 10px;cursor:pointer;}
[data-dy-segbtn][data-on]{background:#3b82f6;color:#fff;}
[data-dy-pre]{margin:0;padding:9px 10px;border-radius:8px;max-height:180px;overflow:auto;
  font-size:11px;line-height:15px;white-space:pre-wrap;word-break:break-all;
  background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.25));
  color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-dy-time]{flex:none;width:78px;box-sizing:border-box;padding:6px 8px;border-radius:7px;
  font-size:12px;font-family:inherit;text-align:center;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;}
[data-dy-time]:focus{outline:none;border-color:#3b82f6;}
[data-dy-mini]{padding:5px 10px;border-radius:7px;font-size:11px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;}
[data-dy-mini]:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-dy-mini][disabled]{opacity:.5;cursor:default;}
[data-dy-mini][data-danger]{color:#f87171;}
/* 桌宠人格卡（2026-10-24 v5） */
[data-dy-personas]{display:flex;gap:8px;flex-wrap:wrap;}
[data-dy-pcard]{flex:1;min-width:150px;padding:10px;border-radius:10px;cursor:pointer;text-align:left;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));color:inherit;font-family:inherit;}
[data-dy-pcard][data-on]{border-color:#3b82f6;background:rgba(59,130,246,.14);}
[data-dy-pcard-name]{font-size:12px;font-weight:600;}
[data-dy-pcard-desc]{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);margin-top:3px;line-height:15px;}
[data-dy-wrow]{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;}
[data-dy-sep]{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-step]{flex:none;width:20px;height:20px;border-radius:50%;font-size:11px;font-weight:600;
  display:inline-flex;align-items:center;justify-content:center;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.18));
  color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-dy-step][data-done]{background:rgba(34,197,94,.18);color:#22c55e;}
[data-dy-loginbox]:empty{display:none;}
[data-dy-area="setup"] > [data-dy-row] [data-dy-title]{margin:0;font-size:16px;line-height:22px;}
[data-dy-area="setup"] [data-dy-sub]{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#60646c);}
[data-dy-area="setup"] [data-dy-btn],[data-dy-setup-button]{min-height:32px;box-sizing:border-box;padding:6px 12px;font-size:12px;line-height:18px;border-radius:6px;}
[data-dy-area="setup"] [data-dy-btn][data-primary]{background:#2563eb;border-color:#2563eb;}
[data-dy-area="setup"] [data-dy-step][data-done]{background:transparent;color:#247b50;}
[data-dy-setup-row]{display:grid;grid-template-columns:24px minmax(0,1fr) auto;align-items:center;gap:12px;padding:12px 0;}
[data-dy-setup-row]+[data-dy-setup-row]{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));}
[data-dy-setup-label]{font-size:14px;font-weight:500;line-height:20px;}
[data-dy-setup-row] [data-dy-sub]{margin-top:3px;}
[data-dy-setup-detail]{grid-column:2 / -1;min-width:0;}
[data-dy-setup-state]{font-size:12px;color:var(--dsw-alias-label-secondary,#8a929c);}
[data-dy-setup-state][data-ready]{color:#247b50;}
[data-dy-setup-check]{border:0;background:none;color:var(--dsw-alias-accent,#397bfa);font:inherit;font-size:12px;padding:4px 0;cursor:pointer;}
[data-dy-setup-check]:disabled{opacity:.5;cursor:default;}
[data-dy-setup-button]{border-color:var(--dsw-alias-border-l2,#cfd3d9);background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-secondary,#374151);padding:6px 12px;}
[data-dy-setup-button]:focus-visible{outline:2px solid #397bfa;outline-offset:2px;}
[data-dy-toast]{position:fixed;z-index:10000;top:max(24px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:8px;
  max-width:calc(100vw - 32px);box-sizing:border-box;padding:10px 14px;border-radius:8px;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#202124);
  box-shadow:0 4px 16px rgba(0,0,0,.12);font-size:13px;line-height:20px;pointer-events:none;}
[data-dy-toast] svg{flex:none;color:#247b50;}
[data-dy-environment-issues]{display:flex;flex-direction:column;gap:10px;margin-top:3px;}
[data-dy-environment-issue]{padding:9px 11px;border-left:2px solid #c79641;background:rgba(192,144,56,.07);border-radius:0 6px 6px 0;font-size:12px;line-height:18px;}
[data-dy-environment-issue] p{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#7c8592);font-size:11px;overflow-wrap:anywhere;}
[data-dy-loginbox]{display:flex;flex-direction:column;gap:10px;}
@media(max-width:480px){[data-dy-setup-row]{gap:9px;grid-template-columns:22px minmax(0,1fr) auto;}[data-dy-area="setup"] [data-dy-btn],[data-dy-setup-button]{min-height:44px;padding:8px 10px;}[data-dy-setup-detail]{grid-column:1 / -1;}}
[data-dy-qr]{display:block;}
[data-dy-people]{display:flex;flex-direction:column;gap:4px;max-height:260px;overflow:auto;
  padding:4px;border-radius:9px;background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.16));}
[data-dy-person]{display:flex;align-items:center;gap:8px;width:100%;text-align:left;cursor:pointer;
  padding:7px 9px;border-radius:7px;border:0;background:transparent;color:inherit;font-family:inherit;font-size:12px;}
[data-dy-person]:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.22));}
[data-dy-person][data-picked]{background:rgba(59,130,246,.14);}
[data-dy-person][disabled]{cursor:default;opacity:.6;}
[data-dy-person-name]{font-weight:600;flex:none;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-dy-person-sub]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-tag]{flex:none;font-size:10px;padding:1px 6px;border-radius:5px;
  background:rgba(245,158,11,.16);color:#f59e0b;}
[data-dy-tag][data-ok]{background:rgba(34,197,94,.16);color:#22c55e;}
[data-dy-msgrow]{padding:7px 9px;border-radius:8px;background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.14));}
[data-dy-chat]{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow:auto;
  padding:8px;border-radius:9px;background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.16));}
[data-dy-bubble]{max-width:78%;padding:7px 10px;border-radius:10px;font-size:12px;line-height:17px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.2));align-self:flex-start;}
[data-dy-bubble][data-mine]{align-self:flex-end;background:rgba(59,130,246,.22);}
[data-dy-bubble][data-them]{align-self:flex-start;background:rgba(128,128,128,.24);}
[data-dy-bubble-text]{white-space:pre-wrap;word-break:break-word;}
/* ── 面板三组（2026-10-25 重排）：20+ 张卡压成 7 张，分「常开必看 / 出问题才看 / 一次配好」──
 * 实际 DOM 结构（两层，别忘了）：
 *   div[data-dy-group]                 组容器（一组一行，flex）
 *     ├─ span[data-dy-groupname]       组名（常开必看 / 出问题才看 / 一次配好）
 *     └─ button[data-dy-groupbtn]      **只有折叠组有**：能点，带 data-open / aria-expanded
 *          └─ span[data-dy-groupchev]  「展开看 ▼ / 收起 ▲」或组①的提示文字
 * 组容器自己**不**带 data-dy-card ⇒ 卡片计数才正好 7。
 * [data-dy-subblock] 合并进同一张卡里的子块（带上分隔线；卡里第一块不出线）
 * [data-dy-inner]    原本就嵌在卡里的透明小卡（不参与顶层卡片计数）
 * [data-dy-subflat]  那两个状态屏（她的所思所想 / 聊天模式状态）的虚线框 */
[data-dy-group]{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;
  letter-spacing:.04em;color:var(--dsw-alias-label-secondary,#c9ccd1);}
div[data-dy-group]{padding:2px 4px 0;}
/* 折叠组：整行做成一颗大按钮，一眼看得出能点 */
button[data-dy-groupbtn]{width:100%;box-sizing:border-box;text-align:left;padding:10px 12px;
  border-radius:10px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:600;
  letter-spacing:.04em;display:flex;align-items:center;gap:8px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.08));color:inherit;}
button[data-dy-groupbtn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.2));}
button[data-dy-groupbtn][data-open]{color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-dy-grouphint]{font-size:11px;font-weight:400;letter-spacing:0;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-groupchev]{margin-left:auto;font-size:11px;font-weight:400;letter-spacing:0;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-inner]{display:flex;flex-direction:column;gap:10px;}
[data-dy-subblock]{display:flex;flex-direction:column;gap:10px;margin-top:10px;padding-top:10px;
  border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));}
[data-dy-subblock]:first-child{margin-top:0;padding-top:0;border-top:0;}
[data-dy-subflat]{display:flex;flex-direction:column;border-radius:10px;box-sizing:border-box;}
[data-dy-run]{display:flex;flex-direction:column;gap:5px;padding:9px 10px;border-radius:8px;background:rgba(128,128,128,.07);}
[data-dy-dot]{width:7px;height:7px;border-radius:50%;background:#9aa0a6;flex:none;}
[data-dy-dot][data-tone=active]{background:#3b82f6;}
[data-dy-dot][data-tone=good]{background:#22c55e;}
[data-dy-dot][data-tone=warn]{background:#f59e0b;}
[data-dy-results]{display:flex;flex-direction:column;gap:7px;}
[data-dy-pick]{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));padding-top:8px;}
[data-dy-pick] summary{cursor:pointer;line-height:19px;overflow-wrap:anywhere;}
[data-dy-pick] p{white-space:pre-wrap;overflow-wrap:anywhere;line-height:19px;font-size:12px;margin:8px 0;}
[data-dy-pick] a{color:#3b82f6;font-size:12px;}
[data-dy-page]{--dy-blue:#3b82f6;--dy-line:var(--dsw-alias-border-l2,rgba(128,128,128,.18));max-width:720px;line-height:1.55;}
[data-dy-card]{padding:18px;gap:12px;}
[data-dy-title]{font-size:14px;}
[data-dy-sub],[data-dy-kv]{font-size:12px;line-height:1.65;}
[data-dy-page] button:focus-visible,[data-dy-page] a:focus-visible,[data-dy-page] summary:focus-visible{outline:2px solid var(--dy-blue);outline-offset:3px;}
[data-dy-page] button[aria-disabled=true]{opacity:.55;}
[data-dy-caption]{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-steps]{display:flex;gap:8px;flex-wrap:wrap;margin:2px 0 6px;}
[data-dy-steps] span{padding:4px 9px;border-radius:6px;background:rgba(128,128,128,.08);font-size:12px;}
[data-dy-steps] [data-current]{color:#3b82f6;background:rgba(59,130,246,.1);font-weight:600;}
[data-dy-run]{padding:12px;border:1px solid var(--dy-line);gap:7px;}
[data-dy-stats]{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:12px;padding:6px 0;}
[data-dy-stats] strong{font-variant-numeric:tabular-nums;}
[data-dy-pick]{padding:11px 0 0;}
[data-dy-pick-title]{font-size:13px;font-weight:600;overflow-wrap:anywhere;}
[data-dy-pick] p{margin:5px 0;}
[data-dy-markdown]{font-size:12px;line-height:1.7;overflow-wrap:anywhere;}
[data-dy-markdown] h4{font-size:13px;margin:12px 0 6px;}
[data-dy-markdown] p{white-space:pre-wrap;margin:5px 0;}
[data-dy-markdown] ul,[data-dy-markdown] ol{padding-left:22px;margin:6px 0;}
[data-dy-markdown] a{color:#3b82f6;}
[data-dy-markdown] blockquote{margin:6px 0;border-left:3px solid var(--dy-line);padding-left:10px;}
[data-dy-markdown] code{font-family:Consolas,monospace;background:rgba(128,128,128,.1);padding:1px 3px;border-radius:3px;}
[data-dy-events]{display:flex;flex-direction:column;gap:7px;border-left:2px solid var(--dy-line);padding-left:12px;}
[data-dy-event]{display:flex;gap:10px;align-items:flex-start;font-size:12px;}
[data-dy-event] time{flex:none;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-event][data-warn]{color:#d48a1e;}
[data-dy-days]{display:flex;gap:5px;flex-wrap:wrap;}
[data-dy-days] button{min-width:36px;}
[data-dy-days] [data-on]{border-color:#3b82f6;color:#3b82f6;background:rgba(59,130,246,.1);}
[data-dy-reply]{padding:12px;border:1px solid var(--dy-line);border-radius:8px;display:flex;flex-direction:column;gap:9px;}
[data-dy-collapse]{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:0;background:transparent;color:inherit;padding:0;font:inherit;cursor:pointer;}
[data-dy-collapse] span:last-child{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-wrow]{flex-wrap:wrap;}
[data-dy-area="run"] [data-dy-title]{font-size:16px;line-height:22px;margin:0;}
[data-dy-area="run"] [data-dy-badge]{color:var(--dsw-alias-label-secondary,inherit);background:rgba(128,128,128,.1);}
[data-dy-area="run"] [data-dy-tag]{color:var(--dsw-alias-label-secondary,inherit);background:rgba(128,128,128,.08);}
[data-dy-area="run"] [data-dy-btn],[data-dy-area="run"] [data-dy-mini],[data-dy-guide] button{min-height:32px;box-sizing:border-box;padding:6px 12px;border-radius:6px;font-size:12px;line-height:18px;}
[data-dy-area="run"] [data-dy-btn][data-primary]{background:#2563eb;border-color:#2563eb;}
[data-dy-area="run"] [data-dy-segbtn][data-on]{background:rgba(128,128,128,.12);border-color:var(--dy-line);color:inherit;}
[data-dy-area="run"] [data-dy-msg][data-warn]{color:inherit;border-left:2px solid #d48a1e;}
[data-dy-area="run"] [data-dy-header]{align-items:flex-start;}
[data-dy-run-actions]{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end;}
[data-dy-guide]{box-sizing:border-box;width:min(760px,calc(100vw - 32px));max-height:82vh;max-height:82dvh;padding:0;border:1px solid var(--dy-line);border-radius:8px;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,inherit);font:inherit;box-shadow:0 12px 40px rgba(0,0,0,.2);}
[data-dy-guide][open]{display:flex;flex-direction:column;}
[data-dy-guide]::backdrop{background:rgba(0,0,0,.4);}
[data-dy-guide-header]{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 20px;border-bottom:1px solid var(--dy-line);flex:none;}
[data-dy-guide-header] h2{margin:0;font-size:16px;line-height:24px;font-weight:600;}
[data-dy-guide-body]{padding:16px 20px 24px;overflow:auto;overscroll-behavior:contain;}
[data-dy-guide-body] [data-dy-markdown]{font-size:14px;line-height:1.75;}
[data-dy-guide-body] [data-dy-markdown] h4{font-size:16px;margin:24px 0 8px;}
[data-dy-guide-body] [data-dy-markdown] h4:first-child{margin-top:0;}
[data-dy-guide] button:focus-visible{outline:2px solid var(--dy-blue);outline-offset:3px;}
@media(max-width:480px){[data-dy-run-actions]{flex-direction:column;align-items:flex-end;gap:4px;}[data-dy-area="run"] button,[data-dy-area="run"] a[data-dy-mini],[data-dy-guide] button{min-height:44px;}[data-dy-guide]{width:calc(100vw - 24px);max-height:90dvh;}[data-dy-guide-header],[data-dy-guide-body]{padding-left:16px;padding-right:16px;}}
@media(max-width:480px){[data-dy-card]{padding:14px;}[data-dy-steps]{gap:4px;}[data-dy-bubble]{max-width:90%;}[data-dy-person-name]{max-width:110px;}}
@media(prefers-reduced-motion:reduce){[data-dy-page] *{transition:none!important;}}
/* Remaining settings share one compact form language with the message/send sections. */
[data-dy-preferences]{--pref-ink:var(--dsw-alias-label-primary,#202124);--pref-muted:var(--dsw-alias-label-secondary,#60646c);--pref-surface:var(--dsw-alias-bg-base,var(--dsw-alias-bg-overlay,#fff));color:var(--pref-ink);font-size:14px;line-height:22px;}
[data-dy-preferences] [data-dy-title]{margin:0;font-size:16px;line-height:24px;font-weight:600;}
[data-dy-preferences] h3[data-dy-title]{font-size:14px;line-height:22px;}
[data-dy-preferences] [data-dy-groupname]{font-size:16px;line-height:24px;font-weight:600;}
[data-dy-preferences] p{margin:0;}
[data-dy-preferences] [data-dy-sub],[data-dy-pref-note],[data-dy-preferences] [data-dy-kv]{font-size:13px;line-height:21px;color:var(--pref-muted);overflow-wrap:anywhere;}
[data-dy-preferences] [data-dy-subblock]{gap:12px;margin-top:20px;padding-top:20px;}
[data-dy-preferences] [data-dy-subblock]:first-child{margin-top:4px;padding-top:0;}
[data-dy-preferences] [data-dy-btn],[data-dy-preferences] [data-dy-mini]{min-height:34px;font-size:13px;line-height:20px;padding:6px 12px;border-radius:6px;}
[data-dy-preferences] [data-primary]{background:var(--pref-ink);border-color:var(--pref-ink);color:var(--pref-surface);}
[data-dy-preferences] button:disabled{opacity:1;color:var(--pref-muted);background:transparent;border-color:var(--dy-line);cursor:default;}
[data-dy-preferences] [data-dy-input],[data-dy-preferences] [data-dy-time]{min-height:38px;font-size:14px;line-height:22px;border-radius:6px;background:var(--pref-surface);border-color:var(--dsw-alias-border-l1,#b9bec6);}
[data-dy-preferences] [data-dy-input]:focus-visible,[data-dy-preferences] [data-dy-time]:focus-visible{outline:2px solid var(--pref-ink);outline-offset:2px;}
[data-dy-preferences] textarea{resize:vertical;}
[data-dy-preferences] [data-dy-sw][data-on]{background:var(--pref-ink);}
[data-dy-preferences] [data-dy-sw][data-on] i{background:var(--pref-surface);}
[data-dy-persona-editor]{display:flex;flex-direction:column;gap:12px;}
[data-dy-persona-text]{min-height:360px;line-height:24px!important;padding:14px!important;tab-size:2;}
[data-dy-persona-text][data-large]{min-height:560px;height:70vh;}
[data-dy-pref-editorbar]{display:flex;justify-content:space-between;align-items:center;gap:12px;}
[data-dy-pref-actions]{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:4px;}
[data-dy-pref-field]{display:flex;flex-direction:column;gap:8px;font-size:14px;line-height:22px;}
[data-dy-pref-field]>span{font-weight:500;}
[data-dy-pref-field] select{max-width:260px;}
[data-dy-pref-toggle]{display:flex;align-items:center;justify-content:space-between;gap:12px;}
[data-dy-plan-current]{padding:12px;border:1px solid var(--dy-line);border-radius:6px;display:flex;flex-direction:column;gap:4px;}
[data-dy-plan-current] strong,[data-dy-plan-preview] strong{font-weight:500;font-size:13px;}
[data-dy-plan-current] p{font-size:13px;line-height:21px;}
[data-dy-plan-window]{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr) auto;gap:8px;align-items:end;}
[data-dy-plan-window] label{display:flex;flex-direction:column;gap:4px;min-width:0;}
[data-dy-plan-window] label span{font-size:12px;line-height:20px;color:var(--pref-muted);}
[data-dy-plan-window] input{width:100%;min-width:0;font-variant-numeric:tabular-nums;}
[data-dy-plan-window] button{height:38px;}
[data-dy-plan-to]{padding-bottom:8px;color:var(--pref-muted);}
[data-dy-plan-name]{grid-column:1/-1;font-size:12px;color:var(--pref-muted);}
[data-dy-plan-preset]{display:grid;grid-template-columns:56px minmax(0,1fr) auto;gap:10px;align-items:center;padding:6px 0;}
[data-dy-plan-preset] label{font-size:14px;font-weight:500;}
[data-dy-plan-preset] span{font-size:13px;font-variant-numeric:tabular-nums;}
[data-dy-plan-preview]{border-left:2px solid var(--pref-muted);padding-left:12px;display:flex;flex-direction:column;gap:4px;}
[data-dy-pref-error]{font-size:13px;line-height:21px;border-left:2px solid #a76a21;padding-left:10px;}
[data-dy-pref-details]{font-size:13px;line-height:21px;color:var(--pref-muted);}
[data-dy-pref-details] summary{cursor:pointer;min-height:24px;}
[data-dy-pref-details] p{margin-top:8px;overflow-wrap:anywhere;}
[data-dy-preferences] [data-dy-days]{gap:6px;}
[data-dy-preferences] [data-dy-days] button{padding:6px;flex:1;min-width:0;}
[data-dy-preferences] [data-dy-days] [data-on]{color:var(--pref-ink);background:rgba(128,128,128,.1);border-color:var(--pref-ink);}
[data-dy-preferences] [data-dy-collapse] span:last-child{color:var(--pref-muted);}
[data-dy-count-row]{display:grid;grid-template-columns:minmax(0,1fr) 78px 50px 108px;gap:10px;align-items:center;}
[data-dy-count-row] label{font-size:13px;line-height:21px;}
[data-dy-count-row] button{width:100%;}
[data-dy-output-fields]{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:4px;}
[data-dy-output-fields] select{max-width:none;}
@media(max-width:600px){[data-dy-count-row]{grid-template-columns:78px 1fr auto;gap:8px;}[data-dy-count-row] label{grid-column:1/-1;}[data-dy-output-fields]{grid-template-columns:1fr;}}
[data-dy-update-result]:empty{display:none;}
[data-dy-update-how]{font-size:13px;line-height:21px;overflow-wrap:anywhere;margin-top:8px!important;}
@media(max-width:480px){[data-dy-preferences] button,[data-dy-preferences] input,[data-dy-preferences] select{min-height:44px!important;}[data-dy-preferences] [data-dy-sw]{min-height:28px!important;width:44px;height:28px;}[data-dy-preferences] [data-dy-sw] i{top:6px;left:5px;}[data-dy-preferences] [data-dy-sw][data-on] i{left:23px;}[data-dy-plan-window]{column-gap:6px;}[data-dy-plan-window] button{padding-left:8px;padding-right:8px;}[data-dy-plan-to]{padding-bottom:11px;}[data-dy-persona-text]{min-height:336px;}[data-dy-persona-text][data-large]{min-height:480px;}[data-dy-pref-field] select{max-width:none;}}

`

    const SENDING_CSS = `
[data-dy-area="sending"],[data-dy-recipients]{--send-ink:var(--dsw-alias-label-primary,#202124);--send-muted:var(--dsw-alias-label-secondary,#60646c);--send-rule:var(--dsw-alias-border-l2,#dce0e7);color:var(--send-ink);font-size:14px;line-height:20px;}
[data-dy-area="sending"]{gap:0;}
[data-dy-send-heading]{display:flex;align-items:center;justify-content:space-between;gap:16px;}
[data-dy-send-heading] h2{margin:0;font-size:16px;font-weight:600;line-height:24px;}
[data-dy-send-control]{display:flex;align-items:center;gap:10px;flex:none;}
[data-dy-send-meta]{font-size:12px;line-height:18px;color:var(--send-muted);white-space:nowrap;}
[data-dy-send-note]{margin:6px 0 0;font-size:13px;line-height:20px;color:var(--send-muted);overflow-wrap:anywhere;}
[data-dy-send-section]{border-top:1px solid var(--send-rule);margin-top:18px;padding-top:18px;display:flex;flex-direction:column;gap:10px;min-width:0;}
[data-dy-send-section] h3{font-size:14px;line-height:20px;font-weight:600;margin:0;}
[data-dy-send-section] [data-dy-row]{align-items:center;gap:12px;}
[data-dy-send-section] [data-dy-grow]{flex-basis:160px;}
[data-dy-send-section] [data-dy-send-note]{margin-top:4px;}
[data-dy-area="sending"] [data-dy-btn],[data-dy-area="sending"] [data-dy-mini],[data-dy-recipients] [data-dy-btn]{min-height:32px;box-sizing:border-box;border-radius:6px;font-size:12px;line-height:18px;padding:6px 10px;border-color:var(--send-rule);}
[data-dy-area="sending"] [data-dy-sw]{width:38px;height:32px;background:transparent;border-radius:6px;}
[data-dy-area="sending"] [data-dy-sw]::before{content:'';position:absolute;left:0;top:5px;width:38px;height:22px;border-radius:11px;background:var(--dsw-alias-interactive-bg-hover,#92969c);}
[data-dy-area="sending"] [data-dy-sw][data-on]::before{background:var(--send-ink);}
[data-dy-area="sending"] [data-dy-sw] i{top:8px;background:var(--dsw-alias-bg-overlay,#fff);}
[data-dy-area="sending"] [data-dy-sw]:disabled{opacity:.55;cursor:default;}
[data-dy-area="sending"] button:focus-visible,[data-dy-area="sending"] summary:focus-visible,[data-dy-recipients] button:focus-visible,[data-dy-recipients] summary:focus-visible{outline:2px solid #397bfa;outline-offset:3px;}
[data-dy-send-peers]{display:flex;flex-direction:column;gap:0;}
[data-dy-send-peer]{display:flex;gap:12px;align-items:center;min-height:40px;}
[data-dy-send-peer]+[data-dy-send-peer]{border-top:1px solid var(--send-rule);}
[data-dy-send-peer] strong{font-size:14px;font-weight:500;overflow-wrap:anywhere;}
[data-dy-send-peer] [data-dy-mini]{flex:none;}
[data-dy-send-notice]{font-size:12px;line-height:19px;padding:8px 10px;border-left:2px solid #b68534;background:rgba(160,128,64,.07);overflow-wrap:anywhere;}
[data-dy-area="sending"] [data-feedback="sending"]{font-size:12px;line-height:19px;color:var(--send-ink);margin-top:10px;}
[data-dy-send-details]>summary{display:flex;align-items:center;gap:6px;width:fit-content;cursor:pointer;font-size:12px;color:var(--send-muted);list-style:none;min-height:32px;}
[data-dy-send-details]>summary::before{content:'›';font-size:18px;transition:transform .15s;}
[data-dy-send-details][open]>summary::before{transform:rotate(90deg);}
[data-dy-send-details]>div{display:flex;flex-direction:column;gap:12px;margin-top:8px;}
[data-dy-send-settings]{display:grid;grid-template-columns:minmax(0,1fr) minmax(130px,180px);gap:12px;align-items:center;}
[data-dy-send-settings] label{font-size:12px;color:var(--send-muted);}
[data-dy-area="sending"] [data-dy-input],[data-dy-recipients] [data-dy-input]{height:36px;font-size:14px;border-radius:6px;}
[data-dy-send-details] [data-dy-sub]{font-size:12px;line-height:19px;color:var(--send-muted);opacity:1!important;}
[data-dy-recipients]{padding:0;border:1px solid var(--send-rule);border-radius:8px;background:var(--dsw-alias-bg-overlay,#fff);width:min(560px,calc(100vw - 32px));max-height:85vh;max-height:85dvh;box-shadow:0 12px 40px rgba(0,0,0,.2);}
[data-dy-recipients][open]{display:flex;flex-direction:column;}
[data-dy-recipients]::backdrop{background:rgba(0,0,0,.4);}
[data-dy-recipient-body]{padding:0 20px 16px;overflow:auto;overscroll-behavior:contain;}
[data-dy-recipient-search]{display:flex;gap:8px;margin:16px 0 12px;}
[data-dy-recipient-search] button{flex:none;}
[data-dy-recipient-list]{min-height:64px;max-height:320px;overflow:auto;overscroll-behavior:contain;}
[data-dy-recipient-list]>p{font-size:14px;line-height:22px;color:var(--send-muted);padding:14px 0;}
[data-dy-recipient-option]{width:100%;display:flex;align-items:center;gap:12px;text-align:left;padding:10px 8px;min-height:64px;border:0;border-radius:6px;background:transparent;color:var(--send-ink);font:inherit;cursor:pointer;}
[data-dy-recipient-option]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));}
[data-dy-recipient-option]:disabled{cursor:default;}
[data-dy-checkmark]{display:flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;border:1px solid var(--send-muted);border-radius:4px;font-size:12px;}
[data-selected] [data-dy-checkmark]{background:var(--send-ink);color:var(--dsw-alias-bg-overlay,#fff);border-color:var(--send-ink);}
[data-dy-recipient-copy]{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0;}
[data-dy-recipient-copy] strong{font-weight:500;overflow-wrap:anywhere;}
[data-dy-recipient-copy]>span{font-size:12px;line-height:18px;color:var(--send-muted);overflow-wrap:anywhere;}
[data-dy-recipient-footer]{padding:12px 20px;font-size:12px;color:var(--send-muted);border-top:1px solid var(--send-rule);}
[data-dy-recipient-manual]{border-top:1px solid var(--send-rule);margin-top:12px;padding-top:12px;}
[data-dy-recipient-manual] label{display:flex;flex-direction:column;gap:6px;font-size:12px;}
@media(max-width:480px){[data-dy-area="sending"] [data-dy-btn],[data-dy-area="sending"] [data-dy-mini],[data-dy-recipients] [data-dy-btn],[data-dy-area="sending"] [data-dy-input],[data-dy-recipients] [data-dy-input]{min-height:44px;}[data-dy-area="sending"] [data-dy-sw]{height:44px;width:44px;}[data-dy-area="sending"] [data-dy-sw]::before{top:11px;left:3px;}[data-dy-area="sending"] [data-dy-sw] i{top:14px;left:6px;}[data-dy-area="sending"] [data-dy-sw][data-on] i{left:22px;}[data-dy-send-details]>summary{min-height:44px;}[data-dy-send-settings]{grid-template-columns:minmax(0,1fr);gap:6px;}[data-dy-recipient-body]{padding:0 14px 14px;}[data-dy-recipient-footer]{padding:12px 14px;}[data-dy-send-control]{gap:6px;}}
@media(prefers-reduced-motion:reduce){[data-dy-area="sending"] *,[data-dy-area="sending"] *::before{transition:none!important;}}
`

    const MESSAGES_CSS = `
[data-dy-area="messages"]{--msg-ink:var(--dsw-alias-label-primary,#202124);--msg-muted:var(--dsw-alias-label-secondary,#60646c);--msg-rule:var(--dsw-alias-border-l2,#dce0e7);color:var(--msg-ink);font-size:14px;line-height:22px;gap:16px;}
[data-dy-area="messages"] h2{font-size:16px;line-height:24px;margin:0;font-weight:600;}
[data-dy-area="messages"] h3{font-size:14px;line-height:22px;margin:0;font-weight:600;overflow-wrap:anywhere;}
[data-dy-area="messages"] p{margin:0;}
[data-dy-message-note],[data-dy-area="messages"] [data-dy-sub],[data-dy-area="messages"] [data-dy-caption]{font-size:13px;line-height:20px;color:var(--msg-muted);overflow-wrap:anywhere;}
[data-dy-area="messages"] [data-dy-btn],[data-dy-area="messages"] [data-dy-mini]{min-height:32px;padding:6px 10px;font-size:13px;line-height:18px;border-radius:6px;border-color:var(--msg-rule);}
[data-dy-area="messages"] [data-dy-btn][data-primary]{background:var(--msg-ink);color:var(--dsw-alias-bg-overlay,#fff);border-color:var(--msg-ink);}
[data-dy-area="messages"] [data-dy-btn]:disabled,[data-dy-area="messages"] [data-dy-mini]:disabled{opacity:.65;}
[data-dy-area="messages"] button:focus-visible,[data-dy-area="messages"] summary:focus-visible,[data-dy-area="messages"] a:focus-visible{outline:2px solid #397bfa;outline-offset:3px;}
[data-dy-message-tabs]{display:flex;gap:20px;border-bottom:1px solid var(--msg-rule);}
[data-dy-message-tabs] button{border:0;border-bottom:2px solid transparent;background:transparent;padding:8px 0;color:var(--msg-muted);font:inherit;font-size:14px;cursor:pointer;}
[data-dy-message-tabs] button[aria-pressed="true"]{color:var(--msg-ink);border-bottom-color:var(--msg-ink);font-weight:500;}
[data-dy-dm-row]{display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%;min-height:66px;padding:12px 0;text-align:left;border:0;border-bottom:1px solid var(--msg-rule);background:transparent;color:inherit;font:inherit;cursor:pointer;}
[data-dy-dm-row]:last-child{border-bottom:0;}
[data-dy-dm-row]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));}
[data-dy-dm-copy]{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1;}
[data-dy-dm-copy] strong{font-size:14px;font-weight:500;}
[data-dy-dm-preview]{font-size:13px;line-height:20px;color:var(--msg-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-dy-dm-action]{font-size:13px;white-space:nowrap;flex:none;}
[data-dy-message-empty]{padding:16px 0;font-size:14px;color:var(--msg-muted);}
[data-dy-conversation]{display:flex;flex-direction:column;gap:14px;min-width:0;}
[data-dy-conversation-head]{display:flex;align-items:center;gap:10px;}
[data-dy-conversation-head] h3{flex:1;min-width:0;}
[data-dy-area="messages"] [data-dy-chat]{padding:0;max-height:280px;min-height:0;background:none;border:0;gap:10px;overscroll-behavior:contain;}
[data-dy-area="messages"] [data-dy-bubble]{font-size:14px;line-height:22px;padding:9px 12px;border-radius:8px;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));}
[data-dy-area="messages"] [data-dy-bubble][data-mine]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18));}
[data-dy-bubble-author]{font-size:12px;line-height:18px;color:var(--msg-muted);margin-bottom:3px;}
[data-dy-dm-reply]{padding-top:14px;border-top:1px solid var(--msg-rule);display:flex;flex-direction:column;gap:10px;}
[data-dy-dm-result]{padding:10px 12px;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.08));border-radius:6px;font-size:13px;line-height:21px;overflow-wrap:anywhere;}
[data-dy-dm-result] p{white-space:pre-wrap;margin-top:4px;}
[data-dy-dm-result][data-warning]{border-left:2px solid #b68534;}
[data-dy-message-memory]{padding-top:16px;border-top:1px solid var(--msg-rule);}
[data-dy-message-memory]>summary{display:flex;justify-content:space-between;align-items:center;cursor:pointer;list-style:none;min-height:32px;font-size:14px;font-weight:500;}
[data-dy-message-memory]>summary::after{content:'›';font-size:20px;font-weight:400;}
[data-dy-message-memory][open]>summary::after{transform:rotate(90deg);}
[data-dy-message-memory]>div{padding-top:10px;display:flex;flex-direction:column;gap:12px;}
[data-dy-area="messages"] [data-dy-msg]{font-size:13px;line-height:20px;color:var(--msg-ink);margin:0;}
[data-dy-area="messages"] [data-dy-inner]{padding:0;border:0;background:transparent;margin:0;}
[data-dy-area="messages"] [data-dy-msgrow]{padding:12px 0;font-size:14px;}
[data-dy-area="messages"] [data-dy-tag]{font-size:12px;color:var(--msg-muted);background:transparent;padding:0;}
[data-dy-comment]{display:flex;flex-direction:column;gap:10px;padding:18px 0;min-width:0;}
[data-dy-comment]:first-child{padding-top:0;}
[data-dy-comment]:last-child{padding-bottom:0;}
[data-dy-comment]+[data-dy-comment]{border-top:1px solid var(--msg-rule);}
[data-dy-comment-head]{display:flex;align-items:center;justify-content:space-between;gap:16px;}
[data-dy-comment-head] strong{font-weight:600;font-size:14px;overflow-wrap:anywhere;flex:1;min-width:0;}
[data-dy-comment-link]{color:var(--msg-muted);font-size:13px;text-decoration:underline;text-underline-offset:3px;white-space:nowrap;min-height:32px;display:inline-flex;align-items:center;}
[data-dy-comment-text]{font-size:15px;line-height:24px;white-space:pre-wrap;overflow-wrap:anywhere;}
[data-dy-comment-work]{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--msg-muted);overflow-wrap:anywhere;}
[data-dy-comment-history]{font-size:13px;line-height:21px;color:var(--msg-muted);}
[data-dy-comment-history]>summary{cursor:pointer;width:fit-content;min-height:28px;display:flex;align-items:center;gap:6px;list-style:none;}
[data-dy-comment-history]>summary::before{content:'›';font-size:18px;}
[data-dy-comment-history][open]>summary::before{transform:rotate(90deg);}
[data-dy-comment-history]>div,[data-dy-comment-history]>p{padding:8px 0 4px 12px;white-space:pre-wrap;overflow-wrap:anywhere;}
[data-dy-comment-history] p+p{margin-top:6px;}
[data-dy-comment-action]{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
[data-dy-ai-comment]{min-width:92px;background:transparent;}
[data-dy-comment] [data-dy-dm-result]{margin:0;}
[data-dy-area="messages"] [data-danger]{color:var(--dsw-alias-label-primary,#9b3030);}
@media(max-width:480px){[data-dy-area="messages"] [data-dy-btn],[data-dy-area="messages"] [data-dy-mini],[data-dy-message-tabs] button,[data-dy-message-memory]>summary,[data-dy-comment-history]>summary,[data-dy-comment-link]{min-height:44px;}[data-dy-message-tabs]{gap:18px;}[data-dy-dm-action]{font-size:12px;}[data-dy-conversation-head]{flex-wrap:wrap;}[data-dy-area="messages"] [data-dy-bubble]{max-width:90%;}}
`

    const replyLabels = { reading: '读取上下文…', generating: 'DSH 正在生成…', sending: '正在发送…',
      sent: 'DSH 已回复', 'sent-warning': '已发送，回复位置待核对', failed: '回复未完成', uncertain: '发送结果待核对',
      unconfirmed: '正在查询处理结果…', skipped: '本次未发送' }

    /** Shared job lifecycle for both message channels. Viewing and polling never start a reply. */
    function useReplyJob({ path, query, enabled, onSent }) {
      const [job, setJob] = React.useState(null)
      const [error, setError] = React.useState('')
      const [ready, setReady] = React.useState(false)
      const [starting, setStarting] = React.useState(false)
      const alive = React.useRef(true)
      const pending = React.useRef(false)
      const checking = React.useRef(false)
      const current = React.useRef(null)
      const observed = React.useRef('')
      const sentCallback = React.useRef(onSent)
      sentCallback.current = onSent
      const accept = (next) => {
        if (!alive.current) return
        current.current = next; setJob(next); setReady(true); setError('')
        if (['sent', 'sent-warning'].includes(next?.status) && next.id !== observed.current) {
          observed.current = next.id; sentCallback.current?.(next)
        }
      }
      const check = async () => {
        if (!enabled || checking.current) return
        checking.current = true
        try {
          const r = await jget(path + '?' + query)
          if (!r?.ok) throw new Error(r?.error || '暂时无法读取回复状态')
          // Missing evidence after a disconnected POST is not proof that nothing happened.
          if (!r.job && current.current?.status === 'unconfirmed') return
          accept(r.job || null)
        } catch (e) { if (alive.current) setError('回复状态暂不可用：' + String(e?.message || e)) }
        finally { checking.current = false }
      }
      React.useEffect(() => {
        alive.current = true; check()
        const timer = setInterval(() => { if (current.current && !current.current.done) check() }, 2500)
        return () => { alive.current = false; clearInterval(timer) }
      }, [path, query, enabled])
      const start = async (payload) => {
        if (pending.current || !enabled || !ready || (current.current && !current.current.done)) return
        pending.current = true; setStarting(true); setError('')
        try {
          const r = await jpost(path, { ...payload, confirm: true })
          if (r?.job) accept(r.job)
          else if (!r?.ok) accept({ status: 'failed', done: true, error: r?.error || '未能启动回复' })
          else throw new Error('未收到回复任务状态')
        } catch (e) {
          if (alive.current) {
            const unknown = { status: 'unconfirmed', done: false, error: '连接中断，暂未确认处理结果。正在查询状态，请勿重复发送。' }
            current.current = unknown; setJob(unknown); setError(String(e?.message || e)); check()
          }
        } finally { pending.current = false; if (alive.current) setStarting(false) }
      }
      return { job, error, ready, starting, current, pending, check, start, active: starting || Boolean(job && !job.done) }
    }

    function ReplyResult({ reply }) {
      const { job, error } = reply
      const warning = ['failed', 'uncertain', 'unconfirmed', 'sent-warning'].includes(job?.status)
      return h(React.Fragment || 'div', null,
        job ? h('div', { 'data-dy-dm-result': '', role: 'status', 'data-warning': warning ? '' : undefined },
          h('strong', null, replyLabels[job.status] || '正在处理…'),
          job.error || job.note || job.hint ? h('p', null, job.error || job.note || job.hint) : null,
          ['sent', 'sent-warning'].includes(job.status) && job.text ? h('p', null, job.text) : null) : null,
        error ? h('p', { 'data-dy-message-note': '', role: 'alert' }, error) : null,
        error || ['uncertain', 'unconfirmed'].includes(job?.status) ? h('button', { 'data-dy-mini': '', onClick: reply.check }, '查询处理结果') : null)
    }

    function CommentConversation({ item }) {
      const identifiable = Boolean(item.aweme_id && item.comment_id)
      const reply = useReplyJob({ path: '/comment/ai-reply', enabled: identifiable,
        query: 'aweme_id=' + encodeURIComponent(item.aweme_id || '') + '&comment_id=' + encodeURIComponent(item.comment_id || '') })
      const { job, active } = reply
      const completed = ['sent', 'sent-warning'].includes(job?.status)
      const locked = active || completed || ['uncertain', 'unconfirmed'].includes(job?.status)
      const send = () => {
        if (!identifiable || locked || !reply.ready || reply.error) return
        return reply.start({ aweme_id: String(item.aweme_id), comment_id: String(item.comment_id),
          ...(item.root_comment_id ? { root_comment_id: String(item.root_comment_id) } : {}),
          ...(workLink(item) ? { work_url: workLink(item) } : {}),
          ...(item.aweme_type != null ? { aweme_type: item.aweme_type } : {}) })
      }
      return h('article', { 'data-dy-comment': '', 'aria-label': (item.nickname || '未知用户') + '的评论' },
        h('div', { 'data-dy-comment-head': '' },
          h('strong', null, item.nickname || '未知用户'),
          h('button', { 'data-dy-btn': '', 'data-dy-ai-comment': '', disabled: !identifiable || locked || !reply.ready || Boolean(reply.error), onClick: send },
            active ? replyLabels[job?.status] || '正在启动…' : completed ? '已回复' : job?.status === 'uncertain' ? '结果待核对' : 'DSH 回复')),
        h('p', { 'data-dy-comment-text': '' }, item.content || '这条评论没有可读取的文字。'),
        workLink(item) || item.aweme_desc || item.title ? h('div', { 'data-dy-comment-work': '' },
          item.aweme_desc || item.title ? h('span', null, '作品：' + (item.aweme_desc || item.title)) : null,
          workLink(item) ? h('a', { href: workLink(item), target: '_blank', rel: 'noopener noreferrer', 'data-dy-comment-link': '' }, '查看作品 ↗') : null) : null,
        item.my_comments_here?.length ? h('details', { 'data-dy-comment-history': '' },
          h('summary', null, '我在这条作品下的过往发言 · ' + item.my_comments_here.length),
          h('div', null, item.my_comments_here.map((comment, i) => h('p', { key: i }, String(comment.text || ''))))) : null,
        !identifiable ? h('span', { 'data-dy-message-note': '' }, '缺少原评论标识，请到抖音查看。') : null,
        h(ReplyResult, { reply }))
    }

    function ChatConversation({ who, onBack, onSent }) {
      const [data, setData] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [readError, setReadError] = React.useState('')
      const alive = React.useRef(true)
      const readPending = React.useRef(false)
      const messageLog = React.useRef(null)
      const id = String(who.sec_uid || '')
      const read = async () => {
        if (readPending.current) return
        readPending.current = true; setLoading(true)
        try {
          const r = await jpost('/chat/read', { to: who.nick, to_id: id })
          if (!r?.ok) throw new Error(r?.error || r?.hint || '会话暂时读不到')
          if (alive.current) { setData(r); setReadError('') }
        } catch (e) { if (alive.current) setReadError('读取失败：' + String(e?.message || e)) }
        finally { readPending.current = false; if (alive.current) setLoading(false) }
      }
      const reply = useReplyJob({ path: '/chat/reply', query: 'to_id=' + encodeURIComponent(id), enabled: Boolean(id), onSent: () => { read(); onSent(who) } })
      React.useEffect(() => { if (messageLog.current) messageLog.current.scrollTop = messageLog.current.scrollHeight }, [data?.messages?.length])
      React.useEffect(() => {
        alive.current = true; read()
        const messages = setInterval(() => { if (!reply.pending.current && (!reply.current.current || reply.current.current.done)) read() }, 30_000)
        return () => { alive.current = false; clearInterval(messages) }
      }, [id])
      const { job, active } = reply
      const uncertain = ['uncertain', 'unconfirmed'].includes(job?.status)
      const latest = data?.messages?.at(-1)
      const newInbound = job?.inbound && latest?.from === 'them' && (
        String(latest.text || '').trim() !== String(job.inbound.text || '').trim()
        || (latest.at && job.inbound.at && String(latest.at) !== String(job.inbound.at)))
      const canReply = id && !who.is_group && data && !readError && reply.ready && !reply.error && !active && (!uncertain || newInbound)
      return h('div', { 'data-dy-conversation': '' },
        h('div', { 'data-dy-conversation-head': '' },
          h('button', { 'data-dy-mini': '', onClick: onBack }, '返回私信'),
          h('h3', null, who.nick || '私信会话'),
          h('button', { 'data-dy-mini': '', disabled: loading, onClick: () => { read(); reply.check() } }, loading ? '读取中…' : '刷新对话')),
        readError ? h('p', { role: 'alert', 'data-dy-message-note': '' }, readError) : null,
        !data ? h('p', { 'data-dy-message-empty': '' }, loading ? '正在读取对话…' : '尚未读到对话，请刷新重试。') :
          h('div', { 'data-dy-chat': '', ref: messageLog, role: 'log', 'aria-label': '私信记录' },
            data.messages?.length ? data.messages.map((m, i) => h('div', { key: i, 'data-dy-bubble': '',
              'data-mine': m.from === 'me' ? '' : undefined, 'data-them': m.from === 'them' ? '' : undefined },
              h('div', { 'data-dy-bubble-author': '' }, m.from === 'me' ? '我' : m.from === 'them' ? who.nick : '发送方未确认'),
              h('div', { 'data-dy-bubble-text': '' }, String(m.text || (m.awe === 800 ? '分享卡片' : '非文字消息'))),
              m.awe === 800 && m.text ? h('div', { 'data-dy-message-note': '' }, '分享卡片') : null)) :
              h('p', { 'data-dy-message-empty': '' }, '暂时没有可展示的私信。')),
        data?.context?.facts?.length ? h('details', { 'data-dy-comment-history': '' }, h('summary', null, '对方的记忆'),
          h('p', null, '关于对方：' + data.context.facts.join('、'))) : null,
        h('div', { 'data-dy-dm-reply': '' },
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', 'data-primary': '', 'data-dy-ai-dm': '', disabled: !canReply,
              onClick: () => canReply && reply.start({ to: who.nick, to_id: id }) }, active ? replyLabels[job?.status] || '正在启动…' : 'DSH 回复'),
            h('span', { 'data-dy-message-note': '' }, '回复这位好友的最新消息')),
          !id || who.is_group ? h('p', { 'data-dy-message-note': '' }, who.is_group ? '暂不支持由 DSH 回复群聊。' : '这条会话缺少账号标识，暂时不能由 DSH 回复。') : null,
          uncertain && newInbound ? h('p', { 'data-dy-message-note': '' }, '对方又发来了新消息，可以回复这条新消息；上次未确认的内容不会重发。') : null,
          h(ReplyResult, { reply })))
    }

    function Switch({ on, onChange, disabled, label, id }) {
      return h('button', {
        id, 'data-dy-sw': '', 'data-on': on ? '' : undefined,
        role: 'switch', 'aria-checked': Boolean(on), 'aria-label': label || '切换设置',
        disabled: Boolean(disabled),
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    // Contact selection stays beside its task in a modal; selection writes use the existing config API.
    function RecipientDialog({ mode, people, loading, hint, error, selected, busy, onToggle, onReload, onClose, feedback, children }) {
      const dialog = React.useRef(null)
      const [query, setQuery] = React.useState('')
      React.useEffect(() => {
        const trigger = document.activeElement, modal = dialog.current
        modal?.showModal()
        return () => { modal?.close(); trigger?.focus() }
      }, [])
      const matches = (people || []).filter((person) => String(person.nick || '').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
      return h('dialog', { ref: dialog, 'data-dy-recipients': '', 'aria-labelledby': 'dy-recipients-title',
        onCancel: (event) => { event.preventDefault(); onClose() },
        onKeyDown: (event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
          if (event.key !== 'Tab') return
          const nodes = [...event.currentTarget.querySelectorAll('button:not([disabled]), input:not([disabled]), summary, [tabindex="0"]')].filter((node) => node.getClientRects().length)
          const first = nodes[0], last = nodes.at(-1)
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        } },
        h('header', { 'data-dy-guide-header': '' }, h('h2', { id: 'dy-recipients-title' }, mode === 'dm' ? '选择私信接收人' : '选择评论区 @ 对象'),
          h('button', { 'data-dy-btn': '', onClick: onClose }, '完成')),
        h('div', { 'data-dy-recipient-body': '' },
          h('p', { 'data-dy-send-note': '' }, mode === 'dm' ? '选中后自动保存，推荐会发给列表中的每个人。' : '选中后自动保存，仅在自动发送和 @ 提醒都开启时生效。'),
          h('div', { 'data-dy-recipient-search': '' },
            h('input', { 'data-dy-input': '', type: 'search', autoFocus: true, 'aria-label': '搜索会话昵称', placeholder: '搜索昵称', value: query, onChange: (event) => setQuery(event.target.value) }),
            h('button', { 'data-dy-btn': '', disabled: busy, onClick: onReload }, loading ? '读取中…' : '刷新会话')),
          hint ? h('p', { 'data-dy-send-notice': error ? '' : undefined, 'data-dy-send-note': error ? undefined : '', role: error ? 'alert' : 'status' }, hint) : null,
          h('div', { 'data-dy-recipient-list': '', 'aria-label': '可选会话', 'aria-busy': loading },
            loading && people === null ? h('p', { role: 'status' }, '正在读取会话…')
              : matches.length ? matches.map((person, index) => {
                const checked = selected(person), unavailable = mode === 'at' && person.is_group
                return h('button', { key: `${person.sec_uid || person.nick}-${index}`, 'data-dy-recipient-option': '', role: 'checkbox',
                  'aria-checked': checked, 'aria-label': person.nick, disabled: busy || unavailable, onClick: () => onToggle(person),
                  'data-selected': checked ? '' : undefined },
                  h('span', { 'data-dy-checkmark': '', 'aria-hidden': true }, checked ? '✓' : ''),
                  h('span', { 'data-dy-recipient-copy': '' }, h('strong', null, person.nick),
                    h('span', null, person.is_group ? (mode === 'at' ? '群聊不能作为 @ 对象' : '群聊 · 网页端发送可能无法送达') : person.duplicate ? '重名会话' + (person.preview ? ' · ' + person.preview : '') : person.preview || '私信会话')),
                  checked ? h('span', { 'data-dy-send-meta': '' }, '已选') : null)
              }) : h('p', null, query ? '没有匹配的会话，请换个昵称。' : hint ? '可重新读取会话。' : '暂无会话，请先在抖音建立会话后刷新。')),
          children),
        h('footer', { 'data-dy-recipient-footer': '', role: 'status', 'aria-live': 'polite' }, feedback || (loading ? '正在读取会话…' : busy ? '正在保存…' : '更改会立即保存')))
    }

    // A modal document keeps long help near its trigger without expanding the settings layout.
    function GuideDialog({ onClose }) {
      const dialog = React.useRef(null)
      const [text, setText] = React.useState(null)
      const [error, setError] = React.useState('')
      const [attempt, setAttempt] = React.useState(0)
      React.useEffect(() => {
        const trigger = document.activeElement
        const modal = dialog.current
        modal?.showModal()
        return () => { modal?.close(); trigger?.focus() }
      }, [])
      React.useEffect(() => {
        const controller = new AbortController()
        setError('')
        setText(null)
        jget('/guide', { signal: controller.signal }).then((r) => {
          if (!r?.ok || !String(r.text || '').trim()) throw new Error('使用指南暂不可用')
          if (!controller.signal.aborted) setText(r.text)
        }).catch(() => { if (!controller.signal.aborted) setError('使用指南读取失败，请重试。') })
        return () => controller.abort()
      }, [attempt])
      return h('dialog', { ref: dialog, 'data-dy-guide': '', 'aria-labelledby': 'dy-guide-title',
        onCancel: (event) => { event.preventDefault(); onClose() },
        onKeyDown: (event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
          if (event.key !== 'Tab') return
          const focusable = [...event.currentTarget.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
            .filter((element) => element.getClientRects().length)
          const first = focusable[0], last = focusable.at(-1)
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        } },
        h('header', { 'data-dy-guide-header': '' },
          h('h2', { id: 'dy-guide-title' }, '使用指南'),
          h('button', { 'data-dy-btn': '', autoFocus: true, onClick: onClose }, '关闭')),
        h('div', { 'data-dy-guide-body': '', tabIndex: 0, 'aria-label': '使用指南正文' },
          error ? h('div', { role: 'alert' }, h('p', null, error),
            h('button', { 'data-dy-btn': '', onClick: () => setAttempt((value) => value + 1) }, '重新读取指南'))
            : text === null ? h('p', { role: 'status' }, '正在读取使用指南…') : h(Markdown, { text })))
    }

    /**
     * ⭐ 聊天模式的实时状态屏（2026-10-24，使用者两轮反馈打磨成拟人版）。
     *    使用者原话：「显示 AI 现在在干嘛」→「要拟人，小鱼在干啥干啥，
     *    最后是小鱼抱着手机等着你发消息呢，还有正在发送之类的」。
     *    设计：一条**小鱼的动作**（emoji + 一句话）+ 一行小字（技术参数，给排障用）。
     *    每 15 秒拉一次 /chat/watch（读状态文件，很轻）。
     */
    function ChatWatchStatus() {
      const [s, setS] = React.useState(null)
      const [tick, setTick] = React.useState(0) // 本地 1 秒一跳：让"下次还有 X 秒"活起来
      React.useEffect(() => {
        let alive = true
        const pull = async () => {
          try { const r = await jget('/chat/watch'); if (alive && r && r.ok) setS(r) } catch { /* 拉不到等下一拍 */ }
        }
        pull()
        const t = setInterval(pull, 15_000)
        const t2 = setInterval(() => setTick((x) => x + 1), 1000)
        return () => { alive = false; clearInterval(t); clearInterval(t2) }
      }, [])
      if (!s) return h('div', { 'data-dy-sub': '' }, '🐟 小鱼正在游过来…（状态加载中）')
      void tick // tick 只用于触发重渲染，不直接读
      const ago = s.lastCheckAt ? Math.max(0, Math.round((Date.now() - s.lastCheckAt) / 1000)) : null
      const sec = Number(s.sec || 30)
      const nextIn = s.lastCheckAt ? Math.max(0, sec - ago) : sec
      /* ⭐⭐ 2026-10-26 凌晨（主人：「如果是普通用户，他该怎么办，没那么聪明啊」）
       *   面板不再让用户读内部字段（lastResult / lastError 是给排障的），
       *   分两层显示：
       *     第一层 = 后端给的一句人话（s.human）+ 该干什么（s.action）—— 普通人只看这层
       *     第二层 = 技术细节（几秒前 · 走了哪条路 · 看了几次）—— 默认小字，排障才看
       *   health=broken 时把 action 高亮成橙色，warning 黄色，ok 绿点。
       */
      const health = s.health || (s.lastResult === 'error' ? 'warning' : 'ok')
      const DOT = { ok: '🟢', warning: '🟡', broken: '🔴', off: '⚪' }
      const FISH = {
        ok: `🐟 小鱼抱着手机趴在缸边等着呢——刚看过（${ago} 秒前），还没有新消息。下次去看还有 ${nextIn} 秒`,
        ok_prime: `🐳 小鱼刚接班，正在把聊天记录翻到最新一页（之前的不重播，从现在起只等新的）`,
        ok_new: `🔔 小鱼看到新消息了：「${s.lastNewText || ''}」——已经转给值班的小鱼接话`,
        error: `😵 小鱼撞缸了`,
        no_match: `🤔 小鱼在已建立会话里没找到「${s.to || '这个人'}」：${s.lastNote || '陌生人消息走不了这条路'}`,
        off: `😴 开关关了，小鱼在缸底睡觉（这条是旧状态）`,
        skip_no_to: `🫥 小鱼不知道该盯谁——还没选私信对象`,
        skip_no_login: `🫥 小鱼进不去抖音——还没登录`,
      }
      // 后端给了人话就用它（普通人只看得懂那个）；没给才退回老的拟人句
      const line = s.human || FISH[s.lastResult] || `🐟 小鱼状态：${s.lastResult || '刚下水，还没跑第一拍'}`
      const tone = health === 'broken' ? '#f59e0b' : health === 'warning' ? '#fbbf24' : null
      return h('div', { 'data-dy-inner': '', 'data-dy-subflat': '', style: { background: 'transparent', border: '1px dashed var(--dsw-alias-border-l2,rgba(255,255,255,.14))', padding: '8px 10px', gap: '4px' } },
        h('div', { 'data-dy-sub': '', style: { opacity: '.95' } }, `${DOT[health] || '🐟'} ${line}`),
        // 该干什么：只有真需要用户动手时才显示（action 为空 = 不用管）
        s.action
          ? h('div', { 'data-dy-sub': '', style: { color: tone || 'inherit', fontWeight: '500' } }, `👉 ${s.action}`)
          : null,
        h('div', { 'data-dy-sub': '', style: { opacity: '.7' } },
          `每 ${sec} 秒看一眼「${s.to || '私信对象'}」· 走 ${s.via || 'http'} · 已看 ${s.checks || 0} 次 · 提醒过 ${s.notified || 0} 条${s.failStreak ? ` · 连续失败 ${s.failStreak} 次` : ''}`))
    }

    /**
     * ⭐ 关键：绝不能让组件抛错把整页搞没。
     *    用 error boundary 包住 —— 任何子组件炸了只显示一句提示 + 重试，
     *    而不是像之前那样整块空白（一个 TDZ 错误就能让面板彻底消失）。
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { err: null }
      }
      static getDerivedStateFromError(err) {
        return { err: String((err && err.message) || err) }
      }
      render() {
        if (this.state.err) {
          return h('div', { 'data-dy-card': '' },
            h('div', { 'data-dy-title': '' }, '⚠️ 这个面板出错了'),
            h('div', { 'data-dy-sub': '' }, this.state.err),
            h('div', { 'data-dy-row': '' },
              h('button', {
                'data-dy-btn': '',
                onClick: () => this.setState({ err: null }),
              }, '重试')))
        }
        return this.props.children
      }
    }

    const scheduleTime = (value) => {
      const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''))
      return match && +match[1] < 24 && +match[2] < 60 ? +match[1] * 60 + +match[2] : null
    }
    const clockText = (value) => scheduleTime(value) === null ? String(value || '') : String(value).padStart(5, '0')
    const timeRange = (row) => `${clockText(row.start)}–${scheduleTime(row.end) < scheduleTime(row.start) ? '次日 ' : ''}${clockText(row.end)}`
    const dayNames = ['日', '一', '二', '三', '四', '五', '六']
    const daysText = (days) => days.length === 7 ? '每天' : days.length ? [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d)).map((d) => '周' + dayNames[d]).join('、') : '未选择星期'
    const schedulePresets = [
      { source: 'noon', name: '中午', start: '12:00', end: '14:00' },
      { source: 'night', name: '夜间', start: '18:00', end: '09:00' },
    ]
    const planFromConfig = (cfg) => ({
      enabled: cfg.autoEnabled == null ? Number(cfg.perDay) > 0 : Boolean(cfg.autoEnabled),
      days: Array.isArray(cfg.scheduleDays) ? [...cfg.scheduleDays] : [0, 1, 2, 3, 4, 5, 6],
      rows: [
        ...schedulePresets.filter((preset) => cfg[preset.source]).map((preset) => ({ ...preset })),
        ...(Array.isArray(cfg.windows) ? cfg.windows.map((row) => ({ ...row, source: 'custom', start: clockText(row?.start), end: clockText(row?.end) })) : []),
      ],
    })
    // Compare the actual selected start weekdays, including the Sunday/Monday boundary.
    const planError = (plan) => {
      const intervals = []
      const name = (index) => schedulePresets.find((preset) => preset.source === plan.rows[index].source)?.name
        || `自定义时段 ${plan.rows.slice(0, index + 1).filter((row) => row.source === 'custom').length}`
      for (const [index, row] of plan.rows.entries()) {
        const start = scheduleTime(row.start), end = scheduleTime(row.end)
        if (start === null || end === null) return `${name(index)}：请填写完整的开始和结束时间。`
        if (start === end) return `${name(index)}：开始与结束不能相同。`
        for (const day of plan.days) intervals.push({ index, start: day * 1440 + start, end: day * 1440 + end + (end < start ? 1440 : 0) })
      }
      for (let i = 0; i < intervals.length; i++) for (let j = i + 1; j < intervals.length; j++) {
        const a = intervals[i], b = intervals[j]
        if ([-10080, 0, 10080].some((offset) => a.start < b.end + offset && b.start + offset < a.end)) {
          return `${name(a.index)}与${name(b.index)}重叠，请调整后保存。`
        }
      }
      return ''
    }
    const planPatch = (plan) => {
      const windows = [], result = { autoEnabled: plan.enabled, scheduleDays: plan.days, noon: false, night: false }
      for (const row of plan.rows) {
        if (row.source === 'noon' && row.start === '12:00' && row.end === '14:00') result.noon = true
        else if (row.source === 'night' && row.start === '18:00' && row.end === '09:00') result.night = true
        else windows.push({ start: row.start, end: row.end, label: String(row.label || '').trim() })
      }
      return { ...result, windows, __clearKeys: [...(!windows.length ? ['windows'] : []), ...(!plan.days.length ? ['scheduleDays'] : [])] }
    }

    function ScheduleEditor({ cfg, draft, onChange, onSave, busy, summary, nextWindow, feedback }) {
      const plan = draft || planFromConfig(cfg)
      const days = [...plan.days].sort().join(',')
      const dayMode = plan.dayMode || (days === '0,1,2,3,4,5,6' ? 'daily' : days === '1,2,3,4,5' ? 'weekdays' : days === '0,6' ? 'weekends' : 'custom')
      const error = planError(plan)
      const change = (values) => onChange({ ...plan, ...values })
      const changeRow = (index, key, value) => change({ rows: plan.rows.map((row, i) => i === index ? { ...row, [key]: value } : row) })
      const customRows = plan.rows.map((row, index) => ({ row, index })).filter(({ row }) => row.source === 'custom')
      const togglePreset = (preset, enabled) => {
        const enabledPresets = new Set(plan.rows.filter((row) => row.source !== 'custom').map((row) => row.source))
        if (enabled) enabledPresets.add(preset.source)
        else enabledPresets.delete(preset.source)
        change({ rows: [...schedulePresets.filter((row) => enabledPresets.has(row.source)), ...customRows.map(({ row }) => row)] })
      }
      return h('section', { 'data-dy-subblock': '', 'data-dy-plan': '' },
        h('h3', { 'data-dy-title': '' }, '自动运行计划'),
        h('p', { 'data-dy-pref-note': '' }, 'DSH 保持开启时，每个时段内最多启动一轮，不保证整点执行。'),
        h('div', { 'data-dy-plan-current': '', 'aria-live': 'polite' },
          h('strong', null, '当前计划'), h('p', null, summary),
          nextWindow ? h('p', null, `${nextWindow.active ? '当前可用时段' : '下个可用时段'}：${shortTime(nextWindow.startsAt)}–${shortTime(nextWindow.endsAt)}`) : null,
          planError(planFromConfig(cfg)) && planFromConfig(cfg).enabled ? h('div', null,
            h('button', { 'data-dy-mini': '', disabled: busy, onClick: () => onSave({ autoEnabled: false }, '自动计划已暂停', 'schedule') }, '暂停当前计划')) : null),
        h('div', { 'data-dy-pref-toggle': '' }, h('label', { htmlFor: 'dy-plan-enabled' }, '允许自动运行'),
          h(Switch, { id: 'dy-plan-enabled', label: '允许自动运行', on: plan.enabled, disabled: busy, onChange: (enabled) => change({ enabled }) })),
        h('label', { 'data-dy-pref-field': '' }, h('span', null, '重复日期'),
          h('select', { 'data-dy-input': '', 'aria-label': '重复日期', value: dayMode, disabled: busy,
            onChange: (e) => change({ dayMode: e.target.value, days: e.target.value === 'daily' ? [0,1,2,3,4,5,6] : e.target.value === 'weekdays' ? [1,2,3,4,5] : e.target.value === 'weekends' ? [0,6] : plan.days }) },
            h('option', { value: 'daily' }, '每天'), h('option', { value: 'weekdays' }, '周一至周五'),
            h('option', { value: 'weekends' }, '周六、周日'), h('option', { value: 'custom' }, '选择星期'))),
        dayMode === 'custom' ? h('div', { 'data-dy-days': '', role: 'group', 'aria-label': '选择星期' },
          [1,2,3,4,5,6,0].map((day) => h('button', { key: day, 'data-dy-mini': '', disabled: busy,
            'data-on': plan.days.includes(day) ? '' : undefined, 'aria-pressed': plan.days.includes(day), 'aria-label': '周' + dayNames[day],
            onClick: () => change({ days: plan.days.includes(day) ? plan.days.filter((value) => value !== day) : [...plan.days, day].sort() }) }, dayNames[day]))) : null,
        h('div', { 'data-dy-pref-field': '' }, h('span', null, '默认时段'),
          schedulePresets.map((preset) => h('div', { 'data-dy-plan-preset': '', key: preset.source },
            h('label', { htmlFor: 'dy-plan-' + preset.source }, preset.name),
            h('span', null, timeRange(preset)),
            h(Switch, { id: 'dy-plan-' + preset.source, label: preset.name + '时段',
              on: plan.rows.some((row) => row.source === preset.source), disabled: busy,
              onChange: (enabled) => togglePreset(preset, enabled) }))),
          h('p', { 'data-dy-pref-note': '' }, '已启用的默认时段与自定义时段共同生效，使用同一组重复日期；重叠时需调整。')),
        h('div', { 'data-dy-pref-field': '' }, h('span', null, '自定义时段（可选）'),
          customRows.map(({ row, index }, i) => h('div', { 'data-dy-plan-window': '', key: i },
            h('label', null, h('span', null, '开始'), h('input', { 'data-dy-input': '', type: 'time', value: row.start, disabled: busy,
              'aria-label': `自定义时段 ${i + 1} 开始`, onChange: (e) => changeRow(index, 'start', e.target.value) })),
            h('span', { 'data-dy-plan-to': '', 'aria-hidden': true }, '至'),
            h('label', null, h('span', null, scheduleTime(row.end) < scheduleTime(row.start) ? '结束 · 次日' : '结束'),
              h('input', { 'data-dy-input': '', type: 'time', value: row.end, disabled: busy, 'aria-label': `自定义时段 ${i + 1} 结束`, onChange: (e) => changeRow(index, 'end', e.target.value) })),
            h('button', { 'data-dy-mini': '', disabled: busy, 'aria-label': `移除自定义时段 ${i + 1}`, onClick: () => change({ rows: plan.rows.filter((_, j) => j !== index) }) }, '移除'),
            row.label ? h('span', { 'data-dy-plan-name': '' }, row.label) : null)),
          h('div', null, h('button', { 'data-dy-mini': '', disabled: busy, onClick: () => change({ rows: [...plan.rows, { source: 'custom', start: '', end: '', label: '' }] }) }, '添加自定义时段'))),
        h('p', { 'data-dy-pref-note': '' }, '按运行 DSH 的电脑时间；周一至周五不含节假日调休。跨午夜时段归开始日期，结束后不再启动新一轮。'),
        error ? h('p', { 'data-dy-pref-error': '', role: 'alert' }, error) : null,
        draft ? h('div', { 'data-dy-plan-preview': '', 'aria-live': 'polite' }, h('strong', null, '保存后'),
          h('p', null, !plan.enabled ? '暂停自动运行，保留以下日期与时段。' : !plan.days.length || !plan.rows.length ? '未选择日期或时段，自动运行暂停。' : error ? '请先修正时段。' : `${daysText(plan.days)} · ${plan.rows.map(timeRange).join('；')}`),
          h('p', { 'data-dy-pref-note': '' }, '修改尚未保存，当前计划继续生效。')) : null,
        feedback,
        h('div', { 'data-dy-pref-actions': '' },
          h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: busy || !draft || Boolean(error), onClick: async () => { if (await onSave(planPatch(plan), '自动计划已保存', 'schedule')) onChange(null) } }, busy ? '保存中…' : '保存计划'),
          draft ? h('button', { 'data-dy-mini': '', disabled: busy, onClick: () => onChange(null) }, '撤销修改') : null),
        h('details', { 'data-dy-pref-details': '' }, h('summary', null, '运行与修改规则'),
          h('p', null, '这是允许启动的时间范围，不是整点闹钟；任务结束时间不受范围限制。自动推荐达到每日上限后暂停，手动运行不受影响。'),
          h('p', null, '当天已执行的时段不会因编辑而重跑；替换后的时段可能从下次所选日期起生效。')))
    }

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [cfg, setCfg] = React.useState(null)
      const [loadError, setLoadError] = React.useState('')
      const [loadVersion, setLoadVersion] = React.useState(0)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [msgTone, setMsgTone] = React.useState('')
      const [msgArea, setMsgArea] = React.useState('run')
      const [setupToast, setSetupToast] = React.useState('')
      const setupToastTimer = React.useRef(null)
      React.useEffect(() => () => clearTimeout(setupToastTimer.current), [])
      const [kws, setKws] = React.useState(null)
      /** ⭐ 一键自救的结果（{ok, human, need_user, fixed}）—— null = 还没点过 */
      const [chatFix, setChatFix] = React.useState(null)
      const [doctor, setDoctor] = React.useState(null)
      const qrPending = React.useRef(false)
      const installPending = React.useRef(false)
      const [report, setReport] = React.useState(null)
      const [planDraft, setPlanDraft] = React.useState(null)
      const [personaLarge, setPersonaLarge] = React.useState(false)
      const [upd, setUpd] = React.useState(null)
      const [updateError, setUpdateError] = React.useState('')
      const [ai, setAi] = React.useState(null)
      const [copied, setCopied] = React.useState('')
      // 扫码登录：qr = { url }，qrHint = 一句人话（出不来码时说什么）
      const [qr, setQr] = React.useState(null)
      const [qrHint, setQrHint] = React.useState('')
      // 私信对象：列表 + 选中的那个人
      const [people, setPeople] = React.useState(null)
      const [peopleHint, setPeopleHint] = React.useState('')
      const [peopleError, setPeopleError] = React.useState(false)
      const [recipientPicker, setRecipientPicker] = React.useState('')
      const patchPending = React.useRef(false)
      const peoplePending = React.useRef(false)
      // 新手流程说明
      const [guideOpen, setGuideOpen] = React.useState(false)
      // 当前登录的账号
      const [acc, setAcc] = React.useState(null)
      // 人设（使用者自己那份）
      const [persona, setPersona] = React.useState(null)
      const [personaOpen, setPersonaOpen] = React.useState(false)
      const [personaDraft, setPersonaDraft] = React.useState(null)
      // 私信对象：手动填的模式
      const [manualDm, setManualDm] = React.useState(null)
      // 每天挑几条（输入框草稿）
      const [perDayDraft, setPerDayDraft] = React.useState(null)
      const [manualCountDraft, setManualCountDraft] = React.useState(null)
      // 记忆统计
      const [mem, setMem] = React.useState(null)
      // 消息（收件箱）：评论区 @ 我 + 谁私信我
      const [inbox, setInbox] = React.useState(null)
      const [inboxTab, setInboxTab] = React.useState('dm')
      const [inboxLoading, setInboxLoading] = React.useState({})
      const [inboxErrors, setInboxErrors] = React.useState({})
      // 当前选中的私信会话；生成任务由会话组件管理。
      const [chat, setChat] = React.useState(null)
      const [clearMemConfirm, setClearMemConfirm] = React.useState(false)
      const inboxPending = React.useRef(new Set())
      // 最近一轮的日志
      const [runLog, setRunLog] = React.useState(null)
      const [logOpen, setLogOpen] = React.useState(false)
      const [rawOpen, setRawOpen] = React.useState(false)
      const [warningsOnly, setWarningsOnly] = React.useState(false)
      const [resultScope, setResultScope] = React.useState('recent')
      const [reportError, setReportError] = React.useState('')
      const [fullReport, setFullReport] = React.useState(null)
      const [progress, setProgress] = React.useState(null)
      const [progressError, setProgressError] = React.useState('')
      const [runRequest, setRunRequest] = React.useState(null)
      const [runClock, setRunClock] = React.useState(Date.now())
      const [reportLoading, setReportLoading] = React.useState(false)
      const progressRef = React.useRef(null)
      const pendingRun = React.useRef(false)
      const requestRef = React.useRef(null)
      const refreshProgress = React.useRef(() => {})
      const openedLog = React.useRef(false)
      const reportStamp = React.useRef('')
      const resultScopeRef = React.useRef('recent')
      openedLog.current = rawOpen
      resultScopeRef.current = resultScope
      requestRef.current = runRequest
      // 「评论区 @ 提醒」（0.5.9）：开关 = 总闸，atPeers 多选 = 范围；会话列表只读一次
      // 聊天盯梢间隔的输入草稿（2026-10-24）
      const [cwSecDraft, setCwSecDraft] = React.useState(null)
      // dsh 入口路径（输入框草稿）—— 2026-10-23 加，见「出问题了？」卡片
      const [dshBinDraft, setDshBinDraft] = React.useState(null)
      // All hooks stay above the loading return. Only preferences and help collapse as cards.
      const [foldErr, setFoldErr] = React.useState(false)
      const [foldCfg, setFoldCfg] = React.useState(false)

      const say = (t, tone, area = 'run') => {
        if (['setup', 'messages', 'persona', 'prefs', 'schedule', 'about'].includes(area) || (area === 'sending' && !recipientPicker)) {
          clearTimeout(setupToastTimer.current)
          setSetupToast(tone === 'good' ? t : '')
          if (tone === 'good' && t) setupToastTimer.current = setTimeout(() => setSetupToast(''), 3000)
        }
        setMsg(['setup', 'messages', 'persona', 'prefs', 'schedule', 'about'].includes(area) && tone === 'good' ? '' : t)
        setMsgTone(tone || ''); setMsgArea(area)
      }
      const notice = (area) => msg && msgArea === area ? h('div', {
        'data-dy-msg': '', role: 'status', 'data-feedback': area,
        'data-good': msgTone === 'good' ? '' : undefined,
        'data-warn': msgTone === 'warn' ? '' : undefined,
      }, msg) : null

      const saySetup = (text, tone) => say(text, tone, 'setup')
      const saySending = (text, tone) => say(text, tone, 'sending')
      const sayMessages = (text, tone) => say(text, tone, 'messages')
      const sayHelp = (text, tone) => say(text, tone, 'help')

      // Keep observing while a run request is waiting. This endpoint only reads existing records.
      React.useEffect(() => {
        let alive = true
        let pulling = null
        let lastSuccess = 0
        let controller = null
        const pullOnce = async () => {
          controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 8000)
          try {
            const r = await asJson(await fetch(API + '/progress' + (openedLog.current ? '?log=1' : ''),
              { credentials: 'same-origin', signal: controller.signal }))
            if (!r?.ok || !r.round) throw new Error('状态暂不可用')
            if (!alive) return
            progressRef.current = r
            lastSuccess = Date.now()
            setProgress(r)
            setProgressError('')
            // A fresh idle response permits a manual retry after a lost POST; never resend automatically.
            const attempt = requestRef.current
            if (attempt && r.round.startedAt !== attempt.previousStart && r.round.startedAt >= attempt.at - 3000) {
              setRunRequest(null); requestRef.current = null
            } else if (attempt?.uncertain && r.running === false && r.round.startedAt === attempt.previousStart) {
              setRunRequest(null)
              requestRef.current = null
              say('未确认启动，可以重试。', 'warn')
            }
            setSt((s) => s ? { ...s, ...(r.counts ? { counts: r.counts } : {}) } : s)
            if (openedLog.current && typeof r.tail === 'string') setRunLog(redactLog(r.tail))
            const stamp = `${r.report?.stamp || ''}:${r.round.id || ''}:${r.round.phase}`
            if (reportStamp.current !== stamp) {
              try {
                const scope = resultScopeRef.current
                const result = await asJson(await fetch(API + '/report?scope=' + scope, { credentials: 'same-origin', signal: controller.signal }))
                if (alive && scope === resultScopeRef.current) { setReport(result); setReportError(''); reportStamp.current = stamp; setFullReport(null) }
              } catch { if (alive) setReportError('暂时无法读取推荐结果，请重试。') }
            }
          } catch (e) {
            if (alive) setProgressError(String(e?.message || e).includes('404') ? '请重启 DSH 后查看运行状态' : '暂时无法更新状态，正在重试…')
          } finally { clearTimeout(timer) }
        }
        const pull = (force = false) => {
          if (!alive) return Promise.resolve()
          // A click during a poll must get a fresh snapshot after it, not silently skip the refresh.
          if (pulling) return force ? pulling.then(() => pull(true)) : pulling
          const observing = requestRef.current || ['preparing', 'running', 'unknown'].includes(progressRef.current?.round?.phase)
          if (!force && !observing && Date.now() - lastSuccess < 30_000) return Promise.resolve()
          pulling = pullOnce().finally(() => { pulling = null })
          return pulling
        }
        refreshProgress.current = () => pull(true)
        pull(true)
        const poll = setInterval(() => pull(), 4000)
        const clock = setInterval(() => {
          if (requestRef.current || ['preparing', 'running'].includes(progressRef.current?.round?.phase)) setRunClock(Date.now())
        }, 1000)
        return () => { alive = false; controller?.abort(); clearInterval(poll); clearInterval(clock) }
      }, [])

      /**
       * ⭐ 查登录的号：带重试的账号查询（主人 2026-10-24 验收「一直显示正在查登录的号」）。
       *    旧版只在面板打开时查一次，/account 慢或失败就永远停在「正在查…」。
       *    现在：先拿缓存（秒回）；空/失败则带 refresh=1 强查，最多重试 3 次（间隔 4s）。
       */
      const loadAccount = async (attempt) => {
        try {
          let a = null
          try { a = await jget('/account') } catch { a = null }
          if (a && a.account && a.account.nick) { setAcc(a.account); return true }
          // 缓存空/没昵称 ⇒ 强制查一次（宿主跑体检，慢但准）
          a = await jget('/account?refresh=1')
          if (a && a.account && (a.account.nick || a.account.uid)) { setAcc(a.account); return true }
          return false
        } catch {
          if ((attempt || 0) < 2) {   // 还有得救：4 秒后再来（宿主可能正忙）
            await new Promise((r) => setTimeout(r, 4000))
            return loadAccount((attempt || 0) + 1)
          }
          return false
        }
      }

      React.useEffect(() => {
        let alive = true
        let retryTimer = 0
        let controller = new AbortController()
        let timer = setTimeout(() => controller.abort(), 12000)
        setLoadError('')
        /**
         * 🔴 2026-11-05：面板一直停在「读设置中」的两个真口子（B 站有人反馈）。
         *   ① 只试一次、没有重试：插件路由是等宿主 webServer 就绪才注册的，
         *      面板比路由先加载时这一次必然失败，然后就永远停住。
         *   ② 失败信息被 `if (alive)` 挡住：面板在加载途中被宿主重新挂载时 alive=false，
         *      错误直接丢掉 —— 界面既不报错、也不出「重新读取」按钮，只能干等。
         *   ⇒ 现在：失败自动重试（间隔递增，共 3 次），**每次重试换一个新的超时控制器**
         *      （共用一个的话第一次 abort 后后面全废），并且错误一定落到状态里。
         */
        const attempt = async (n) => {
          if (n > 0) {
            controller = new AbortController()
            timer = setTimeout(() => controller.abort(), 12000)
          }
          const signal = controller.signal
          try {
            const [s, c] = await Promise.all([jget('/status', { signal }), jget('/config', { signal })])
            if (!alive) return
            if (!s?.ok || !c?.config) throw new Error('设置数据暂不可用')
            clearTimeout(timer)
            setLoadError('')
            setSt(s)
            setCfg(c.config)
            jget('/persona').then((r) => { if (alive && r?.ok) setPersona(personaData(r)) }).catch(() => {})
            if (s && s.loggedIn) {
              // 账号昵称：带重试，查到才把「正在查登录的号…」换下来
              const okAcc = alive ? await loadAccount(0) : false
              if (alive && !okAcc) {
                // 查了三轮还是空：挂一句实话，别让主人盯着"正在查"干等
                setAcc({ nick: '', uid: '', alive: false, at: '', failed: true })
                say('登录态在，但昵称没查到 —— 不影响使用', 'warn')
              }
            }
          } catch (e) {
            if (!alive) return
            const why = e?.name === 'AbortError' ? '读取超时' : String(e?.message || e)
            // 还有次数就自动再试（宿主刚起来时路由可能晚到一两秒）
            if (n < 2) {
              setLoadError(`正在重试（第 ${n + 2}/3 次）：${why}`)
              retryTimer = setTimeout(() => { if (alive) attempt(n + 1) }, 1200 * (n + 1))
              return
            }
            setLoadError(`${why}（已自动重试 3 次仍失败）`)
          } finally { clearTimeout(timer) }
        }
        attempt(0)
        return () => { alive = false; clearTimeout(retryTimer); controller.abort(); clearTimeout(timer) }
      }, [loadVersion])

      const patch = async (p, label, feedbackArea) => {
        if (patchPending.current) return false
        patchPending.current = true
        setBusy('patch')
        const prefsKeys = ['keywords', 'windows', 'perDay', 'manualPerRun', 'autoEnabled', 'scheduleDays', 'noon', 'night', 'reportLevel', 'notifyMode']
        const area = feedbackArea || (Object.keys(p).some((key) => prefsKeys.includes(key)) ? 'prefs' : ('dshBin' in p ? 'help' : 'sending'))
        try {
          const r = await jpost('/config', p)
          if (!r?.ok || !r.config) throw new Error(r?.error || '设置未保存')
          setCfg(r.config)
          if (Object.keys(p).some((key) => ['windows', 'autoEnabled', 'scheduleDays', 'noon', 'night', 'perDay'].includes(key))) {
            try { const status = await jget('/status'); if (status?.ok) setSt(status) } catch { /* Settings were saved; keep the last known status. */ }
          }
          say(label || '已保存', 'good', area)
          return true
        } catch (e) { say('保存失败：' + String((e && e.message) || e), 'warn', area); return false }
        finally { patchPending.current = false; setBusy('') }
      }

      const onDoctor = async (area = 'help') => {
        setBusy('doctor')
        try {
          const r = await jpost('/doctor', {})
          if (!Array.isArray(r?.items)) throw new Error(r?.error || '没有取得完整的检查结果，请重试')
          setDoctor(r)
          const environment = r.environment?.items || r.items.filter((item) => !/Cookie|登录|人设|无头浏览器/.test(item.item || ''))
          const bad = environment.filter((item) => item.state !== 'ok' && item.fix)
          say(bad.length ? `发现 ${bad.length} 项环境待处理，请查看对应项目的处理方法。` : '运行环境检查通过', bad.length ? 'warn' : 'good', area)
          await refresh()
          return r
        } catch (e) { say('检查失败：' + String((e && e.message) || e), 'warn', area) }
        finally { setBusy('') }
      }

      const onInstall = async () => {
        if (installPending.current) return
        installPending.current = true
        setBusy('install')
        try {
          let r
          try { r = await jpost('/environment/repair', {}) }
          catch (e) { if (!/HTTP 404/.test(e?.message || '')) throw e; r = await jpost('/install', {}) }
          if (!r?.ok) throw new Error(r?.error || r?.hint || '安装没有启动')
          if (r.unchanged) { saySetup('依赖已齐全。', 'good'); await onDoctor('setup') }
          else if (r.started || r.busy || r.install?.phase === 'running') {
            setSt((prev) => ({ ...prev, installing: true, install: r.install }))
            saySetup('正在补齐运行依赖，完成后会自动检查。', '')
          } else throw new Error('没有取得安装启动状态，请重新检查')
        }
        catch (e) { saySetup('装依赖失败：' + String((e && e.message) || e), 'warn') }
        finally { installPending.current = false; setBusy('') }
      }

      /** 刷新状态（登录成功 / 装完之后要让按钮和进度条变） */
      const refresh = async () => {
        try {
          const [s, c] = await Promise.all([jget('/status'), jget('/config')])
          if (s) setSt(s)
          if (c && c.config) setCfg(c.config)
          if (s && s.loggedIn) {
            const okAcc = await loadAccount(0)
            if (!okAcc) setAcc({ nick: '', uid: '', alive: false, at: '', failed: true })
          } else setAcc(null)
        } catch { /* 刷不动就留着旧的 */ }
      }

      React.useEffect(() => {
        if (!st?.installing) return undefined
        const timer = setInterval(async () => {
          try {
            const status = await jget('/status')
            if (status?.ok) {
              setSt(status)
              if (!status.installing) {
                if (status.install?.phase === 'failed') saySetup('环境安装未完成：' + (status.install.error || '请查看下方处理建议'), 'warn')
                const checked = await jpost('/doctor', {})
                if (Array.isArray(checked?.items)) setDoctor(checked)
                if (status.install?.phase !== 'failed') saySetup(checked.environment?.ready === false || !status.venvReady
                  ? '仍有环境项目待处理，处理方法在下方。' : '运行环境已就绪，可以扫码登录。', checked.environment?.ready === false || !status.venvReady ? 'warn' : 'good')
              }
            }
          } catch { /* Preserve the installation state until the next read succeeds. */ }
        }, 3000)
        return () => clearInterval(timer)
      }, [st?.installing])

      /**
       * ⭐ 扫码登录 · 第一步：出二维码
       * @param {boolean} force 强制重来（先关掉后台无头浏览器 —— 它占着同一个 Chrome 配置）
       */
      const onQr = async (force) => {
        if (qrPending.current) return
        qrPending.current = true
        setBusy('login'); setQrHint(''); setQr(null)
        try {
          const r = await jpost('/login/qr', { force: force ? '1' : '' })
          if (r && r.ok && r.already_logged_in) {
            // ⭐ 浏览器里本来就登录着，不用扫码 —— 直接把凭证导出来了
            setQrHint('')
            saySetup('这个浏览器里本来就登录着，已经直接登录好了', 'good')
            await refresh()
          } else if (r && r.no_qr_element && r.browser_open !== false) {
            // 没截到二维码图 —— 别放一张首页截图骗人，让用户看那个窗口
            setQrHint(r.hint || '没能自动截到二维码，请直接看那个 Chrome 窗口')
            setQr({ opened: true })
            saySetup('登录窗口已打开，请在浏览器中扫码。', '')
          } else if (r && r.ok && r.qr_url) {
            setQr({ url: r.qr_url, opened: true })
            saySetup('登录窗口已打开，用手机抖音扫码后点「我扫完了」。', '')
          } else if (r && r.conflict === 'profile_in_use') {
            setQr({ conflict: true })
            setQrHint('后台浏览器正在占用登录配置。点击「重新打开登录窗口」会正常关闭插件的后台浏览器，再打开扫码窗口。')
            saySetup('', '')
          } else {
            setQr({ failed: true })
            setQrHint([r?.error || r?.detail || '未取得登录窗口状态', r?.hint].filter(Boolean).join('；'))
            saySetup('', '')
          }
        } catch (e) { setQr({ failed: true }); setQrHint('登录窗口未能打开：' + String((e && e.message) || e)); saySetup('', '') }
        finally { qrPending.current = false; setBusy('') }
      }

      /** 第二步：我扫完了（轮询到成功；成功后会顺带关掉登录窗口）
       * 🔴 2026-10-24 主人验收「点了没反应」：旧版同步等 120 秒（宿主 spawnSync
       *    被 watch 堵死，面板期间什么都查不动）。改成**小步轮询**：每次只让宿主
       *    check 一次（秒回），前端自己转；不再有「按下去整页僵死」。 */
      const onWaitLogin = async () => {
        setBusy('wait')
        try {
          let done = false
          let usedCheck = true
          for (let i = 0; i < 40 && !done; i++) {   // 40 次 × ~2s ≈ 80 秒
            const r = await jpostSoft('/login/check', {})
            if (r === null) { usedCheck = false; break }   // 宿主太旧没有这条路由 ⇒ 落回 wait
            if (r && r.ok) {
              done = true
              setQr(null)
              saySetup('登录成功 —— 可以刷了', 'good')
              await refresh()
              break
            }
            if (r && r.up === false) {   // 登录浏览器没了：别傻转，直接给提示
              setQrHint(r.hint || '登录用的浏览器还没开 —— 先点「扫码登录」')
              saySetup('没等到，先出二维码', 'warn')
              break
            }
            if (r && r.verify && r.verify.length) {
              setQrHint('卡在验证：' + r.verify.join(' / ') + ' —— 在那个浏览器窗口里做完，不用重扫')
            } else if (i === 3) {
              setQrHint('在等你扫码…（手机抖音 → 扫一扫）')
            }
          }
          if (!done && usedCheck) { saySetup('没等到，再试一次', 'warn'); setQrHint((prev) => prev || '等了一会儿还没扫上 —— 二维码可能过期了，点「重新出码」再来') }
          if (!done && !usedCheck) {   // 旧宿主兜底：一次 wait（还是同步，但只 20 秒）
            try {
              const r = await jpost('/login/wait', { seconds: 20 })
              if (r && r.ok) { setQr(null); saySetup('登录成功 —— 可以刷了', 'good'); await refresh() }
              else { setQrHint((r && (r.hint || r.error)) || '还没好 —— 再点一次「我扫完了」'); saySetup('还没好', 'warn') }
            } catch (e) { setQrHint('等待失败：' + String((e && e.message) || e)) }
          }
        } catch (e) { setQrHint('等待登录失败：' + String((e && e.message) || e)); saySetup('等待失败', 'warn') }
        finally { setBusy('') }
      }

      const onCloseLogin = async () => {
        try { await jpost('/login/close', {}) } catch { /* 关不掉也无所谓 */ }
        setQr(null); setQrHint('登录窗口已关。想继续就再点一次「扫码登录」。')
      }

      const onLogout = async () => {
        setBusy('login')
        try {
          await jpost('/login/clear', {})
          setQr(null)
          saySetup('已退出登录（Cookie 删了）', 'good')
          await refresh()
        } catch (e) { saySetup('退出失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      /**
       * ⭐ 列出会话里的人 —— 让用户点选，不用手填 sec_uid。
       *    （2026-10-22 用户指出：新手不可能知道「稳定 id」是什么，更找不到）
       */
      const loadPeople = async () => {
        if (peoplePending.current) return
        peoplePending.current = true
        setBusy('people'); setPeopleHint(''); setPeopleError(false)
        try {
          const r = await jpost('/dm/people', {})
          if (r && r.ok) {
            setPeople(r.people || [])
            setPeopleHint(r.hint || '')
          } else {
            setPeopleError(true)
            setPeople([])
            setPeopleHint((r && (r.hint || r.error)) || '读不到会话列表')
          }
        } catch (e) { setPeopleError(true); setPeopleHint('读不到会话列表：' + String((e && e.message) || e)) }
        finally { peoplePending.current = false; setBusy('') }
      }
      const openRecipients = (mode) => {
        setRecipientPicker(mode); setManualDm(null); setMsg('')
        if (people === null) loadPeople()
      }
      const saveChatInterval = async () => {
        if (cwSecDraft === null) return
        const seconds = Math.max(10, Math.min(Number(cwSecDraft) || 30, 300))
        if (await patch({ chatWatchSec: seconds }, '聊天检查间隔已保存')) setCwSecDraft(null)
      }

      /** 0.5.5 私信对象列表：点选 = 追加进 dmPeers（去重），不再覆盖单值 */
      const pickPerson = async (p) => {
        const cur = Array.isArray(cfg.dmPeers) ? cfg.dmPeers : []
        const same = cur.some((x) => (p.sec_uid && x.sec_uid === p.sec_uid) || (!p.sec_uid && x.nick === p.nick))
        if (same) { saySending(`「${p.nick}」已经在列表里了`, 'warn'); return }
        const next = [...cur, { nick: p.nick, sec_uid: p.sec_uid || '' }]
        await patch({ dmPeers: next }, `已把「${p.nick}」加进私信对象（共 ${next.length} 人）`)
      }

      /* 0.5.7 「听他的话」开关已删（主人定稿：聊天模式开着 = 谁私信都接，列表只管发给谁） */

      /** 0.5.9 「评论区 @ 提醒」多选：开关管总闸，列表管范围；点人 = 加入/移除
       *  会话列表复用私信区读到的 people（读一次，不反复拉）
       *  🔴 移除到「一个不剩」时必须带 __clearKeys —— 否则空数组会被空值守卫保回磁盘旧值（清不掉） */
      const patchAtPeers = async (cur, msg) => {
        await patch(cur.length
          ? { atPeers: cur }
          : { atPeers: [], __clearKeys: ['atPeers'] }, msg)
      }
      const toggleAt = async (p) => {
        const cur = Array.isArray(cfg.atPeers) ? [...cfg.atPeers] : []
        const idx = cur.findIndex((x) => x.nick === p.nick)
        let msg
        if (idx >= 0) { cur.splice(idx, 1); msg = `已把「${p.nick}」移出 @ 名单` }
        else { cur.push({ nick: p.nick }); msg = `@ 名单加了「${p.nick}」（共 ${cur.length} 人）` }
        await patchAtPeers(cur, msg)
      }
      const removeAt = async (idx) => {
        const cur = Array.isArray(cfg.atPeers) ? [...cfg.atPeers] : []
        if (!cur[idx]) return
        const gone = cur.splice(idx, 1)[0]
        await patchAtPeers(cur, `已把「${gone.nick}」移出 @ 名单`)
      }
      const clearAt = async () => {
        // 🔴 数组守卫同款：真清空必须带 __clearKeys 显式口子，否则空数组会被保回磁盘旧值（清不掉）
        await patch({ atPeers: [], __clearKeys: ['atPeers'] }, '@ 名单已清空 —— 开关开着也不会 @ 任何人')
      }

      /** 0.5.5 把某人从列表里移除
       *  🔴 移除到「一个不剩」必须带 __clearKeys（空数组会被守卫保回磁盘旧值） */
      const removePeer = async (idx) => {
        const cur = Array.isArray(cfg.dmPeers) ? [...cfg.dmPeers] : []
        if (!cur[idx]) return
        const gone = cur.splice(idx, 1)[0]
        await patch(cur.length
          ? { dmPeers: cur }
          : { dmPeers: [], __clearKeys: ['dmPeers'] },
          `已把「${gone.nick || gone.sec_uid}」移出私信对象`)
      }

      /* ── 最近一轮发生了什么 ── */
      const loadRunLog = async () => {
        if (logOpen) { setRawOpen(false); openedLog.current = false }
        setLogOpen(!logOpen)
      }

      /* ── 消息收件箱 ── */
      const loadInbox = async (scope = inboxTab) => {
        if (inboxPending.current.has(scope)) return
        inboxPending.current.add(scope)
        setInboxLoading((prev) => ({ ...prev, [scope]: true }))
        setInboxErrors((prev) => ({ ...prev, [scope]: '' }))
        setInbox((prev) => prev || { ok: true, at: [], dm: [], loaded: {} })
        try {
          const r = await jget('/inbox?scope=' + scope)
          if (r && r.ok) {
            const field = scope === 'dm' ? 'dm' : 'at'
            if (r.errors?.length) throw new Error(r.errors.join('；'))
            setInbox((prev) => ({ ...prev, [field]: r[field] || [], loaded: { ...prev.loaded, [scope]: true } }))
          } else {
            throw new Error(r?.error || r?.hint || '暂时读不到消息，请重试。')
          }
        } catch (e) {
          setInboxErrors((prev) => ({ ...prev, [scope]: '读取失败：' + String(e?.message || e) }))
        } finally {
          inboxPending.current.delete(scope)
          setInboxLoading((prev) => ({ ...prev, [scope]: false }))
        }
      }
      const selectInboxTab = (scope) => {
        setInboxTab(scope)
        if (inbox && !inbox.loaded?.[scope]) loadInbox(scope)
      }

      const openChat = (who) => setChat({ who })
      const onChatSent = (who) => setInbox((prev) => prev ? { ...prev,
        dm: (prev.dm || []).map((person) => person.sec_uid === who.sec_uid ? { ...person, needs_reply: false } : person) } : prev)

      /** 记忆：看统计 / 清空 */      const loadMem = async () => {
        setClearMemConfirm(false)
        setBusy('mem')
        try {
          const r = await jget('/memory')
          if (!r?.ok || !r.stats) throw new Error(r?.error || '未读到记忆统计')
          setMem(r.stats)
        } catch (e) { sayMessages('读记忆失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }
      const clearMem = async () => {
        setBusy('mem')
        try {
          const r = await jpost('/memory/clear', {})
          if (!r?.ok || !r.stats) throw new Error(r?.error || '清空失败')
          setClearMemConfirm(false)
          setMem((r && r.stats) || { dm: 0, comment: 0, bytes: 0 })
          sayMessages('记忆已清空（私信和评论区的记录都删了）', 'good')
        } catch (e) { sayMessages('清空失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      /**
       * 读人设。
       * ⭐ 2026-10-26：后端现在会多给三样，面板要靠它们说真话：
       *    effective       = **真正生效的那份内容**（自己写 → 插件自带 → 中性默认）
       *    effective_label = 那一份叫什么（给用户看的来源说明）
       *    default_text    = 中性默认（「填入中性默认」按钮用）
       * 以前只读 text（= 自己那份），没写就空框 ⇒ 用户以为人设丢了。
       */
      const loadPersona = async () => {
        if (persona) { setPersonaOpen((v) => !v); return }
        setBusy('persona')
        try {
          const r = await jget('/persona')
          if (!r?.ok) throw new Error(r?.error || '暂未读取到人设')
          setPersona(personaData(r)); setPersonaOpen(true)
        } catch (e) { say('读人设失败：' + String((e && e.message) || e), 'warn', 'persona') }
        finally { setBusy('') }
      }

      /** 存人设（空 = 删掉自己那份，退回默认） */
      const savePersona = async () => {
        if (!persona) return
        const text = personaDraft ?? (persona.custom ? persona.text : persona.effective || persona.defaultText || '')
        setBusy('persona')
        try {
          const r = await jpost('/persona', { text })
          if (r && r.ok) {
            say(text.trim() ? '人设已保存（下一轮生效）' : '已清空自定义人设，退回默认', 'good', 'persona')
            setPersona({ ...persona, text, custom: Boolean(text.trim()) }); setPersonaDraft(null)
            try { const fresh = await jget('/persona'); if (fresh?.ok) setPersona(personaData(fresh)) } catch { /* The write succeeded; retain that confirmed result. */ }
          } else say('保存失败：' + ((r && r.error) || '未知'), 'warn', 'persona')
        } catch (e) { say('保存失败：' + String((e && e.message) || e), 'warn', 'persona') }
        finally { setBusy('') }
      }

      const onRun = async () => {
        if (pendingRun.current || runLocked) return
        pendingRun.current = true
        const attempt = { at: Date.now(), previousStart: progressRef.current?.round?.startedAt || 0 }
        setRunRequest(attempt)
        say('')
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 90_000)
        try {
          const r = await asJson(await fetch(API + '/run', { method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' }, body: '{}', signal: controller.signal }))
          if (!r?.ok) {
            setRunRequest(null)
            const why = (r && (r.error || r.message || r.hint)) || '没跑起来'
            say('没跑起来：' + why, 'warn')
          }
        } catch {
          // A lost response does not mean the task failed. Never retry the POST automatically.
          setRunRequest({ ...attempt, uncertain: true })
        } finally { clearTimeout(timer); pendingRun.current = false; refreshProgress.current() }
      }

      const onShowReport = async (scope = resultScopeRef.current) => {
        if (typeof scope !== 'string') scope = 'today'
        setResultScope(scope); resultScopeRef.current = scope
        setReportLoading(true)
        setReportError('')
        try {
          // /report?scope=recent may describe a previous day; today's counters come from /progress.
          await refreshProgress.current()
          const r = await jget('/report?scope=' + scope)
          if (scope === resultScopeRef.current) setReport(r)
        } catch { setReportError('暂时无法读取推荐结果，请重试。') }
        finally { setReportLoading(false) }
      }

      const showFullReport = async () => {
        if (fullReport) { setFullReport(null); return }
        try {
          const r = await jget('/report?scope=today')
          setFullReport(r)
        } catch { setReportError('暂时无法读取完整日报，请重试。') }
      }

      const saveKws = async () => {
        const lines = String(kws ?? (cfg.keywords || []).join('\n')).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        /* 🔴 2026-10-25 晚：后端守卫「空数组不许盖掉非空列表」（keywords 就是这么丢的）。
         *    真想清空 = 把框删空再点保存 ⇒ 带 __clearKeys 显式口子，守卫放行。 */
        const saved = await patch(
          lines.length ? { keywords: lines } : { keywords: [], __clearKeys: ['keywords'] },
          lines.length ? '关键词已保存' : '关键词已清空',
        )
        if (saved) setKws(null)
      }

      const updatePending = React.useRef(false)
      const onCheckUpdate = async (force = true) => {
        if (updatePending.current) return
        updatePending.current = true; setBusy('update'); setUpdateError('')
        try {
          const r = await jget('/update' + (force ? '?force=1' : ''))
          setUpd(r)
          if (!r.checked) setUpdateError(r.note || '暂时无法检查更新，请稍后重试。')
          else say(r.hasUpdate ? '发现新版本 v' + r.latest : '当前已是最新版本', 'good', 'about')
        } catch { setUpdateError('检查更新失败，请稍后重试。') }
        finally { updatePending.current = false; setBusy('') }
      }

      // Quiet cached check; the only update control and result live in About.
      React.useEffect(() => {
        let alive = true
        const timer = setTimeout(async () => {
          if (updatePending.current) return
          updatePending.current = true
          try { const r = await jget('/update'); if (alive) setUpd(r) } catch { /* Manual retry stays in About. */ }
          finally { updatePending.current = false }
        }, 3000)
        return () => { alive = false; clearTimeout(timer) }
      }, [])

      const loadAi = async () => {
        setBusy('ai')
        try {
          const r = await jget('/ai-usage')
          setAi(r)
          if (!(r.mcp && r.mcp.exists)) sayHelp('MCP server 文件缺失，插件包可能不完整', 'warn')
        } catch (e) { sayHelp('读使用说明失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      const copy = async (text, what) => {
        const area = /日志|记录/.test(what) ? 'run' : 'help'
        try {
          const content = /日志|记录/.test(what) ? redactLog(text) : String(text || '')
          if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(content)
          else {
            const ta = document.createElement('textarea')
            ta.value = content; ta.style.position = 'fixed'; ta.style.opacity = '0'
            document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove()
          }
          setCopied(what)
          say('已复制' + what, 'good', area)
          setTimeout(() => setCopied(''), 2000)
        } catch (e) { say('复制失败，手动选中吧', 'warn', area) }
      }

      if (!st || !cfg) {
        return h('div', { 'data-dy-page': '' },
          h('div', { 'data-dy-card': '' },
            h('div', { 'data-dy-sub': '' }, loadError ? '暂时没能读取设置' : '读设置中…'),
            loadError ? h('div', { 'data-dy-row': '' },
              h('button', { 'data-dy-btn': '', onClick: () => setLoadVersion((v) => v + 1) }, '重新读取'),
              h('details', null, h('summary', null, '查看详情'), h('div', { 'data-dy-sub': '' }, loadError))) : null))
      }

      const kwText = kws !== null ? kws : (Array.isArray(cfg.keywords) ? cfg.keywords.join('\n') : '')
      const round = progress?.round
      const matched = runRequest && round?.startedAt !== runRequest.previousStart && round?.startedAt >= runRequest.at - 3000
      const waiting = Boolean(runRequest && !matched)
      const active = progress?.running === true || round?.phase === 'preparing' || round?.phase === 'running'
      const runLocked = pendingRun.current || waiting || active || !progress || Boolean(progressError) || !st.venvReady || !st.loggedIn
      const runTitle = waiting
        ? (runRequest.uncertain ? '正在确认是否已启动…' : '正在准备这一轮…')
        : progressError || ({ idle: '还没有运行记录', preparing: '正在准备这一轮…', running: '正在运行',
          completed: '本轮已完成', ended: '本轮已结束', failed: '本轮未完成', unknown: '暂未确认本轮是否结束' }[round?.phase] || '正在读取状态…')
      const runTone = progressError || runRequest?.uncertain && waiting || round?.phase === 'failed' || round?.phase === 'unknown'
        ? 'warn' : (waiting || active ? 'active' : (['completed', 'ended'].includes(round?.phase) ? 'good' : ''))
      const runStart = waiting ? runRequest.at : round?.startedAt
      const runEnd = waiting || active ? runClock : round?.endedAt
      const runSeconds = runStart && runEnd ? Math.max(0, Math.floor((runEnd - runStart) / 1000)) : 0
      const runTime = runSeconds >= 60 ? `${Math.floor(runSeconds / 60)} 分 ${runSeconds % 60} 秒` : `${runSeconds} 秒`
      const counts = progress?.counts || st.counts || { total: st.pickedToday || 0, auto: 0, manual: 0, unknown: st.pickedToday || 0 }
      const autoEnabled = cfg.autoEnabled == null ? Number(cfg.perDay) > 0 : Boolean(cfg.autoEnabled)
      const savedPlan = planFromConfig(cfg)
      const actualDays = savedPlan.days
      const planTimes = savedPlan.rows.map(timeRange)
      const planSummary = !autoEnabled ? '自动计划已暂停；仍可手动跑一轮。'
        : !Number(cfg.perDay) ? '自动每日上限为 0，自动任务暂停；仍可手动运行。'
        : !actualDays.length || !planTimes.length ? '自动计划未选日期或时段；仍可手动跑一轮。'
        : counts.auto >= Number(cfg.perDay) ? '今日自动额度已用完；仍可手动跑一轮。'
        : daysText(actualDays) + ' · ' + planTimes.join('；')
      const personaText = personaDraft ?? (persona?.custom ? persona.text : persona?.effective || persona?.defaultText || '')
      const personaSaved = persona?.custom ? persona.text : persona?.effective || persona?.defaultText || ''
      const personaDirty = personaDraft !== null && personaDraft !== personaSaved
      const roundEvents = Array.isArray(round?.events) ? round.events : []
      const roundWarnings = Array.isArray(round?.warnings) ? round.warnings : []
      const sends = round?.result?.sends
      const sendParts = sends ? [['card', '卡片'], ['dm', '私信'], ['comment', '评论']].map(([key, label]) => {
        const item = sends[key] || {}
        return Number(item.succeeded || 0) + Number(item.failed || 0) + Number(item.unknown || 0) > 0
          ? `${label}：成功 ${item.succeeded || 0}，失败 ${item.failed || 0}，未确认 ${item.unknown || 0}` : ''
      }).filter(Boolean) : []
      const sendSummary = sendParts.length ? sendParts.join('；') : '没有已确认的发送记录。'

      /* ⭐ 0.5.5 私信对象列表的小工具（面板侧只读展示用）；0.5.9 @ 多选列表 */
      const dmPeers = Array.isArray(cfg.dmPeers) ? cfg.dmPeers.filter((p) => p && (p.nick || p.sec_uid)) : []
      const atPeers = Array.isArray(cfg.atPeers) ? cfg.atPeers.filter((p) => p && String(p.nick || '').trim()) : []
      const environmentItems = doctor?.environment?.items || (doctor?.items || []).filter((item) => !/Cookie|登录|人设|无头浏览器/.test(item.item || ''))
      const environmentIssues = environmentItems.filter((item) => item.state !== 'ok' && item.fix)
      const environmentReady = doctor?.environment?.ready ?? st.environmentReady ?? st.venvReady
      const canRepairEnvironment = !st.venvReady || doctor?.environment?.repairable || environmentIssues.some((item) => /venv|主依赖|签名器/.test(item.item || ''))
      const installingEnvironment = Boolean(st.installing || busy === 'install')
      const environmentStage = { checking: '正在检查需要补齐的依赖…', python: '正在准备 Python 环境…', dependencies: '正在安装运行依赖…', signer: '正在补齐评论读取组件…' }[st.install?.stage] || '正在安装运行环境…'
      const showEnvironmentHelp = () => {
        setFoldErr(true)
        setTimeout(() => document.querySelector('[data-dy-area="help"]')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 0)
      }

      // Common actions remain visible; the two secondary cards preserve their controls while closed.
      return h('div', { 'data-dy-page': '' },
        setupToast ? h('div', { 'data-dy-toast': '', role: 'status', 'aria-live': 'polite', 'aria-atomic': true },
          h('svg', { width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
            h('circle', { cx: 10, cy: 10, r: 8 }), h('path', { d: 'm6 10 2.5 2.5L14 7', strokeLinecap: 'round', strokeLinejoin: 'round' })),
          h('span', null, setupToast)) : null,

        /* Setup is two actionable rows. Environment repair never substitutes for account login. */
          h('div', { 'data-dy-card': '', 'data-dy-area': 'setup' },
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' },
                h('h2', { 'data-dy-title': '' }, '开始使用'),
                h('div', { 'data-dy-sub': '' }, environmentReady && st.loggedIn ? '准备完成，可以在下方跑一轮。' : '准备好运行环境，再登录你的抖音账号。')),
              h('button', { 'data-dy-mini': '', 'data-dy-setup-button': '', disabled: Boolean(busy) || installingEnvironment,
                onClick: () => onDoctor('setup') }, busy === 'doctor' ? '检查中…' : doctor ? '重新检查' : '检查环境')),
            h('div', { 'aria-label': '首次使用步骤' },
            h('div', { 'data-dy-setup-row': 'environment' },
              h('span', { 'data-dy-step': '', 'data-done': environmentReady ? '' : undefined }, environmentReady ? '✓' : '1'),
              h('div', null,
                h('div', { 'data-dy-setup-label': '' }, '运行环境'),
                !environmentReady || installingEnvironment || environmentIssues.length ? h('div', { 'data-dy-sub': '', role: installingEnvironment ? 'status' : undefined }, installingEnvironment ? environmentStage
                  : environmentIssues.length ? `有 ${environmentIssues.length} 项待处理，方法见下方。`
                    : '首次使用安装一次，完成后自动检查。') : null),
              installingEnvironment ? h('span', { 'data-dy-setup-state': '' }, '安装中…')
                : canRepairEnvironment ? h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: onInstall }, st.venvReady ? '修复环境' : '安装环境')
                  : h('span', { 'data-dy-setup-state': '', 'data-ready': environmentReady ? '' : undefined }, environmentReady ? '已就绪' : '待处理'),
              environmentIssues.length ? h('div', { 'data-dy-setup-detail': '', 'data-dy-environment-issues': '' },
                environmentIssues.map((item, i) => h('div', { key: item.id || i, 'data-dy-environment-issue': '' },
                  h('strong', null, item.item), h('span', null, ' · ' + item.detail),
                  h('p', null, item.fix))),
                h('div', { 'data-dy-row': '' }, h('button', { 'data-dy-setup-check': '', onClick: showEnvironmentHelp }, '查看完整检查与处理方法 ↓'))) : null,
              st.install?.phase === 'failed' && st.install?.error ? h('div', { 'data-dy-setup-detail': '', 'data-dy-msg': '', 'data-warn': '' },
                st.install.error, h('div', null, h('button', { 'data-dy-setup-check': '', onClick: showEnvironmentHelp }, '查看安装详情 ↓'))) : null),
            h('div', { 'data-dy-setup-row': 'account' },
              h('span', { 'data-dy-step': '', 'data-done': st.loggedIn ? '' : undefined }, st.loggedIn ? '✓' : '2'),
              h('div', null,
                h('div', { 'data-dy-setup-label': '' }, '抖音账号'),
                h('div', { 'data-dy-sub': '' }, st.loggedIn ? '已保存登录态' + (acc?.nick ? ' · ' + acc.nick : '') : '将在浏览器中打开扫码页面')),
              st.loggedIn
                ? h('button', { 'data-dy-mini': '', disabled: Boolean(busy), onClick: onLogout }, '退出登录')
                : h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: Boolean(busy) || installingEnvironment, onClick: () => onQr(false) },
                  busy === 'login' ? '打开中…' : '扫码登录'),
            !st.loggedIn && (qr || qrHint)
              ? h('div', { 'data-dy-loginbox': '', 'data-dy-setup-detail': '' },
                qr?.url ? h('div', { 'data-dy-row': '', style: { alignItems: 'center', gap: '12px' } },
                    h('img', {
                      'data-dy-qr': '', src: qr.url, alt: '抖音登录二维码',
                      onError: () => { setQr((prev) => ({ ...prev, url: '' })); setQrHint('二维码图片未加载，请直接在已打开的浏览器中扫码，或重新打开登录窗口。') },
                      style: { width: '164px', height: '164px', borderRadius: '8px', background: '#fff', padding: '6px' },
                    }),
                    h('div', { 'data-dy-sub': '' }, '用手机抖音「扫一扫」。', h('br'), '完成后点「我扫完了」。')) : null,
                    qrHint ? h('div', { 'data-dy-msg': '', 'data-warn': qr?.conflict || qr?.failed ? '' : undefined }, qrHint) : null,
                    h('div', { 'data-dy-row': '' },
                      qr?.opened ? h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: onWaitLogin }, busy === 'wait' ? '确认中…' : '我扫完了') : null,
                      h('button', { 'data-dy-mini': '', disabled: Boolean(busy), onClick: () => onQr(true) }, '重新打开登录窗口'),
                      qr?.opened ? h('button', { 'data-dy-mini': '', disabled: Boolean(busy), onClick: onCloseLogin }, '关闭登录窗口') : null),
                    qr?.opened ? h('div', { 'data-dy-sub': '' }, '若出现短信验证码或拖动滑块，请在浏览器中完成，再点「我扫完了」。') : null)
              : null)),
            notice('setup')),

        /* Run state and results are separate from technical records. */
        h('div', { 'data-dy-card': '', 'data-dy-area': 'run' },
          h('div', { 'data-dy-row': '', 'data-dy-header': '' },
            h('div', { 'data-dy-grow': '' },
              h('h2', { 'data-dy-title': '' }, '刷抖音'),
              h('div', { 'data-dy-sub': '' }, '挑出值得看的内容，整理成今日推荐。')),
            h('div', { 'data-dy-run-actions': '' },
            h('button', { 'data-dy-mini': '', 'aria-haspopup': 'dialog', onClick: () => setGuideOpen(true) }, '使用指南'),
            h('span', { 'data-dy-caption': '', title: '面板构建版本' }, 'v' + (st.version || '?') + '·b' + PANEL_BUILD
              + (st.panelBuild && st.panelBuild !== PANEL_BUILD ? `（宿主 b${st.panelBuild}，请刷新页面）` : '')))),
          h('div', { 'data-dy-row': '' },
            h('span', { 'data-dy-badge': '', 'data-on': st.loggedIn ? '' : undefined, 'data-off': !st.loggedIn ? '' : undefined }, st.loggedIn ? '已登录' : '未登录'),
            st.loggedIn && acc?.nick ? h('span', { 'data-dy-account': '' }, acc.nick) : null,
            h('span', { 'data-dy-badge': '', 'data-on': st.venvReady ? '' : undefined }, st.venvReady ? '环境就绪' : '环境未装'),
            h('div', { 'data-dy-grow': '' }),
            h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: runLocked, onClick: onRun }, waiting || active ? '运行中…' : '现在跑一轮')),
          h('div', { 'data-dy-sub': '' }, `手动每轮最多推荐 ${cfg.manualPerRun ?? 3} 条，不占自动额度。`,
            h('br'), cfg.autoSend ? '选中的内容会按发送设置，通过抖音私信分享卡片，再发送推荐理由。' : '本轮只生成推荐，不自动发送。',
            cfg.autoSend && cfg.commentAtMe ? h('span', null, ' 评论区 @ 提醒已开启。') : null),
          !st.venvReady || !st.loggedIn ? h('div', { 'data-dy-msg': '' }, !st.venvReady ? '先在「开始使用」装好运行环境。' : '先在「开始使用」扫码登录抖音。') : null,
          h('div', { 'data-dy-run': '', 'data-tone': runTone },
            h('div', { 'data-dy-row': '' },
              h('i', { 'data-dy-dot': '', 'data-tone': runTone, 'aria-hidden': true }),
              h('strong', { role: 'status' }, runTitle),
              roundWarnings.length ? h('span', { 'data-dy-tag': '' }, `${roundWarnings.length} 项提醒`) : null),
            runStart ? h('div', { 'data-dy-sub': '' }, `${round?.source === 'auto' ? '自动' : '手动'}运行 · ${shortTime(runStart)} 开始`
              + (runEnd ? ` · ${waiting || active ? '已用' : '用时'} ${runTime}` : '')) : null,
            active && round?.activityAt ? h('div', { 'data-dy-sub': '' }, `最近活动 ${shortTime(round.activityAt)}`) : null,
            round?.result ? h('div', { 'data-dy-sub': '' }, round.result.validated === false
              ? '本轮推荐结果尚未确认，保留最近一次结果。'
              : `${Number.isFinite(round.candidates) ? `检查 ${round.candidates} 条候选 · ` : ''}新增 ${round.result.recommendations ?? 0} 条推荐 · ${round.result.reportUpdated ? '日报已更新' : '本轮未更新日报'}`) : null,
            round?.result ? h('div', { 'data-dy-sub': '' }, sendSummary) : null,
            roundWarnings.map((warning, i) => h('div', { key: i, 'data-dy-msg': '', 'data-warn': '' }, redactLog(warning)))),
          notice('run'),
          h('div', { 'data-dy-stats': '', 'aria-label': '今日推荐统计', 'aria-live': 'polite' },
            h('span', null, '今日推荐 ', h('strong', null, counts.total), ' 条'),
            h('span', null, '自动推荐 ', h('strong', null, counts.auto), ` 条 / 每日上限 ${cfg.perDay ?? 0} 条`),
            h('span', null, '手动推荐 ', h('strong', null, counts.manual), ' 条'),
            counts.unknown ? h('span', null, `旧记录未区分 ${counts.unknown} 条`) : null),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '', 'data-dy-sub': '' }, planSummary),
            h('button', { 'data-dy-mini': '', onClick: () => { setFoldCfg(true); setTimeout(() => document.querySelector('[data-dy-area="prefs"]')?.scrollIntoView({ block: 'nearest' }), 0) } }, '调整计划')),
          st.nextWindow && autoEnabled ? h('div', { 'data-dy-sub': '' }, `下个允许时段：${shortTime(st.nextWindow.startsAt)}–${shortTime(st.nextWindow.endsAt)}${st.nextWindow.label ? ' · ' + st.nextWindow.label : ''}`) : null,
          h('div', { 'data-dy-subblock': '', 'data-dy-results': '' },
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '', 'data-dy-title': '' }, '推荐结果'),
              h('button', { 'data-dy-mini': '', disabled: reportLoading, onClick: () => onShowReport() }, reportLoading ? '读取中…' : '刷新结果')),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-seg': '', role: 'group', 'aria-label': '推荐范围' },
                ['recent', 'today'].map((scope) => h('button', { key: scope, 'data-dy-segbtn': '', 'data-on': resultScope === scope ? '' : undefined,
                  'aria-pressed': resultScope === scope, disabled: reportLoading, onClick: () => onShowReport(scope) }, scope === 'recent' ? '最近一轮' : '今日全部'))),
              h('div', { 'data-dy-grow': '' }),
              h('button', { 'data-dy-mini': '', onClick: showFullReport }, fullReport ? '收起完整日报' : '完整日报')),
            reportError ? h('div', { 'data-dy-msg': '', 'data-warn': '', role: 'status' }, reportError) : null,
            reportLoading || !report && !reportError ? h('div', { 'data-dy-sub': '' }, '正在读取推荐结果…') : null,
            report ? h('div', { 'data-dy-results-list': '' },
              h('div', { 'data-dy-sub': '' }, resultScope === 'today' ? '今日全部推荐'
                : report.roundId && report.roundId === round?.id ? '本轮推荐'
                : active || waiting ? '上一轮推荐 · 本轮结果尚未生成'
                : '最近一次已有结果'),
              (report.picks || []).length ? (report.picks || []).map((pick, i) => h('div', { key: pick.id || i, 'data-dy-pick': '' },
                h('div', { 'data-dy-row': '' },
                  h('div', { 'data-dy-grow': '', 'data-dy-pick-title': '' }, `${i + 1}. ${pick.title || '未命名作品'}`),
                  workLink(pick) ? h('a', { href: workLink(pick), target: '_blank', rel: 'noopener noreferrer', 'data-dy-mini': '' }, '打开作品 ↗') : null),
                h(Markdown, { text: pick.text || '' })))
                : h('div', { 'data-dy-sub': '' }, resultScope === 'today' ? '今天还没有推荐。完成登录后，点「现在跑一轮」试试。'
                  : round?.phase === 'completed' && report.roundId === round?.id ? '本轮已完成，暂无新的合适内容。' : '还没有可展示的推荐结果。')) : null,
            fullReport ? h('div', { 'data-dy-subblock': '' }, h('div', { 'data-dy-title': '' }, '今日完整日报'),
              fullReport.text ? h(Markdown, { text: fullReport.text }) : h('div', { 'data-dy-sub': '' }, '今天还没有日报。')) : null),
          h('div', { 'data-dy-subblock': '' },
            h('button', { 'data-dy-collapse': '', 'aria-label': '本轮记录', 'aria-expanded': logOpen, onClick: loadRunLog }, h('strong', null, '本轮记录'), h('span', null, logOpen ? '收起 ▲' : '展开 ▼')),
            logOpen ? h('div', { 'data-dy-inner': '' },
              h('div', { 'data-dy-row': '' },
                h('span', { 'data-dy-sub': '', 'data-dy-grow': '' }, round?.id ? `${shortTime(round.startedAt)} 的${round.source === 'auto' ? '自动' : '手动'}运行` : '还没有本轮记录'),
                h('button', { 'data-dy-mini': '', onClick: () => setWarningsOnly((v) => !v), 'aria-pressed': warningsOnly }, warningsOnly ? '查看全部' : '只看提醒'),
                h('button', { 'data-dy-mini': '', onClick: () => copy(roundEvents.map((event) => `${shortTime(event.at)} ${event.message}`).join('\n'), '本轮记录') }, '复制本轮记录')),
              h('div', { 'data-dy-events': '' },
                roundEvents.filter((event) => !warningsOnly || event.level === 'warning' || event.level === 'error').map((event, i) => h('div', { key: i, 'data-dy-event': '', 'data-warn': ['warning', 'error'].includes(event.level) ? '' : undefined },
                  h('time', null, shortTime(event.at)), h('span', null, redactLog(event.message)))),
                !roundEvents.length ? h('div', { 'data-dy-sub': '' }, '本轮暂时没有可展示的记录。原始内容可在下方查看。') : null,
                warningsOnly && roundEvents.length && !roundEvents.some((event) => ['warning', 'error'].includes(event.level)) ? h('div', { 'data-dy-sub': '' }, '本轮记录没有提醒。') : null),
              h('details', { 'data-dy-raw-log': '', onToggle: (event) => { const open = event.currentTarget.open; setRawOpen(open); openedLog.current = open; if (open) refreshProgress.current() } },
                h('summary', null, '原始日志'),
                rawOpen ? h('div', { 'data-dy-inner': '' },
                  h('div', { 'data-dy-sub': '' }, '日志可能含早于本轮的记录；查看和复制均已脱敏。'),
                  h('pre', { 'data-dy-pre': '', style: { maxHeight: '320px' } }, runLog ?? '正在读取…'),
                  h('button', { 'data-dy-mini': '', onClick: () => copy(runLog || '', '原始日志') }, '复制原始日志')) : null)) : null),
          ),
        guideOpen ? h(GuideDialog, { onClose: () => setGuideOpen(false) }) : null,

        /* Sending keeps the scope visible; contact selection and chat details open only on demand. */
        h('style', null, SENDING_CSS),
        h('div', { 'data-dy-card': '', 'data-dy-area': 'sending' },
          h('div', { 'data-dy-send-heading': '' },
            h('h2', null, '自动发送'),
            h('div', { 'data-dy-send-control': '' },
              h('span', { 'data-dy-send-meta': '' }, cfg.autoSend ? '已开启' : '已关闭'),
              h(Switch, { label: '自动发送推荐', disabled: Boolean(busy), on: Boolean(cfg.autoSend),
                onChange: (value) => patch({ autoSend: value }, value ? '自动发送已开启' : '自动发送已关闭') }))),
          h('p', { 'data-dy-send-note': '' }, cfg.autoSend ? '手动和定时运行选出的推荐，按以下设置发送。' : '手动和定时运行只记录推荐，暂不自动发送。'),
          msgTone === 'warn' ? notice('sending') : null,

          h('section', { 'data-dy-send-section': '', 'aria-labelledby': 'dy-dm-heading' },
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('h3', { id: 'dy-dm-heading' }, '私信接收人'),
                h('p', { 'data-dy-send-note': '' }, '先分享卡片，再发送推荐理由。')),
              h('button', { 'data-dy-btn': '', 'aria-haspopup': 'dialog', disabled: Boolean(busy) || !st.loggedIn,
                onClick: () => openRecipients('dm') }, dmPeers.length ? '管理接收人' : '选择接收人')),
            dmPeers.length ? h('div', { 'data-dy-send-peers': '', 'aria-label': '已选私信接收人' }, dmPeers.map((person, index) =>
              h('div', { key: person.sec_uid || person.nick, 'data-dy-send-peer': '' },
                h('div', { 'data-dy-grow': '' }, h('strong', null, person.nick || person.sec_uid),
                  !person.sec_uid ? h('span', { 'data-dy-send-meta': '' }, ' · 群聊或未指定 ID') : null),
                h('button', { 'data-dy-mini': '', 'aria-label': '移除私信接收人 ' + (person.nick || person.sec_uid), disabled: Boolean(busy), onClick: () => removePeer(index) }, '移除'))))
              : h('p', { 'data-dy-send-note': '' }, '尚未选择接收人，不会发送推荐私信。'),
            !st.loggedIn ? h('p', { 'data-dy-send-note': '' }, '先在「开始使用」登录，才能读取会话。') : null,
            dmPeers.some((person) => !person.sec_uid) ? h('div', { 'data-dy-send-notice': '' }, '群聊或未指定 ID 的会话可能无法送达。已观察到网页端群聊发出后，对方收不到；手机端正常，请核实后使用。') : null),

          h('section', { 'data-dy-send-section': '', 'aria-labelledby': 'dy-at-heading' },
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('h3', { id: 'dy-at-heading' }, '评论区 @ 提醒'),
                h('p', { 'data-dy-send-note': '' }, !cfg.autoSend ? '自动发送已关闭，@ 提醒暂不生效。' : !cfg.commentAtMe ? '已关闭，保留已选名单。' : atPeers.length ? '挑到最值得的内容时，在评论区提醒已选对象。' : '已开启，选择对象后才会 @。')),
              h(Switch, { label: '评论区 @ 提醒', on: Boolean(cfg.commentAtMe), disabled: !cfg.autoSend || Boolean(busy),
                onChange: (value) => patch({ commentAtMe: value }, value ? '评论区 @ 提醒已开启' : '评论区 @ 提醒已关闭') })),
            h('div', { 'data-dy-send-peers': '', 'aria-label': '已选评论区 @ 对象' }, atPeers.map((person, index) =>
              h('div', { key: person.nick, 'data-dy-send-peer': '' }, h('strong', { 'data-dy-grow': '' }, person.nick),
                h('button', { 'data-dy-mini': '', 'aria-label': '移除 @ 对象 ' + person.nick, disabled: Boolean(busy), onClick: () => removeAt(index) }, '移除')))),
            h('div', { 'data-dy-row': '' },
              h('button', { 'data-dy-btn': '', 'aria-haspopup': 'dialog', disabled: Boolean(busy) || !st.loggedIn, onClick: () => openRecipients('at') }, atPeers.length ? '管理 @ 对象' : '选择 @ 对象'),
              atPeers.length > 1 ? h('button', { 'data-dy-mini': '', disabled: Boolean(busy), onClick: clearAt }, '清空 @ 名单') : null,
              h('span', { 'data-dy-send-meta': '' }, '仅支持个人会话')),
            cfg.commentAtMe && cfg.autoSend ? h('p', { 'data-dy-send-note': '' }, '@ 昵称需能在抖音提及列表中找到，通常是关注或互关的人。') : null,
            cfg.autoComment ? h('p', { 'data-dy-send-note': '' }, '自动评论也已开启，推荐时可能发布普通评论。') : null),

          h('section', { 'data-dy-send-section': '', 'aria-labelledby': 'dy-chat-heading' },
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('h3', { id: 'dy-chat-heading' }, '聊天模式'),
                h('p', { 'data-dy-send-note': '' }, cfg.chatWatch ? `每 ${Math.max(10, Math.min(Number(cfg.chatWatchSec || 30), 300))} 秒检查新私信，交给${cfg.chatWatchTarget === 'duty' ? '值班小鱼' : '前台会话'}处理。` : '已关闭，暂不自动检查新私信。')),
              h(Switch, { label: '聊天模式', on: Boolean(cfg.chatWatch), disabled: Boolean(busy),
                onChange: (value) => patch({ chatWatch: value }, value ? '聊天模式已开启' : '聊天模式已关闭') })),
            h('p', { 'data-dy-send-note': '' }, '独立于自动发送，接收所有新私信，不限于上方接收人。'),
            h('details', { 'data-dy-send-details': '' }, h('summary', null, '聊天设置与状态'),
              h('div', null,
                cfg.chatWatch ? h('div', { 'data-dy-send-settings': '' },
                  h('label', { htmlFor: 'dy-chat-interval' }, '检查间隔（10–300 秒）'),
                  h('input', { id: 'dy-chat-interval', 'data-dy-input': '', type: 'number', min: 10, max: 300,
                    disabled: busy === 'patch', value: cwSecDraft !== null ? cwSecDraft : String(cfg.chatWatchSec || 30),
                    onChange: (event) => setCwSecDraft(event.target.value), onBlur: saveChatInterval,
                    onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); saveChatInterval() } } }),
                  h('label', { htmlFor: 'dy-chat-target' }, '新消息交给'),
                  h('select', { id: 'dy-chat-target', 'data-dy-input': '', disabled: Boolean(busy), value: cfg.chatWatchTarget || 'lead',
                    onChange: (event) => patch({ chatWatchTarget: event.target.value }, '消息接收会话已保存') },
                    h('option', { value: 'lead' }, '前台会话'), h('option', { value: 'duty' }, '值班小鱼')),
                  h('p', { 'data-dy-send-note': '', style: { gridColumn: '1 / -1' } }, '值班小鱼使用独立会话，不在时退回前台。')) : null,
                cfg.chatWatch ? h(ChatWatchStatus, { key: 'cw-status' }) : null,
                h('div', { 'data-dy-row': '' }, h('button', { 'data-dy-btn': '', disabled: Boolean(busy),
                  onClick: async () => {
                    setBusy('chatfix')
                    try {
                      const result = await jpost('/chat/fix', {})
                      setChatFix(result)
                      saySending(result.ok ? '聊天检查已完成' : result.need_user?.what || '还有问题，请查看检查结果', result.ok ? 'good' : 'warn')
                      await refresh()
                    } catch (error) { saySending('检查失败：' + String(error?.message || error), 'warn') }
                    finally { setBusy('') }
                  } }, busy === 'chatfix' ? '检查中…' : '检查并修复聊天')),
                h('p', { 'data-dy-send-note': '' }, '检查登录与私信读取；聊天关闭时会开启聊天模式，并尝试读取最近私信。'),
                chatFix ? h('div', { 'data-dy-send-notice': '', role: 'status' }, chatFix.human || '', chatFix.need_user?.how ? ' ' + chatFix.need_user.how : '') : null))),
          h('p', { 'data-dy-send-note': '', style: { marginTop: '16px' } }, '在「消息与记忆」中点击「DSH 回复」，不受自动发送开关影响。')),

        recipientPicker ? h(RecipientDialog, { mode: recipientPicker, people, loading: busy === 'people', hint: peopleHint, error: peopleError, busy: Boolean(busy),
          selected: (person) => recipientPicker === 'at' ? atPeers.some((peer) => peer.nick === person.nick) : dmPeers.some((peer) => person.sec_uid ? peer.sec_uid === person.sec_uid : peer.nick === person.nick && !peer.sec_uid),
          onToggle: (person) => {
            if (recipientPicker === 'at') return toggleAt(person)
            const index = dmPeers.findIndex((peer) => person.sec_uid ? peer.sec_uid === person.sec_uid : peer.nick === person.nick && !peer.sec_uid)
            return index >= 0 ? removePeer(index) : pickPerson(person)
          }, onReload: loadPeople, onClose: () => setRecipientPicker(''),
          feedback: busy === 'patch' ? '正在保存…' : msgArea === 'sending' ? msg : '' },
          recipientPicker === 'dm' ? h('details', { 'data-dy-send-details': '', 'data-dy-recipient-manual': '' },
            h('summary', { onClick: () => { if (manualDm === null) setManualDm({ nick: '', id: '' }) } }, '手动添加接收人'),
            manualDm !== null ? h('div', null,
              h('label', null, '昵称', h('input', { 'data-dy-input': '', value: manualDm.nick, placeholder: '比如：示例好友',
                onChange: (event) => setManualDm({ ...manualDm, nick: event.target.value }) })),
              h('label', null, '账号标识（sec_uid）', h('input', { 'data-dy-input': '', value: manualDm.id, placeholder: 'MS4wLjABAAAA…',
                onChange: (event) => setManualDm({ ...manualDm, id: event.target.value }) })),
              h('p', { 'data-dy-send-note': '' }, '优先从会话中选择。仅填昵称可能无法精确匹配账号。'),
              h('div', { 'data-dy-row': '' }, h('button', { 'data-dy-btn': '', disabled: Boolean(busy) || !(manualDm.nick.trim() || manualDm.id.trim()),
                onClick: async () => {
                  const person = { nick: manualDm.nick.trim(), sec_uid: manualDm.id.trim() }
                  const current = Array.isArray(cfg.dmPeers) ? cfg.dmPeers : []
                  if (current.some((peer) => person.sec_uid ? peer.sec_uid === person.sec_uid : peer.nick === person.nick)) { saySending('这个接收人已在列表中', 'warn'); return }
                  if (await patch({ dmPeers: [...current, person] }, '接收人已添加')) setManualDm({ nick: '', id: '' })
                } }, '添加接收人'))) : null) : null) : null,

        h('style', null, MESSAGES_CSS),
        h('div', { 'data-dy-card': '', 'data-dy-area': 'messages' },
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('h2', null, '消息与记忆')),
            h('button', { 'data-dy-btn': '', disabled: inboxLoading[inboxTab] || !st.loggedIn, onClick: () => loadInbox() }, inboxLoading[inboxTab] ? '读取中…' : inbox?.loaded?.[inboxTab] ? '刷新消息' : '读取消息')),
          h('p', { 'data-dy-message-note': '' }, st.loggedIn ? '选择消息，DSH 会结合上下文和人设生成回复，点击后直接发送。' : '先在「开始使用」扫码登录，才能读取消息。'),
          notice('messages'),
          h('div', { 'data-dy-message-tabs': '', role: 'group', 'aria-label': '消息分类' },
            h('button', { 'aria-pressed': inboxTab === 'dm', onClick: () => selectInboxTab('dm') }, '私信' + (inbox?.loaded?.dm ? ' · ' + inbox.dm.length : '')),
            h('button', { 'aria-pressed': inboxTab === 'comment', onClick: () => selectInboxTab('comment') }, '评论区 @ 与回复' + (inbox?.loaded?.comment ? ' · ' + inbox.at.length : ''))),
          inboxErrors[inboxTab] ? h('p', { 'data-dy-message-note': '', role: 'alert' }, inboxErrors[inboxTab]) : null,
          !inbox?.loaded?.[inboxTab] ? h('p', { 'data-dy-message-empty': '' }, inboxLoading[inboxTab] ? '正在读取最近的消息…' : inboxErrors[inboxTab] ? '点击「读取消息」重试。' : '尚未读取消息。点击「读取消息」查看最近的私信与评论。') : null,
          inbox !== null ? h('div', null,
            !inbox.ok ? h('div', { 'data-dy-msg': '', role: 'alert' }, (inbox.errors || []).join('；') || '读取失败，请重试。') : null,
            inbox.loaded?.comment && inboxTab === 'comment' ? h('div', { 'data-dy-comment-list': '' },
              inbox.at.length ? inbox.at.map((item, i) => h(CommentConversation, { key: commentKey(item) || i, item }))
                : h('p', { 'data-dy-message-empty': '' }, '最近没有评论区 @ 或回复消息。')) : null,
            inbox.loaded?.dm && inboxTab === 'dm' ? (chat ? h(ChatConversation, {
              key: chat.who.sec_uid || chat.who.nick, who: chat.who, onBack: () => setChat(null), onSent: onChatSent,
            }) : h('div', null,
              (inbox.dm || []).length ? inbox.dm.map((person, i) => h('button', {
                key: person.sec_uid || i, 'data-dy-dm-row': '', 'data-dy-inbox-dm': '', onClick: () => openChat(person),
              },
                h('span', { 'data-dy-dm-copy': '' },
                  h('span', null, h('strong', null, person.nick || '未命名会话'), person.duplicate ? '（重名会话）' : ''),
                  h('span', { 'data-dy-dm-preview': '' }, person.their_last?.text || person.preview || '打开查看最近对话')),
                h('span', { 'data-dy-dm-action': '' }, person.needs_reply ? '待回复 · 查看 ›' : '查看对话 ›')))
                : h('p', { 'data-dy-message-empty': '' }, '最近没有私信。'))) : null,
            inbox.ok && inbox.errors?.length ? h('div', { 'data-dy-msg': '', role: 'alert' }, '部分消息没有读到：' + inbox.errors.join('；')) : null) : null,
          h('details', { 'data-dy-message-memory': '', onToggle: (e) => { if (e.currentTarget.open && mem === null && busy !== 'mem') loadMem() } },
            h('summary', null, '对话记忆'),
            h('div', null,
              h('p', { 'data-dy-message-note': '' }, '记录保存在本机，回复时会作为上下文提供给当前使用的模型。'),
              mem === null ? h('div', { 'data-dy-row': '' },
                h('p', { 'data-dy-message-note': '' }, busy === 'mem' ? '正在读取记忆统计…' : '尚未读取记忆统计。'),
                h('button', { 'data-dy-mini': '', disabled: busy === 'mem', onClick: loadMem }, '读取统计')) :
                h('p', null, '私信 ' + mem.dm + ' 人 · 评论 ' + mem.comment + ' 条作品 · ' + Math.round((mem.bytes || 0) / 1024) + ' KB'),
              mem && !mem.dm && !mem.comment ? h('p', { 'data-dy-message-note': '' }, '还没有对话记忆。读取或回复消息后会逐渐积累。') : null,
              mem && (mem.dm || mem.comment) ? h('div', null,
                !clearMemConfirm ? h('button', { 'data-dy-mini': '', 'data-danger': '', onClick: () => setClearMemConfirm(true) }, '清空全部记忆') :
                  h('div', { 'data-dy-dm-result': '' },
                    h('p', null, '清空本机保存的全部私信和评论记忆？此操作无法撤销，抖音中的原消息会保留。'),
                    h('div', { 'data-dy-row': '', style: { marginTop: '10px' } },
                      h('button', { 'data-dy-mini': '', disabled: busy === 'mem', onClick: () => setClearMemConfirm(false) }, '取消'),
                      h('button', { 'data-dy-mini': '', 'data-danger': '', disabled: busy === 'mem', onClick: clearMem }, busy === 'mem' ? '清空中…' : '确认清空记忆')))) : null))),
        h('section', { 'data-dy-card': '', 'data-dy-area': 'persona', 'data-dy-preferences': '' },
          h('div', { 'data-dy-row': '' },
            h('h2', { 'data-dy-title': '', 'data-dy-grow': '' }, '我的人设'),
            h('button', { 'data-dy-mini': '', disabled: busy === 'persona', 'aria-expanded': personaOpen, onClick: loadPersona }, personaOpen ? '收起编辑' : '编辑人设')),
          h('p', { 'data-dy-pref-note': '' }, '设置表达方式与边界，用于推荐说明和 DSH 回复。'),
          h('p', { 'data-dy-pref-note': '', 'data-dy-persona-source': '' }, persona ? '当前生效：' + (persona.custom ? '我写的人设' : persona.effectiveLabel || '插件自带的那份') : '暂未读到人设，点击编辑可重试。'),
          notice('persona'),
          personaOpen && persona ? h('div', { 'data-dy-persona-editor': '' },
            h('div', { 'data-dy-pref-editorbar': '' }, h('label', { htmlFor: 'dy-persona-text' }, '人设内容'),
              h('button', { 'data-dy-mini': '', 'aria-pressed': personaLarge, onClick: () => setPersonaLarge((v) => !v) }, personaLarge ? '恢复高度' : '扩大编辑区')),
            h('textarea', { id: 'dy-persona-text', 'data-dy-input': '', 'data-dy-persona-text': '', 'data-large': personaLarge ? '' : undefined,
              rows: 16, value: personaText, disabled: busy === 'persona', 'aria-describedby': 'dy-persona-hint',
              onChange: (e) => setPersonaDraft(e.target.value), placeholder: '写下希望 DSH 如何表达，以及需要遵守的边界。' }),
            h('div', { 'data-dy-pref-editorbar': '' },
              h('span', { 'data-dy-pref-note': '', role: 'status' }, personaDirty ? '有未保存的修改' : '与当前生效内容一致'),
              h('span', { 'data-dy-pref-note': '' }, personaText.length.toLocaleString() + ' 字')),
            h('p', { id: 'dy-persona-hint', 'data-dy-pref-note': '' }, personaText.trim() ? '保存后用于新的推荐与回复；收起编辑会保留本次草稿。' : '保存空白内容会清除自定义人设，恢复插件自带或中性默认。'),
            h('div', { 'data-dy-pref-actions': '' },
              h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: Boolean(busy) || !personaDirty, onClick: savePersona }, busy === 'persona' ? '保存中…' : '保存人设'),
              personaDirty ? h('button', { 'data-dy-mini': '', disabled: Boolean(busy), onClick: () => setPersonaDraft(null) }, '撤销修改') : null,
              h('button', { 'data-dy-mini': '', disabled: Boolean(busy), onClick: () => setPersonaDraft(persona.defaultText || '') }, '填入中性默认'))) : null),

        h('div', { 'data-dy-card': '', 'data-dy-area': 'prefs', 'data-dy-preferences': '' },
          h('button', { 'data-dy-collapse': '', 'aria-label': '运行偏好', 'data-open': foldCfg ? '' : undefined, 'aria-expanded': foldCfg,
            onClick: () => setFoldCfg((v) => !v) }, h('strong', { 'data-dy-groupname': '' }, '运行偏好'), h('span', null, foldCfg ? '收起 ▲' : '展开 ▼')),
          h('div', { 'data-dy-sub': '' }, '可选设置 · 调整关注内容、自动计划、推荐数量与通知。'),
          notice('prefs'),
          foldCfg ? h('div', { 'data-dy-inner': '' },
              h(ScheduleEditor, { cfg, draft: planDraft, onChange: setPlanDraft, onSave: patch, busy: busy === 'patch', summary: planSummary,
                nextWindow: autoEnabled && Number(cfg.perDay) > counts.auto ? st.nextWindow : null, feedback: notice('schedule') }),
      /* ── 刷什么 ── */
              h('div', { 'data-dy-subblock': '' },
                h('h3', { 'data-dy-title': '' }, '内容偏好'),
                h('div', { 'data-dy-sub': '' }, '关注关键词，一行一个（留空 = 用内置默认那几组）'),
                h('div', { 'data-dy-sub': '' }, '关键词用于偏好筛选，不是搜索。'),
                h('textarea', {
                  'data-dy-input': '', 'aria-label': '关注关键词', rows: 4, value: kwText,
                  placeholder: '搞笑\n美食\n猫',
                  onChange: (e) => setKws(e.target.value),
                }),
                h('div', { 'data-dy-row': '' },
                  h('button', {
                    'data-dy-btn': '', 'data-primary': '',
                    disabled: Boolean(busy) || kws === null, onClick: saveKws,
                  }, '保存'))),
      /* ── 每天挑几条 / 日报多细 ── */
              h('div', { 'data-dy-subblock': '' },
                h('h3', { 'data-dy-title': '' }, '推荐数量'),
                h('div', { 'data-dy-sub': '' },
                  '自动推荐每日上限，只限制定时任务；0 会暂停自动运行。手动运行不占这个额度。'),
                h('div', { 'data-dy-count-row': '' },
                  h('label', { htmlFor: 'dy-auto-limit' }, '自动推荐每日上限'),
                  h('input', {
                    id: 'dy-auto-limit', 'data-dy-time': '', 'aria-label': '自动推荐每日上限', type: 'number', min: 0, max: 300,
                    style: { width: '72px' },
                    value: String(perDayDraft !== null ? perDayDraft : (cfg.perDay != null ? cfg.perDay : 5)),
                    onChange: (e) => setPerDayDraft(e.target.value),
                  }),
                  h('span', { 'data-dy-sub': '' }, '条 / 天'),
                  h('button', {
                    'data-dy-mini': '', 'data-primary': '',
                    disabled: Boolean(busy) || perDayDraft === null,
                    onClick: async () => {
                      const n = Math.max(0, Math.min(Number(perDayDraft) || 0, 300))
                      if (await patch({ perDay: n }, `自动每天最多 ${n} 条`)) setPerDayDraft(null)
                    },
                  }, '保存')),
                h('div', { 'data-dy-count-row': '' },
                  h('label', { htmlFor: 'dy-manual-limit' }, '手动运行每轮最多'),
                  h('input', { id: 'dy-manual-limit', 'data-dy-time': '', 'aria-label': '手动每轮最多推荐', type: 'number', min: 1, max: 30,
                    value: String(manualCountDraft ?? cfg.manualPerRun ?? 3), onChange: (e) => setManualCountDraft(e.target.value) }),
                  h('span', { 'data-dy-sub': '' }, '条 / 轮'),
                  h('button', { 'data-dy-mini': '', disabled: Boolean(busy) || manualCountDraft === null,
                    onClick: async () => { if (await patch({ manualPerRun: Math.max(1, Math.min(30, Number(manualCountDraft) || 3)) }, '手动每轮数量已保存')) setManualCountDraft(null) } }, '保存手动数量')),
                h('div', { 'data-dy-sub': '' }, '合适才推荐，不凑满。手动与自动结果都加入今日推荐。'),
                h('div', { 'data-dy-output-fields': '' },
                  h('label', { 'data-dy-pref-field': '' }, h('span', null, '日报详细程度'),
                    h('select', { 'data-dy-input': '', value: String(cfg.reportLevel || 'full'), disabled: Boolean(busy),
                      onChange: (e) => patch({ reportLevel: e.target.value }, '日报详细程度已保存') },
                      h('option', { value: 'full' }, '完整 · 推荐理由与说明'), h('option', { value: 'brief' }, '简短 · 每条一两行'), h('option', { value: 'off' }, '不写日报'))),
                  h('label', { 'data-dy-pref-field': '' }, h('span', null, '通知方式'),
                    h('select', { 'data-dy-input': '', value: String(cfg.notifyMode || 'toast'), disabled: Boolean(busy),
                      onChange: (e) => patch({ notifyMode: e.target.value }, '通知方式已保存') },
                      h('option', { value: 'toast' }, st.toastSupported === false ? 'Windows 通知（这个平台收不到）' : 'Windows 通知'),
                      h('option', { value: 'file' }, '仅保存文件'),
                      h('option', { value: 'webhook' }, 'Webhook'), h('option', { value: 'both' }, 'Windows 通知与 Webhook')),
                    /* 🔴 2026-11-05：mac/Linux 上 toast 根本弹不出来（lib/toast.mjs 直接跳过）——
                       以前面板不提示，用户以为插件没跑。现在明说 + 给替代方案。 */
                    st.toastSupported === false
                      ? h('div', { 'data-dy-sub': '', 'data-dy-warn': '' },
                        '这个平台没有 Windows 通知（当前是 ' + String(st.platform || '非 Windows') + '）。'
                        + '选「Windows 通知」不会弹任何东西 —— 请改用「Webhook」或「仅保存文件」（报告一直都会写）。')
                      : null))),
            ) : null),

        h('div', { 'data-dy-card': '', 'data-dy-area': 'help', 'data-dy-preferences': '' },
          h('button', { 'data-dy-collapse': '', 'aria-label': '帮助与排查', 'data-open': foldErr ? '' : undefined, 'aria-expanded': foldErr,
            onClick: () => setFoldErr((v) => !v) }, h('strong', { 'data-dy-groupname': '' }, '帮助与排查'), h('span', null, foldErr ? '收起 ▲' : '展开 ▼')),
          h('div', { 'data-dy-sub': '' }, '环境诊断、DSH 入口与 MCP 接入。'),
          notice('help'),
          foldErr ? h('div', { 'data-dy-inner': '' },
      /* ── 环境体检 ── */
              h('div', { 'data-dy-subblock': '' },
                h('div', { 'data-dy-row': '' },
                  h('div', { 'data-dy-grow': '' },
                    h('h3', { 'data-dy-title': '' }, '环境诊断'),
                    h('div', { 'data-dy-sub': '' }, '检查运行环境与登录状态，并给出处理办法。')),
                  h('button', { 'data-dy-btn': '', disabled: busy === 'doctor', onClick: () => onDoctor('help') },
                    busy === 'doctor' ? '查着…' : '检查环境')),
                doctor
                  ? h('div', { 'data-dy-kv': '' },
                    (doctor.items || []).map((it, i) => h('div', { key: 'd' + i, style: { marginBottom: it.state !== 'ok' ? '8px' : '2px' } },
                      (it.state === 'ok' ? '正常 · ' : it.state === 'warn' ? '需关注 · ' : '异常 · ')
                      + it.item + '：' + it.detail,
                      it.state !== 'ok' && it.fix ? h('div', { 'data-dy-sub': '' }, '处理方法：' + it.fix) : null)))
                  : null,
                st.installTail ? h('details', null, h('summary', { 'data-dy-sub': '' }, '安装详情'),
                  h('pre', { 'data-dy-pre': '' }, redactLog(st.installTail))) : null,

                /**
                 * ⭐⭐ 2026-10-23 加：**dsh 入口路径**（起因：使用者反馈「总是显示找不到 dsh」）
                 * 🔴 桌面版不是 npm 全局装的，插件以前只能猜路径；猜不到就报"找不到 dsh"，
                 *    而面板上**根本没有地方填** —— 使用者彻底卡死。
                 *    现在：自动探测（多半能中）+ 这里可手填兜底 + 「自动找」清空回到探测。
                 */
                h('div', { 'data-dy-row': '', style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))' } },
                  h('div', { 'data-dy-grow': '' },
                    h('div', { 'data-dy-title': '' }, 'dsh 入口（后台跑一轮要用）'),
                    h('div', { 'data-dy-sub': '' },
                      cfg.dshBin
                        ? '已手填路径。点「自动找」清空，回到自动探测。'
                        : '留空 = 自动找（桌面版会去 app.asar 里找，一般能中）。只有报「找不到 dsh」时才需要填。'))),
                h('div', { 'data-dy-row': '' },
                  h('input', {
                    'data-dy-input': '', style: { flex: '1' },
                    placeholder: '…\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js',
                    value: dshBinDraft !== null ? dshBinDraft : String(cfg.dshBin || ''),
                    onChange: (e) => setDshBinDraft(e.target.value),
                  }),
                  h('button', {
                    'data-dy-mini': '', disabled: Boolean(busy) || dshBinDraft === null,
                    onClick: async () => { if (await patch({ dshBin: String(dshBinDraft || '').trim() }, '已保存 dsh 入口路径')) setDshBinDraft(null) },
                  }, '保存'),
                  h('button', {
                    'data-dy-mini': '', disabled: Boolean(busy),
                    onClick: async () => { if (await patch({ dshBin: '' }, '已清空 ⇒ 回到自动探测')) setDshBinDraft(null) },
                  }, '自动找')),
                h('div', { 'data-dy-sub': '' },
                  '填这两个之一：<安装目录>\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\'
                  + 'dsh-desktop-host\\lib\\cli.js 或 …\\@deepseek-ai\\dsh\\lib\\bin.js')),
      /* ── 给别的 AI 用（MCP） ── */
              h('div', { 'data-dy-subblock': '' },
                h('div', { 'data-dy-row': '' },
                  h('div', { 'data-dy-grow': '' },
                    h('div', { 'data-dy-title': '' }, '给别的 AI 用'),
                    h('div', { 'data-dy-sub': '' },
                      '想让 Claude Code / Cursor / 别的 agent 也能刷抖音？这插件自带一个 MCP server，配一段 JSON 就能接。'))),
                h('div', { 'data-dy-row': '' },
                  h('button', {
                    'data-dy-btn': '', disabled: busy === 'ai', onClick: loadAi,
                  }, busy === 'ai' ? '读说明中…' : '看接入方式')),
                ai
                  ? h('div', { 'data-dy-inner': '', style: { background: 'transparent', border: 'none', padding: 0, gap: '8px' } },
                    h('div', { 'data-dy-kv': '' }, 'MCP server：' + ((ai.mcp && ai.mcp.server) || '(缺失)')),
                    ai.mcp && ai.mcp.exists
                      ? null
                      : h('div', { 'data-dy-msg': '', 'data-warn': '' }, '缺少 MCP 服务文件，请重新安装插件。'),
                    h('div', { 'data-dy-sub': '' }, '把下面这段填进那个工具的 MCP 配置（路径已经按这台机器算好了）：'),
                    h('pre', { 'data-dy-pre': '' }, (ai.mcp && ai.mcp.configText) || ''),
                    h('div', { 'data-dy-row': '' },
                      h('button', {
                        'data-dy-mini': '',
                        onClick: () => copy((ai.mcp && ai.mcp.configText) || '', 'MCP 配置'),
                      }, copied === 'MCP 配置' ? '已复制' : '复制 MCP 配置'),
                      h('button', {
                        'data-dy-mini': '',
                        onClick: () => copy((ai.mcp && ai.mcp.selfTest) || '', '自测命令'),
                      }, copied === '自测命令' ? '已复制' : '复制自测命令')),
                    h('div', { 'data-dy-sub': '' }, '自测（不接任何客户端，先看它自己通不通）：'),
                    h('pre', { 'data-dy-pre': '' }, (ai.mcp && ai.mcp.selfTest) || ''),
                    ai.doc
                      ? h('div', { 'data-dy-row': '' },
                        h('button', {
                          'data-dy-mini': '',
                          onClick: () => copy(ai.doc, '使用说明'),
                        }, copied === '使用说明' ? '已复制' : '复制完整使用说明（贴给那个 AI 看）'))
                      : h('div', { 'data-dy-msg': '', 'data-warn': '' }, '读不到 AI-USAGE.md：' + (ai.doc_error || '未知原因')))
                  : h('div', { 'data-dy-sub': '' }, '点「看接入方式」会显示：MCP 配置、自测命令、给 AI 看的使用说明。')),
            ) : null),
        h('section', { 'data-dy-card': '', 'data-dy-area': 'about', 'data-dy-preferences': '', id: 'dy-about' },
          h('div', { 'data-dy-row': '' },
            h('h2', { 'data-dy-title': '', 'data-dy-grow': '' }, '关于'),
            h('button', { 'data-dy-mini': '', disabled: busy === 'update', onClick: () => onCheckUpdate(true) }, busy === 'update' ? '检查中…' : '检查更新')),
          h('p', { 'data-dy-pref-note': '' }, '刷抖音 · v' + (st.version || '?') + ' · b' + PANEL_BUILD),
          h('div', { 'data-dy-update-result': '', 'aria-live': 'polite' },
            updateError ? h('p', { 'data-dy-pref-error': '' }, updateError) : upd?.checked ? h('p', null, upd.hasUpdate ? '有新版本 v' + upd.latest : '已是最新版本') : h('p', { 'data-dy-pref-note': '' }, upd?.note || '可检查插件新版本。'),
            upd?.checked && upd.hasUpdate && upd.how ? h('p', { 'data-dy-update-how': '' }, upd.how) : null),
          h('details', { 'data-dy-pref-details': '' }, h('summary', null, '版本与文件信息'),
            h('p', null, '检查更新不会自动安装。'),
            upd?.source ? h('p', null, '更新来源：' + upd.source) : null,
            h('p', { 'data-dy-path': '' }, '报告位置：' + (st.report || 'out/')))),



      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-douyin-scroll')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-douyin-scroll: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'douyin-scroll', order: 31, label: '刷抖音' },
          () => h(Boundary, null, h(Panel)),
        ))
        // ⭐ 桌面小宠（2026-10-24 v3）：她整个搬去独立插件 dsh-deskpet ——
        //    这里不再注册任何浮层/窗口（开关和功能都在 dsh-deskpet 插件里）。
      },
    }
  },
})
