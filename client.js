/**
 * dsh-douyin-scroll —— 浏览器半端（设置在「设置」里的一页，中文名「刷抖音」）
 * ============================================================================
 * 2026-10-22 从零重写的最小可用版：先确保**面板一定能显示**，再谈功能。
 * 之前那版 700+ 行、7 个折叠区，一旦某处报错整页就没了。
 * 这一版只有 4 块：状态 / 三步装机 / 刷什么 / 什么时候跑。
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
    const PANEL_BUILD = 23

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))
    // jpost 但失败/404 返回 null（用在新旧宿主兼容探测上，不炸面板）
    const jpostSoft = async (p, body) => { try { return await jpost(p, body) } catch { return null } }

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
/* （旧版 GUI 浮层小宠的样式已随 v3 迁往 dsh-deskpet 删除） */
`

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-dy-sw': '', 'data-on': on ? '' : undefined,
        disabled: Boolean(disabled),
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
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

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [cfg, setCfg] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [msgTone, setMsgTone] = React.useState('')
      const [kws, setKws] = React.useState(null)
      /** ⭐ 一键自救的结果（{ok, human, need_user, fixed}）—— null = 还没点过 */
      const [chatFix, setChatFix] = React.useState(null)
      const [doctor, setDoctor] = React.useState(null)
      const [report, setReport] = React.useState(null)
      const [wins, setWins] = React.useState(null)
      const [upd, setUpd] = React.useState(null)
      const [ai, setAi] = React.useState(null)
      const [copied, setCopied] = React.useState('')
      // 扫码登录：qr = { url }，qrHint = 一句人话（出不来码时说什么）
      const [qr, setQr] = React.useState(null)
      const [qrHint, setQrHint] = React.useState('')
      // 私信对象：列表 + 选中的那个人
      const [people, setPeople] = React.useState(null)
      const [peopleHint, setPeopleHint] = React.useState('')
      // 新手流程说明
      const [guide, setGuide] = React.useState(null)
      // 当前登录的账号
      const [acc, setAcc] = React.useState(null)
      // 人设（使用者自己那份）
      const [persona, setPersona] = React.useState(null)
      // 私信对象：手动填的模式
      const [manualDm, setManualDm] = React.useState(null)
      // 每天挑几条（输入框草稿）
      const [perDayDraft, setPerDayDraft] = React.useState(null)
      // 记忆统计
      const [mem, setMem] = React.useState(null)
      // 消息（收件箱）：评论区 @ 我 + 谁私信我
      const [inbox, setInbox] = React.useState(null)
      // 聊天：当前跟谁聊、消息列表、输入框
      const [chat, setChat] = React.useState(null)
      const [chatText, setChatText] = React.useState('')
      // 最近一轮的日志
      const [runLog, setRunLog] = React.useState(null)
      // 「评论区 @ 提醒」（0.5.9）：开关 = 总闸，atPeers 多选 = 范围；会话列表只读一次
      // 聊天盯梢间隔的输入草稿（2026-10-24）
      const [cwSecDraft, setCwSecDraft] = React.useState(null)
      // dsh 入口路径（输入框草稿）—— 2026-10-23 加，见「出问题了？」卡片
      const [dshBinDraft, setDshBinDraft] = React.useState(null)
      /* ⭐ 面板三组折叠（2026-10-25 重排）—— 两个状态，默认都收起。
       * 🔴 必须放在这里（和其它 useState 一起、在 `if (!st || !cfg) return` 之前），
       *    绝不能塞进条件分支：React 的 hook 顺序一变，整页就白。
       *    · foldErr = 「出问题才看」（体检 / dsh 入口 / 关于 / MCP）
       *    · foldCfg = 「一次配好」（策略 / 桌宠 / 消息与记忆） */
      const [foldErr, setFoldErr] = React.useState(false)
      const [foldCfg, setFoldCfg] = React.useState(false)

      const say = (t, tone) => { setMsg(t); setMsgTone(tone || '') }

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
        ;(async () => {
          try {
            const [s, c] = await Promise.all([jget('/status'), jget('/config')])
            if (!alive) return
            setSt(s)
            if (c && c.config) setCfg(c.config)
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
            if (alive) say('读设置失败：' + String((e && e.message) || e), 'warn')
          }
        })()
        return () => { alive = false }
      }, [])

      const patch = async (p, label) => {
        setBusy('patch')
        try {
          const r = await jpost('/config', p)
          if (r && r.config) setCfg(r.config)
          say(label || '已保存', 'good')
        } catch (e) { say('保存失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      const onDoctor = async () => {
        setBusy('doctor')
        try {
          const r = await jpost('/doctor', {})
          setDoctor(r)
          const bad = (r.must_fix || []).length
          say(bad ? ('检查完：' + bad + ' 项要修') : '检查完：环境没问题', bad ? 'warn' : 'good')
        } catch (e) { say('检查失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      const onInstall = async () => {
        setBusy('install')
        try { await jpost('/install', {}); say('开始装依赖，进度看日志', 'good') }
        catch (e) { say('装依赖失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
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

      /**
       * ⭐ 扫码登录 · 第一步：出二维码
       * @param {boolean} force 强制重来（先关掉后台无头浏览器 —— 它占着同一个 Chrome 配置）
       */
      const onQr = async (force) => {
        setBusy('login'); setQrHint(''); setQr(null)
        try {
          const r = await jpost('/login/qr', { force: force ? '1' : '' })
          if (r && r.ok && r.qr_url) {
            setQr({ url: r.qr_url })
            say('二维码出来了 —— 用手机抖音扫一下', 'good')
          } else if (r && r.ok && r.already_logged_in) {
            // ⭐ 浏览器里本来就登录着，不用扫码 —— 直接把凭证导出来了
            setQrHint('')
            say('这个浏览器里本来就登录着，已经直接登录好了', 'good')
            await refresh()
          } else if (r && r.ok && r.no_qr_element) {
            // 没截到二维码图 —— 别放一张首页截图骗人，让用户看那个窗口
            setQrHint(r.hint || '没能自动截到二维码，请直接看那个 Chrome 窗口')
            say('二维码没截到，请看弹出的浏览器窗口', 'warn')
          } else if (r && r.conflict === 'profile_in_use') {
            setQrHint(r.error + ' —— 点「重新出码」，我会先把后台那个关掉再出。')
            say('后台浏览器占着窗口，需要先关掉它', 'warn')
          } else {
            setQrHint((r && (r.error || r.detail)) || '出二维码失败')
            say('出二维码失败', 'warn')
          }
        } catch (e) { setQrHint('出二维码失败：' + String((e && e.message) || e)); say('出二维码失败', 'warn') }
        finally { setBusy('') }
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
              say('登录成功 —— 可以刷了', 'good')
              await refresh()
              break
            }
            if (r && r.up === false) {   // 登录浏览器没了：别傻转，直接给提示
              setQrHint(r.hint || '登录用的浏览器还没开 —— 先点「扫码登录」')
              say('没等到，先出二维码', 'warn')
              break
            }
            if (r && r.verify && r.verify.length) {
              setQrHint('卡在验证：' + r.verify.join(' / ') + ' —— 在那个浏览器窗口里做完，不用重扫')
            } else if (i === 3) {
              setQrHint('在等你扫码…（手机抖音 → 扫一扫）')
            }
          }
          if (!done && usedCheck) { say('没等到，再试一次', 'warn'); setQrHint((prev) => prev || '等了一会儿还没扫上 —— 二维码可能过期了，点「重新出码」再来') }
          if (!done && !usedCheck) {   // 旧宿主兜底：一次 wait（还是同步，但只 20 秒）
            try {
              const r = await jpost('/login/wait', { seconds: 20 })
              if (r && r.ok) { setQr(null); say('登录成功 —— 可以刷了', 'good'); await refresh() }
              else { setQrHint((r && (r.hint || r.error)) || '还没好 —— 再点一次「我扫完了」'); say('还没好', 'warn') }
            } catch (e) { setQrHint('等待失败：' + String((e && e.message) || e)) }
          }
        } catch (e) { setQrHint('等待登录失败：' + String((e && e.message) || e)); say('等待失败', 'warn') }
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
          say('已退出登录（Cookie 删了）', 'good')
          await refresh()
        } catch (e) { say('退出失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      /**
       * ⭐ 列出会话里的人 —— 让用户点选，不用手填 sec_uid。
       *    （2026-10-22 用户指出：新手不可能知道「稳定 id」是什么，更找不到）
       */
      const loadPeople = async () => {
        setBusy('people'); setPeopleHint('')
        try {
          const r = await jpost('/dm/people', {})
          if (r && r.ok) {
            setPeople(r.people || [])
            setPeopleHint(r.hint || '')
            if (!(r.people || []).length) say('会话列表是空的', 'warn')
            else say(`找到 ${r.people.length} 个人`, 'good')
          } else {
            setPeople([])
            setPeopleHint((r && (r.hint || r.error)) || '读不到会话列表')
            say('读不到会话列表', 'warn')
          }
        } catch (e) { setPeopleHint('读不到会话列表：' + String((e && e.message) || e)); say('读失败', 'warn') }
        finally { setBusy('') }
      }

      /** 0.5.5 私信对象列表：点选 = 追加进 dmPeers（去重），不再覆盖单值 */
      const pickPerson = async (p) => {
        const cur = Array.isArray(cfg.dmPeers) ? cfg.dmPeers : []
        const same = cur.some((x) => (p.sec_uid && x.sec_uid === p.sec_uid) || (!p.sec_uid && x.nick === p.nick))
        if (same) { say(`「${p.nick}」已经在列表里了`, 'warn'); return }
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

      /** 展开 / 收起「怎么用」（新手流程） */
      const toggleGuide = async () => {
        if (guide !== null) { setGuide(null); return }
        setBusy('guide')
        try {
          const r = await jget('/guide')
          setGuide((r && r.text) || '(说明文件缺失)')
        } catch (e) { say('读说明失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      /* ── 最近一轮发生了什么 ── */
      const loadRunLog = async () => {
        if (runLog !== null) { setRunLog(null); return }
        setBusy('log')
        try {
          const r = await jget('/log')
          setRunLog(r || { tail: '(读不到)' })
        } catch (e) { say('读日志失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      /* ── 消息收件箱 ── */
      const loadInbox = async () => {
        if (inbox !== null) { setInbox(null); return }
        setBusy('inbox')
        try {
          const r = await jget('/inbox')
          if (r && r.ok) {
            setInbox(r)
            const n = (r.at_n || 0) + (r.dm_n || 0)
            say(n ? `有 ${n} 条可能要回` : '没有需要回的消息', n ? 'warn' : 'good')
          } else {
            setInbox({ ok: false, at: [], dm: [], errors: [(r && (r.error || r.hint)) || '读不到'] })
            say('读消息失败', 'warn')
          }
        } catch (e) {
          setInbox({ ok: false, at: [], dm: [], errors: [String((e && e.message) || e)] })
          say('读消息失败', 'warn')
        } finally { setBusy('') }
      }

      /* ── 聊天模式 ── */
      const openChat = async (who) => {
        setBusy('chat')
        try {
          const r = await jpost('/chat/read', { to: who.nick, to_id: who.sec_uid || '' })
          if (r && r.ok) {
            setChat({ who: { nick: r.to || who.nick, sec_uid: r.to_sec_uid || who.sec_uid }, data: r })
            setChatText('')
            say(`打开了和「${r.to || who.nick}」的对话`, 'good')
          } else {
            say('读不到会话：' + ((r && (r.error || r.hint)) || '未知'), 'warn')
          }
        } catch (e) { say('读不到会话：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      /** ⭐ 聊天界面开着时自动刷新（2026-10-24 会话模式）：30 秒拉一次新消息，
       *  走 HTTP 快路径所以很轻；关掉聊天界面就停。正在输入/发送中不打扰。 */
      React.useEffect(() => {
        if (!chat || !chat.who) return undefined
        const t = setInterval(async () => {
          try {
            if (busy === 'send') return
            const r = await jpost('/chat/read', { to: chat.who.nick, to_id: chat.who.sec_uid || '' })
            if (r && r.ok) setChat((prev) => (prev && prev.who.sec_uid === (r.to_sec_uid || prev.who.sec_uid) ? { ...prev, data: r } : prev))
          } catch { /* 刷不到就等下一拍 */ }
        }, 30_000)
        return () => clearInterval(t)
      }, [chat && chat.who && chat.who.sec_uid, busy === 'send'])

      const sendChat = async () => {
        const text = String(chatText || '').trim()
        if (!text || !chat) return
        setBusy('send')
        try {
          const r = await jpost('/chat/send', { to: chat.who.nick, to_id: chat.who.sec_uid || '', text, confirm: true })
          if (r && r.ok && r.sent) {
            setChatText('')
            say('已发送', 'good')
            // 重新读一遍，让新消息和记忆都刷新
            const again = await jpost('/chat/read', { to: chat.who.nick, to_id: chat.who.sec_uid || '' })
            if (again && again.ok) setChat({ ...chat, data: again })
          } else {
            say('发送失败：' + ((r && (r.error || r.hint)) || '未知'), 'warn')
          }
        } catch (e) { say('发送失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      /** 记忆：看统计 / 清空 */      const loadMem = async () => {
        if (mem !== null) { setMem(null); return }
        setBusy('mem')
        try {
          const r = await jget('/memory')
          setMem((r && r.stats) || { dm: 0, comment: 0, bytes: 0 })
        } catch (e) { say('读记忆失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }
      const clearMem = async () => {
        setBusy('mem')
        try {
          const r = await jpost('/memory/clear', {})
          setMem((r && r.stats) || { dm: 0, comment: 0, bytes: 0 })
          say('记忆已清空（私信和评论区的记录都删了）', 'good')
        } catch (e) { say('清空失败：' + String((e && e.message) || e), 'warn') }
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
        if (persona !== null) { setPersona(null); return }
        setBusy('persona')
        try {
          const r = await jget('/persona')
          setPersona({
            text: String((r && r.text) || ''),
            custom: Boolean(r && r.custom),
            effective: String((r && r.effective) || ''),
            effectiveLabel: String((r && r.effective_label) || ''),
            defaultText: String((r && r.default_text) || ''),
            hint: (r && r.hint) || '',
          })
        } catch (e) { say('读人设失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      /** 存人设（空 = 删掉自己那份，退回默认） */
      const savePersona = async () => {
        if (!persona) return
        setBusy('persona')
        try {
          const r = await jpost('/persona', { text: persona.text })
          if (r && r.ok) {
            say(persona.text.trim() ? '人设已保存（下一轮生效）' : '已清空自定义人设，退回默认', 'good')
            setPersona({ ...persona, custom: Boolean(r.custom) })
          } else say('保存失败：' + ((r && r.error) || '未知'), 'warn')
        } catch (e) { say('保存失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      const onRun = async () => {
        setBusy('run')
        try {
          const r = await jpost('/run', {})
          /**
           * 🔴 2026-10-22 修：以前不管有没有真跑起来都说"已经开跑了"。
           *    现在按返回的 ok 分流，并把**真原因**显示出来
           *    （最常见的是上游模型 429 限流）。
           */
          if (r && r.ok) {
            say(r.message || '已经开跑了，跑完会弹通知', 'good')
          } else {
            const why = (r && (r.error || r.message || r.hint)) || '没跑起来'
            say('没跑起来：' + why, 'warn')
          }
        } catch (e) { say('跑失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      const onShowReport = async () => {
        setBusy('report')
        try {
          const r = await jget('/report')
          setReport(r && r.text ? r.text : '(今天还没有报告)')
        } catch (e) { say('读报告失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      const saveKws = async () => {
        const lines = String(kws || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        /* 🔴 2026-10-25 晚：后端守卫「空数组不许盖掉非空列表」（keywords 就是这么丢的）。
         *    真想清空 = 把框删空再点保存 ⇒ 带 __clearKeys 显式口子，守卫放行。 */
        await patch(
          lines.length ? { keywords: lines } : { keywords: [], __clearKeys: ['keywords'] },
          lines.length ? '关键词已保存' : '关键词已清空',
        )
      }

      /** 当前编辑中的自定义时段（`null` = 还没动过，跟随 cfg） */
      const winList = wins !== null ? wins : (Array.isArray(cfg && cfg.windows) ? cfg.windows : [])
      const setWinAt = (i, k, v) => {
        const next = winList.map((w, j) => (j === i ? { ...w, [k]: v } : w))
        setWins(next)
      }
      const addWin = () => { setWins([...winList, { start: '09:00', end: '11:00', label: '' }]) }
      const delWin = (i) => { setWins(winList.filter((_, j) => j !== i)) }
      const saveWins = async () => {
        // ⚠️ 只挑合法的时间，别把半截输入存进去（存了也不会跑，只会让人以为配好了）
        const clean = winList
          .map((w) => ({
            start: String((w && w.start) || '').trim(),
            end: String((w && w.end) || '').trim(),
            label: String((w && w.label) || '').trim(),
          }))
          .filter((w) => /^\d{1,2}:\d{2}$/.test(w.start) && /^\d{1,2}:\d{2}$/.test(w.end))
        const dropped = winList.length - clean.length
        /* 🔴 2026-10-25 晚：数组守卫同款 —— 真清空走 __clearKeys 显式口子 */
        await patch(
          clean.length ? { windows: clean } : { windows: [], __clearKeys: ['windows'] },
          dropped
            ? `已保存 ${clean.length} 个时段（${dropped} 个时间格式不对，没存）`
            : (clean.length ? `已保存 ${clean.length} 个时段` : '已清空自定义时段'),
        )
        setWins(null)
      }

      const onCheckUpdate = async (force) => {
        setBusy('update')
        try {
          const r = await jget('/update' + (force ? '?force=1' : ''))
          setUpd(r)
          if (!r.checked) say('查不到最新版本（没发布或没网）', 'warn')
          else if (r.hasUpdate) say(`有新版本 v${r.latest}（当前 v${r.current}）`, 'warn')
          else say('已经是最新版 v' + r.current, 'good')
        } catch (e) { say('检查更新失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      /* ⭐ 0.5.5 自动检查更新（主人 2026-10-26：「自动检查更新放最上面」）：
       *    面板打开 3 秒后静默查一次（force=1 不吃缓存），有新版本就弹在顶部卡里，
       *    不打扰、不自动装（「检查更新只查不装」是 selfcheck 的红线）。 */
      React.useEffect(() => {
        let alive = true
        const t = setTimeout(async () => {
          try {
            const r = await jget('/update?force=1')
            if (alive) setUpd(r)
          } catch { /* 静默：查不到不打扰 */ }
        }, 3000)
        return () => { alive = false; clearTimeout(t) }
      }, [])

      const loadAi = async () => {
        setBusy('ai')
        try {
          const r = await jget('/ai-usage')
          setAi(r)
          if (!(r.mcp && r.mcp.exists)) say('MCP server 文件缺失，插件包可能不完整', 'warn')
        } catch (e) { say('读使用说明失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      const copy = async (text, what) => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text)
          else {
            const ta = document.createElement('textarea')
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
            document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove()
          }
          setCopied(what)
          say('已复制' + what, 'good')
          setTimeout(() => setCopied(''), 2000)
        } catch (e) { say('复制失败，手动选中吧', 'warn') }
      }

      if (!st || !cfg) {
        return h('div', { 'data-dy-page': '' },
          h('div', { 'data-dy-card': '' },
            h('div', { 'data-dy-sub': '' }, '读设置中…')))
      }

      const kwText = kws !== null ? kws : (Array.isArray(cfg.keywords) ? cfg.keywords.join('\n') : '')

      /* ⭐ 0.5.5 私信对象列表的小工具（面板侧只读展示用）；0.5.9 @ 多选列表 */
      const dmPeers = Array.isArray(cfg.dmPeers) ? cfg.dmPeers.filter((p) => p && (p.nick || p.sec_uid)) : []
      const atPeers = Array.isArray(cfg.atPeers) ? cfg.atPeers.filter((p) => p && String(p.nick || '').trim()) : []

      /* ════════════════════════════════════════════════════════════════════════
       * 面板结构（2026-10-25 重排：20+ 张卡 → 3 组 / 7 张卡）
       *   组 ①「常开必看」永远展开 —— 卡①开始使用 / 卡②刷抖音 / 卡③自动发送
       *   组 ②「出问题才看」默认收起 —— 卡④出问题了？（体检 / dsh 入口 / 报告 / MCP / 关于）
       *   组 ③「一次配好」默认收起 —— 卡⑤刷抖音的策略 / 卡⑥桌宠 / 卡⑦消息与记忆
       *   组标题用 data-dy-group（**不是** data-dy-card），所以卡片计数正好 7。
       *   折叠状态 = Panel 顶部那两个 useState（foldErr / foldCfg）。
       *   ⚠️ 这里的 h(...) 里**不许加 hook** —— 条件分支里加 hook 会让整页白屏。
       * ════════════════════════════════════════════════════════════════════════ */
      return h('div', { 'data-dy-page': '' },

        /* ══════ 组 ①「常开必看」—— **永远展开**（新手上手先看这三张，不折叠）══════ */
        h('div', { 'data-dy-group': '' },
          h('span', { 'data-dy-groupname': '' }, '常开必看'),
          h('span', { 'data-dy-grouphint': '' }, '装好之后天天要用的三张')),

        /* ── 卡 ⓪ 检查更新（0.5.5 主人令：放最上面）──
         *    面板打开 3 秒自动查一次；有新版就黄条提醒 + 给升级命令，没有就轻描淡写一行。 */
        (upd && upd.checked && upd.hasUpdate)
          ? h('div', { 'data-dy-card': '', 'data-dy-highlight': '' },
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' },
                h('div', { 'data-dy-title': '' }, `🆙 有新版本 v${upd.latest}（当前 v${upd.current}）`),
                h('div', { 'data-dy-sub': '' }, (upd.source ? '来源：' + upd.source + '。' : '')
                  + (upd.how || '用命令行升级，装完重启 dsh 生效。'))),
              h('button', { 'data-dy-mini': '', disabled: busy === 'update', onClick: () => onCheckUpdate(true) }, '再查一次')))
          : null,

        /* ── 卡 ① 开始使用 ── */
  /* ── 开始使用：三步装机 + 扫码登录（⭐ 2026-10-24 主人令：放最上面，
           *    已登录时这里带「退出登录」按钮；第二个才是「刷抖音」状态卡）──
           * 🔴 2026-10-22：以前这里只写一句「命令行跑 node tools/qr-login.mjs start」——
           *    对新手等于"你自己去折腾"。现在做成**点按钮 → 出二维码 → 手机扫 → 点我扫完了**。
           *    进度条按状态自己算：没环境 → 没登录 → 能用了。 */
          h('div', { 'data-dy-card': '' },
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' },
                h('div', { 'data-dy-title': '' }, '开始使用'),
                h('div', { 'data-dy-sub': '' },
                  st.venvReady && st.loggedIn
                    ? '✅ 都装好了，可以直接用'
                    : `还差 ${!st.venvReady ? '两步' : '一步'} —— 跟着数字点就行`)),
              h('span', {
                'data-dy-badge': '',
                'data-on': (st.venvReady && st.loggedIn) ? '' : undefined,
              }, (st.venvReady && st.loggedIn) ? '就绪' : '未就绪')),

            /* 第 ① 步 */
            h('div', { 'data-dy-row': '' },
              h('span', { 'data-dy-step': '', 'data-done': st.venvReady ? '' : undefined }, st.venvReady ? '✓' : '1'),
              h('div', { 'data-dy-grow': '' },
                h('div', { 'data-dy-sub': '' }, st.venvReady ? '运行环境好了' : '装运行环境（约 30 秒，一次就够）')),
              st.venvReady
                ? null
                : h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: busy === 'install', onClick: onInstall },
                  busy === 'install' ? '装着…' : '装环境')),

            /* 第 ② 步 —— 扫码登录（新手最容易卡的地方，做成主按钮） */
            h('div', { 'data-dy-row': '' },
              h('span', { 'data-dy-step': '', 'data-done': st.loggedIn ? '' : undefined }, st.loggedIn ? '✓' : '2'),
              h('div', { 'data-dy-grow': '' },
                h('div', { 'data-dy-sub': '' }, st.loggedIn ? '已登录，可以刷了' : '扫码登录抖音（用手机抖音扫一下）')),
              st.loggedIn
                ? h('button', { 'data-dy-btn': '', disabled: busy === 'login', onClick: onLogout }, '退出登录')
                : h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: busy === 'login', onClick: onQr },
                  busy === 'login' ? '准备中…' : '扫码登录')),

            /* 二维码区：只在没登录时出现 */
            !st.loggedIn
              ? h('div', { 'data-dy-loginbox': '' },
                qr && qr.url
                  ? h('div', { 'data-dy-row': '', style: { flexDirection: 'column', alignItems: 'center', gap: '10px', padding: '6px 0' } },
                    h('img', {
                      'data-dy-qr': '', src: qr.url, alt: '抖音登录二维码',
                      style: { width: '190px', height: '190px', borderRadius: '10px', background: '#fff', padding: '6px' },
                    }),
                    h('div', { 'data-dy-sub': '', style: { textAlign: 'center' } },
                      '手机抖音 → 右上角「≡」→ 扫一扫'),
                    h('div', { 'data-dy-row': '' },
                      h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: busy === 'wait', onClick: onWaitLogin },
                        busy === 'wait' ? '等你扫…' : '我扫完了'),
                      h('button', { 'data-dy-btn': '', disabled: Boolean(busy), onClick: () => onQr(true) }, '重新出码'),
                      h('button', { 'data-dy-btn': '', disabled: Boolean(busy), onClick: onCloseLogin }, '关掉窗口')),
                    h('div', { 'data-dy-sub': '', style: { textAlign: 'center', maxWidth: '420px' } },
                      '扫完如果抖音还弹「短信验证码」或「拖动滑块」—— 在那个弹出的浏览器窗口里做完，再点「我扫完了」。不用重新扫。'))
                  : h('div', { 'data-dy-sub': '' },
                    qrHint || '点上面的「扫码登录」，会弹出一个浏览器窗口显示二维码，手机扫一下就行。'))
              : null),

        /* ── 卡 ② 刷抖音（状态 / 现在跑一轮 / 看日志 / 怎么用 / 已登录账号）── */
  /* ── 状态 ── */
          h('div', { 'data-dy-card': '' },
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' },
                h('div', { 'data-dy-title': '' }, '刷抖音'),
                h('div', { 'data-dy-sub': '' },
                  '峰谷时段自动刷一轮，把值得看的挑出来写成日报。不催你、不刷屏。')),
              h('button', { 'data-dy-mini': '', disabled: busy === 'guide', onClick: toggleGuide },
                guide === null ? '怎么用？' : '收起说明'),
              /* ⭐ 面板构建号 —— 改完面板对一下这个数，就知道浏览器有没有拿到新代码。
               *    括号里是**宿主**那边的构建号（宿主读磁盘上的 client.js）：
               *    两者不一致 = 浏览器还在跑旧 bundle（刷新页面 / 重启 dsh）。 */
              h('span', {
                'data-dy-badge': '', title: '面板构建版本（改完面板对一下这个数）',
                style: { fontVariantNumeric: 'tabular-nums' },
              }, 'v' + (st.version || '?') + '·b' + PANEL_BUILD
                + (st.panelBuild && st.panelBuild !== PANEL_BUILD
                  ? `（宿主 b${st.panelBuild} ≠ 浏览器 b${PANEL_BUILD} ⇒ 刷新页面）` : ''))),
            h('div', { 'data-dy-row': '' },
              h('span', {
                'data-dy-badge': '',
                'data-on': st.loggedIn ? '' : undefined,
                'data-off': st.loggedIn ? undefined : '',
              }, st.loggedIn ? '已登录' : '未登录'),
              /* ⭐ 登录的是哪个号 —— 只显示昵称就够（ID 太长，对用户没用） */
              st.loggedIn && acc && acc.nick
                ? h('span', { 'data-dy-account': '' }, '👤 ' + acc.nick)
                : (st.loggedIn
                  ? h('span', { 'data-dy-sub': '' }, acc && acc.failed ? '（昵称没查到，不影响用）' : '正在查登录的号…')
                  : null),
              h('span', {
                'data-dy-badge': '',
                'data-on': st.venvReady ? '' : undefined,
                'data-off': st.venvReady ? undefined : '',
              }, st.venvReady ? '环境就绪' : '环境未装'),
              h('span', { 'data-dy-badge': '' },
                '今天 ' + (st.pickedToday != null ? st.pickedToday : 0) + ' / ' + (cfg.perDay != null ? cfg.perDay : 0)),
              h('div', { 'data-dy-grow': '' }),
              h('button', {
                'data-dy-btn': '', 'data-primary': '',
                disabled: busy === 'run', onClick: onRun,
              }, busy === 'run' ? '跑着呢…' : '现在跑一轮')),
            msg ? h('div', {
              'data-dy-msg': '',
              'data-good': msgTone === 'good' ? '' : undefined,
              'data-warn': msgTone === 'warn' ? '' : undefined,
            }, msg) : null,
            /* ⭐ 「看日志」—— 点一轮没反应时，让用户能自己看清发生了什么 */
            h('div', { 'data-dy-row': '' },
              h('button', { 'data-dy-mini': '', disabled: busy === 'log', onClick: loadRunLog },
                runLog === null ? '看日志（跑一轮没反应就点这）' : '收起日志')),
            runLog !== null
              ? h('div', { 'data-dy-inner': '', style: { background: 'transparent', border: 'none', padding: 0, gap: '6px' } },
                h('div', { 'data-dy-kv': '' },
                  `上次跑：${runLog.lastRunAt ? new Date(runLog.lastRunAt).toLocaleString('zh-CN') : '从没跑过'}`
                  + `　今天已挑 ${runLog.pickedToday || 0} / ${runLog.perDay || 0}`),
                runLog.canRun === false
                  ? h('div', { 'data-dy-msg': '', 'data-warn': '' },
                    runLog.roundActive ? '⚠️ 上一轮还在跑 —— 等它结束再点'
                      : (runLog.pickedToday >= runLog.perDay ? '⚠️ 今天的配额用完了（改「每天挑几条」或等明天）' : '现在不能跑'))
                  : null,
                h('pre', { 'data-dy-pre': '', style: { maxHeight: '300px' } }, runLog.tail || '(日志是空的)'))
              : null,
            guide !== null
              ? h('pre', { 'data-dy-pre': '', style: { maxHeight: '380px' } }, guide)
              : null),

        /* ── 卡 ③ 自动发送（含「私信发给谁」·评论区 @ 你 · 聊天模式）────────────────────────
         *    私信对象紧跟在自动发送开关下面（0.5.5 主人令）—— 它们本来就是一件事：发给谁、发什么、发不发。
         *    2026-10-25 重排：20+ 张卡压成 7 张，功能一个不删，只合并。 */
        h('div', { 'data-dy-card': '', 'data-dy-highlight': cfg.autoSend ? '' : undefined },
          /* 合并卡的总标题：说清这张里装了什么（不然只见「自动发送」，找不到私信对象） */
          h('div', { 'data-dy-title': '' }, '自动发送（发给谁 · 评论区 @ 你 · 聊天模式）'),
          /* ── 自动发送开关（放在**最上面**，别埋在长面板底部） ── */
          h('div', { 'data-dy-subblock': '', 'data-dy-highlight': cfg.autoSend ? '' : undefined },
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' },
                h('div', { 'data-dy-title': '' }, '自动发送'),
                h('div', { 'data-dy-sub': '' },
                  (cfg.autoSend
                    ? '✅ 开着（默认）：插件自己跑一轮时，会把值得的视频发给你'
                      + (cfg.autoComment ? '，也会发评论' : '') + '。'
                    : '关着：插件自己跑一轮只写报告 + 弹通知，不往抖音发任何东西。'))),
              h(Switch, {
                on: Boolean(cfg.autoSend),
                onChange: (v) => patch({ autoSend: v }, v
                  ? '✅ 已打开自动发送'
                  : '已关闭自动发送 —— 后台跑一轮只写报告'),
              })),
            h('div', { 'data-dy-row': '' },
              h('span', { 'data-dy-badge': '', 'data-on': cfg.autoSend ? '' : undefined, 'data-off': cfg.autoSend ? undefined : '' },
                cfg.autoSend ? '会自动发' : '只写报告'),
              h('span', { 'data-dy-sub': '' },
                '发给：' + (dmPeers.length
                  ? dmPeers.map((p) => p.nick || (p.sec_uid || '').slice(0, 8) + '…').join('、')
                  : (cfg.dmTo || '（还没选私信对象，去下面「私信发给谁」选）')))),
            h('div', { 'data-dy-sub': '' },
              '⚠️ 只管「插件自己在后台跑的轮次」。你当场在对话里让它发，不受这个开关影响。'),
  /* ── 私信发给谁（0.5.5：放自动发送正下方 —— 主人 2026-10-26 令；多人列表 + 每人「听他的话」开关） ── */
          h('div', { 'data-dy-subblock': '', style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))' } },
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' },
                h('div', { 'data-dy-title': '' }, '私信发给谁'),
                h('div', { 'data-dy-sub': '' },
                  dmPeers.length
                    ? `已选 ${dmPeers.length} 人：${dmPeers.map((p) => p.nick || (p.sec_uid || '').slice(0, 8) + '…').join('、')}。日报和分享卡片发给每一个人。`
                    : '想让插件把好玩的发给你，先在这里选一个人（可以多选）。不选也行 —— 那就只写日报，不发私信。')),
              h('button', {
                'data-dy-btn': '', disabled: busy === 'people' || !st.loggedIn, onClick: loadPeople,
              }, busy === 'people' ? '读取中…' : (people === null ? '从我的会话里选' : '重新读取'))),

            !st.loggedIn
              ? h('div', { 'data-dy-sub': '' }, '（要先在上面扫码登录，才能读到你的人）')
              : null,

            /* ⭐ 0.5.5 已选列表：每人一行 —— 昵称 + 「听他的话」开关 + 移除 */
            dmPeers.length
              ? h('div', { 'data-dy-people': '' },
                dmPeers.map((p, i) => h('div', {
                  key: 'peer' + i,
                  'data-dy-person': '',
                  'data-picked': p.sec_uid ? '' : undefined,
                },
                  h('span', { 'data-dy-person-name': '' }, p.nick || (p.sec_uid || '').slice(0, 10) + '…'),
                  p.sec_uid
                    ? null
                    : h('span', { 'data-dy-tag': '', title: '群里可能发不出消息：在我这个号上试的，网页端发的别人收不到，手机端正常。别的号不一定这样。' }, '群聊 · 可能发不出'),
                  h('span', { 'data-dy-grow': '' }),
                  h('button', {
                    'data-dy-mini': '', disabled: Boolean(busy),
                    onClick: () => removePeer(i),
                  }, '移除'))))
              : null,

            /* 🔴 群聊限制写在明面上（不是 hover 小字）—— 主人 2026-10-26 令：
             *    「不在选项上说清吗」—— 选了群的人一眼就能看到这条限制。
             *    ⚠️ 措辞留余地：只在鱼号上试过，别把一次观察说成铁律（主人 2026-10-26 令）。 */
            dmPeers.some((p) => !p.sec_uid)
              ? h('div', { 'data-dy-msg': '', 'data-warn': '' },
                '⚠️ **群里可能发不出消息**：在我这个号上试的，网页端发的群里人收不到，手机端正常。'
                + '别的号不一定这样。看群消息没问题，要说话请用手机端。')
              : null,

            people && people.length
              ? h('div', { 'data-dy-people': '' },
                people.map((p, i) => {
                  const added = dmPeers.some((x) => (p.sec_uid && x.sec_uid === p.sec_uid) || (!p.sec_uid && x.nick === p.nick))
                  return h('button', {
                    key: 'p' + i,
                    'data-dy-person': '',
                    'data-picked': added ? '' : undefined,
                    disabled: Boolean(busy) || added,
                    onClick: () => pickPerson(p),
                  },
                    h('span', { 'data-dy-person-name': '' }, p.nick),
                    p.is_group
                      ? h('span', {
                        'data-dy-tag': '',
                        title: '群里可能发不出消息：在我这个号上试的，网页端发的别人收不到，手机端正常。别的号不一定这样。',
                      }, '群聊 · 可能发不出')
                      : null,
                    p.duplicate && !p.is_group ? h('span', { 'data-dy-tag': '' }, '重名') : null,
                    added ? h('span', { 'data-dy-tag': '', 'data-ok': '' }, '✓ 已在列表') : null,
                    p.preview ? h('span', { 'data-dy-person-sub': '' }, p.preview) : null)
                }))
              : null,

            people && !people.length
              ? h('div', { 'data-dy-msg': '', 'data-warn': '' }, peopleHint || '会话列表是空的')
              : null,
            peopleHint && people && people.length
              ? h('div', { 'data-dy-sub': '' }, peopleHint)
              : null,

            /* ⭐ 手动补一个会话列表里没有的人（留活路，但不再是主路径） */
            h('div', { 'data-dy-row': '' },
              h('button', {
                'data-dy-mini': '',
                onClick: () => setManualDm(manualDm === null ? { nick: '', id: '' } : null),
              }, manualDm === null ? '手动加一个（会话列表里没有的人）' : '收起')),
            manualDm !== null
              ? h('div', { 'data-dy-inner': '', style: { background: 'transparent', border: 'none', padding: 0, gap: '8px' } },
                h('div', { 'data-dy-sub': '' }, '昵称（显示用）'),
                h('input', {
                  'data-dy-input': '', value: manualDm.nick, placeholder: '比如：示例好友',
                  onChange: (e) => setManualDm({ ...manualDm, nick: e.target.value }),
                }),
                h('div', { 'data-dy-sub': '' }, '稳定 ID（sec_uid，从「从我的会话里选」拿最方便；没有它没法精确认人）'),
                h('input', {
                  'data-dy-input': '', value: manualDm.id, placeholder: 'MS4wLjABAAAA…',
                  onChange: (e) => setManualDm({ ...manualDm, id: e.target.value }),
                }),
                h('div', { 'data-dy-row': '' },
                  h('button', {
                    'data-dy-btn': '', 'data-primary': '', disabled: Boolean(busy) || !(manualDm.nick.trim() || manualDm.id.trim()),
                    onClick: async () => {
                      const cur = Array.isArray(cfg.dmPeers) ? cfg.dmPeers : []
                      const next = [...cur, { nick: manualDm.nick.trim(), sec_uid: manualDm.id.trim() }]
                      await patch({ dmPeers: next }, `已把「${manualDm.nick.trim() || manualDm.id.trim()}」加进私信对象`)
                      setManualDm(null)
                    },
                  }, '加进列表')))
              : null),


            /* ⭐⭐ 评论区 @ 提醒（0.5.9 主人定稿）—— 开关 = 总闸，选人 = 范围（可多个）：
             *    开关开着 + 名单有人 = 会 @；开关关 = 选了人也不 @；开着没选 = 待命（值班跳过）。
             *    会话列表只读一次（复用私信区的 people），不反复拉。 */
            h('div', { 'data-dy-row': '', style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))' } },
              h('div', { 'data-dy-grow': '' },
                h('div', { 'data-dy-title': '' }, '评论区 @ 提醒'),
                h('div', { 'data-dy-sub': '' },
                  !cfg.autoSend
                    ? '先打开上面的「自动发送」，这个才有用。'
                    : !cfg.commentAtMe
                      ? '总闸关着 —— 选了人也不 @。'
                      : atPeers.length
                        ? `开：挑到最值得的那条时，在评论区 @ ${atPeers.map((p) => p.nick).join('、')}（他刷抖音就能收到通知）。`
                        : '开着但还没选人 —— 待命中，选了人就开始 @。')),
              h(Switch, {
                on: Boolean(cfg.commentAtMe),
                disabled: !cfg.autoSend || busy === 'patch',
                onChange: (v) => {
                  // 🔴 0.5.9d：这里以前调 setShowAtPicker（那版 state 已删）⇒ 运行时
                  //    ReferenceError ⇒ onChange 整个崩 ⇒ patch 从没执行 ⇒ 主人点开关「没反应」。
                  //    教训：删 state 时要连引用一起删光；这类崩 node --check 查不出来。
                  if (!atPeers.length && v && !people) loadPeople()
                  patch({ commentAtMe: v }, v ? '✅ 评论区 @ 提醒：开（选了人就开始 @）' : '已关闭 —— 选了人也不 @')
                },
              })),
            cfg.autoSend && cfg.commentAtMe
              ? h('div', { 'data-dy-sub': '' },
                atPeers.length
                  ? `要 @ 的人（${atPeers.length}）：${atPeers.map((p) => p.nick).join('、')}`
                  : '要 @ 的人：（还没选 —— 点下面列表里的人）')
              : null,
            cfg.autoSend && cfg.commentAtMe && !people
              ? h('div', { 'data-dy-row': '' },
                h('button', {
                  'data-dy-mini': '', disabled: busy === 'people' || !st.loggedIn, onClick: loadPeople,
                }, busy === 'people' ? '读取会话列表中…' : '读一次会话列表（两个选人区共用，不反复拉）'))
              : null,
            cfg.autoSend && cfg.commentAtMe
              ? h('div', { 'data-dy-people': '' },
                people && people.length
                  ? people.map((p, i) => {
                    const added = atPeers.some((x) => x.nick === p.nick)
                    return h('button', {
                      key: 'at' + i,
                      'data-dy-person': '',
                      'data-picked': added ? '' : undefined,
                      disabled: Boolean(busy) || p.is_group,
                      onClick: () => toggleAt(p),
                    },
                      h('span', { 'data-dy-person-name': '' }, p.nick),
                      p.is_group ? h('span', { 'data-dy-tag': '' }, '群不能 @') : null,
                      added ? h('span', { 'data-dy-tag': '', 'data-ok': '' }, '✓ 要 @') : null)
                  })
                  : h('div', { 'data-dy-sub': '' }, busy === 'people' ? '读取中…' : '会话列表还没读'))
              : null,
            atPeers.length
              ? h('div', { 'data-dy-row': '' },
                atPeers.map((p, i) => h('span', {
                  key: 'atp' + i, 'data-dy-tag': '', 'data-ok': '', style: { marginRight: '6px' },
                },
                  p.nick + ' ',
                  h('button', {
                    'data-dy-mini': '', disabled: Boolean(busy), style: { marginLeft: '2px' },
                    onClick: () => removeAt(i),
                  }, '×'))),
                h('span', { 'data-dy-grow': '' }),
                h('button', { 'data-dy-mini': '', disabled: Boolean(busy), onClick: clearAt }, '全清（不 @ 了）'))
              : null,
            cfg.commentAtMe && cfg.autoSend
              ? h('div', { 'data-dy-sub': '', style: { marginTop: '4px', opacity: '.78' } },
                '💡 真 @ 需要起无头 Chrome 走「点选弹层」流程（约 20-40 秒）；@ 的昵称必须能在弹层里搜到（一般是关注/互关的人）。')
              : null,

            /* ⭐⭐ 聊天模式（2026-10-24）：使用者实测的「会话模式」进插件。
             *   每 N 秒静默读一次私信对象的会话（HTTP 快路径，不起浏览器），
             *   他来新消息就弹 Windows 通知。回话还是你来（或叫值班轮）。 */
            h('div', { 'data-dy-row': '', style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))' } },
              h('div', { 'data-dy-grow': '' },
                h('div', { 'data-dy-title': '' }, '聊天模式'),
                /* 🔴🔴 2026-10-25 主人：「聊天模式怎么打开了，关闭不了」
                 *
                 * 真因不是开关坏了：`dmToId` 被一次配置事故清空，而这里
                 *   `disabled: !cfg.dmToId`
                 * 让开关**永久变灰**——点它没反应。更糟的是右边那段说明文字
                 * 还写着"✅ 开着"，主人看到的就是"显示开着、关不掉"。
                 *
                 * ✅ 规矩（这条比修 bug 本身重要）：
                 *    **任何 disabled 都必须当场说清为什么**，不许只变灰。
                 *    变灰而不解释 = 让主人猜 = 他会以为软件坏了。
                 *    所以这里分成三档文案：
                 *      ① 没选私信对象 ⇒ 明说"开关是灰的，点不了不是坏了，先选人"
                 *      ② 正在保存     ⇒ 明说"保存中"
                 *      ③ 正常         ⇒ 说功能状态
                 */
                h('div', { 'data-dy-sub': '' },
                  !dmPeers.length
                    ? '⚠️ 还没选私信对象 —— 去下面「私信发给谁」点选一个人，小鱼才知道有消息时状态屏该显示谁。'
                    : busy === 'patch'
                      ? '保存中…'
                      : (cfg.chatWatch
                        ? `✅ 开着：每 ${Math.max(10, Math.min(Number(cfg.chatWatchSec || 30), 300))} 秒看一眼私信，**谁来的都看**（${dmPeers.map((p) => p.nick || (p.sec_uid || '').slice(0, 8) + '…').join('、')}）；有新消息就转给值班的小鱼接。不弹桌面通知，不起浏览器，很轻。`
                        : '关着（默认是开的）。关了之后来消息就没人接话——小鱼睡缸底。想恢复再打开。'))),
              h(Switch, {
                on: Boolean(cfg.chatWatch),
                disabled: busy === 'patch',
                /* 变灰时点它也给一句话——比"毫无反应"好，主人至少知道点到了 */
                onChange: (v) => {
                  patch({ chatWatch: v }, v
                    ? (dmPeers.length ? '✅ 已打开聊天模式（谁私信都接）' : '聊天模式开了 —— 建议先去「私信发给谁」点选对象，状态屏才好显示')
                    : '已关闭聊天模式')
                },
              })),
            busy === 'patch'
              ? h('div', { 'data-dy-sub': '' }, '保存中…')
              : null,
            !dmPeers.length
              ? h('div', { 'data-dy-sub': '' }, '（还没选私信对象 —— 在下面「私信发给谁」里点选）')
              : null,
            cfg.chatWatch
              ? h('div', { 'data-dy-row': '' },
                h('span', { 'data-dy-sub': '' }, '看消息的间隔（秒，10–300）'),
                h('input', {
                  'data-dy-input': '', style: { width: '90px' }, type: 'number', min: 10, max: 300,
                  value: cwSecDraft !== null ? cwSecDraft : String(cfg.chatWatchSec || 30),
                  onChange: (e) => setCwSecDraft(e.target.value),
                }),
                h('button', {
                  'data-dy-mini': '', disabled: Boolean(busy) || cwSecDraft === null,
                  onClick: async () => {
                    const n = Math.max(10, Math.min(Number(cwSecDraft) || 30, 300))
                    await patch({ chatWatchSec: n }, `聊天模式间隔已存：${n} 秒`)
                    setCwSecDraft(null)
                  },
                }, '保存'))
              : null,
            /* ⭐ 私信投给谁（2026-10-25 深夜「探明呗」后新增）：
             *    lead = 前台会话（排队等当前轮跑完，私聊夹在工作流里）
             *    duty = 常驻值班鱼 dm-duty-fish（独立会话秒醒，私聊不占前台）
             *    值班鱼不在时后端自动退回前台，状态屏会写明。 */
            cfg.chatWatch
              ? h('div', { 'data-dy-row': '' },
                h('span', { 'data-dy-sub': '' }, '消息投给'),
                h('div', { 'data-dy-seg': '', role: 'group' },
                  [['lead', '前台会话'], ['duty', '值班小鱼']].map(([v, label]) =>
                    h('button', {
                      key: 'cwt-' + v,
                      'data-dy-segbtn': '', 'data-on': (cfg.chatWatchTarget || 'lead') === v ? '' : undefined,
                      disabled: busy === 'patch',
                      onClick: () => patch({ chatWatchTarget: v },
                        v === 'duty'
                          ? '以后私信投给值班小鱼（独立会话，前台不受打扰；她不在会自动退回前台）'
                          : '以后私信投进前台会话（跟工作对话排一个队）'),
                    }, label))))
              : null,
            /* ⭐ 实时状态屏（2026-10-24 使用者要求：「我哪知道它有什么用、错在哪了」）：
             *    开着聊天模式时每 15 秒拉一次后端状态，显示几秒前看过、结果、通知弹没弹。 */
            cfg.chatWatch ? h(ChatWatchStatus, { key: 'cw-status' }) : null,
            /* ⭐⭐ 2026-10-26 凌晨（主人：「如果是普通用户，他该怎么办，没那么聪明啊」）
             *   一句话说明 + 一个按钮：不懂的人只会点这个。
             *   按钮背后是 /chat/fix —— 后端自动判断、能修的自己修，修不了的用
             *   「还差一步：……」告诉他去点哪儿。绝不让用户读日志。 */
            h('div', { 'data-dy-row': '', style: { marginTop: '8px', alignItems: 'center' } },
              h('button', {
                'data-dy-btn': '',
                disabled: busy === 'chatfix',
                onClick: async () => {
                  setBusy('chatfix')
                  try {
                    const r = await jpost('/chat/fix', {})
                    setChatFix(r)
                    say(r.ok ? '好了，现在能收发了' : (r.need_user ? `还差一步：${r.need_user.what}` : '还有问题，看下面的说明'), r.ok ? 'good' : 'warn')
                  } catch (e) { say('自检失败：' + String((e && e.message) || e), 'warn') }
                  finally { setBusy('') }
                },
              }, busy === 'chatfix' ? '检查中…' : '🔧 一键修好（不聊天时点这个）'),
              h('span', { 'data-dy-sub': '' }, '收到消息不回？先点这个，它自己会修。')),
            chatFix
              ? h('div', { 'data-dy-sub': '', style: { color: chatFix.ok ? '#22c55e' : '#f59e0b' } },
                `${chatFix.ok ? '✅' : '👉'} ${chatFix.human || ''}`
                  + (chatFix.need_user && chatFix.need_user.how ? `\n${chatFix.need_user.how}` : ''))
              : null),
        ),

        /* ══════ 组「出问题才看」—— **默认收起**（foldErr 初始 false），点标题行展开 ══════
         * 🔴 折叠状态是 Panel 顶部那两个 useState；这里只读、只 set，**绝不在条件分支里加 hook**。 */
        h('div', { 'data-dy-group': '' },
          h('button', {
            'data-dy-groupbtn': '', 'data-open': foldErr ? '' : undefined,
            'aria-expanded': foldErr ? 'true' : 'false',
            onClick: () => setFoldErr((v) => !v),
          },
            h('span', { 'data-dy-groupname': '' }, '出问题才看'),
            h('span', { 'data-dy-groupchev': '' }, foldErr ? '收起 ▲' : '展开看 ▼'))),

        /* ── 卡 ④ 出问题了？（体检 + dsh 入口 + 看报告 + 给别的 AI 用 + 关于）──
         *    都是「平时不看、出问题才翻」的东西，收进一张卡，默认折叠。 */
        foldErr
          ? h('div', { 'data-dy-card': '' },
      /* ── 环境体检 ── */
              h('div', { 'data-dy-subblock': '' },
                h('div', { 'data-dy-row': '' },
                  h('div', { 'data-dy-grow': '' },
                    h('div', { 'data-dy-title': '' }, '出问题了？'),
                    h('div', { 'data-dy-sub': '' }, '点一下，9 项环境逐个查，哪项红了直接告诉你怎么办')),
                  h('button', { 'data-dy-btn': '', disabled: busy === 'doctor', onClick: onDoctor },
                    busy === 'doctor' ? '查着…' : '检查环境')),
                doctor
                  ? h('div', { 'data-dy-kv': '' },
                    (doctor.items || []).map((it, i) => h('div', { key: 'd' + i },
                      (it.state === 'ok' ? '✅ ' : it.state === 'warn' ? '⚠️ ' : '❌ ')
                      + it.item + '：' + it.detail)))
                  : null,
                h('div', { 'data-dy-row': '' },
                  h('button', { 'data-dy-mini': '', disabled: busy === 'report', onClick: onShowReport }, '看今天的报告')),

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
                    onClick: async () => { await patch({ dshBin: String(dshBinDraft || '').trim() }, '已保存 dsh 入口路径'); setDshBinDraft(null) },
                  }, '保存'),
                  h('button', {
                    'data-dy-mini': '', disabled: Boolean(busy),
                    onClick: async () => { await patch({ dshBin: '' }, '已清空 ⇒ 回到自动探测'); setDshBinDraft(null) },
                  }, '自动找')),
                h('div', { 'data-dy-sub': '', style: { opacity: '.78' } },
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
                      : h('div', { 'data-dy-msg': '', 'data-warn': '' }, '⚠️ 找不到 tools/mcp-server.mjs —— 插件包不完整，重新安装'),
                    h('div', { 'data-dy-sub': '' }, '把下面这段填进那个工具的 MCP 配置（路径已经按这台机器算好了）：'),
                    h('pre', { 'data-dy-pre': '' }, (ai.mcp && ai.mcp.configText) || ''),
                    h('div', { 'data-dy-row': '' },
                      h('button', {
                        'data-dy-mini': '',
                        onClick: () => copy((ai.mcp && ai.mcp.configText) || '', 'MCP 配置'),
                      }, copied === 'MCP 配置' ? '✓ 已复制' : '复制 MCP 配置'),
                      h('button', {
                        'data-dy-mini': '',
                        onClick: () => copy((ai.mcp && ai.mcp.selfTest) || '', '自测命令'),
                      }, copied === '自测命令' ? '✓ 已复制' : '复制自测命令')),
                    h('div', { 'data-dy-sub': '' }, '自测（不接任何客户端，先看它自己通不通）：'),
                    h('pre', { 'data-dy-pre': '' }, (ai.mcp && ai.mcp.selfTest) || ''),
                    ai.doc
                      ? h('div', { 'data-dy-row': '' },
                        h('button', {
                          'data-dy-mini': '',
                          onClick: () => copy(ai.doc, '使用说明'),
                        }, copied === '使用说明' ? '✓ 已复制' : '复制完整使用说明（贴给那个 AI 看）'))
                      : h('div', { 'data-dy-msg': '', 'data-warn': '' }, '读不到 AI-USAGE.md：' + (ai.doc_error || '未知原因')))
                  : h('div', { 'data-dy-sub': '' }, '点「看接入方式」会显示：MCP 配置、自测命令、给 AI 看的使用说明。')),
      /* ── 关于 / 检查更新 ── */
              h('div', { 'data-dy-subblock': '' },
                h('div', { 'data-dy-row': '' },
                  h('div', { 'data-dy-grow': '' },
                    h('div', { 'data-dy-title': '' }, '关于'),
                    h('div', { 'data-dy-sub': '' }, '当前版本 v' + (st.version || '?') + ' · 报告在 ' + (st.report || 'out/'))),
                  h('button', {
                    'data-dy-btn': '', disabled: busy === 'update', onClick: () => onCheckUpdate(true),
                  }, busy === 'update' ? '查着呢…' : '检查更新')),
                upd
                  ? h('div', { 'data-dy-kv': '' },
                    upd.checked
                      ? (upd.hasUpdate
                        ? `有新版本 v${upd.latest}（当前 v${upd.current}）`
                        : `已是最新版（v${upd.current}）`) + (upd.source ? `　来源：${upd.source}` : '')
                      : (upd.note || '查不到最新版本'),
                    upd.hasUpdate && upd.how ? h('div', { style: { marginTop: '4px' } }, '升级：' + upd.how) : null)
                  : null,
                upd && upd.tried && !upd.checked
                  ? h('div', { 'data-dy-sub': '' }, '试过：' + upd.tried.map((t) => t.source + (t.ok ? ' ✓' : ' ✗')).join('、'))
                  : null),
      /* ── 报告 ── */
              report !== null
                ? h('div', { 'data-dy-subblock': '' },
                  h('div', { 'data-dy-title': '' }, '报告'),
                  h('pre', { 'data-dy-pre': '' }, report))
                : null,
            )
          : null,

        /* ══════ 组「一次配好」—— **默认收起**（foldCfg 初始 false），点标题行展开 ══════
         * 🔴 折叠状态是 Panel 顶部那两个 useState；这里只读、只 set，**绝不在条件分支里加 hook**。 */
        h('div', { 'data-dy-group': '' },
          h('button', {
            'data-dy-groupbtn': '', 'data-open': foldCfg ? '' : undefined,
            'aria-expanded': foldCfg ? 'true' : 'false',
            onClick: () => setFoldCfg((v) => !v),
          },
            h('span', { 'data-dy-groupname': '' }, '一次配好'),
            h('span', { 'data-dy-groupchev': '' }, foldCfg ? '收起 ▲' : '展开看 ▼'))),

        /* ── 卡 ⑤ 刷抖音的策略：刷什么 / 什么时候自己跑 / 每天挑几条 / 日报多细 / 通知方式 ── */
        foldCfg
          ? h('div', { 'data-dy-card': '' },
              h('div', { 'data-dy-title': '' }, '刷抖音的策略'),
              h('div', { 'data-dy-sub': '' },
                '刷什么、什么时候自己跑、每天挑几条、日报写多细、消息怎么通知你 —— 一次配好就不用再管。'),
      /* ── 刷什么 ── */
              h('div', { 'data-dy-subblock': '' },
                h('div', { 'data-dy-title': '' }, '刷什么'),
                h('div', { 'data-dy-sub': '' }, '关注关键词，一行一个（留空 = 用内置默认那几组）'),
                h('div', { 'data-dy-sub': '' },
                  '⚠️ 抖音没有能用的搜索接口，所以这几个词**不会替你搜**，也不筛掉别的视频：'
                  + '它们只做一件事 —— 文案 / 话题里命中了的候选排前面，并在报告里标注。'
                  + '候选仍然来自推荐流 + 热榜。'),
                h('textarea', {
                  'data-dy-input': '', rows: 5, value: kwText,
                  placeholder: '搞笑\n美食\n猫',
                  onChange: (e) => setKws(e.target.value),
                }),
                h('div', { 'data-dy-row': '' },
                  h('button', {
                    'data-dy-btn': '', 'data-primary': '',
                    disabled: Boolean(busy), onClick: saveKws,
                  }, '保存'))),
      /* ── 什么时候跑 ── */
              h('div', { 'data-dy-subblock': '' },
                h('div', { 'data-dy-row': '' },
                  h('div', { 'data-dy-grow': '' },
                    h('div', { 'data-dy-title': '' }, '什么时候自己跑'),
                    h('div', { 'data-dy-sub': '' }, '只在谷时跑（便宜）。全关 = 只在你点「现在跑一轮」时跑。'))),
                h('div', { 'data-dy-row': '' },
                  h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-sub': '' }, '中午谷时 12:00–14:00')),
                  h(Switch, {
                    on: Boolean(cfg.noon),
                    onChange: (v) => patch({ noon: v }, v ? '中午自动跑：开' : '中午自动跑：关'),
                  })),
                h('div', { 'data-dy-row': '' },
                  h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-sub': '' }, '晚上谷时 18:00–次日 09:00')),
                  h(Switch, {
                    on: Boolean(cfg.night),
                    onChange: (v) => patch({ night: v }, v ? '晚上自动跑：开' : '晚上自动跑：关'),
                  })),

                /* ⭐ 自定义时段：和上面两个开关**叠加**（任意一个命中就跑），每个时段每天只跑一次 */
                h('div', { 'data-dy-sub': '', style: { marginTop: '4px' } }, '自定义时段（可选，跟上面两个叠加）'),
                winList.length
                  ? winList.map((w, i) => h('div', { 'data-dy-wrow': '', key: 'w' + i },
                    h('input', {
                      'data-dy-time': '', type: 'time', value: String(w.start || ''),
                      onChange: (e) => setWinAt(i, 'start', e.target.value),
                    }),
                    h('span', { 'data-dy-sep': '' }, '→'),
                    h('input', {
                      'data-dy-time': '', type: 'time', value: String(w.end || ''),
                      onChange: (e) => setWinAt(i, 'end', e.target.value),
                    }),
                    h('input', {
                      'data-dy-input': '', style: { flex: '1', minWidth: '60px' },
                      placeholder: '备注（可空）', value: String(w.label || ''),
                      onChange: (e) => setWinAt(i, 'label', e.target.value),
                    }),
                    h('button', { 'data-dy-mini': '', 'data-danger': '', onClick: () => delWin(i) }, '删')))
                  : null,
                h('div', { 'data-dy-row': '' },
                  h('button', { 'data-dy-mini': '', onClick: addWin }, '+ 加一个时段'),
                  winList.length
                    ? h('button', {
                      'data-dy-mini': '', 'data-primary': '',
                      disabled: Boolean(busy), onClick: saveWins,
                    }, '保存时段')
                    : null,
                  h('div', { 'data-dy-grow': '' }),
                  winList.length
                    ? h('span', { 'data-dy-sub': '' }, '跨零点也行（23:00 → 02:00）')
                    : null),

                h('div', { 'data-dy-sub': '' }, '两个都关 = 只在点「现在跑一轮」时跑。')),
      /* ── 每天挑几条 / 日报多细 ── */
              h('div', { 'data-dy-subblock': '' },
                h('div', { 'data-dy-title': '' }, '每天挑几条'),
                h('div', { 'data-dy-sub': '' },
                  '全天总量（不是每轮）。0 = 不自动刷，只在你点「现在跑一轮」时跑。'),
                h('div', { 'data-dy-row': '' },
                  h('input', {
                    'data-dy-time': '', type: 'number', min: 0, max: 300,
                    style: { width: '72px' },
                    value: String(perDayDraft !== null ? perDayDraft : (cfg.perDay != null ? cfg.perDay : 5)),
                    onChange: (e) => setPerDayDraft(e.target.value),
                  }),
                  h('span', { 'data-dy-sub': '' }, '条 / 天'),
                  h('div', { 'data-dy-grow': '' }),
                  h('button', {
                    'data-dy-mini': '', 'data-primary': '',
                    disabled: Boolean(busy) || perDayDraft === null,
                    onClick: async () => {
                      const n = Math.max(0, Math.min(Number(perDayDraft) || 0, 300))
                      await patch({ perDay: n }, `每天最多 ${n} 条`)
                      setPerDayDraft(null)
                    },
                  }, '保存')),
                h('div', { 'data-dy-row': '' },
                  h('span', { 'data-dy-sub': '' }, '日报写多细：'),
                  h('select', {
                    'data-dy-input': '', style: { flex: '1', maxWidth: '180px' },
                    value: String(cfg.reportLevel || 'full'),
                    onChange: (e) => patch({ reportLevel: e.target.value }, '日报详细程度已保存'),
                  },
                    h('option', { value: 'full' }, '完整版（为什么值得 + 一句话）'),
                    h('option', { value: 'brief' }, '薄版（每条一两行）'),
                    h('option', { value: 'off' }, '不写日报')),

                  h('span', { 'data-dy-sub': '', style: { marginLeft: '12px' } }, '通知：'),
                  h('select', {
                    'data-dy-input': '', style: { flex: '1', maxWidth: '150px' },
                    value: String(cfg.notifyMode || 'toast'),
                    onChange: (e) => patch({ notifyMode: e.target.value }, '通知方式已保存'),
                  },
                    h('option', { value: 'toast' }, '弹 Windows 通知'),
                    h('option', { value: 'file' }, '只写文件（不打扰）'),
                    h('option', { value: 'webhook' }, '推 webhook'),
                    h('option', { value: 'both' }, '通知 + webhook')))),
            )
          : null,

        /* ── 卡 ⑥ 我的人设（桌宠联动开关 2026-10-26 按主人要求隐藏） ──
         *   主人：「人设是不是该改成我的人设」⇒ 对，这份是**你的**那份，
         *   不是泛称的"人设"。标题就叫「我的人设」。 */
        foldCfg
          ? h('div', { 'data-dy-card': '' },
              h('div', { 'data-dy-title': '' }, '我的人设'),
      /* ⭐⭐ 2026-10-25 拆分：卡⑥从「桌宠控制台」变成「联动桌宠」一个开关。
       *   为什么缩水：桌宠独立成插件了（dsh-deskpet），她的开关 / 人格 / 弹幕三态 /
       *   语音 / 按钮条全在**设置 → 桌宠**那边。在这里控制它们就是跨插件伸手，
       *   两份配置互相覆盖的坑我们踩过一次（dmTo 被清空那次就是这么来的）。
       *   这里只回答一个问题：**刷抖音的状态要不要喂给她**。
       *
       * 🔴 2026-10-26 主人：「联动桌宠选项暂时不要出现」⇒ 用 HIDE_PET_LINK 关掉。
       *   为什么用常量而不是删代码：
       *     · 删了以后要恢复就得重写一遍（这块逻辑+文案不短）
       *     · 后端 petLinkTo 还在工作（默认 true，状态源照常注册），
       *       只是**面板不让人看见/改它** —— 主人要的是"别出现在界面上"，
       *       不是"断掉联动"。
       *   要恢复：把下面的 HIDE_PET_LINK 改成 false 即可，别改别的。 */
              (() => {
                const HIDE_PET_LINK = true
                if (HIDE_PET_LINK) return null
                return h('div', { 'data-dy-subblock': '' },
                  h('div', { 'data-dy-row': '' },
                    h('div', { 'data-dy-grow': '' },
                      h('div', { 'data-dy-title': '' }, '联动桌宠'),
                      h('div', { 'data-dy-sub': '' },
                        (cfg.petLinkTo !== false
                          ? '✅ 开着：刷抖音的状态会喂给桌宠 —— 她在气泡里说「正一条条看视频文案」这种话，就是从这里来的。'
                          : '关着：桌宠不知道你在刷抖音，她自己待着（这不是故障）。'))),
                    h(Switch, {
                      on: cfg.petLinkTo !== false,
                      disabled: busy === 'patch',
                      onChange: (v) => patch({ petLinkTo: v },
                        v ? '✅ 联动开了：她知道你在刷抖音了' : '联动关了：她不再知道抖音的状态'),
                    })))
              })(),
                /* ⚠️ 2026-10-25 主人：「走动模式去掉，不生效也没动画」⇒ 这块直接删掉。 */
      /* ── 我的人设
       *   🔴 2026-10-26 主人：「人设默认的是不是有问题，人设是不是该改成我的人设」
       *      两件事一起改：
       *        ① 叫法 —— 卡片标题「人设」→「我的人设」（这是**你的**那份，不是泛称）
       *        ② 默认有真问题 —— 面板原来只读 $DOUYIN_HOME/persona.md，
       *           而实际生效的是**插件自带那份**（16970 字节完整人设），
       *           于是文本框空着、提示写"用的是默认"，看着就像人设丢了。
       *           现在后端会返回 effective（真正生效的内容）+ effective_label（哪一份），
       *           面板直接展示它，并在上面写清"现在用的是哪一份"。
       */
              h('div', { 'data-dy-subblock': '' },
                h('div', { 'data-dy-row': '' },
                  h('div', { 'data-dy-grow': '' },
                    h('div', { 'data-dy-sub': '' },
                      '人格是性格档位，这里补几句你额外想让她遵守的话（写日报时也用这份）。')),
                  h('button', { 'data-dy-mini': '', disabled: busy === 'persona', onClick: loadPersona },
                    persona === null ? '展开' : '收起')),
                persona !== null
                  ? h('div', { 'data-dy-inner': '', style: { background: 'transparent', border: 'none', padding: 0, gap: '8px' } },
                    // ⭐ 说清"现在生效的是哪一份"（别再让用户以为自己的人设丢了）
                    h('div', { 'data-dy-sub': '', style: { fontWeight: '500' } },
                      persona.custom
                        ? '✅ 正在用你写的这份'
                        : `ℹ️ 你没写自己的 —— 现在用的是「${persona.effective_label || '插件自带的那份'}」，内容就在下面`),
                    h('textarea', {
                      'data-dy-input': '', rows: 8,
                      // 没有自己那份时，把**真正生效的内容**显示出来（而不是空框）
                      value: persona.text || (persona.custom ? '' : (persona.effective || '')),
                      placeholder: '比如：\n- 说话软一点、别腻\n- 简短，别写成客服\n- 不透露任何私人信息',
                      onChange: (e) => setPersona({ ...persona, text: e.target.value }),
                    }),
                    h('div', { 'data-dy-row': '' },
                      h('button', {
                        'data-dy-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: savePersona,
                      }, persona.custom ? '保存' : '保存为我的人设'),
                      h('button', {
                        'data-dy-mini': '', disabled: Boolean(busy),
                        onClick: () => setPersona({ ...persona, text: persona.defaultText || '' }),
                      }, '填入中性默认'),
                      h('div', { 'data-dy-grow': '' }),
                      h('span', { 'data-dy-sub': '' }, '留空保存 = 退回上一份（自己写 → 插件自带 → 中性默认）')))
                  : null),
            )
          : null,

        /* ── 卡 ⑦ 消息与记忆：收件箱（谁找我）+ 聊天窗口 + 对话记忆（含清空） ── */
        foldCfg
          ? h('div', { 'data-dy-card': '' },
              h('div', { 'data-dy-title': '' }, '消息与记忆'),
              h('div', { 'data-dy-sub': '' },
                '谁在评论区 @ 了你、谁给你发了私信；点一条就能回。聊过的话记在本机，不上传。'),
      /* ── 消息：评论区 @ 我 + 谁私信我 ── */
              h('div', { 'data-dy-subblock': '' },
                h('div', { 'data-dy-row': '' },
                  h('div', { 'data-dy-grow': '' },
                    h('div', { 'data-dy-title': '' }, '消息'),
                    h('div', { 'data-dy-sub': '' },
                      '谁在评论区 @ 了你、谁最近给你发了私信。点一条就能回。')),
                  h('button', { 'data-dy-btn': '', disabled: busy === 'inbox' || !st.loggedIn, onClick: loadInbox },
                    busy === 'inbox' ? '读取中…' : (inbox === null ? '看看谁找我' : '收起'))),
                !st.loggedIn ? h('div', { 'data-dy-sub': '' }, '（要先扫码登录）') : null,

                inbox !== null && inbox.ok
                  ? h('div', { 'data-dy-inner': '', style: { background: 'transparent', border: 'none', padding: 0, gap: '10px' } },
                    /* 评论区 @ */
                    h('div', { 'data-dy-sub': '' }, `评论区 @ 我：${inbox.at_n || 0} 条`),
                    (inbox.at || []).length
                      ? h('div', { 'data-dy-people': '' },
                        inbox.at.map((a, i) => h('div', { key: 'at' + i, 'data-dy-msgrow': '' },
                          h('div', { 'data-dy-row': '' },
                            h('span', { 'data-dy-person-name': '' }, a.nickname || '（不知道是谁）'),
                            h('span', { 'data-dy-tag': '', ...(a.before === '回过' ? { 'data-ok': '' } : {}) }, a.before),
                            h('div', { 'data-dy-grow': '' }),
                            a.video_url
                              ? h('a', { href: a.video_url, target: '_blank', rel: 'noreferrer', 'data-dy-mini': '', style: { textDecoration: 'none' } }, '看视频')
                              : null),
                          h('div', { 'data-dy-person-sub': '', style: { whiteSpace: 'normal', marginTop: '2px' } }, a.content || ''),
                          a.my_comments_here && a.my_comments_here.length
                            ? h('div', { 'data-dy-sub': '', style: { marginTop: '2px' } },
                              '我在这条视频下说过：' + a.my_comments_here[a.my_comments_here.length - 1].text.slice(0, 40))
                            : null)))
                      : h('div', { 'data-dy-sub': '' }, (inbox.at_n ? '都回过了' : '最近没有人在评论区 @ 你')),

                    /* 私信 */
                    h('div', { 'data-dy-sub': '', style: { marginTop: '6px' } }, `最近私信：${inbox.dm_n || 0} 个可能要回`),
                    (inbox.dm || []).length
                      ? h('div', { 'data-dy-people': '' },
                        inbox.dm.map((p, i) => h('button', {
                          key: 'dm' + i, 'data-dy-person': '', 'data-dy-inbox-dm': '', disabled: Boolean(busy),
                          onClick: () => openChat(p),
                        },
                          h('span', { 'data-dy-person-name': '' }, p.nick),
                          p.duplicate ? h('span', { 'data-dy-tag': '' }, '重名') : null,
                          p.needs_reply ? h('span', { 'data-dy-tag': '' }, '该回了') : null,
                          h('span', { 'data-dy-person-sub': '' },
                            (p.their_last ? '他：' + String(p.their_last.text).slice(0, 26) : (p.preview || ''))),
                          h('span', { 'data-dy-tag': '' }, `记 ${p.remembered || 0}`))))
                      : h('div', { 'data-dy-sub': '' }, '最近没有私信'),
                    (inbox.errors && inbox.errors.length)
                      ? h('div', { 'data-dy-msg': '', 'data-warn': '' }, '有些读不到：' + inbox.errors.join('；'))
                      : null)
                  : null,
                inbox !== null && !inbox.ok
                  ? h('div', { 'data-dy-msg': '', 'data-warn': '' }, (inbox.errors || []).join('；') || '读不到消息')
                  : null),
      /* ── 聊天（带记忆） ── */
              chat !== null
                ? h('div', { 'data-dy-subblock': '' },
                  h('div', { 'data-dy-row': '' },
                    h('div', { 'data-dy-grow': '' },
                      h('div', { 'data-dy-title': '' }, '跟 ' + chat.who.nick + ' 聊'),
                      h('div', { 'data-dy-sub': '' },
                        chat.data.context && chat.data.context.facts && chat.data.context.facts.length
                          ? '记得关于他的：' + chat.data.context.facts.join('、')
                          : (chat.data.context && chat.data.context.note) ? chat.data.context.note : '记忆里还没有这个人')),
                    h('button', { 'data-dy-mini': '', onClick: () => { setChat(null); setChatText('') } }, '关掉')),

                  /* 消息气泡 */
                  h('div', { 'data-dy-chat': '' },
                    (chat.data.messages || []).map((m, i) => h('div', {
                      key: 'm' + i,
                      'data-dy-bubble': '',
                      'data-mine': m.from === 'me' ? '' : undefined,
                      'data-them': m.from === 'them' ? '' : undefined,
                    },
                      h('div', { 'data-dy-bubble-text': '' }, String(m.text || '').slice(0, 300)),
                      m.awe === 800 ? h('div', { 'data-dy-tag': '' }, '分享卡片') : null))),

                  /* 输入 */
                  h('div', { 'data-dy-row': '' },
                    h('input', {
                      'data-dy-input': '', style: { flex: '1' },
                      placeholder: '说点什么…（发出去会进记忆）',
                      value: chatText,
                      onChange: (e) => setChatText(e.target.value),
                      onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() } },
                    }),
                    h('button', {
                      'data-dy-btn': '', 'data-primary': '',
                      disabled: busy === 'send' || !String(chatText || '').trim(),
                      onClick: sendChat,
                    }, busy === 'send' ? '发送中…' : '发送')),
                  h('div', { 'data-dy-sub': '' },
                    '发出去的话会记进记忆，下次打开就知道聊到哪了。'))
                : null,
      /* ── 对话记忆 ── */
              h('div', { 'data-dy-subblock': '' },
                h('div', { 'data-dy-row': '' },
                  h('div', { 'data-dy-grow': '' },
                    h('div', { 'data-dy-title': '' }, '对话记忆'),
                    h('div', { 'data-dy-sub': '' },
                      '回私信、回评论时会记住聊过什么（存在本机，不上传）。这样它才不会把人当陌生人、重复问已经说过的事。')),
                  h('button', {
                    'data-dy-btn': '', disabled: busy === 'mem', onClick: loadMem,
                  }, mem === null ? '看记忆' : '收起')),
                mem !== null
                  ? h('div', { 'data-dy-inner': '', style: { background: 'transparent', border: 'none', padding: 0, gap: '8px' } },
                    h('div', { 'data-dy-kv': '' },
                      `私信记忆 ${mem.dm} 个人 · 评论区记忆 ${mem.comment} 条视频 · 共 ${Math.round((mem.bytes || 0) / 1024)} KB`),
                    h('div', { 'data-dy-sub': '' },
                      mem.dm || mem.comment
                        ? '想忘掉某个人：在对话里说「忘掉他」，或者清空全部。'
                        : '还没有记忆 —— 用它聊过天之后才会有。'),
                    h('div', { 'data-dy-row': '' },
                      h('button', {
                        'data-dy-mini': '', 'data-danger': '', disabled: Boolean(busy) || (!mem.dm && !mem.comment),
                        onClick: clearMem,
                      }, '清空全部记忆')))
                  : null),
            )
          : null,
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
