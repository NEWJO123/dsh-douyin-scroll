/**
 * selfcheck.mjs —— 不装进 DSH 也能跑的本地预检
 * ============================================================================
 * 用途：装之前先确认「文件齐不齐 / 能 import 吗 / Python 编译过吗 / 示例数据能跑吗」。
 *
 * 跑法（插件根目录）：
 *     node selfcheck.mjs
 *
 * ⚠️ 它**不**启动 DSH、**不**启动浏览器、**不**联网。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { findBrowser } from './lib/chrome.mjs'
import { homeDir } from './lib/paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0
const ok = (m) => { pass++; console.log(`  ✅ ${m}`) }
const bad = (m) => { fail++; console.log(`  ❌ ${m}`) }
/** 读文件，读不到就返回空串（断言会自然失败，但不会把整段检查炸掉）。
 *  为什么需要：selfcheck 已经很长，某个文件被改名/删除时应该报"缺这个文件"，
 *  而不是 "TypeError: readFileSync ... ENOENT" 把后面几十条断言一起带走。 */
const readIf = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const warn = (m) => { console.log(`  ⚠️  ${m}`) }

console.log('dsh-douyin-scroll 本地预检\n')

/* ── 1. 必需文件 ── */
console.log('1. 文件清单')
const required = [
  'package.json', 'cordis.patch.yml', 'index.js', 'client.js', 'requirements.txt',
  'lib/hostdeps.mjs', 'lib/state.mjs', 'lib/credential.mjs', 'lib/notify.mjs', 'lib/toast.mjs', 'lib/uvfetch.mjs',
  'lib/paths.mjs', 'lib/chrome.mjs',
  'prompts/duty.md', 'prompts/persona.default.md', 'prompts/sample-candidates.json',
  // 给别的 AI / MCP 用的那一层
  'AI-USAGE.md', 'tools/mcp-server.mjs', 'tools/doctor.mjs', 'check-client.mjs',
  // 采集 / 发送这一层：全是自带的脚本（2026-10-21 起不再有 vendor/ 里的内置 MCP）
  'tools/forward-pick.py', 'tools/forward-run.mjs', 'tools/notice-read.py', 'tools/api-comments.py',
  'tools/comment-api.mjs', 'tools/comment-delete.mjs', 'tools/card-share.mjs', 'tools/im-send.mjs',
  'tools/qr-login.mjs', 'tools/session-guard.py', 'tools/dy-signer.mjs',
]
for (const f of required) {
  if (existsSync(join(here, f))) ok(f)
  else bad(`缺文件：${f}`)
}

/* ── 2. package.json 契约 ── */
console.log('\n2. package.json')
try {
  const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
  if (pkg.name === 'dsh-douyin-scroll') ok('name = dsh-douyin-scroll')
  else bad(`name 应为 dsh-douyin-scroll，实际 ${pkg.name}`)
  if (pkg.dsh?.bundle?.patch) ok(`bundle patch = ${pkg.dsh.bundle.patch}`)
  else bad('缺少 dsh.bundle.patch')
  if (pkg.dsh?.client?.platform === 'web') ok('client platform = web')
  else warn('没有 dsh.client.platform = web（设置页可能不加载）')
} catch (e) { bad(`package.json 读不了：${e.message}`) }

/* ── 3. cordis.patch.yml 的 id 必须等于命名空间 ── */
console.log('\n3. cordis.patch.yml')
try {
  const y = readFileSync(join(here, 'cordis.patch.yml'), 'utf8')
  if (/id:\s*douyin-scroll\b/.test(y)) ok('entry id = douyin-scroll（必须等于命名空间）')
  else bad('entry id 不是 douyin-scroll —— 设置页会写不进去（"no volatile fields"）')
} catch (e) { bad(`读不了：${e.message}`) }

/* ── 4. JS 语法 ── */
console.log('\n4. JS 语法（node --check）')
for (const f of ['index.js', 'client.js',
  ...readdirSync(join(here, 'lib')).filter((x) => x.endsWith('.mjs')).map((x) => join('lib', x)),
  ...readdirSync(join(here, 'tools')).filter((x) => x.endsWith('.mjs')).map((x) => join('tools', x))]) {
  const r = spawnSync(process.execPath, ['--check', join(here, f)], { encoding: 'utf8' })
  if (r.status === 0) ok(f)
  else bad(`${f}：${(r.stderr || '').split('\n').slice(0, 3).join(' ')}`)
}

/* ── 4a-1. 面板状态 setter 不许有悬空引用（2026-10-26 血的教训）──
 * 起因：删一个 useState（比如 showAtPicker）时漏删了引用它的 onClick ⇒
 *   运行时 ReferenceError ⇒ onChange 整个崩 ⇒ **面板点开关「没反应」**。
 *   而 `node --check` 查不出来（不是语法错误），面板渲染检查也查不出来（那个路径没被点）。
 *   ⇒ 必须静态扫：所有 setXxx( 调用，setXxx 必须在 useState 解构里定义过。
 */
console.log('\n4a-1. 面板状态 setter 引用完整')
try {
  const c = readFileSync(join(here, 'client.js'), 'utf8')
  const defined = new Set()
  for (const m of c.matchAll(/const\s*\[\s*\w+\s*,\s*(set\w+)\s*\]\s*=\s*React\.useState/g)) defined.add(m[1])
  const called = new Set()
  for (const m of c.matchAll(/\b(set[A-Z]\w*)\s*\(/g)) called.add(m[1])
  const IGNORE = new Set(['setTimeout', 'setInterval', 'setAttribute', 'setState', 'setImmediate'])
  const dangling = [...called].filter((x) => !defined.has(x) && !IGNORE.has(x))
  // useState 之外的普通函数（setWinAt 之类）也认：扫 const 声明
  for (const d of dangling) {
    if (!new RegExp(`const\\s+${d}\\s*=`).test(c)) {
      bad(`client.js 里 ${d}(...) 没有定义 —— 面板点它会 ReferenceError（2026-10-26「点了没反应」的真凶）`)
    }
  }
  if (!dangling.some((d) => !new RegExp(`const\\s+${d}\\s*=`).test(c))) {
    ok('面板状态 setter 都有定义（没有会崩的悬空引用）')
  }
} catch (e) { bad(`检查 client.js 状态引用失败：${e.message}`) }

/* ── 4b. 私信「谁发的」判据不能被退回去 ── */
console.log('\n4b. 私信发送方判据')
try {
  const s = readFileSync(join(here, 'tools', 'im-send.mjs'), 'utf8')
  if (/avatar-side/.test(s)) ok('im-send.mjs 用「头像左右」判发送方')
  else bad('im-send.mjs 里没有 avatar-side 判据 —— 回读会退回「分不清谁发的」')
  if (/--read/.test(s)) ok('im-send.mjs 有 --read 只读模式（douyin_im_read 靠它）')
  else bad('im-send.mjs 缺 --read 模式 —— douyin_im_read 会读不到')
  // 曾经的错：拿 message.isMyMessage 当发送方判据 —— 它**恒为 true**，连对方发的也是 true
  if (/mine:\s*!!found\.isMyMessage/.test(s)) bad('im-send.mjs 又把 isMyMessage 当发送方判据了 —— 它恒为 true，不能用')
  else ok('没有退回用 isMyMessage 判发送方')
} catch (e) { bad(`读不了 tools/im-send.mjs：${e.message}`) }

/* ── ⭐ 4b-2. 私信「发给谁」三道闸（2026-10-23 修的三处发错人 bug） ──
 *
 * 起因：这三处全是"工具报成功、实际发错人"的静默错误。
 *   ① already-open 判断用整个 bodyText ⇒ 左侧列表里任何人都在里面，
 *      只要界面开着**任何**一个会话，就会把当前那个人的 id 当成目标返回。
 *      实测：界面开着「枫眠」+ 发给「示例好友」（只给昵称）
 *            ⇒ ok:true, to:"示例好友", to_sec_uid:枫眠的 id。
 *   ② 昵称用 text.includes 匹配 ⇒「大肥鱼」（没有任何人叫这个）命中 3 个人。
 *   ③ 会话项被平移到屏外（left<0）时，点击**毫无反应也不报错**，
 *      然后拿旧会话的 id 去校验 ⇒ 假装切换成功。
 *
 * 这三条只要有一条被改回去，就会重新出现"私信发给陌生人"。
 */
console.log('\n4b-2. 私信「发给谁」三道闸')
try {
  const s = readFileSync(join(here, 'tools', 'im-send.mjs'), 'utf8')

  // ① 不许再用整个页面文本判"已打开"
  //    ⚠️ 断言要看**代码**，别被注释里的同名字样误伤：
  //       所以先剥掉注释，再找真正会被执行的那一句。
  const sCode = s
    .replace(/\/\*[\s\S]*?\*\//g, '')          // 块注释
    .replace(/^[ \t]*\/\/.*$/gm, '')            // 整行行注释
    .replace(/([^:'"`])\/\/[^\n]*/g, '$1')      // 行尾注释（避开 https:// 这类）
  /**
   * 危险写法只有这两种（其余的 includes 是"只给提示、不自动选"的合法用途）：
   *   ① `else if (who && t.includes(who))` —— 用整个 bodyText 判"已打开"
   *   ② `hits = list.filter(c => c.text.includes(who))` —— 把模糊命中直接当收件人
   * 只禁这两种，别一棍子打死（nearMisses 那种提示是故意的）。
   */
  const dangerousBodyText = /who\s*&&\s*t\.includes\(who\)/.test(sCode)
  const dangerousHits = /hits\s*=\s*list\.filter\(\(c\)\s*=>\s*c\.text\.includes\(who\)\)/.test(sCode)
  if (dangerousBodyText) {
    bad('openConversation 又用 bodyText/includes 判断「已经打开」了 —— 会把消息发进当前那个人的会话')
  } else if (dangerousHits) {
    bad('昵称匹配又把 text.includes 的结果直接当收件人了 —— 会认错人')
  } else if (/const cur = await currentWho\(\)/.test(sCode)) {
    ok('「已打开」靠右栏头部精确比对（不再用整个页面文本）')
  } else {
    bad('openConversation 里找不到「右栏头部」判据 —— 没法确认当前会话到底是谁')
  }

  // ② 昵称匹配不许直接把 includes 的结果当成命中
  if (/hits = list\.filter\(\(c\) => c\.text\.includes\(who\)\)\s*\n\s*how =/.test(s)) {
    bad('昵称匹配又用 text.includes 直接命中了 ——「大肥鱼」会匹配到别人')
  } else if (/hits = list\.filter\(\(c\) => c\.nick === who\)/.test(s)) {
    ok('昵称先精确比对（c.nick === who）')
  } else {
    bad('昵称匹配没有精确比对 —— 会认错人')
  }
  if (/near_misses/.test(s)) ok('模糊命中只当提示（near_misses），不自动选')
  else bad('没有 near_misses —— 模糊命中会被当成真命中')

  // ③ 屏外元素必须先弄回可视区
  if (/status: 'offscreen'/.test(s)) ok('会话项在可视区外时明确失败（offscreen），不假装成功')
  else bad("没有 offscreen 状态 —— 点不到也会报成功")
  if (/in_view/.test(s) && /panel:\s*panel/.test(s)) ok('列表项带出 in_view / panel（能分清在主列表还是陌生人列表）')
  else bad('列表项没带 in_view / panel —— 分不清点不点得到')
  if (/StrangerConversationListicon/.test(s)) ok('能自己从「陌生人消息」面板退回主列表')
  else bad('不会切回主列表 —— 使用者那条在屏外时永远发不出去')

  // ④ 打字前最后一道身份核对
  if (/发送前核对失败/.test(s)) ok('真打字之前会再核一次右栏昵称（最后一道闸）')
  else bad('打字前没有身份核对 —— 页面重渲染后会发错人')

  // ⑤ 未读数要带出来（不然"谁找过我"永远是 0）
  if (/unreadCount/.test(s)) ok('listConversations 读 unreadCount（未读数）')
  else bad('没读 unreadCount —— 面板算不出"谁可能有未读"')
} catch (e) { bad(`读不了 tools/im-send.mjs（私信闸）：${e.message}`) }

/* ── 4b-3. 纯 HTTP 读私信（im-http.py，2026-10-24 二版） ──
 *
 * 背景：浏览器读私信冷启动 ~10s，且"谁发的"靠头像左右猜、时间戳恒为 0。
 * 抖音 IM 实际走 imapi.douyin.com 的 protobuf（只要 Cookie，~1s）。
 * 这里守住五件事：
 *   ① im-http.py 必须是**纯只读**（出现发送代码立刻报红）
 *   ② 身份铁闸：sec_uid **当场反查**成数字 uid，与会话 peer_uid **严格相等**才算命中
 *   ③ 🔴 防倒退：**「只有一个会话就拿来用」这类捷径不许回来**
 *      （一版全靠这个捷径在撑，而匹配条件 sec_uid==数字uid 永远不成立 —— 0.3.1 认错人事故同款）
 *   ④ 通道伪装：curl_cffi impersonate（TLS 指纹对齐浏览器，和 notice-read.py 一套）
 *   ⑤ index.js：有 to_id 才走快路径、matched 才算命中；浏览器兜底必须在
 */
console.log('\n4b-3. 纯 HTTP 读私信（im-http.py）')
try {
  const h = readFileSync(join(here, 'tools', 'im-http.py'), 'utf8')

  // ① 只读红线（剥掉注释再查，免得注释里的说明文字自咬尾巴）
  const hCode = h.replace(/#[^\n]*/g, '')
  if (/message\/send|\/v1\/send|sendMsg|publish/i.test(hCode)) {
    bad('im-http.py 里出现了发送代码 —— 它必须只是个只读工具，发私信只走 im-send.mjs')
  } else ok('im-http.py 是纯只读（没有任何发送调用）')
  if (h.includes('--read') && !h.includes('--write') && !h.includes('--send')) ok('入口只认 --read 参数')
  else bad('im-http.py 的参数入口不对')

  // ② 身份铁闸：反查核验
  if (/sec_user_id=/.test(h) && /c\["peer_uid"\] == wanted_uid/.test(h)) ok('sec_uid 当场反查 → uid 严格相等才算命中')
  else bad('身份核验不完整 —— 必须反查 sec_uid 并与 peer_uid 严格比对')

  // ③ 防倒退：单会话捷径必须不存在（剥注释后的真代码里）
  if (/conversations\[0\]|convs\[0\]|length === 1/.test(hCode)) {
    bad('「单会话就拿来用」的捷径还在 —— 那是一版认错人的根因，必须删干净')
  } else ok('没有单会话捷径（验不明就退出，不猜）')
  if (/"type"\] == 1/.test(hCode.replace(/\s/g, '')) || /type.*== 1/.test(hCode)) ok('只认私聊 type=1（群聊不参与按人匹配）')
  else bad('没限定私聊 —— 群聊会话会把消息标错人')

  // ④ 数据质量 + 通道伪装
  if (/毫秒时间戳|field10/.test(h) && /def iso/.test(h)) ok('消息带真实毫秒时间戳（iso()）')
  else bad('没解时间戳 —— HTTP 路径的核心优势没了')
  if (/messages\.sort\(key=lambda/.test(hCode)) ok('消息按时间戳排序（不信线序 —— 小 limit 不会挑到最旧的）')
  else bad('没按时间戳排序 —— 小 limit 会挑到最旧的消息')
  if (/sender == my_uid/.test(hCode)) ok('发送者按协议字段判（uid 比对，不靠头像猜）')
  else bad('没按 uid 判发送者 —— 会退回头像猜的老毛病')
  if (/impersonate="chrome"/.test(hCode)) ok('走 curl_cffi 伪装 Chrome 指纹（不拿裸脚本指纹戳 IM 接口）')
  else bad('没用 curl_cffi impersonate —— TLS 指纹是脚本特征，接口在看请求模式')
  if (/def build_envelope/.test(h)) ok('信封是 build_envelope 自建的（没有第三方常量）')
  else bad('找不到 build_envelope —— 信封构造没了')
  if (/CK0CEKZOGg|_ENVELOPE_B64\s*=\s*"A-Za-z0-9/.test(h)) {
    bad('im-http.py 里抄了第三方 base64 信封常量 —— 要自己构造（别人的信封里嵌着他们自己的会话 ID）')
  }

  // ⑤ index.js 双路径 + 命中条件
  const idx = readFileSync(join(here, 'index.js'), 'utf8')
  if (/im-http\.py/.test(idx)) ok('douyin_im_read 先走 HTTP 快路径（im-http.py）')
  else bad('index.js 没接 im-http.py —— 快路径丢了')
  if (/if \(toId\)/.test(idx.slice(idx.indexOf('douyin_im_read'), idx.indexOf('douyin_im_read') + 4000))) {
    ok('有 to_id（sec_uid）才走快路径 —— 不给 sec_uid 不白付 HTTP 往返')
  } else bad('快路径没有 to_id 前置条件 —— 读陌生人会白付一次往返')
  if (/http\.matched/.test(idx)) ok('命中只认 matched（反查核验通过的那个），不认别的')
  else bad('没有 matched 判定 —— 身份铁闸没接上')
  if (/im-send\.mjs/.test(idx) && /陌生人/.test(idx.slice(idx.indexOf('douyin_im_read'), idx.indexOf('douyin_im_read') + 4000))) {
    ok('读不到时退回浏览器路径（陌生人消息只有那条路能读）')
  } else bad('没有浏览器兜底 —— 陌生人的私信会读不到')
  if (/via:\s*'http'/.test(idx)) ok('返回里带 via 标明走的哪条路')
  else bad('没有 via 字段 —— 分不清这次读走的是哪条路')
  if (/im-http\.mjs/.test(idx)) bad('index.js 还在调 im-http.mjs —— 旧文件已删，这是死引用')
} catch (e) { bad(`读不了 tools/im-http.py：${e.message}`) }

/* ── 4c. 「先卡片，后文字」这条规矩不能被改回去 ── */
console.log('\n4c. 发送顺序规矩（先卡片，后文字）')
try {
  const idx = readFileSync(join(here, 'index.js'), 'utf8')
  if (/orderWarning/.test(idx)) ok('index.js 有顺序哨兵 orderWarning')
  else bad('index.js 里没有 orderWarning —— 「刚发过文字又发卡片」不会有人提醒了')
  if (/先卡片，后文字/.test(idx)) ok('工具说明里写明了「先卡片，后文字」')
  else bad('douyin_dm / douyin_share_card 的说明里没有这条规矩 —— 模型会先发文字')
  if (/reason_delay_sec/.test(idx)) ok('share_card 支持 reason + reason_delay_sec（卡片后自动补理由）')
  else bad('share_card 丢了 reason 参数 —— 只能发一张光秃秃的卡片')
  const charter = readFileSync(join(here, 'prompts', 'duty.md'), 'utf8')
  if (/先卡片，后文字/.test(charter)) ok('章程 prompts/duty.md 里写明了这条规矩')
  else bad('章程里没写「先卡片，后文字」—— 每轮都会忘')
} catch (e) { bad(`读不了规矩相关文件：${e.message}`) }

/* ── 4d. 人设分家：不许串门 ── */
console.log('\n4d. 人设分家')
try {
  const idx = readFileSync(join(here, 'index.js'), 'utf8')
  if (/persona:/.test(idx) && /personaWarn/.test(idx)) {
    ok('runDuty 会校验人设文件第一行的 persona 标记')
  } else bad('index.js 里没有 persona 标记校验 —— 任何一份 AGENTS.md 都会被当成人设照抄')
  // ⭐ 三层人设：使用者自己那份 > 插件自带 > 默认中性
  const layers = ['join(stateDir, \'persona.md\')', 'prompts\', \'persona.md', 'persona.default.md']
  const missing = layers.filter((k) => !idx.includes(k.replace(/\\/g, '')))
  if (!missing.length) ok('人设三层齐全（使用者自己 / 插件自带 / 默认中性）')
  else bad(`人设层缺失：${missing.join('、')}`)
  if (/personaFrom/.test(idx)) ok('会记录本轮用的是哪一层人设')
  else warn('没记录人设来源，出问题不好查')
  /**
   * ⭐⭐ 4d-2. **人设文件要有可落地的东西，不能只有空话**
   *
   * 🔴 事故（2026-10-23）：人设里只有「软一点」「别腻」这种形容词，
   *    结果写出来的回复全是客服工单腔。光有形容词不够 ——
   *    必须有**正反对照**（什么样算坏、什么样算好），模型才学得会。
   *
   * ⚠️ 这一节检查的是**结构**，不检查具体风格：
   *    每个使用者可以喜欢完全不同的话术，插件不该规定"该可爱还是该专业"。
   *    所以这里只守三件事：有具体例子、有收敛边界、称呼边界清楚。
   */
  console.log('\n4d-2. 人设文件的结构（例子 / 边界 / 称呼）')
  // ⚠️ 下面几段都要用到章程内容，先读出来（原来定义在后面，前面用会 TDZ 报错）
  const charter2 = readFileSync(join(here, 'prompts', 'duty.md'), 'utf8')
  /**
   * 🔴 2026-10-30 修：这里必须和 `runDuty` 用**同一套三层解析**。
   *
   * 原来只认 `prompts/persona.md`，读不到就整段退到 `persona.default.md` 上做断言 ——
   * 可 default 是**中性默认**，设计上就不带 ❌/✅ 正反对照、不带称呼边界，
   * 于是「这台机器还没配过自己的人设」被报成了「人设写坏了」。
   * 而 `git clone` 下来的人 100% 都是这个状态，README 却写着「全部通过再装」——
   * 干净克隆上那句话**永远不可能成立**，使用者照文档走第一步就卡住。
   *
   * 现在的口径：有自己那份（①`$DOUYIN_HOME/persona.md` ②`prompts/persona.md`）
   * 才查结构；一份都没有 = 正常状态（首次使用），明说"走中性默认"，不判失败。
   * ⚠️ 中性默认的身份牌不在这里守，它在 4d-5（`persona: default`）。
   */
  const minePath = (() => { try { return join(homeDir({ create: false }), 'persona.md') } catch { return '' } })()
  const ownPersona = [
    minePath && existsSync(minePath) ? { file: minePath, from: '你自己那份（$DOUYIN_HOME/persona.md）' } : null,
    existsSync(join(here, 'prompts', 'persona.md')) ? { file: join(here, 'prompts', 'persona.md'), from: '插件自带（prompts/persona.md）' } : null,
  ].filter(Boolean)[0] || null
  const personaDefault = readIf(join(here, 'prompts', 'persona.default.md'))
  // 「实际生效的那份」：有自己那份就用它，否则是中性默认
  const activePersona = ownPersona ? readIf(ownPersona.file) : personaDefault
  if (!ownPersona) {
    if (personaDefault.trim()) ok('本机还没配自己的人设 —— 会落到中性默认 persona.default.md（干净安装就是这个状态，不算失败）')
    else bad('既没有自己那份人设，也没有 persona.default.md —— 装上等于没有人设')
    warn('还没配人设 ⇒ 跳过三条结构检查（正反对照 / 何时收着 / 称呼边界）；写了自己那份才会查')
  } else {
    // ① 必须有正反对照表（❌ 什么样 / ✅ 什么样），光有形容词没用
    if (/正反|❌[^\n]*✅|\|\s*❌/.test(activePersona)) {
      ok('人设里有正反对照（❌ 反例 / ✅ 正例）—— 比抽象形容词管用')
    } else bad('人设只有抽象形容词（"软一点""别腻"）—— 模型学不会，写出来还是模板腔')
    // ② 必须有"什么时候该收着"的边界，否则会一直卖弄
    if (/该收的时候收|收敛|不许.*稀释|别腻/.test(activePersona)) {
      ok('人设写明了什么时候该收着（讲风险 / 等结果时不许卖弄）')
    } else bad('人设只有风格没有收敛 —— 讲红线、风险时也在耍宝就废了')
    // ③ 称呼边界：有个"只能叫某一个人"的概念（不管具体叫法）
    if (/只能叫|只属于|不许乱叫|只对.*一个/.test(activePersona)) {
      ok('人设写明了称呼边界（某种称呼只能对一个人用）')
    } else bad('人设没说称呼边界 —— 会对着路人乱叫')
  }
  /**
   * ⭐⭐ 4d-2b. **章程与私人口吻的隔离**
   *
   * 🔴 事故（2026-10-23）：章程 `duty.md` 是**随包发布**的，
   *    但里面被写进了带表情符号、具体自称的口吻示范 ⇒ 等于把某一套私人说话方式
   *    强加给所有使用者。
   *    所以自检要守两件事：章程里不许有具体口吻；章程里必须写明"口吻看人设"。
   */
  if (/口吻|语气/.test(charter2) && /persona\.md/.test(charter2)) {
    ok('章程里写明了「口吻看本轮 persona.md」（不是写死在章程里）')
  } else bad('章程没写"口吻来自人设" —— 模型会照着章程里的例子编，而章程是公开的')
  // 公开评论的三条通用边界（这些是"手段"不是"风格"，该写死）
  if (/不当评委/.test(charter2) || /不点评/.test(charter2)) {
    ok('章程写明公开评论「不当评委」（只补有用信息或具体认可）')
  } else bad('章程没说"不当评委" —— 会去点评别人的视频水平')

  /**
   * ⭐⭐ 4d-4. **push 前必须显式授权**（2026-10-23）
   *
   * 起因：曾经一天发了 7 个版本号，其中好几个对使用者毫无变化。
   * 规矩改成：**推送到公开仓库前必须显式授权**，靠 git hook 硬拦，不靠自觉。
   *
   * 🔴 光写进文档不算数（文档会忘）。要守三样：文档写、hook 在、hook 真生效。
   */
  console.log('\n4d-4. push 前必须显式授权')
  const prePush = join(here, '.githooks', 'pre-push')
  if (existsSync(prePush)) {
    const pp = readFileSync(prePush, 'utf8')
    if (/DOUYIN_PUSH_OK/.test(pp) && /exit 1/.test(pp)) ok('pre-push hook 存在且默认拒绝推送（要显式授权才放行）')
    else bad('pre-push hook 存在但没拦住 —— 形同虚设')
  } else bad('没有 .githooks/pre-push —— 只在文档里写"不许推"，会忘')
  // hook 必须真的挂上（core.hooksPath 指对地方），否则文件在也不生效
  /**
   * 🔴 2026-10-30 修：`core.hooksPath` 是**本地配置**，`git clone` 不会带过来 ——
   * 所以每个新克隆读到的都是空串，原来这里直接判 ❌，「干净克隆全过」永远不成立。
   * 这一项的意图是「hook 真生效」而不是「文件存在」，那就把它挂上（`--local`，可逆，不联网）。
   * ⚠️ 只在**本目录就是仓库根**时动手：否则 `--local` 会写进外层仓库的 config。
   */
  try {
    const git = (args) => spawnSync('git', args, { cwd: here, encoding: 'utf8', timeout: 15_000 })
    const top = String(git(['rev-parse', '--show-toplevel']).stdout || '').trim()
    const isRepoRoot = top && resolve(top) === resolve(here)
    const hp = String(git(['config', 'core.hooksPath']).stdout || '').trim()
    if (hp === '.githooks') {
      ok('core.hooksPath 指向 .githooks（hook 真的生效）')
    } else if (!hp && isRepoRoot && existsSync(prePush)) {
      const r = git(['config', '--local', 'core.hooksPath', '.githooks'])
      const after = String(git(['config', 'core.hooksPath']).stdout || '').trim()
      if (r.status === 0 && after === '.githooks') ok('core.hooksPath 原来空着，已顺手设为 .githooks（新克隆不会自动带，这次挂上）')
      else bad('core.hooksPath 挂不上 —— pre-push 拦不住推送')
    } else if (!hp) {
      warn('core.hooksPath 空着，且这里不是 git 仓库根（下载的 zip / 解压包）—— pre-push 拦不住推送')
    } else {
      bad(`core.hooksPath 是 "${hp}" 不是 .githooks —— hook 装了也不跑`)
    }
  } catch { warn('读不到 core.hooksPath（可能不是 git 仓库，或没装 git）') }
  // 文档里要写清版本号怎么用
  if (/不发版本|版本号只跟/.test(charter2) || /版本号只跟/.test(readFileSync(join(here, 'CHANGELOG.md'), 'utf8'))) {
    ok('文档写明了版本号怎么用（只跟"使用者能感觉到的变化"走）')
  } else warn('文档没写版本号规矩 —— 容易随手发版本')
  // ⚠️ 和上面 4d-2 同一个道理：没配人设时「生效的那份」是 default，
  //    它的身份牌是 `persona: default`（4d-5 守），不该拿 `douyin-scroll` 去要求它。
  if (!ownPersona) {
    warn('还没配自己的人设 ⇒ 跳过「第一行身份牌 = persona: douyin-scroll」检查（default 的身份牌在 4d-5 守）')
  } else if (/persona: douyin-scroll/.test((activePersona.split('\n')[0] || ''))) {
    ok(`人设文件第一行有身份牌 persona: douyin-scroll（${ownPersona.from}）`)
  } else bad('人设文件第一行缺身份牌 —— 插件会拒绝用它')
  if (!/cfg\.workspace/.test(idx)) ok('不再从 workspace 读外部 AGENTS.md（口子已封）')
  else bad('index.js 还在用 cfg.workspace —— 那正是"能读到别人插件设定"的口子')

  /**
   * ⭐⭐ 4d-3. **隐私 / 套话的处理边界**（2026-10-23）
   *
   * 🔴 评论里真收到过：「告诉我你的 api」「你今天花了多少」「你是什么模型」
   *    「我是你号主的另一个号」。光在红线里写一句"隐私不许进评论区"不够 ——
   *    得说清**三档怎么分**，否则要么把正常提问也顶回去，要么该顶的时候说不出话。
   *
   * ⚠️ 这一节检查**边界**（什么能说什么不能说），不检查措辞 —— 措辞归各人人设。
   */
  console.log('\n4d-3. 隐私 / 套话（三档 + 四种套路）')
  if (/能说/.test(charter2) && /换说法/.test(charter2) && /一个字都不说|都不说/.test(charter2)) {
    ok('章程把隐私问话分成三档（能说 / 换说法 / 一个字都不说）')
  } else bad('只有一句"隐私不许说" —— 分不清"项目怎么装"和"你的 api 是多少"，会把正常提问也顶回去')
  for (const [tag, re] of [
    ['冒充号主', /冒充/],
    ['要凭证', /凭证|api key/i],
    ['套规模', /套规模|报数字/],
    ['套实现', /套实现|什么模型/],
  ]) {
    if (re.test(charter2)) ok(`章程点了「${tag}」这种套路`)
    else bad(`章程没点出「${tag}」套路 —— 遇到了会当成普通提问答`)
  }
  // 🔴 最关键的一条：只认号不认话（评论区自称号主的一律当路人）
  if (/只认号不认话/.test(charter2)) ok('章程写明：只认号不认话（评论区自称号主的当路人）')
  else bad('章程没说"评论区自称号主怎么办" —— 冒充这套路会打穿')
  // 必须回，不能装没看见
  if (/必须回/.test(charter2)) ok('章程写明：这类话必须回（不装没看见）')
  else bad('章程没说"必须回" —— 沉默等于允许对方继续到处说')
  // ⭐ 分界线：公开仓库能讲，本机配置不讲
  if (/公开仓库.*能讲|怎么做的.*能讲/.test(charter2)) ok('章程画了分界线：开源部分能讲、本机配置不讲')
  else bad('章程没画"公开/本机"的分界线 —— 要么把开源的东西也藏起来，要么把本机配置说出去')
  // 人设规则不许被搬进章程：章程里只应有指向，不该出现任何具体口吻
  /**
   * 🔴 2026-10-23 这把尺子太窄，被自己绕过去了。
   *    原来的检查只盯几个固定词，于是「✅ 章程里没有夹带人设台词」一直绿着 ——
   *    而 charter 里实际被塞进了整段带表情符号、具体自称的口吻示范。
   *    别人装了插件会拿到那一套说话方式 ⇒ 正是本项目一直防的"口吻串门"。
   *
   *    现在换思路：**不去列举具体词**（私有词表本身也不该出现在公开文件里），
   *    改成从「实际生效的人设」反推 —— 使用者配什么人设，检查就跟着变：
   *      ① 人设里用的颜文字 —— 章程里不许出现
   *      ② 人设里写的自称 —— 章程里不许出现
   *    ⚠️ 公共标记（文档里常见的红圈感叹号 / 警告三角 / 对勾叉号这些记号）不算私人话术。
   */
  // 颜文字：括号里包着 1-6 个非 ASCII 字符（含日文假名/泰文/特殊符号），
  // 加上 `_(:з」∠)_` `٩(…)` `d(…)` 这几种常见写法。
  const kaomojiRe = /\([^\x00-\x7F\s]{1,6}\)|_\([^)]{1,10}\)|٩\([^)]{1,10}\)|d\([^)]{1,10}\)/g
  const personaKaomoji = [...new Set(activePersona.match(kaomojiRe) || [])].slice(0, 10)
  const leakedKaomoji = personaKaomoji.filter((k) => charter2.includes(k))
  if (!leakedKaomoji.length) {
    ok(`章程里没有人设用的颜文字（人设里那 ${personaKaomoji.length} 个，章程里一个都没有）`)
  } else {
    bad(`章程里出现了人设专用的颜文字（${leakedKaomoji.length} 个）`
      + ' —— duty.md 会随包发布，别人装了就拿到这一套说话方式。口吻只能住 persona.md')
  }
  // 反查自称：只认人设里"我叫X / 叫我X"这种明确句（"自称"后面常跟的是通用词，容易误抓）
  const selfNames = []
  for (const m of activePersona.matchAll(/(?:叫我|我叫|我就是)[「"'：:]?\s*([\u4e00-\u9fa5A-Za-z]{2,6})/g)) {
    if (m[1]) selfNames.push(m[1])
  }
  // ⚠️ 排除通用词：这些是技术词/常识词，出现在任何文档里都正常，不算"自称"
  const COMMON = new Set(['模型', '助手', '系统', '程序', '智能体', '机器人', '工具', '插件', '服务'])
  const uniqSelf = [...new Set(selfNames)].filter((n) => !COMMON.has(n)).slice(0, 6)
  const leakedSelf = uniqSelf.filter((n) => n && charter2.includes(n))
  if (!leakedSelf.length) ok('章程里没有人设用的具体自称')
  else bad(`章程里出现了人设专用自称（${leakedSelf.length} 个）—— 那属于 persona.md，不该随包发布`)
  // 章程里必须明确写"语气来自人设"，否则模型会自己编一套
  if (/语气.*(来自|按).*人设|口吻.*(来自|看).*persona\.md/.test(charter2)) {
    ok('章程写明了「口吻看本轮 persona.md」（不是写死在章程里）')
  } else bad('章程没写"口吻来自人设" —— 模型会照着章程里的例子编，而章程是公开的')
  // 🔴 硬隔离：抖音的代码里不许出现刷B站的**家目录 / 人设目录**路径。
  //    ⚠️ 出处注释（"抄 dsh-bili-scroll 的约定"）是允许的 —— 那是记账，不是耦合。
  const codeFiles = ['client.js',
    ...readdirSync(join(here, 'lib')).filter((x) => x.endsWith('.mjs')).map((x) => join('lib', x)),
    ...readdirSync(join(here, 'tools')).filter((x) => /\.(mjs|js|py)$/.test(x)).map((x) => join('tools', x))]
  const hits = codeFiles.filter((f) => /bili[-_](duty|persona)/i.test(readFileSync(join(here, f), 'utf8')))
  if (hits.length) bad(`抖音的代码里出现了刷B站的家目录/人设路径：${hits.join(', ')}`)
  else ok(`代码里没有刷B站的家目录/人设路径（查了 ${codeFiles.length} 个文件）`)
  const pf = join(here, 'prompts', 'persona.default.md')
  if (existsSync(pf) && /^<!-- persona: default -->/.test(readFileSync(pf, 'utf8').trimStart())) {
    ok('默认人设 prompts/persona.default.md 带身份牌 persona: default')
  } else bad('默认人设缺身份牌 —— 发布包必须自带一份中性人设，否则普通用户装了什么都没有')
  // 🔴 发布边界：`prompts/persona.md` 只是本机的私有配置，**绝不能进仓库、也不能进发布包**。
  //    ⚠️ 2026-10-22：这一项只在**开发者仓库**里成立（靠 .gitignore 拦）。
  //    从 npm 装下来的包**没有 .gitignore** —— 那时应该检查的是
  //    "包里到底有没有那个文件"，不能因为缺 .gitignore 就判失败。
  const giFile = join(here, '.gitignore')
  if (existsSync(giFile)) {
    const gi = readFileSync(giFile, 'utf8')
    if (/^prompts\/persona\.md$/m.test(gi)) ok('.gitignore 排除了 prompts/persona.md（本地私有配置，不随仓库发布）')
    else bad('.gitignore 没排除 prompts/persona.md —— 那份本地配置会被推到公开仓库')
  } else {
    // 发布包形态：直接看包里有没有这个文件（有就是事故）
    const localPersona = join(here, 'prompts', 'persona.md')
    if (!existsSync(localPersona)) ok('发布包里没有 prompts/persona.md（只有 persona.default.md）')
    else bad('发布包里带了 prompts/persona.md —— 必须删掉')
  }
} catch (e) { bad(`人设分家检查失败：${e.message}`) }

/* ── 4f. 自定义时段 ──
 * ⚠️ 2026-10-22：自定义时段的**界面**在"面板重写"时被砍掉了（那一版为了救回面板，
 *    只保留 4 个卡片）。后端（schema / normalize / tick）还在，随时能加回。
 *    所以这里只检查**后端**不会退化；UI 部分改成 warn，不判失败。
 */
console.log('\n4f. 自定义时段（后端）')
try {
  const idx = readFileSync(join(here, 'index.js'), 'utf8')
  const cl = readFileSync(join(here, 'client.js'), 'utf8')
  // schema 里要有 windows 字段
  if (/windows:\s*z\.array\(z\.object/.test(idx)) ok('Config 有 windows 字段（对象数组）')
  else bad('Config 缺 windows —— 自定义时段存不进去')
  // 🔴 schemastery 兼容性：这个版本的字符串没有 .optional()，写了会让整个 index.js import 失败
  //    （2026-10-22 事故：一个 .optional() 让 fiberPhase 恒为 null，面板和工具全消失）
  const codeOnly = idx.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  if (!/\.optional\(\)/.test(codeOnly)) ok('没有用 .optional()（这个 schemastery 版本不支持）')
  else bad('代码里用了 .optional() —— 这个 schemastery 版本没有这个方法，index.js 会 import 失败、插件整个不加载')
  // normalize 必须按字段名判断，不能靠"数组里有元素"
  if (/OBJECT_ARRAYS/.test(idx) && /windows/.test(idx)) ok('normalize 用白名单保住对象数组（空数组也不会吃）')
  else bad('normalize 还在靠 base[k].length 判断 —— 空 DEFAULT 会把对象数组吃光')
  // tick 必须把自定义时段并进去
  if (/custom:\$\{i\}/.test(idx) && /cfg\.windows/.test(idx)) ok('定时器会把自定义时段拼进候选窗口')
  else bad('定时器没读 cfg.windows —— 配了也不跑')
  // ⚠️ 总开关 peakValley 不许再拦截（UI 已经没有它了）
  const hasPeakGate = /^\s*if \(!cfg\.peakValley\) return\s*$/m.test(idx)
  if (!hasPeakGate) ok('没有 peakValley 总闸拦截（UI 已无此开关，拦了就是死锁）')
  else bad('tick 里还有 `if (!cfg.peakValley) return` —— 设置页没有这个开关，用户配了也不会跑')
  // UI 还没做回来 —— 只提示，不算失败
  if (/\+ 加一个时段/.test(cl)) ok('设置页有自定义时段入口')
  else warn('设置页暂时没有自定义时段入口（后端已就绪，加回来只是一个卡片的事）')
} catch (e) { bad(`自定义时段检查失败：${e.message}`) }

/* ── 4g. 给别的 AI 用（MCP server） ── */
console.log('\n4g. 给别的 AI 用')
try {
  const mcpFile = join(here, 'tools', 'mcp-server.mjs')
  const mcp = existsSync(mcpFile) ? readFileSync(mcpFile, 'utf8') : ''
  if (!mcp) bad('缺 tools/mcp-server.mjs —— 别的 agent 工具接不进来')
  else {
    // ① 必须零依赖：只许 import node: 内置模块 + 相对路径
    const imports = [...mcp.matchAll(/^import .*?from '([^']+)'/gm)].map((m) => m[1])
    const external = imports.filter((s) => !s.startsWith('node:') && !s.startsWith('.'))
    if (external.length) bad(`mcp-server.mjs 引入了外部依赖：${external.join(', ')} —— 这个包没有 node_modules，会直接崩`)
    else ok(`mcp-server.mjs 零依赖（${imports.length} 个 import 全是 node: / 相对路径）`)
    // ② stdout 只能出 JSON-RPC
    if (/console\.log/.test(mcp.replace(/--selftest[\s\S]*$/, ''))) {
      bad('mcp-server.mjs 正文里用了 console.log —— 会污染 JSON-RPC 的 stdout，客户端会崩')
    } else ok('mcp-server.mjs 正文不往 stdout 打日志（只走 stderr）')
    // ③ 真跑一遍协议握手
    const st = spawnSync(process.execPath, [mcpFile, '--selftest'], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, PYTHONUTF8: '1' },
    })
    const out = String(st.stdout || '')
    if (st.status === 0 && /#1 initialize -> ok/.test(out) && /#2 tools\/list -> \d+ tools/.test(out)) {
      const n = (out.match(/#2 tools\/list -> (\d+) tools/) || [])[1]
      ok(`mcp-server.mjs 自测通过（initialize + tools/list，${n} 个工具）`)
    } else bad(`mcp-server.mjs 自测失败：${(out || st.stderr || '').split('\n').slice(0, 3).join(' ')}`)
    // ④ 会发东西的工具必须有 confirm 闸
    const sendTools = ['douyin_share_card', 'douyin_dm', 'douyin_comment_reply']
    const missing = sendTools.filter((t) => {
      const i = mcp.indexOf(`name: '${t}'`)
      if (i < 0) return true
      const seg = mcp.slice(i, i + 2500)
      return !/confirm: \{ type: 'boolean'/.test(seg) || !/args\?\.confirm !== true/.test(seg)
    })
    if (missing.length) bad(`这些 MCP 工具没有 confirm 闸：${missing.join(', ')}`)
    else ok(`${sendTools.length} 个会发东西的 MCP 工具都带 confirm 闸`)
    // ⑤ @ 我 / 记忆 这两个能力也要在 MCP 里有
    if (/name: 'douyin_at_me'/.test(mcp)) ok('MCP 有 douyin_at_me（谁 @ 了我）')
    else bad('MCP 缺 douyin_at_me')
    if (/context|记忆/.test(mcp)) ok('MCP 文档提到记忆上下文')
    else bad('MCP 没提记忆 —— 别的 AI 不会用上下文')
  }
  // ⑤ 使用说明必须存在，且写清「先卡片后文字」
  const doc = join(here, 'AI-USAGE.md')
  if (existsSync(doc)) {
    const d = readFileSync(doc, 'utf8')
    if (/先卡片，后文字/.test(d)) ok('AI-USAGE.md 写明了「先卡片，后文字」')
    else bad('AI-USAGE.md 没写「先卡片，后文字」—— 别的 AI 会按错的顺序发')
    if (/confirm: true/.test(d) || /confirm:true/.test(d)) ok('AI-USAGE.md 写明了 confirm 闸')
    else bad('AI-USAGE.md 没写 confirm 闸 —— 别的 AI 会直接发')
    if (/不读画面|ASR/.test(d)) ok('AI-USAGE.md 写明了「看不到画面」')
    else bad('AI-USAGE.md 没写「看不到画面」—— 别的 AI 会以为它能看视频')
  } else bad('缺 AI-USAGE.md —— 别的 AI 不知道怎么用')
} catch (e) { bad(`MCP / 使用说明检查失败：${e.message}`) }

/* ── 4h. 检查更新 ── */
console.log('\n4h. 检查更新')
try {
  const idx = readFileSync(join(here, 'index.js'), 'utf8')
  const cl = readFileSync(join(here, 'client.js'), 'utf8')
  if (/updateUrl:\s*z\.string\(\)/.test(idx)) ok('Config 有 updateUrl（可以指定自己的更新源）')
  else bad('Config 缺 updateUrl')
  if (/const checkUpdate\s*=/.test(idx) && /registry\.npmjs\.org/.test(idx)) ok('检查更新会查 npm registry')
  else bad('检查更新没有 npm 来源')
  if (/repoSlug/.test(idx) && /raw\.githubusercontent\.com/.test(idx)) ok('有 GitHub 来源（从 package.json 的 repository 推出来）')
  else bad('没有 GitHub 来源 —— 只发 GitHub 不验证 npm 的包永远查不到')
  // 🔴 只查不装：绝不能自动升级（改使用者的 profile 是他的机器）
  //    判据看**行为**：checkUpdate 那段里不许出现任何会去执行 `plugin add` 的调用。
  const updSeg = (() => {
    const i = idx.indexOf('const checkUpdate')
    return i < 0 ? '' : idx.slice(i, i + 3500)
  })()
  const installsItself = /spawn(Sync)?\([^)]*'plugin'/.test(updSeg)
    || /runNodeTool\('install\.mjs'/.test(updSeg)
    || /execSync\(/.test(updSeg)
  if (installsItself) bad('checkUpdate 里出现了会真去装包的调用 —— 检查更新只许"告诉有没有"，不许自己动')
  else ok('检查更新只查不装（不自动改 profile）')
  if (/\/update/.test(cl) && /检查更新/.test(cl)) ok('设置页有「检查更新」按钮')
  else bad('设置页没有检查更新入口')
} catch (e) { bad(`检查更新检查失败：${e.message}`) }

/* ── 4i. 设置页「给别的 AI 用」 ── */
console.log('\n4i. 设置页的 AI 接入块')
try {
  const cl = readFileSync(join(here, 'client.js'), 'utf8')
  if (/给别的 AI 用/.test(cl)) ok('设置页有「给别的 AI 用」卡片')
  else bad('设置页没有「给别的 AI 用」卡片')
  if (/\/ai-usage/.test(cl)) ok('卡片会调 /ai-usage 拿配置和说明')
  else bad('卡片没接 /ai-usage')
  if (/copy\(/.test(cl) && /clipboard/.test(cl)) ok('有复制按钮（clipboard + execCommand 兜底）')
  else bad('没有复制按钮 —— 让人手抄路径不现实')
} catch (e) { bad(`AI 接入块检查失败：${e.message}`) }

/* ── 4j. 设置页真的能渲染出来 ──
 * 🔴 2026-10-22 教训：`node --check` 只查语法。面板整块消失的原因是**渲染/加载时抛错**，
 *    语法完全合法。这一段用极小 React 替身把 Panel 真跑一遍 —— 白屏会在推之前被抓住。
 *    ⭐ 而且它同时验证**新手流程**：没登录时看到什么、点「扫码登录」出什么、
 *      点「从我的会话里选」能不能列出人。
 * ⭐ 2026-10-25 面板重排：20+ 张卡 → 3 组 / 7 张卡。这里补两条**源码级**守卫：
 *    ① 三个组标题（常开必看 / 出问题才看 / 一次配好）必须在，且组标题用 data-dy-group
 *       （不是 data-dy-card —— 否则卡片计数就不止 7）
 *    ② 两个折叠组的状态必须初始 false（默认收起），且必须放在**条件 return 之前**
 *       （hook 顺序稳定，不许挪进 if 分支里）
 *    渲染层面的"7 张卡 / 默认收起 / 点开才看得见"由 panel-render-check.mjs 实测。
 */
console.log('\n4j. 设置页渲染 + 新手流程')
try {
  const r = spawnSync(process.execPath, [join(here, 'tools', 'panel-render-check.mjs')], {
    encoding: 'utf8', timeout: 120_000,
  })
  // ⭐ 2026-10-24 起检查脚本以 process.exit 收尾（组件里的轮询定时器会挂住进程）——
  //    输出里「桌宠」段失败也会走非零退出，这里照旧归到 4j 的红项。
  if (r.status === 0) {
    const n = (String(r.stdout || '').match(/元素树 (\d+) 个节点/) || [])[1]
    ok(`设置页能渲染（${n || '?'} 个节点，所有卡片都在）`)
  } else {
    const why = String(r.stdout || r.stderr || '').split('\n').filter((l) => l.includes('❌')).slice(0, 3).join(' ')
    bad(`设置页渲染失败：${why || String(r.stderr || '').slice(0, 200)}`)
  }

  /* ── 4j-1. 面板三组结构（源码级守卫，2026-10-25） ── */
  const cl = readFileSync(join(here, 'client.js'), 'utf8')
  for (const name of ['常开必看', '出问题才看', '一次配好']) {
    if (cl.includes(`'${name}'`)) ok(`面板有组标题「${name}」`)
    else bad(`面板缺组标题「${name}」—— 三组结构被打散了`)
  }
  // 组标题必须用 data-dy-group，不能占 data-dy-card（否则卡片计数不准）
  if (/h\('div', \{ 'data-dy-group': '' \}/.test(cl) && /'data-dy-groupname'/.test(cl)) {
    ok('组标题用 data-dy-group + data-dy-groupname（不占 data-dy-card，卡片计数才对）')
  } else bad('组标题没有用 data-dy-group —— 卡片数会算错')
  // 两个折叠组的状态默认 false（收起）
  if (/const \[foldErr, setFoldErr\] = React\.useState\(false\)/.test(cl)) ok('「出问题才看」默认收起（foldErr 初始 false）')
  else bad('「出问题才看」默认不是收起的 —— 面板会一上来就摊开')
  if (/const \[foldCfg, setFoldCfg\] = React\.useState\(false\)/.test(cl)) ok('「一次配好」默认收起（foldCfg 初始 false）')
  else bad('「一次配好」默认不是收起的')
  // hook 顺序：折叠状态必须在 `if (!st || !cfg)` 那个提前 return **之前**声明
  {
    const iFold = cl.indexOf('const [foldErr, setFoldErr]')
    const iBail = cl.indexOf('if (!st || !cfg) {')
    if (iFold > 0 && iBail > 0 && iFold < iBail) {
      ok('折叠状态声明在「读设置中…」提前 return 之前（hook 顺序稳定，不会白屏）')
    } else bad(`折叠状态的 useState 放错位置（foldErr@${iFold} return@${iBail}）—— 必须在提前 return 之前`)
  }
  // 二维码登录（新手必经）必须在「常开必看」里、默认就看得到
  if (cl.indexOf("'开始使用'") < cl.indexOf("'出问题才看'")) {
    ok('「开始使用」（含扫码登录）在「出问题才看」之前 ⇒ 属于常开必看，默认展开')
  } else bad('「开始使用」被排到折叠组后面了 —— 新手看不到扫码登录')
} catch (e) { bad(`渲染检查跑不起来：${e.message}`) }

/* ── 4j-2. 桌宠对话投递：宁可拒绝，也不许把主人的会话写坏 ──
 * 🔴🔴 2026-10-25 血的教训（两次，都是"写完当场毫无反应，下次开会话才炸"）：
 *   ① 手写 user/message 漏了 `source`
 *      ⇒ "format v4 message requires a producer-owned source kind"
 *   ② 补了 source 又漏了 `id`
 *      ⇒ 41 条无 id 消息 ⇒ 再打开会话就 "session event at seq 40214 lacks an
 *         identified message"，4 万条会话整个读不开（主人真的踩到了）
 *   ③ 直接 append 还会插在 tool-call 与 tool-result 中间 ⇒ 每轮 400
 *   现在改走 agent.followup()（由 agent 循环在正确边界落盘），并由
 *   tools/pet-relay-test.mjs 用 DSH 自己的 adoptSessionEvent 验收消息格式。
 */
console.log('\n4j-2. 桌宠对话投递（不许写坏会话）')
try {
  const r = spawnSync(process.execPath, [join(here, 'tools', 'pet-relay-test.mjs')], {
    encoding: 'utf8', timeout: 60_000,
  })
  const out = String(r.stdout || '')
  const line = out.split('\n').filter((l) => l.includes('结果：')).pop() || ''
  if (r.status === 0) ok(`投递链路安全（${line.replace('结果：', '').replace('✓', '').trim() || '全过'}）`)
  else {
    const why = out.split('\n').filter((l) => l.includes('❌')).slice(0, 3).join(' ')
    bad(`投递链路有问题：${why || String(r.stderr || '').slice(0, 200)}`)
  }
  const idx = readFileSync(join(here, 'index.js'), 'utf8')
  // ⚠️ 只看**代码**，不看注释 —— 我习惯在注释里贴旧代码当证据，
  //    直接正则整文件会把证据当成"还在用"，误报过一次。
  const idxCode = idx.split('\n')
    .filter((l) => {
      const t = l.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')
  if (/append\(\s*['"]user\/message['"]/.test(idxCode)) bad('index.js 还在直接 append user/message —— 这条路上次把会话写死了，改用 agent.followup()')
  else ok('index.js 不再自己往会话日志塞消息（走 agent.followup）')
  if (/deliverToSession/.test(idxCode)) ok('index.js 用的是 lib/pet-relay.mjs 的 deliverToSession')
  else bad('index.js 没接 pet-relay 的投递实现')
  let covered = 0
  const relay = readFileSync(join(here, 'lib', 'pet-relay.mjs'), 'utf8')
  for (const f of ['id', 'role', 'source', 'content']) if (new RegExp(`'${f}'`).test(relay)) covered++
  if (covered === 4) ok('投递自检覆盖 id / role / source / content 四个字段')
  else bad(`投递字段自检只覆盖 ${covered}/4 —— 少一个就会写坏会话`)
  // 🔴🔴 2026-10-25 实测抓到的第二个漏（比 id 隐蔽，它**不报错**）：
  //    转达消息没带 `clientTimeZone`。DSH 的 dsh-time-context 只从
  //    "当前这一轮的用户消息"里收集时区（source.kind==='user' && 有 rpcId &&
  //    有 clientTimeZone 才算一条）。真人打字时 DSH 会带，我们不带 ⇒
  //    那一轮唯一的用户消息就"没有时区" ⇒ 模型被告知
  //      Browser time zone for this request: unavailable. Ask the user to clarify
  //    ⇒ 任何"今天/明天/几点"都会变得含糊。**不报错、不崩、就是悄悄偏**。
  //    症状：转达之后那轮的 runtime context 里 time zone 变成 unavailable。
  if (/clientTimeZone/.test(relay) && /pickClientTimeZone/.test(relay)) {
    ok('转达消息带上 clientTimeZone（否则那轮模型看到"时区不可用"）')
  } else {
    bad('转达消息没带 clientTimeZone —— 每转达一次，那轮的时区判断就变成 unavailable（实测过）')
  }
  // 值必须是 UTC 或规范 IANA 名，否则 dsh-time-context 直接 throw TypeError
  if (/Intl\.DateTimeFormat[\s\S]{0,200}timeZone/.test(relay)) ok('时区值会经过 Intl 规范化（非规范名 DSH 会 throw）')
  else warn('pet-relay 里没看到 Intl 规范化时区 —— 确认一下传出去的是不是规范名')
  // 🚨 必须有"清队列"的止损口（2026-10-25 事故：149 条堆在 next-turn，只能手改会话）
  if (/\/api\/douyin-duty\/pet\/queue\/clear/.test(idxCode) && /clearPetQueue/.test(idxCode)) {
    ok('有 /pet/queue/clear 止损口（队列堆住时能清，不用手改会话）')
  } else {
    bad('没有清队列的接口 —— 下次队列堆住又只能手改会话文件')
  }
  // 清队列只清 pet-relay，不许误伤真人输入（默认不是 all）
  if (/only === 'all'/.test(idxCode) && /'pet-relay'/.test(idxCode)) ok('清队列默认只清转达、不碰真人输入')
  else warn('清队列的 scope 看着可疑 —— 确认默认不会误删主人自己的输入')
} catch (e) { bad(`投递检查跑不起来：${e.message}`) }

/* ═══ 2026-10-25 拆分：4j-5/6/7/8/9/10 已随桌宠搬去 dsh-deskpet（它的 selfcheck 接手）═══
 *  这些断言检查的是 tools/pet-page、tools/pet-host、lib/pet-tts —— 现在都是桌宠插件的东西，
 *  抖音仓库里已经没有这些文件，留着只会全部报 ENOENT。
 *  对应的守卫在 dsh-deskpet/selfcheck.mjs；抖音侧的拆分守卫见下面 4p 节。 */
/* ── 4j-11. 配置不许被空值清空（2026-10-25 事故：私信对象和 venv 路径一起消失）──
 *
 * 🔴 事故经过（主人原话：「聊天模式怎么打开了，关闭不了」）：
 *   查下来**不是开关坏了** —— 是 `dmTo` / `dmToId` / `pythonPath` 三个值被清空了。
 *   而面板那句 `disabled: !cfg.dmToId` 让开关永久变灰（点它没反应），
 *   右边说明却还写着"✅ 开着" ⇒ 主人的观感就是"显示开着、关不掉"。
 *
 * 根因是**合并逻辑的漏洞**，不是某一次误操作：
 *   `loadCfg()` 里"表单值优先"的规则，把**空字符串当成一个正常值**。
 *   可这些字段的"空"永远是**坏状态**（没选人、没设解释器），不可能是主人特意清空。
 *   于是：表单空 + 磁盘有值 ⇒ 内存变空 ⇒ 下一次任何 patch 就写进磁盘，永久丢失。
 *
 * ✅ 现在的规矩（守这里）：
 *   ① `loadCfg` 合并后，字符串字段"表单空、磁盘非空"⇒ 用磁盘的
 *   ② `saveCfg` 写盘前，同样"空的不许盖掉磁盘上的非空值"（**对所有字符串字段**，
 *      不是只盯着 dmTo/dmToId —— 旧补丁就是只保护两个键，pythonPath 才漏掉的）
 *   ③ 真丢了要留备份（.lost-<时间戳>），下次一分钟能捞回来
 *
 * ⚠️ 这三条少任何一条，同类事故都会复发。所以每一处都单独断言。
 */
console.log('\n4j-11. 配置不许被空值清空（私信对象/venv 路径）')
try {
  const idx11 = readIf(join(here, 'index.js'))
  // ① loadCfg 的空值兜底
  if (/空值兜底|表单给空的、磁盘有值/.test(idx11)) ok('loadCfg 有"空白档优先用磁盘值"的兜底')
  else bad('loadCfg 没做空值兜底 —— 表单空会把磁盘值顶掉')
  // ② saveCfg 的通用保护：必须遍历 DEFAULTS 而不是写死两个键
  //
  // ⚠️ 这里返工过一次，值得记：第一版我写的是
  //      /for \(const k of Object\.keys\(DEFAULTS\)\) \{\s*\n\s*if \(typeof DEFAULTS\[k\] !== 'string'\) continue/
  //    然后做破坏性验证——把保护改回 `for (const k of ['dmTo','dmToId'])`，
  //    **自检居然还是 419 通过**。原因：`index.js` 里有两处长得一模一样的循环
  //    （loadCfg 里一处、saveCfg 里一处），我把 loadCfg 那处改坏了，
  //    但正则匹配到的是 saveCfg 那处 ⇒ 假通过。
  //    ⇒ 教训：**断言要盯"这段代码在不在 saveCfg 这个函数体里"，不能全文件搜。**
  //    现在先按函数边界切出 saveCfg 的函数体，再在函数体里查。
  const saveCfgBody = (() => {
    let i = idx11.indexOf('const saveCfg = (patch, opts = {}) =>')
    if (i < 0) i = idx11.indexOf('const saveCfg = (patch')
    if (i < 0) return ''
    // 从 const saveCfg 起，到下一个同级的 const 定义为止（这函数很短）
    const rest = idx11.slice(i)
    const end = rest.indexOf('\n  const saveCfgHost')
    return end > 0 ? rest.slice(0, end) : rest.slice(0, 4000)
  })()
  if (!saveCfgBody) {
    bad('找不到 saveCfg 函数体 —— 改名了？这条断言要跟着改')
  } else {
    const generic = /Object\.keys\(DEFAULTS\)/.test(saveCfgBody)
    const hardcoded = /\['dmTo'\s*,\s*'dmToId'\]/.test(saveCfgBody)
    if (generic && !hardcoded) {
      ok('saveCfg 的空值保护是**通用**的（遍历所有字符串字段，不写死键名）')
    } else if (hardcoded) {
      bad("saveCfg 的空值保护退回成写死 ['dmTo','dmToId'] 了 —— 下次加新配置项（比如 pythonPath）还会漏")
    } else {
      bad(`saveCfg 里找不到通用空值保护（generic=${generic}）`)
    }
  }
  // ②-b loadCfg 的兜底也要在**它自己的函数体**里（同一个假通过陷阱）
  const loadCfgBody = (() => {
    const i = idx11.indexOf('const loadCfg = () =>')
    if (i < 0) return ''
    const rest = idx11.slice(i)
    const end = rest.indexOf('\n  const cfg = loadCfg()')
    return end > 0 ? rest.slice(0, end) : rest.slice(0, 3000)
  })()
  if (/Object\.keys\(DEFAULTS\)/.test(loadCfgBody) && /!cur\.trim\(\) && disk\.trim\(\)|cur\.trim\(\)/.test(loadCfgBody)) {
    ok('loadCfg 函数体里也有空值兜底（表单空、磁盘非空 ⇒ 用磁盘）')
  } else bad('loadCfg 函数体里没有空值兜底')
  if (/差点被空值覆盖/.test(saveCfgBody)) ok('保住值时会记日志（排障能一眼看到）')
  else bad('保住值不记日志 —— 出事了查不出来')
  // ③ 备份：真要丢非空值，先留一份
  if (/\.lost-/.test(saveCfgBody)) ok('真要丢非空值会先备份成 .lost-<时间戳>')
  else bad('没有备份 —— 丢了只能靠翻日志猜')
  // ④ 面板：disabled 必须解释原因（不许只变灰）
  //    0.5.9d 起「评论区 @ 提醒」改成「开关永远能点 + 点开即选人」，
  //    所以这里的判据从旧文案（「点不动 —— 不是坏了」）改成新设计（不许再有变灰的死开关）。
  const cli11 = readIf(join(here, 'client.js'))
  if (/disabled: !cfg\.autoSend \|\| busy === 'patch'/.test(cli11) && !/disabled: !cfg\.autoSend \|\| !atNick/.test(cli11)) {
    ok('面板没有「缺前置条件就变灰」的死开关（0.5.9d：@ 开关永远能点，点开即选人）')
  } else bad('面板又有变灰的死开关 —— 主人点了没反应会以为软件坏了')
  if (/if \(!atPeers\.length && v && !people\) loadPeople\(\)/.test(cli11)) {
    ok('@ 开关点开时自动读会话列表并选人（不会点了没反应）')
  } else bad('@ 开关点开后没有自动读列表/选人 —— 点了像没反应')
} catch (e) { bad(`4j-11 检查跑不起来：${e.message}`) }

/* ── 4j-7 结束 ── */

console.log('\n4k. 新手流程（登录 / 私信对象）')
try {
  const cl = readFileSync(join(here, 'client.js'), 'utf8')
  const idx = readFileSync(join(here, 'index.js'), 'utf8')
  const qr = readFileSync(join(here, 'tools', 'qr-login.mjs'), 'utf8')
  const ims = readFileSync(join(here, 'tools', 'im-send.mjs'), 'utf8')

  // ① 面板必须有扫码登录按钮，不能只写命令行
  //    ⚠️ 查的是**代码**，注释里提到旧做法（"以前只写一句命令行跑…"）不算
  const clCode = cl.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '')
  if (/扫码登录/.test(clCode) && /\/login\/qr/.test(clCode)) ok('面板有「扫码登录」按钮（不是只写命令行）')
  else bad('面板没有扫码登录入口 —— 新手又要自己去敲 node tools/qr-login.mjs')
  if (/node tools\/qr-login\.mjs/.test(clCode)) bad('面板里还在教用户敲命令 —— 应该直接点按钮')
  else ok('面板里没有"自己去敲命令行"的登录指引')
  // ② 必须提前说明可能要过短信/滑块验证
  if (/短信验证码/.test(cl) && /滑块/.test(cl)) ok('面板提前说明了可能还要过短信/滑块验证')
  else bad('面板没提短信/滑块 —— 用户扫完卡在验证页会以为失败了')
  // ③ 「我扫完了」按钮
  if (/我扫完了/.test(cl) && /\/login\/wait/.test(cl)) ok('有「我扫完了」按钮（轮询到登录成功）')
  else bad('没有「我扫完了」—— 用户不知道什么时候算登录好')
  // ④ 后端四个登录路由
  for (const [p, name] of [['/login/qr', '出二维码'], ['/login/wait', '等登录'], ['/login/close', '关窗口'], ['/login/qr.png', '二维码图']]) {
    if (idx.includes(`/api/douyin-duty${p}`)) ok(`后端有 ${p}（${name}）`)
    else bad(`后端缺 ${p}（${name}）`)
  }
  // ⑤ 已登录时不许截首页冒充二维码
  if (/already_logged_in/.test(qr)) ok('qr-login 会先判断"已登录"并直接导 Cookie（不会截首页冒充二维码）')
  else bad('qr-login 不判断已登录状态 —— 会截一张首页图当二维码给用户')
  if (/document\.cookie\.indexOf\('sessionid='\)/.test(qr)) bad('还在用 document.cookie 判登录 —— sessionid 是 HttpOnly，永远读不到')
  else ok('没有用 document.cookie 判登录（HttpOnly 读不到，必须走 CDP）')
  // ⑥ profile 互斥要有明确提示
  // ⑥ profile 互斥要有明确提示（conflict 由 qr-login.mjs 产生，index.js 原样透传给面板）
  if (/profile_in_use/.test(qr) && /conflict/.test(idx)) ok('后台无头浏览器占着 Chrome 配置时会明确提示（不用干等 60 秒）')
  else bad('profile 被占时没有明确提示 —— 用户会干等 60 秒看到"连不上"')
  // ⑦ 私信对象必须能"从会话里选"，不许让用户手填 sec_uid
  if (/--list/.test(ims) && /mode: 'list'/.test(ims)) ok('im-send.mjs 有 --list（列出会话里的人）')
  else bad('im-send.mjs 没有 --list —— 面板列不出人')
  if (/dm\/people/.test(idx)) ok('后端有 /dm/people（读会话里的人）')
  else bad('后端缺 /dm/people')
  if (/从我的会话里选/.test(cl) && /pickPerson/.test(cl)) ok('面板能"从我的会话里选"人（不用手填 sec_uid）')
  else bad('面板还在让用户手填私信对象')
  // ⑧ 同名必须标出来
  if (/duplicate/.test(ims) && /重名/.test(cl)) ok('同名的人会被标出来（避免选错）')
  else bad('同名的人没标 —— 重名时可能选错人')
  // ⑨ 新手流程说明要能看到（不用让用户去翻 GitHub）
  if (/怎么用？/.test(cl) && /\/guide/.test(cl) && idx.includes('/api/douyin-duty/guide')) {
    ok('面板有「怎么用？」能展开新手流程')
  } else bad('面板没有新手流程入口 —— 用户还得自己去翻文档')
  if (existsSync(join(here, 'GUIDE.md'))) ok('GUIDE.md 在（新手流程正文）')
  else bad('缺 GUIDE.md')

  /* ── ⑩ 登录后要显示"登录的哪个号" ── */
  if (idx.includes('/api/douyin-duty/account')) ok('后端有 /account（当前登录的账号）')
  else bad('后端缺 /account —— 面板没法显示登录的是哪个号')
  if (/data-dy-account/.test(cl) && /acc\.nick/.test(cl)) ok('面板显示账号昵称')
  else bad('面板没显示账号昵称 —— 用户不知道在给谁刷')
  if (/account\.json/.test(idx)) ok('扫码成功后会记下账号（account.json）')
  else bad('扫码成功后没记账号 —— 面板只能显示"已登录"三个字')

  /* ── ⑪ 私信对象：既要点选，也要能手填 ── */
  if (/自己写/.test(cl) && /manualDm/.test(cl)) ok('私信对象可以手填（不只是从会话里选）')
  else bad('私信对象只能点选，不能手填')

  /* ── ⑫ 这些基本功能不许再丢 ── */
  const mustHave = [
    ['每天挑几条', /每天挑几条/],
    ['日报详细程度', /日报写多细/],
    ['通知方式', /通知：/],
    // 🔴 2026-10-26 主人：「人设是不是该改成我的人设」⇒ 标题定为「我的人设」
    ['人设编辑', /'我的人设'/],
  ]
  for (const [name, re] of mustHave) {
    if (re.test(cl)) ok(`面板有「${name}」`)
    else bad(`面板缺「${name}」—— 功能又少了一块`)
  }
  /* 🔴 2026-10-26 主人：「人设默认的是不是有问题」—— 查出来是**面板在说谎**：
   *   实际生效的是插件自带那份（16970 字节完整人设），
   *   但面板只读 $DOUYIN_HOME/persona.md（不存在）⇒ 空框 + 提示"用的是默认"。
   *   现在后端必须返回 effective / effective_label，面板必须展示它。 */
  if (/effective_from/.test(idx) && /effective_label/.test(idx)) ok('人设接口返回「当前真正生效的那份 + 来源」')
  else bad('人设接口只返回自己那份 —— 没写自己的用户会看到空框，以为人设丢了')
  if (/persona\.effective/.test(cl) || /effectiveLabel/.test(cl)) ok('面板会展示当前生效的人设内容（不再是空框）')
  else bad('面板不展示生效内容 —— 用户会以为人设是空的')
  if (idx.includes('/api/douyin-duty/persona')) ok('后端有 /persona（人设读写）')
  else bad('后端缺 /persona')
} catch (e) { bad(`新手流程检查失败：${e.message}`) }

/* ── 4l. 真 @ 提及（2026-10-22 修的真 bug） ──
 * 🔴 事故：index.js 把 --mention-* 传给 comment-api.mjs，但那个脚本**根本不认**这几个参数
 *    ⇒ 一路静默忽略，发出去的是**普通评论**（名字不变蓝、对方收不到通知），工具却报成功。
 *    唯一有效的 comment-mention-ui.mjs 在 index.js 里从来没被调用过。
 */
console.log('\n4l. 真 @ 提及')
try {
  const idx = readFileSync(join(here, 'index.js'), 'utf8')
  const cm = readFileSync(join(here, 'tools', 'comment-api.mjs'), 'utf8')
  const ui = readFileSync(join(here, 'tools', 'comment-mention-ui.mjs'), 'utf8')

  if (/runNodeTool\('comment-mention-ui\.mjs'/.test(idx)) ok('index.js 真的会调 comment-mention-ui.mjs（UI 点选那条路）')
  else bad('index.js 不调 comment-mention-ui.mjs —— 真 @ 根本发不出去（历史 bug 回来了）')

  // 不许再把 mention 参数喂给做不了 @ 的那个脚本
  if (/comment-api\.mjs'[^\n]*mention/.test(idx)) bad('又把 --mention-* 传给 comment-api.mjs —— 它会静默忽略')
  else ok('没有把 mention 参数喂给 comment-api.mjs')

  // comment-api.mjs 必须**明确拒绝** mention，不许静默降级
  if (/unsupported: 'mention'/.test(cm)) ok('comment-api.mjs 收到 --mention-* 会明确拒绝（不再静默降级）')
  else bad('comment-api.mjs 收到 mention 参数不吭声 —— 会发出"看起来成功"的普通评论')

  // ⭐⭐ 2026-10-23 重新设计后：不再靠"有没有 mention"偷偷分流，
  //    改成**调用方必须显式选 mode**（api / ui）。检查这条设计在不在。
  if (/const mode = String\(args\.mode/.test(idx)) ok('index.js 用显式 mode 参数分流（api / ui 两条通道）')
  else bad('index.js 没有显式 mode 分流 —— 又会变成"传了 mention 就偷偷换路"，调用方不知道自己在走哪条')

  // api 模式不许带 mention（要真 @ 必须显式选 ui）
  if (/mode === 'api' && mentionName/.test(idx) && /mention-in-api-mode/.test(idx)) {
    ok('mode=api 传了 mention_name 会明确拒绝（并告诉他改用 mode:ui）')
  } else bad('mode=api 传 mention 时不报错 —— 会静默发成"看着像 @"的普通评论')

  // ui 模式不许带 comment_id（真 @ 只能顶层 —— 避免又回到"先找评论"的死锁）
  if (/mode === 'ui' && replyTo/.test(idx) && /reply-in-ui-mode/.test(idx)) {
    ok('mode=ui 传了 comment_id 会明确拒绝（真 @ 只能顶层，不依赖找评论）')
  } else bad('mode=ui 允许指定 comment_id —— 又回到"必须先找到目标评论"的死锁')

  // 发送闸 / 限流退避 / 三态回读（2026-10-23 实测：连发 3 条后 403）
  if (/const sendGate = async/.test(idx) && /blockedUntil/.test(idx)) ok('有本地发送闸 + 限流退避（防连发 403）')
  else bad('没有发送闸 —— 连发会被抖音 403，而且越重试封越久')
  if (/const readbackAfter = async/.test(idx) && /state: 'pending'/.test(idx)) ok('回读是三态（visible / pending），不谎报成功也不谎报失败')
  else bad('回读只会 found/not found —— 分不清"还在审核"和"真没发出去"')

  /**
   * ⭐⭐ 2026-10-23 **判断规则**（使用者连着问了两次，前两版都想错了）
   *    唯一判据 = 有没有对话对象（有 comment_id）。
   *    这里守三条，防止以后又被改回"回人就 @":
   */
  // ① 有 comment_id + mode=api 时，工具描述必须引导"不需要 @"
  if (/有 comment_id（要回某条评论）⇒ 用 mode:api/.test(idx)) ok('工具描述写明了：有 comment_id ⇒ 用 api，不要用 @')
  else bad('工具描述没写明「有 comment_id 就用 api」—— 提示词会把调用方又推去发 @ 顶层')
  // ② 拒绝文案里必须引导"直接回复"，而不是教他发顶层
  if (/你已经有 comment_id 了 ⇒ \*\*不需要 @\*\*/.test(idx)) ok('拒绝文案引导"直接回复就行，不用 @"（不把人往顶层推）')
  else bad('拒绝文案没引导直接回复 —— 调用方会以为"要通知人只能用 @"')
  // ③ 值班轮的 commentAtMe 必须用 mode=ui（推视频、没有评论可回），且写明"这是 @ 唯一该用的场景"
  if (/这是 @ 唯一该用的场景/.test(idx)) ok('值班轮提示词写明：推视频（无评论可回）才用 @')
  else bad('值班轮提示词没说清"什么时候该用 @"—— 模型可能拿 @ 去回复人')
  // ④ at-me 自动回复脚本必须走 api 直接回复（不是 UI 点选）
  const atw = (() => { try { return readFileSync(join(here, 'tools', 'at-me-watch.mjs'), 'utf8') } catch { return '' } })()
  if (atw && /runNode\('comment-api\.mjs'/.test(atw) && /--reply/.test(atw)) ok('at-me-watch 用 api 直接回复（1 秒、拿得到 cid）')
  else if (atw) bad('at-me-watch 还在走 UI 点选 —— 慢、拿不到 cid（今天 6 条垃圾就删不掉）')
  if (atw && /rate_limited: true/.test(atw)) ok('at-me-watch 撞 403 会停下，不重试')
  else if (atw) bad('at-me-watch 撞 403 还在继续发 —— 会封更久')

  // UI 路径现在**支持**"回复某条 + 真 @"（2026-10-22 加：先点那条评论的「回复」再 @ 点选）
  if (/--reply-cid/.test(ui) && /--reply-text/.test(ui)) ok('UI 脚本支持按 cid 或正文片段定位目标评论')
  else bad('UI 脚本定位目标评论的方式丢了')
  // 但若某版本不支持，必须有明确报错而不是默默发顶层
  if (/reply_target_not_found|reply_button_not_found/.test(ui)) ok('找不到目标评论/回复按钮时会明确失败（不默默改成发顶层）')
  else bad('找不到目标评论时没有明确失败 —— 可能默默发成顶层，用户以为回复了')

  /**
   * ⭐⭐ 4l-2. **楼根 bug**（2026-10-23 实测抓到的真 bug，最阴的一种）
   *
   * 🔴 事故：comment-api.mjs 里写的是
   *      body.reply_id = REPLY; body.reply_to_reply_id = REPLY;
   *    —— 两个字段塞同一个值。服务端落库的结果（我实际读回来核实过）：
   *      回号主的顶层评论 X，结果那条回复变成 level=1、root_comment_id=它自己
   *      ⇒ **变成了一条冒出来的顶层评论**，压根没进那栋楼。
   *    工具报 ok、拿得到 cid、还能删 —— 每一步都"看起来成功"，所以一直没人发现。
   *
   * 正确结构（从别人的正常回复里读出来的）：
   *    level=2  reply_id=<楼根>  reply_to_reply_id=<具体回哪条>
   *    ⇒ reply_id 永远是楼根；reply_to_reply_id 才是"回这条"。
   */
  console.log('\n4l-2. 楼根（reply_id vs reply_to_reply_id）')
  // ① 不许再把两个字段写成同一个变量
  //    ⚠️ 只看**代码行**（行首不是 * 或 // 的），否则会把注释里"旧代码是什么样"的说明当成 bug
  const cmCode = cm.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n')
  if (/body\.reply_id = REPLY;\s*\n?\s*body\.reply_to_reply_id = REPLY/.test(cmCode)) {
    bad('comment-api.mjs 又把 reply_id 和 reply_to_reply_id 填成同一个值 —— 回复会变成一条冒出来的顶层评论')
  } else ok('comment-api.mjs 没再把 reply_id / reply_to_reply_id 混成一个值')
  // ② 必须支持 --root
  if (/--root/.test(cm) && /body\.reply_id = ROOT/.test(cm)) ok('comment-api.mjs 支持 --root（楼根单独传）')
  else bad('comment-api.mjs 没有 --root —— 回楼中楼时楼根没地方传')
  // ③ 判不出楼根必须拒绝，不许瞎猜
  if (/need_root/.test(cm) && /不瞎猜|拒绝/.test(cm)) ok('comment-api.mjs 判不出楼根时明确拒绝（不瞎猜）')
  else bad('comment-api.mjs 判不出楼根时还在硬发 —— 会又变成顶层评论')
  // ④ 自动判楼根的三条路都在：顶层列表 / 楼中楼里 / 有没有人回过它
  for (const [tag, re] of [
    ['翻顶层列表找这条', /found-level1/],
    ['在楼中楼里找', /found-in-thread/],
    ['看它自己有没有人回过', /has-replies/],
  ]) {
    if (re.test(cm)) ok(`comment-api.mjs 能${tag}`)
    else bad(`comment-api.mjs 少了"${tag}"这条判据`)
  }
  // ⑤ index.js 要把 root_comment_id 一路传下去
  if (/root_comment_id/.test(idx) && /'--root'/.test(idx)) ok('index.js 会把 root_comment_id 传给 comment-api.mjs')
  else bad('index.js 没把 root_comment_id 传下去 —— 工具层说了楼根也用不上')
  /**
   * ⑥ 核实"到底进没进楼" —— **不能只信 publish 的响应**。
   * 🔴 2026-10-23 实测：同一台机器、同一个视频、同一个参数，
   *    前 5 条 publish 响应里带 comment.level、后 7 条 level 全是 undefined。
   *    ⇒ 靠 server_level 判断落位会"有时候判得出来、有时候判不出来"，
   *      判不出来时又会静默当成成功。现在必须**发完重读那一楼**。
   */
  if (/verified_level/.test(cm) && /comment\/list\/reply/.test(cm)) {
    ok('comment-api.mjs 发完会重读那一楼核实落位（不只信 publish 响应）')
  } else bad('comment-api.mjs 只信 publish 响应判落位 —— 服务端有时不返回 level（实测 7/7 都没有）')
  if (/found_at_top/.test(cm)) ok('comment-api.mjs 楼里读不到时会去顶层列表查（能识别"跑成顶层评论"）')
  else bad('comment-api.mjs 楼里读不到就当失败/成功 —— 分不清"跑顶层了"和"热度排够不着"')
  if (/placement/.test(cm) && /不是楼中楼回复|没进楼/.test(cm)) ok('comment-api.mjs 会明确报"落位错了"（不是只说 ok）')
  else bad('comment-api.mjs 不报落位错误 —— 又会出现"发出去了但位置错了还报成功"')
  if (/placement/.test(idx)) ok('index.js 把 placement 透传给调用方')
  else bad('index.js 把落位信息吞了 —— 模型看不到"到底进没进楼"')
  // 三态：读不到 ≠ 失败
  if (/不等于没进楼|不正于没进楼|verified: false/.test(cm)) ok('comment-api.mjs 重读不到时是三态（不谎报失败也不谎报成功）')
  else bad('comment-api.mjs 重读不到时只有两态 —— 会谎报失败')

  /**
   * ⭐⭐ 4l-3. **回复类通知**（type 31/32）
   *
   * 🔴 事故：notice-read.py 的 TYPE_NAME 只有 45/46/@ + 33/34/35，
   *    于是「别人回复了我的评论」这类通知（type=31, comment_type=2）**完全漏掉**。
   *    而这恰恰是最该"直接回复"的场景 —— 连"有人跟我说话"都不知道，回什么。
   *    另外这类通知里真正说话的人在 blk["comment"]["user"]，
   *    不在 user_info / from_user ⇒ 只读前者的实现连 nickname 都是空的。
   */
  console.log('\n4l-3. 回复类通知（type 31/32）')
  const nr = readFileSync(join(here, 'tools', 'notice-read.py'), 'utf8')
  if (/31:\s*"/.test(nr) || /\b31:\s*'/.test(nr)) ok('notice-read.py 认得 type 31（回复了评论）')
  else bad('notice-read.py 不认识 type 31 —— 「别人回复我的评论」全漏')
  if (/root_comment_id/.test(nr)) ok('notice-read.py 会解析 root_comment_id（楼根）')
  else bad('notice-read.py 不解析楼根 —— 回楼中楼时没地方拿它')
  if (/inner\.get\("user"\)|inner\.get\('user'\)/.test(nr)) ok('notice-read.py 从 comment.user 读昵称（评论类通知的说话人在这）')
  else bad('notice-read.py 只读 user_info —— 评论类通知的昵称是空的')
  if (/x\.type === 31 \|\| x\.type === 32/.test(idx)) ok('index.js 的 readAtMe 也认 type 31/32（不只 @）')
  else bad('index.js 的 readAtMe 只看 @ —— 别人回复我这件事看不见')
  if (/reply_n/.test(idx)) ok('工具返回里带 reply_n（回复类条数）')
  else bad('工具返回里没有 reply_n —— 看不出有没有人回我')

  // @ 自己那道闸还在
  if (/是登录号自己的 uid/.test(idx)) ok('有「@ 自己」拦截')
  else bad('「@ 自己」的拦截没了 —— 会 @ 到登录号自己头上')
  if (/--name/.test(ui) && /--aweme/.test(ui)) ok('comment-mention-ui.mjs 参数接口正常')
  else bad('comment-mention-ui.mjs 参数变了')
} catch (e) { bad(`真 @ 检查失败：${e.message}`) }

/* ── 4m. 对话记忆（持续聊天要带上下文） ── */
console.log('\n4m. 对话记忆')
try {
  const idx = readFileSync(join(here, 'index.js'), 'utf8')
  const cl = readFileSync(join(here, 'client.js'), 'utf8')
  const memFile = join(here, 'lib', 'memory.mjs')
  if (!existsSync(memFile)) bad('缺 lib/memory.mjs —— 没有记忆')
  else {
    const mem = readFileSync(memFile, 'utf8')
    ok('lib/memory.mjs 在')
    // 真跑一遍记忆自测
    const t = spawnSync(process.execPath, [join(here, 'tools', 'memory-test.mjs')], { encoding: 'utf8', timeout: 60_000 })
    const m = String(t.stdout || '').match(/结果：(\d+) 通过 \/ (\d+) 失败/)
    if (t.status === 0 && m) ok(`记忆自测通过（${m[1]} 项：去重/上限/事实/评论/清空）`)
    else bad(`记忆自测失败：${String(t.stdout || t.stderr || '').split('\n').slice(-3).join(' ')}`)
    // 记忆必须落本机、且有上限
    if (/MAX_MESSAGES = 80/.test(mem)) ok('记忆有上限（每人最多 80 条）')
    else bad('记忆没上限 —— 会无限长')
    if (/home, 'memory'/.test(mem) || /join\(home, 'memory'\)/.test(mem)) ok('记忆存在插件家目录（本机，不上传）')
    else bad('记忆存哪儿不清楚')
  }
  // douyin_im_read 要带上下文
  if (/context: context \|\|/.test(idx)) ok('douyin_im_read 返回记忆上下文（回话前能看到之前聊过什么）')
  else bad('douyin_im_read 不带上下文 —— 每次都是"第一次见"')
  if (/mergeDmMemory\(stateDir/.test(idx)) ok('读私信会把会话合并进记忆')
  else bad('读私信不写记忆')
  if (/noteSent\(stateDir/.test(idx)) ok('发出去的消息也进记忆（不然下次读会以为凭空出现）')
  else bad('发出去的消息不进记忆')
  // 新工具
  for (const [name, label] of [
    ['douyin_at_me', '评论区 @ 我'],
    ['douyin_remember', '记住长期事实'],
    ['douyin_memory', '记忆管理'],
  ]) {
    if (idx.includes(`name: '${name}'`)) ok(`有 ${name} 工具（${label}）`)
    else bad(`缺 ${name} 工具（${label}）`)
  }
  // 面板
  if (/对话记忆/.test(cl) && /\/memory/.test(cl)) ok('面板有「对话记忆」卡片')
  else bad('面板没有记忆入口 —— 用户不知道它在记什么')
  if (/清空全部记忆/.test(cl)) ok('面板能清空记忆')
  else bad('面板不能清空记忆 —— 用户没法反悔')
} catch (e) { bad(`记忆检查失败：${e.message}`) }

/* ── 4n. 面板里的「消息」和「聊天」（2026-10-22 用户要求） ── */
console.log('\n4n. 消息收件箱 + 聊天模式')
try {
  const idx = readFileSync(join(here, 'index.js'), 'utf8')
  const cl = readFileSync(join(here, 'client.js'), 'utf8')

  // ① 收件箱：评论区 @ 我 + 谁私信我
  if (idx.includes('/api/douyin-duty/inbox')) ok('后端有 /inbox（评论区 @ + 私信列表一次读完）')
  else bad('后端缺 /inbox —— 面板看不到谁找我')
  if (/看看谁找我/.test(cl)) ok('面板有「看看谁找我」按钮')
  else bad('面板没有消息入口')
  if (/评论区 @ 我/.test(cl) && /最近私信/.test(cl)) ok('消息卡分了两块：评论区 @ 我 / 最近私信')
  else bad('消息卡没分块')
  if (/该回了/.test(cl) && /needs_reply/.test(cl)) ok('私信标了「该回了」（他最后说的比我晚）')
  else bad('私信没说该不该回 —— 用户还得自己翻')
  if (/记 \$\{p\.remembered/.test(cl) || /记 \$\{p\.remembered \|\| 0\}/.test(cl) || /remembered/.test(cl)) ok('显示跟这个人记得多少条（记忆）')
  else bad('没显示记忆条数')

  // ② 评论区 @ 我：点进去能看到"我在这条视频下说过什么"
  if (/my_comments_here/.test(cl) && /我在\s*这条视频下说过/.test(cl)) ok('评论区 @ 带我在这条视频下说过什么（靠记忆去重）')
  else bad('评论区 @ 没带"我说过什么" —— 可能重复回同一句')

  // ③ 聊天模式
  if (idx.includes('/api/douyin-duty/chat/read') && idx.includes('/api/douyin-duty/chat/send')) ok('后端有 /chat/read + /chat/send')
  else bad('后端缺聊天接口')
  if (/跟 ' \+ chat\.who\.nick \+ ' 聊/.test(cl)) ok('面板有聊天界面')
  else bad('面板没有聊天界面')
  if (/data-dy-bubble/.test(cl)) ok('消息用气泡显示')
  else bad('消息不是气泡')
  if (/data-dy-inbox-dm/.test(cl)) ok('收件箱的私信按钮可点开聊天')
  else bad('收件箱的人点不开聊天')
  if (/记得关于他的/.test(cl)) ok('聊天界面显示了记忆里的长期事实')
  else bad('聊天界面没显示记忆')
  if (/发出去会进记忆|发出去的话会记进记忆/.test(cl)) ok('聊天说明了"发出去会进记忆"')
  else bad('聊天没说记忆行为')
  // 🔴 聊天发送必须落记忆（不然下次读还是不知道说过什么）
  if (/chat\/send'[\s\S]{0,1500}?noteSent\(stateDir/.test(idx)) ok('聊天发出去的消息会进记忆')
  else bad('聊天发送不写记忆')

  // ④ 聊天模式：后端盯梢 + 面板开关 + 自动刷新 + 快路径
  if (/chatWatchTick/.test(idx)) ok('后端有聊天模式盯梢循环（新消息 → 通知）')
  else bad('后端没有盯梢循环 —— 会话模式没进插件')
  /* 🔴 2026-10-26 主人改口：「聊天模式默认关闭为什么」⇒ 默认必须是 **关**。
   *   理由：默认开 = 一装上就开始读别人私信 + 自动回话 + 拉常驻会话烧额度，
   *   对没读说明书的人是意外行为。用户明确点开才工作。
   *   老用户不受影响（值已在 config.json + intent 自愈会恢复）。 */
  if (/chatWatch: z\.boolean\(\)\.default\(false\)/.test(idx)) ok('chatWatch 默认关（2026-10-26 主人定：用户点开才工作）')
  else bad('chatWatch 默认值不对 —— 现在必须是 false（默认开会让没读说明书的人被动收到自动回话）')
  // 🔴 防倒退：DEFAULTS 表必须也带 chatWatch（2026-10-24 事故：只加了 zod 没加 DEFAULTS，
  //    clampPatch 只放行 DEFAULTS 里的键 ⇒ 面板开关点了没反应）
  if (/DEFAULTS = \{[\s\S]{0,1200}?chatWatch: false/.test(idx)) ok('DEFAULTS 表带 chatWatch 且默认 false（面板的 patch 不会被 strip）')
  else bad('DEFAULTS 表没有 chatWatch（或默认值不对）—— 面板开关会点了没反应')
  if (/chatWatchSec: z\.natural\(\)\.default\(30\)/.test(idx)) ok('看消息间隔默认 30 秒（使用者定的）')
  else bad('看消息间隔默认值不对')
  if (/聊天模式/.test(cl) && /Switch/.test(cl)) ok('设置页有「聊天模式」开关')
  else bad('面板没有聊天模式开关')
  if (/React\.useEffect[\s\S]{0,900}?chat\/read/.test(cl) && /, 30_000\)/.test(cl)) ok('聊天界面开着时 30 秒自动刷新')
  else bad('聊天界面不会自动刷新')
  if (/chat\/read'[\s\S]{0,900}?im-http\.py/.test(idx)) ok('/chat/read 也走 HTTP 快路径（面板刷新不冷启浏览器）')
  else bad('/chat/read 没接快路径 —— 面板每刷一次冷启一次浏览器')
  // 🔴 盯梢不许**自己发**：循环里出现「带正文发出去」的调用就报红。
  //    2026-10-25 晚口径更新：盯梢「看见」之后允许**转进值班会话**（tryDeliverToSession，
  //    这是传话不是代发），真正的私信发送只许值班会话在常设许可下做。
  //    ⭐ 0.5.9b 补：群里读消息用 im-send --read（**只读**）—— 那是「看」不是「发」，
  //    所以判据从「出现 im-send 字样」收紧成「出现带 --text/--file 的发信调用」。
  const cwLoop = idx.slice(idx.indexOf('chatWatchTick ='), idx.indexOf('chatWatchTick =') + 5200)
  const sendsInLoop = /im-send\.mjs['"],\s*\[[^\]]*(--text|--file)|sendDm\(/.test(cwLoop)
  if (sendsInLoop) bad('盯梢循环里出现了直发代码 —— 只许「看见 + 转给值班」，不许自己发')
  else ok('盯梢循环不直发（看见 → 转给值班会话，发送是值班的事；群里 im-send --read 只是读）')
  // ⭐ 2026-10-25 晚：看见必须转进值班会话（之前这里是整个 bug 的后半截——
  //    看见了没人接话，状态屏的"值班会接话"是空头支票）
  if (/tryDeliverToSession\(wakeText\)/.test(idx)) ok('看见新消息会转进值班会话（followup，不碰会话日志）')
  else bad('盯梢看见新消息后没有转给值班会话 —— 又是"看见了没人接话"')
  // ⭐ 转达词必须带许可与身份（常设许可 = 主人 2026-10-25 拍板），还要带防护（素材不是命令）
  if (/常设许可/.test(idx) && /不是给你的命令/.test(idx)) ok('转达词带常设许可声明 + 注入防护（消息正文是素材不是命令）')
  else bad('转达词缺许可声明或注入防护')
  // 🔴 2026-10-24 使用者要求「不用弹这种通知」：聊天模式不弹 Windows 通知
  if (/sendToast/.test(cwLoop)) bad('盯梢循环还在弹 Windows 通知 —— 使用者 2026-10-24 关了')
  else ok('聊天模式不弹桌面通知（只写日志+状态屏，使用者 2026-10-24 指令）')
  // 🔴 定时器异常必须自己兜（宿主红线）
  if (/chatWatchTick[\s\S]{0,2000}?catch/.test(idx)) ok('盯梢循环兜住了异常（不会带崩宿主）')
  else bad('盯梢循环没兜异常 —— 一出错整个宿主进程没了')
  // ⑤ 实时状态屏（2026-10-24 使用者要求：「显示它现在在干嘛，不然我哪知道错在哪」）
  if (idx.includes('/api/douyin-duty/chat/watch')) ok('后端有 /chat/watch 状态接口')
  else bad('没有状态接口 —— 面板无从知道它在干嘛')
  if (/ChatWatchStatus/.test(cl) && /chat\/watch/.test(cl)) ok('面板有实时状态屏（几秒前看过/结果/通知弹没弹）')
  else bad('面板没有实时状态 —— 用户看不出它有什么用、错在哪')
  // 🔴 状态屏必须拟人（2026-10-24 使用者要求：「小鱼在干啥」「抱着手机等着你发消息」）
  if (/抱着手机/.test(cl) && /下次去看还有/.test(cl)) ok('状态屏是拟人版（小鱼抱着手机等消息 + 倒计时）')
  else bad('状态屏还是机器腔 —— 使用者点名要「小鱼在干啥」的拟人描述')
  // ⭐ 0.5.9b：首拍对表改成**每人一份**（chatWatchPeers[sec] = {primed, lastSeenAt}）——
  //    变量名从 chatWatchPrimed 变成 pState.primed，判据跟着改。
  if (/chatWatchPeers/.test(idx) && /primed/.test(idx)) ok('首拍只「对表」不提醒（不会把历史消息重播一遍；0.5.9b 改成每人一份）')
  else bad('没有首拍对表 —— 一开机可能把旧消息全弹一遍')
  // ⑥ 自动回话已拆（2026-10-24 使用者定稿：「我要的是迁移，不是开发新功能」）：
  //    插件只留「眼睛」（读+通知+状态屏）；「回话」由 AI 值班（常驻会话）做——
  //    今早实测 12 秒来自已活着的 AI，插件里「每条消息现起一个会话」实测 73 秒+吞消息，已拆。
  if (/chatReplyRun|chatReplyPrompt|chatReply:/.test(idx)) bad('插件里又有「现起会话回话」的代码 —— 已定稿拆掉，回话归 AI 值班')
  else ok('插件没有「现起会话回话」（回话 = AI 值班，插件只做眼睛）')

  /* ═══ 4m. 2026-10-25 晚追加（主人拍板「开关 = 常设许可」）═══
   *  ① 数组字段空值守卫（keywords 从「猫、美食、搞笑」变 [] 的姊妹事故）
   *  ② 显式清空口子 __clearKeys（不许把使用者关进守卫里）
   *  ③ 上岗报号（打开开关小鱼要说话，贴合场景，一天一次防轰炸）
   *  ④ 面板状态屏说真话（不许再写"值班会接话"的空头支票——现在真的会转给值班）
   */
  console.log('\n4m. 常设许可三件套（数组守卫 / 显式清空 / 上岗报号）')
  try {
    const idxM = readIf(join(here, 'index.js'))
    const cliM = readIf(join(here, 'client.js'))
    // ① 数组守卫要在 loadCfg 和 saveCfg **各自的函数体**里（同一个假通过陷阱：两处长得像）
    const loadBodyM = (() => {
      const i = idxM.indexOf('const loadCfg = () =>')
      if (i < 0) return ''
      const rest = idxM.slice(i)
      const end = rest.indexOf('\n  const cfg = loadCfg()')
      return end > 0 ? rest.slice(0, end) : rest.slice(0, 3200)
    })()
    const saveBodyM = (() => {
      const i = idxM.indexOf('const saveCfg = (patch, opts = {})')
      if (i < 0) return ''
      const rest = idxM.slice(i)
      const end = rest.indexOf('\n  const saveCfgHost')
      return end > 0 ? rest.slice(0, end) : rest.slice(0, 4200)
    })()
    const arrGuard = /ARRAY_FIELDS/
    if (arrGuard.test(loadBodyM) && /disk && disk\.length/.test(loadBodyM)) ok('loadCfg 有数组版空值兜底（空数组不许盖掉非空列表）')
    else bad('loadCfg 缺数组守卫 —— keywords 这类字段还会被静默清空')
    if (arrGuard.test(saveBodyM) && /cleared\.includes\(k\)/.test(saveBodyM)) ok('saveCfg 有数组版保护 + 显式清空口子（cleared）')
    else bad('saveCfg 缺数组守卫或显式清空口子')
    // ② 显式清空口子要能从面板一路走通：client 发 __clearKeys → HTTP 放行 → persistCfg 摘走
    if (/__clearKeys/.test(cliM)) ok('面板编辑器接了显式清空口子（真清空有活路，不被守卫关死）')
    else bad('面板没有清空口子 —— 守卫会把「真想清空」也拦死')
    if (/__clearKeys/.test(idxM) && /stripClearKeys/.test(idxM)) ok('后端有 __clearKeys 摘取（persistCfg 收口）')
    else bad('后端没有摘 __clearKeys —— 口子半路断掉')
    if (/Array\.isArray\(body\.__clearKeys\)/.test(idxM)) ok('HTTP /config 路由放行 __clearKeys（白名单外唯一例外）')
    else bad('HTTP 路由把 __clearKeys 扔了 —— 面板清空等于没点')
    // ③ 上岗报号：异步（不能 spawnSync 冻宿主）+ 每天每触发点一次 + 失败不记"已发"
    if (/runNodeToolAsync/.test(idxM)) ok('上岗报号走异步发送（spawnSync 会冻住整个宿主）')
    else bad('上岗报号用了同步 spawn —— im-send 一跑几十秒，宿主全停')
    if (/greetOnce\('opened'/.test(idxM) && /greetOnce\('resumed'/.test(idxM)) ok('报号两个触发点都在（开关刚开 / 重启接班）')
    else bad('报号触发点缺一个 —— 「点开开关她要说话」就落空了')
    if (/greet: \{ \.\.\.greeted/.test(idxM)) ok('报号按天记账（防轰炸）')
    else bad('报号没有按天记账 —— 每拍重发就是骚扰')
    // ④ 面板不再开空头支票
    if (/值班的小鱼会直接接话/.test(cliM)) bad('状态屏还在写"值班会直接接话"的空头支票（现在必须说"已转给值班/没叫醒"）')
    else ok('状态屏不再开空头支票（看见 → 说清转没转给值班）')
    if (/已经转给值班的小鱼接话/.test(cliM)) ok('状态屏 ok_new 文案带「已转给值班」')
    else bad('状态屏没说"已转给值班" —— 主人还是不知道消息有没有人接')
    // ⑤ 发送器的引号不许再被"批量清洗"弄坏（2026-10-25 事故：d8a41c0 把 im-send 里
  //    126 个 " 换成了「主」，选择器全废 ⇒ 发送永远报"没登录"；--read 走 Python
  //    快路径碰不到这个文件，所以静默坏了两天没人发现）。
    const imSend = readIf(join(here, 'tools', 'im-send.mjs'))
    if (imSend) {
      // ⭐ 0.5.9d：判据收紧到**选择器里**的「主」—— 中文文案（"由主人手动发"）不算坏
      const selBad = /\[(?:data-e2e|contenteditable|class)\*?=[^\]]*主/.test(imSend)
      if (/data-e2e="conversation-item"/.test(imSend) && !selBad) ok('im-send.mjs 选择器引号完好（没被批量替换弄坏）')
      else bad('im-send.mjs 选择器坏了（引号被换成「主」字）—— 发送会永远报"没登录"')
    } else bad('tools/im-send.mjs 不见了 —— 发送器没了')
    // ⑥ 值班鱼投递（2026-10-25 深夜两轮探查后的正式实现）：插件自有常驻会话
    if (/chatWatchTarget: z\.string\(\)\.default\('lead'\)/.test(idxM) && /chatWatchTarget: 'lead'/.test(idxM) && /chatWatchTarget: \['lead', 'duty'\]/.test(idxM)) ok('chatWatchTarget 三处齐（zod 默认 + DEFAULTS + ENUMS 钳制）')
    else bad('chatWatchTarget 登记不全（zod/DEFAULTS/ENUMS）—— 投递目标开关点了没反应')
    // 🔴 2026-10-25 深夜事故：写了 z.enum(...) ⇒ 宿主 schemastery 没有该方法 ⇒
    //    整个插件 import 失败（MCP 工具全消失、桌宠不拉、health.json 停更），
    //    而依赖/符号链接/bundles 全是好的 —— 排查方向被彻底带偏。
    //    ⚠️ 要先剥注释再查：解释"别用 z.enum"的注释本身就会命中关键词（老坑）。
    const idxNoComment = idxM.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    if (/z\.enum\(/.test(idxNoComment)) bad('index.js 里出现 z.enum —— 宿主 schemastery 没有这个方法，整个插件会 import 失败')
    else ok('没有 z.enum（宿主不支持，踩过整个插件加载失败）')
    if (/DUTY_SESSION_ID = 'douyin-duty-fish-v\d+'/.test(idxM) && /agents\.create\(/.test(idxM) && /agents\.resume\(/.test(idxM)) ok('值班会话走官方正路（agents.get → resume → create，绝不重复 create 同一 id）')
    else bad('值班会话没走 agents.create/resume 官方通道')
    // 🔴 主人 2026-10-25 深夜纠正：「我要的就是后台 headless 常驻回复」——
    //    值班会话**必须不进工作区**（侧栏不许露脸）。机制：create 时带
    //    parentAgent + meta.parentSession/origin:'subagent'（照 dsh-subagent 的 childSessionMeta）。
    //    少了这组参数，它会变成一个顶层会话，侧栏「未分组」里就多一个。
    if (/parentAgent/.test(idxM) && /origin: 'subagent'/.test(idxM) && /delegationDepth: 1/.test(idxM)) ok('值班会话带 parentAgent + origin:subagent（不进工作区、侧栏不露脸）')
    else bad('值班会话没带 parentAgent/origin —— 会在侧栏「未分组」里多出一个会话')
    // 🔴 2026-10-26 凌晨根治：开关类字段以磁盘为准（宿主表单只是滞后的镜像）。
    //    病：每次插件重载，表单里旧的 chatWatch:false 会把内存刷停 ⇒ 盯梢静默断档
    //    （实测 54 秒空白，主人一句话漏在缝里）。
    if (/DISK_WINS/.test(idxM) && /'chatWatch'/.test(idxM) && /'chatWatchTarget'/.test(idxM)) ok('开关类字段以磁盘为准（重载不再被宿主表单刷停）')
    else bad('开关字段没走磁盘优先 —— 重载后 chatWatch 会被旧表单刷成 false，盯梢静默断档')
    /* 🔴🔴 2026-10-26 凌晨（主人：「如果是普通用户，他该怎么办，没那么聪明啊」）
     *  三道"普通人能自己活"的底线，少一条就得靠人盯着：
     *    ① 读失败自动重试（不是停在 error 等人点）
     *    ② 连续失败主动弹通知说人话（不是只写状态屏等人来看）
     *    ③ 面板有一键自救按钮（不会读日志的人点一下就够）
     */
    if (/chatWatchLastMs = Date\.now\(\) - sec \* 1000 \+ 15_000/.test(idxM)) ok('读私信失败会自动重试（15 秒后再试，不等人来点）')
    else bad('读失败没有自动重试 —— 普通用户只会觉得"它不回我"')
    if (/failStreak >= 3 && cwState\.notifiedKey !== notifyKey/.test(idxM)) ok('连续失败 3 次主动弹通知（且每种错只提醒一次，不刷屏）')
    else bad('连续失败不通知用户 —— 只写状态屏没人会去看')
    if (/path === '\/api\/douyin-duty\/chat\/fix'/.test(idxM) && /一键修好/.test(cliM)) ok('面板有「一键修好」按钮 + 后端自救接口')
    else bad('缺一键自救 —— 普通用户遇到问题只能干等')
    if (/need_user/.test(idxM) && /还差一步/.test(cliM)) ok('自救失败时明确告诉用户"还差哪一步"（不让用户自己猜）')
    else bad('自救失败没告诉用户该干嘛')
    /* 🔴🔴 2026-10-26 凌晨：挂载自愈 + 不许变成"关不掉的开关"
     *   自愈看的是独立的 intent 文件（chat-watch-intent.json），不是 config.json ——
     *   因为 config.json 会被别的写入路径意外改掉。
     *   而 intent **只有 patch 里明确带 chatWatch 时才更新** —— 否则用户点了关、
     *   下次改别的设置顺手把 intent 改成 true，重启后自己开回来 = 关不掉（比坏更气人）。
     */
    if (/chatIntentFile/.test(idxM) && /wantOn/.test(idxM) && /intent\.wantOn === true && cfg\.chatWatch === false/.test(idxM)) ok('挂载时会自己把开关恢复回上次的状态（重启不再偷偷停掉）')
    else bad('缺挂载自愈 —— 重启后开关可能被刷成 false，用户以为坏了')
    if (/hasOwnProperty\.call\(patch, 'chatWatch'\)/.test(idxM)) ok('intent 只在用户真动开关时更新（不会变成关不掉的开关）')
    else bad('intent 更新条件不对 —— 可能变成用户关不掉的开关（比不工作更气人）')
    /* 🔴 2026-10-26 凌晨实测的隐蔽坑：UTF-8 BOM
     *   PowerShell `Set-Content -Encoding UTF8` 写出的文件带 BOM（EF BB BF），
     *   JSON.parse 遇 BOM 直接抛 ⇒ readJson 静默返回 fallback ⇒ 上层读到"空配置"。
     *   表现极具欺骗性：文件内容肉眼完全正确，程序当它不存在。
     *   实测：自愈三条件全满足却永不触发，日志 intent=undefined，查了两轮才定位。
     */
    const stateSrc = readIf(join(here, 'lib', 'state.mjs'))
    if (/0xfeff/.test(stateSrc) && /charCodeAt\(0\)/.test(stateSrc)) ok('readJson 会剥 UTF-8 BOM（否则带 BOM 的 JSON 被当成空文件）')
    else bad('readJson 不剥 BOM —— PowerShell 写出来的配置文件会被静默忽略（踩过）')
    if (/ownerCtx|生命周期挂在|插件重载不杀它/.test(idxM) || /照 headless runner 的用法/.test(idxM)) ok('值班会话生命周期说明在案（挂宿主根，不随插件重载而死）')
    else warn('值班会话生命周期说明缺失 —— 排障时容易误判')
    if (/TEAM_LEAD_REQUIRED|Agent Teams 队友 ✗|插件不是 Lead/.test(idxM)) ok('记录了为什么不用 Agent Teams（TEAM_LEAD_REQUIRED，roster 挂 Lead 会话名下）')
    else warn('没记录弃用 Agent Teams 的原因 —— 下次探查会绕弯路')
    if (/退回前台/.test(idxM) && /值班鱼不在|值班会话没拉起来/.test(idxM)) ok('值班鱼缺席自动退回前台（消息绝不没人接）')
    else bad('值班鱼缺席没有回退 —— 鱼不在时私信会石沉大海')
    if (/clientTimeZone: pickClientTimeZone\(\)/.test(idxM)) ok('值班投递带 clientTimeZone（dsh-time-context 校验需要）')
    else bad('值班投递缺 clientTimeZone —— 那轮时区会变 unavailable')
    if (/消息投给/.test(cliM) && /值班小鱼/.test(cliM) && /chatWatchTarget/.test(cliM)) ok('面板有「消息投给」切换（前台/值班小鱼）')
    else bad('面板缺投递目标切换 —— 主人没法选消息投给谁')
  } catch (e) { bad(`4m 检查跑不起来：${e.message}`) }

  /* ═══ 2026-10-25 拆分守卫（原来这里是一大段桌宠检查）═══
   *  桌宠整体搬去 dsh-deskpet 了：窗口脚本 / PetHost / 人格档案 / pet* 配置
   *  都不在抖音仓库里了。这里改成守"拆分必须成立"的几条硬规矩：
   *    ① 抖音仓库里不许再有桌宠文件（搬走了就是搬走了，别留一半）
   *    ② 抖音侧不写 pet-window-state.json、不拉 PetHost（两个都干会互相覆盖）
   *    ③ 状态源在（deskpetStateSource）—— 这是两个插件唯一的连接点
   *    ④ petLinkTo 双登记（zod + DEFAULTS，同 chatWatch 的事故口径）
   *    ⑤ assets/pet/ 已从抖音仓库移除（私货跟着宠物走）
   */
  for (const gone of ['tools/pet-page/index.html', 'tools/pet-host/PetHost.cs', 'prompts/deskpet-personas/infp.json', 'lib/pet-tts.mjs']) {
    if (!existsSync(join(here, gone))) ok(`桌宠文件已搬走（${gone} 不在本仓库）`)
    else bad(`桌宠文件还在本仓库：${gone} —— 应该在 dsh-deskpet`)
  }
  {
    const idxCode = idx.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    if (/petStateOf/.test(idxCode) && /deskpetStateSource/.test(idxCode)) ok('状态源在（petStateOf + deskpetStateSource 注册）')
    else bad('状态源没了 —— 桌宠那边拿不到抖音的状态')
    if (/petWinWrite|pet-window-state\.json/.test(idxCode)) bad('抖音侧还在写 pet-window-state.json —— 会跟桌宠互相覆盖')
    else ok('抖音侧不写窗口状态文件（归桌宠）')
    if (/PetHost\.exe|spawn\(hostExe/.test(idxCode)) bad('抖音侧还在拉窗口进程 —— 会跟桌宠抢实例')
    else ok('抖音侧不拉窗口（归桌宠）')
    if (/petLinkTo:\s*z\.boolean\(\)/.test(idx) && /petLinkTo:\s*true/.test(idx)) ok('petLinkTo 双登记（zod + DEFAULTS）')
    else bad('petLinkTo 没双登记 —— 联动开关点了没反应（同 chatWatch 的事故口径）')
    if (!existsSync(join(here, 'assets', 'pet'))) ok('assets/pet/ 已从本仓库移除（私货跟着桌宠走）')
    else warn('assets/pet/ 还在 —— 只是本地素材，确认是有意保留')
  }
  if (/slots\.inject\('shell\.overlay'/.test(cl)) bad('还在往 shell.overlay 注册桌宠（会跟桌面窗出两只）')
  else ok('GUI 内没有桌宠浮层')
  // 状态优先级
  if (/state = 'run'/.test(idx) && /state = 'sleep'/.test(idx) && /state = 'watch'/.test(idx)) ok('状态机四态齐（run/watch/sleep + 兜底 idle）')
  else bad('状态机不完整')
} catch (e) { bad(`消息/聊天检查失败：${e.message}`) }

/* ── 4o. 自动发送总开关 + 跑一轮的失败反馈（2026-10-22 用户要求） ── */
console.log('\n4o. 自动发送开关 + 跑一轮反馈')
try {
  const idx = readFileSync(join(here, 'index.js'), 'utf8')
  const cl = readFileSync(join(here, 'client.js'), 'utf8')

  // ① 配置项：autoSend 默认**必须是 true**（2026-10-22 用户明确要求"默认就是要发消息"）
  if (/autoSend:\s*z\.boolean\(\)\.default\(true\)/.test(idx)) ok('autoSend 配置项在，默认 true（用户要求：默认就发）')
  else bad('autoSend 默认不是 true —— 用户要的是"默认就发消息"')
  if (/autoSend:\s*true/.test(idx)) ok('DEFAULTS 里 autoSend = true')
  else bad('DEFAULTS 里 autoSend 不是 true')

  // ② 提示词必须真的按这个开关分流
  if (/!cfg\.autoSend[\s\S]{0,400}?一个字都不要往抖音发/.test(idx)) {
    ok('自动跑的提示词：autoSend 关着时明确禁止发送')
  } else bad('提示词没按 autoSend 分流 —— 关了也可能发')
  if (/自动发送开着/.test(idx)) ok('autoSend 开着时提示词会放开（并区分评论开关）')
  else bad('autoSend 开着时提示词没变化')

  // ③ 面板必须有开关，而且要在**显眼位置**（不能埋在长面板底部）
  // 🔴 2026-10-24 主人令：面板重排——「开始使用」置顶，第二张才是「刷抖音」（含自动发送）。
  //    旧的顺序约定（自动发送在开始使用之前）作废；新约定：开始使用 → 刷抖音 → 自动发送 → 评论区@我
  if (/自动发送/.test(cl) && /autoSend/.test(cl)) ok('面板有「自动发送」开关')
  else bad('面板没有自动发送开关')
  {
    const iStart = cl.indexOf("'开始使用'")
    const iAuto = cl.indexOf("'自动发送'")
    if (iStart > 0 && iAuto > iStart) ok('「开始使用」置顶、自动发送在其后（2026-10-24 主人令的新顺序）')
    else bad(`卡片顺序不对（开始使用@${iStart} 自动发送@${iAuto}）—— 开始使用应置顶`)
  }

  /* ── ④ 「评论区 @ 提醒」（0.5.9：开关=总闸 + atPeers 多选） ── */
  if (/commentAtMe:\s*z\.boolean\(\)\.default\(false\)/.test(idx)) ok('commentAtMe 配置项在，默认 false（它是总闸）')
  else bad('缺 commentAtMe 配置项')
  if (/atPeers:\s*z\.array\(z\.object/.test(idx)) ok('atPeers 配置项在（@ 名单，多选）')
  else bad('缺 atPeers（@ 名单）')
  if (/评论区 @ 提醒/.test(cl)) ok('面板有「评论区 @ 提醒」区块')
  else bad('面板没有「评论区 @ 提醒」')
  // 位置：自动发送之后（2026-10-24 重排后它在开始使用/状态卡之后的自动发送卡里）
  {
    const iSend = cl.indexOf("'自动发送'")
    const iAtMe = cl.indexOf("'评论区 @ 提醒'")
    if (iSend >= 0 && iAtMe > iSend) ok('「评论区 @ 提醒」位置正确（自动发送下面）')
    else bad(`「评论区 @ 提醒」位置不对（自动发送@${iSend} @提醒@${iAtMe}）`)
  }
  // 提示词必须真的让模型去做这件事
  if (/「评论区 @ 提醒」开着 —— 这是这一轮的重点任务/.test(idx)) ok('提示词写了「评论区 @ 提醒」的具体做法')
  else bad('提示词没写怎么在评论区 @ 提醒 —— 开了也不会发')
  if (/只在\*\*最值得的那一条\*\*发/.test(idx)) ok('限制只发最值得的 1 条（不会刷屏）')
  else bad('没限制条数 —— 可能每条都发')
  if (/只管「插件自己在后台跑的轮次」/.test(cl)) ok('面板说清了适用范围（只管后台轮次，不影响当场对话）')
  else bad('面板没说清适用范围 —— 用户会以为当场也不能发')

  // ④ 跑一轮失败要能看见原因
  if (/diagnoseFailure/.test(idx)) ok('有失败诊断（能认出 429 限流 / 找不到 dsh / 没登录 / 超时）')
  else bad('没有失败诊断 —— 只给一个退出码，用户看不懂')
  if (/RATE_LIMIT/.test(idx) && /rate_limit/.test(idx)) ok('能识别上游 429 限流（这是最常见的假故障）')
  else bad('认不出 429 限流')
  if (/lastFailure/.test(idx)) ok('失败原因会进通知（不是干巴巴一句"没产出报告"）')
  else bad('失败原因不进通知')

  // ⑤ /run 不许再谎报 ok:true
  if (/const started = r && r\.started === true/.test(idx)) ok('/run 只在真启动时返回 ok:true（不再谎报）')
  else bad('/run 还是无脑 ok:true —— 点了没反应还显示"已开跑"')
  if (/message: started/.test(idx)) ok('/run 返回一句人话给面板')
  else bad('/run 没给面板可显示的消息')

  // ⑥ 面板要有"看日志"
  if (/看日志/.test(cl) && idx.includes('/api/douyin-duty/log')) ok('面板有「看日志」（点了没反应能自己排查）')
  else bad('面板没有看日志入口')

  /* ── ⑦ 模型跟随：注释行必须能匹配 ──
   * 🔴 2026-10-22 真 bug：桌面版那行是 `- id: agent-default-model # magpie`（带注释），
   *    旧正则要求 id 后直接行尾 ⇒ 永远匹配不到 ⇒ overlay 不写模型
   *    ⇒ headless 用它自己那份错的 `workbuddy-ai/...` ⇒ 每轮一启动就 429。
   */
  // 判据：源码里那行正则必须带 `(?:#.*)?`（允许行尾注释）
  if (idx.includes('(?:#.*)?$') && /agent-default-model/.test(idx)) ok('模型跟随的正则允许行尾注释（这是 429 的根因）')
  else bad('模型跟随的正则不接受 `# 注释` —— overlay 会漏写模型，headless 用错通道')
  if (/overlay: 模型跟随桌面版/.test(idx)) ok('overlay 会记"模型跟随桌面版"')
  else bad('overlay 没记录模型跟随')

  /* ── ⑧ 通知正文要能从报告里解析出真内容 ──
   * 🔴 2026-10-22 真 bug：toastSummary 只认旧格式（`- **文案摘要**：`），
   *    但 duty.md 现在写成 `**《标题》** · @作者` ⇒ 通知正文变成"（第 1 条）"。
   */
  try {
    const toast = readFileSync(join(here, 'lib', 'toast.mjs'), 'utf8')
    const sample = [
      '## 值得看',
      '### 7676464210544570726',
      '**《烟火里的江西》家常美食「香辣鸡爪」** · @烟火里的江西 · 39.6 秒',
      '**一句话**：一个能照着做的鸡爪方子。',
      '',
      '### 7691197955269956233',
      '**星星之火，可以燎原** · @方面面 · 57.6 秒',
      '**一句话**：一张纸烧完露出底下的画。',
    ].join('\n')
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { toastSummary } from ${JSON.stringify(new URL('./lib/toast.mjs', import.meta.url).href)};`
      + `const s = toastSummary(${JSON.stringify(sample)}, {day:'x'});`
      + `console.log(JSON.stringify({title:s.title,body:s.body,picked:s.picked}))`], { encoding: 'utf8', timeout: 30_000 })
    const j = JSON.parse(String(r.stdout || '{}').trim() || '{}')
    if (j.picked === 2 && /烟火里的江西/.test(j.body) && /星星之火/.test(j.body)) {
      ok('通知正文能从新格式报告里解析出真标题（不再是"（第 1 条）"）')
    } else bad(`通知解析失败：${JSON.stringify(j).slice(0, 200)}`)
  } catch (e) { bad(`通知解析测试失败：${e.message}`) }
} catch (e) { bad(`自动发送/跑一轮检查失败：${e.message}`) }

/* ── 4p. 这几个坑不许再回来（2026-10-30，Issue #3 / #5 / #6 / #7 / #8） ── */
console.log('\n4p. 排障质量：真因不许再被吞掉')
try {
  const idx = readFileSync(join(here, 'index.js'), 'utf8')
  // #6① asar 里的脚本只有 Electron 能读；拿独立 node 跑必然 MODULE_NOT_FOUND
  if (/isAsarPath/.test(idx) && /jsRunnerFor\(/.test(idx) && !/jsRunner\(\)/.test(idx)) {
    ok('dsh 入口按目标路径分派解释器（asar → Electron），没有裸 jsRunner()')
  } else bad('index.js 又回到「一律优先独立 node」—— asar 内的 cli.js 会 MODULE_NOT_FOUND（Issue #6①）')
  if (/r\.status !== 0\) return false/.test(idx)) {
    ok('runnable 要求 status=0 **且** 带版本号（不再「有版本形状就算过」）')
  } else bad('runnable 又变成「有版本号就算通过」—— 假阳性会让真跑时才炸（Issue #6①）')
  // #6③ webServer 只有桌面/web 版有，留在 inject 会让 headless 永不激活
  const injectLine = (idx.match(/export const inject = \[([^\]]*)\]/) || [])[1] || ''
  if (!/webServer/.test(injectLine) && /export const optional = \[[^\]]*webServer/.test(idx)) {
    ok('webServer 在 optional 里（headless 没有它，值班轮才跑得起来）')
  } else bad('webServer 又进 inject 了 —— headless 会 pending 到天荒地老（Issue #6③）')

  // #7① Python 脚本不许写死 node 路径（绿色版 / nvm 的机器直接 FileNotFoundError）
  // ⚠️ 只查**赋值**（`NODE = r"C:\Program Files\…"`）—— 注释里提到那个路径是记账，不是耦合
  const pyFiles = readdirSync(join(here, 'tools')).filter((x) => x.endsWith('.py'))
  const hard = pyFiles.filter((f) => /=\s*r?["']C:\\Program Files/i.test(readFileSync(join(here, 'tools', f), 'utf8')))
  if (!hard.length) ok(`没有 Python 脚本写死 node 路径（查了 ${pyFiles.length} 个）`)
  else bad(`这些还写死 node 路径：${hard.join(', ')} —— 绿色版 node 会 FileNotFoundError（Issue #7①）`)

  // #7② 会被 MCP 读 stdout 的脚本必须钉 utf-8（GBK 控制台遇 emoji 直接崩）
  const needUtf8 = ['api-comments.py', 'api-reply.py', 'notice-read.py', 'session-guard.py', 'doctor.py', 'forward-pick.py', 'im-http.py']
  const missUtf8 = needUtf8.filter((f) => {
    const t = readFileSync(join(here, 'tools', f), 'utf8')
    return !/utf8_stdio\(\)|reconfigure\(encoding/.test(t)
  })
  if (!missUtf8.length) ok('会打昵称 / emoji 的 Python 脚本都钉了 utf-8')
  else bad(`这些脚本没钉 utf-8：${missUtf8.join(', ')} —— UnicodeEncodeError 会吃掉真因（Issue #7②）`)

  // #8① 「进程根本没起来」和「CDP 连不上」必须分开报
  const chrome = readFileSync(join(here, 'lib', 'chrome.mjs'), 'utf8')
  if (/'exit'/.test(chrome) && /SingletonLock/.test(chrome)) {
    ok('无头浏览器失败会区分「进程没起来」和「CDP 连不上」，并提示查残留进程')
  } else bad('ensureChrome 又只报「60 秒连不上 CDP」—— profile 被占的线索全丢了（Issue #8①）')

  // #8② MCP 层吞 error = 排障成本放大器
  const mcpText = readFileSync(join(here, 'tools', 'mcp-server.mjs'), 'utf8')
  if (/const explain =/.test(mcpText) && /stderr_tail/.test(mcpText) && /\.\.\.explain\(j, r\)/.test(mcpText)) {
    ok('MCP 层把子脚本的 error / hint / stderr_tail 原样透出')
  } else bad('MCP 层又把 error 吞了（Issue #8②）')

  // #5 webhook 地址不校验 = 本机变内网跳板
  const notifyText = readFileSync(join(here, 'lib', 'notify.mjs'), 'utf8')
  if (/export function checkWebhookTarget/.test(notifyText) && /checkWebhookTarget\(target/.test(notifyText)) {
    ok('webhook 发之前先校验目的地址（回环 / link-local / 云元数据全拦）')
  } else bad('sendWebhook 又把地址直接丢给 fetch 了（CWE-918，Issue #5）')

  // #3 关键词只能是软偏好，不能变硬筛
  const fpText = readFileSync(join(here, 'tools', 'forward-pick.py'), 'utf8')
  if (/kw_hits/.test(fpText) && /不参与采集、不硬筛/.test(fpText)) {
    ok('关键词只做软加分（命中的排前面，不硬筛）')
  } else bad('关键词要么没接上，要么被做成硬筛了（Issue #3：硬筛会把意外惊喜筛没）')
} catch (e) { bad(`排障质量检查失败：${e.message}`) }

/* ── 4e. 采集门槛 / 跨天记账 ── */
console.log('\n4e. 采集门槛 / 跨天')
try {
  const idx = readFileSync(join(here, 'index.js'), 'utf8')
  const fp = readFileSync(join(here, 'tools', 'forward-pick.py'), 'utf8')
  // ⚠️ 键名是 camelCase（index.js 的 syncCollectorCfg 就写 minDescLen / minComments），
  //    以前这里检查的是 snake_case，跟真实数据不符 ⇒ 永远红。
  if (/collector\.json/i.test(fp) && /minDescLen/.test(fp) && /minComments/.test(fp)) {
    ok('forward-pick.py 真的读 collector.json（设置页的阈值不再空转）')
  } else bad('forward-pick.py 没读 collector.json —— 设置页的「文案太短 / 评论少」两个旋钮是死的')
  if (/"dropped"/.test(fp) && /short_and_quiet/.test(fp)) {
    ok('forward-pick.py 产出 dropped（报告能写清因什么跳过几条）')
  } else bad('forward-pick.py 没有 dropped —— prompt 让模型数数，证据包里却没有')
  if (/dropped:\s*picked\.dropped/.test(idx)) ok('round-evidence.json 带上了 dropped')
  else bad('index.js 的证据包没带 dropped')
  if (/'--limit'/.test(idx)) ok('「每次最多筛选几个」传给了 forward-pick.py（--limit）')
  else bad('maxPerRun 没有传给采集脚本 —— 超过 10 条永远不生效')
  if (/const rollDay/.test(idx) && /rollDay\(\)/.test(idx) && /dayKey\(\)/.test(idx)) {
    ok('state.json 跨天会自己翻篇（不再停在旧日期）')
  } else bad('没有跨天翻篇 —— 长时间挂着插件时 state.json 会一直停在旧日期')
} catch (e) { bad(`采集门槛检查失败：${e.message}`) }

/* ── 5. Python 能否编译 + 判断层能否跑 ── */
console.log('\n5. Python')
const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const ver = spawnSync(py, ['--version'], { encoding: 'utf8' })
if (ver.status === 0) {
  ok(`${py} → ${(ver.stdout || ver.stderr || '').trim()}`)
  const files = readdirSync(join(here, 'tools')).filter((x) => x.endsWith('.py')).map((x) => join('tools', x))
  const c = spawnSync(py, ['-m', 'py_compile', ...files.map((f) => join(here, f))], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } })
  if (c.status === 0) ok(`Python 语法全过（${files.length} 个文件）`)
  else bad(`Python 编译失败：${(c.stderr || '').split('\n').slice(0, 5).join(' ')}`)

  // ⭐ 真正的价值：跑一遍判断层自检
  const s = spawnSync(py, [join(here, 'tools', 'smoke.py')], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } })
  if (s.status === 0 && /判断层是通的/.test(s.stdout || '')) ok('判断层自检通过（tools/smoke.py）')
  else {
    bad('判断层自检没有通过')
    console.log((s.stdout || '').split('\n').slice(0, 20).map((l) => '     ' + l).join('\n'))
    if (s.stderr) console.log((s.stderr || '').split('\n').slice(0, 8).map((l) => '     ' + l).join('\n'))
  }
} else {
  warn(`没有可用的 python（试过 "${py}"）—— 装完依赖后采集脚本才需要它，预检这一步可以跳过`)
}

/* ── 5b. 装机流程：先检查环境，再装依赖 ── */
console.log('\n5b. 装机流程（先检查，再装）')
try {
  const doc = readFileSync(join(here, 'tools', 'doctor.mjs'), 'utf8')
  // ① doctor 必须纯 Node —— 第一次装的时候还没有 Python
  if (/from '\.\.\/lib\/(paths|chrome)\.mjs'/.test(doc) && !/spawnSync\([^)]*doctor\.py/.test(doc)) {
    ok('doctor.mjs 是纯 Node（不需要 Python 就能跑）')
  } else bad('doctor.mjs 依赖了 Python —— 第一次装时必然「环境没装好」，用户卡死')
  // ② 设置页必须是「先装环境 → 再登录」的顺序（文案可变，位置不能变）
  //    ⚠️ 2026-10-22 面板改版：从「① 检查环境 / ② 装依赖」变成
  //       「第①步 装环境 / 第②步 扫码登录」，并额外保留一个「检查环境」按钮（出问题时用）。
  //    判据用**步骤序号 + 各自的完成条件**（比在代码里找中文稳）：
  //       第 1 步的完成条件是 st.venvReady（装环境），第 2 步是 st.loggedIn（登录）。
  const cl = readFileSync(join(here, 'client.js'), 'utf8')
  const step1 = /st\.venvReady \? '' : undefined \}, st\.venvReady \? '✓' : '1'/.test(cl)
  const step2 = /st\.loggedIn \? '' : undefined \}, st\.loggedIn \? '✓' : '2'/.test(cl)
  const i1 = cl.indexOf("st.venvReady ? '✓' : '1'")
  const i2 = cl.indexOf("st.loggedIn ? '✓' : '2'")
  if (step1 && step2 && i1 > 0 && i2 > i1) ok('设置页顺序正确：第 1 步装环境 → 第 2 步扫码登录')
  else bad(`设置页没有「先装环境再登录」的步骤顺序（step1=${step1}@${i1} step2=${step2}@${i2}）—— 用户不知道该先做什么`)
  // ③ 体检入口还在（出问题时能查）
  if (/检查环境/.test(cl)) ok('设置页保留「检查环境」按钮（出问题时用）')
  else bad('设置页没有环境体检入口')
  // ④ 扫码之后可能要过验证 —— 必须告诉用户
  if (/短信验证码|滑块/.test(cl)) ok('设置页写明了扫码后可能还要过短信/滑块验证')
  else bad('设置页没提扫码后的验证 —— 用户会以为扫码失败，反复重扫')
  const qr = readFileSync(join(here, 'tools', 'qr-login.mjs'), 'utf8')
  // ⚠️ 2026-10-22 重构：验证识别逻辑从 `verifyHint` 字符串搬到了 `doCheck()` 的结构化返回
  //    （check 和 watch 共用）。所以查的是「有验证识别」这件事本身，不是某个变量名。
  const hasVerifyProbe = /短信验证码/.test(qr) && /滑块\/拼图/.test(qr) && /verifyKinds|verifyKinds\.length|verify:/.test(qr)
  if (hasVerifyProbe) ok('qr-login.mjs 会识别「卡在验证」并说清卡在哪一步（短信 / 滑块 / 新设备）')
  else bad('qr-login.mjs 只看 cookie —— 用户卡在验证页时只会被告知「还没扫」')
} catch (e) { bad(`装机流程检查失败：${e.message}`) }

/* ── 6. 外部工具（可选） ── */
console.log('\n6. 可选外部工具')
// ⭐ 用 lib/chrome.mjs 的探测逻辑，别再各写一份写死的路径（换台机器就误报）
const found = findBrowser()
if (found) ok(`浏览器已找到：${found}（无头发私信 / 卡片 / 评论要用它）`)
else warn('没找到 Chrome / Edge / Chromium —— 发私信 / 卡片 / 评论会失败；'
  + '装一个，或把完整路径写进环境变量 DOUYIN_BROWSER')
const dsh = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8' })
if (dsh.status === 0) ok('dsh 在 PATH 里')
else warn('dsh 不在 PATH —— 桌面版正常（插件会自动去应用目录找）；npm 装的请确认 PATH')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  console.log('有失败项 —— 先把上面标 ❌ 的修掉再装。')
  process.exit(1)
}
console.log('预检通过。下一步：dsh plugin --profile web add link:<本目录绝对路径>，然后重启 dsh。')
