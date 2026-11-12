# 给 AI 助手看的（本仓库 = 一个 DSH 插件）

`dsh-douyin-scroll`（中文名「**刷抖音**」）：把「刷抖音」做成一条值班链路 ——
取候选 → 打分 → 出一份清单 → 按需发到使用者眼前。
**不看画面、不做 ASR/OCR、不读视频内容。** 判断只用：文案 / 标签 / 作者 / 时长 /
点赞·评论·收藏·转发 / 高赞评论文本。

## 帮用户安装时，按这个顺序

1. **先跑预检**（不用装 DSH）：
   ```bash
   node selfcheck.mjs          # 462 项
   python tools/smoke.py       # 想先看见"判断长什么样"，跑这个（离线示例数据）
   ```
2. **装插件**：`dsh plugin --profile web add link:<本目录绝对路径>`
3. ⚠️ **必须提醒用户重启一次 dsh** —— bundle 层要重启才组装，不重启插件不生效。
4. 重启后进 **设置 → 刷抖音**：
   - 点「**装主依赖**」（建 venv，装 `curl_cffi` + `httpx`，约 30 秒）
   - **登录**：命令行 `node tools/qr-login.mjs start` 扫码（这是唯一会开可见浏览器的场景），
     或者把浏览器里的 Cookie 请求头粘到设置页
   - 点「**测一下**」→ 会话体检 + 试取一次候选

## 三条路（2026-10-21 定型，别再自己加第四条）

| 干什么 | 怎么走 | 需要登录? |
|---|---|---|
| 取候选 / 出清单 | **不签名**的只读接口 `tab/feed` + `hot/search` | 要（Cookie） |
| 读评论 / 读通知（含「评论区 @ 我」） | **签名只读**（`tools/dy-signer.mjs` 出 a_bogus） | 要 |
| 发私信 / 发卡片 / 发评论 | **无头 Chrome** 里跑抖音自己的前端 | 要 |

- ⚠️ **可见浏览器只在扫码登录时用一次**。其余全是无头 Chrome 或纯 HTTP，屏幕上不出现窗口。
- ⚠️ **发任何东西前必须先问使用者**（`confirm: true` 闸，不传只回草稿）。

## 五条实测教训（别再踩）

1. **自己算签名打写接口 = 403**。写接口要强签名 `getBdTicketGuardHeader`，外部补不齐。
   ✅ 正解：在**无头页面的上下文里发 fetch**，让页面自己签。
2. **点评论区 UI 发评论会弹短信验证**（还要展开面板、滚视口、找按钮）。
   ✅ 正解：`douyin_comment_reply`（一条 fetch），200 拿到 `cid`，不弹验证。
   ⚠️ **但 `@` 提及是例外**（第 5 条）。
3. **文本网址在抖音里点不开**，只有**分享卡片**能点。
   ✅ 正解：`douyin_share_card`（无头页面点「分享给朋友」）。
   ⚠️ 分享面板是 `onMouseEnter` 触发的 hover 弹窗，`el.click()` 打不开，必须用真实鼠标轨迹。
4. **私信里 `message.isMyMessage` 恒为 true** —— 连对方发的消息也是 true，拿它判"谁发的"
   试了三次全错（还害我以为回读只能数条数）。三层祖先 class 名也一样、消息行都是整行宽。
   ✅ 正解：**看那枚 36×36 头像落在列表左半边（对方）还是右半边（我）**；
   同一人连发时只有组里最早那条带头像 ⇒ **倒着遍历（DOM 是新的在上）继承**；
   继承不到的给 `unknown`，别猜。见 `tools/im-send.mjs` 的 `readMessages()`。
5. **`@` 提及只有 UI 点选才算数**（2026-10-21 实测矩阵，别再从 API 上打主意）。
   API/XHR 直发时，无论 payload 怎么对齐前端抓包，服务端都会把 mention 的 `sec_uid` 剥掉：
   名字照样变蓝，但点开是空页、对方**收不到通知**（服务端只信"前端点选"这个来源）。
   ✅ 正解：`tools/comment-mention-ui.mjs` —— 滚输入区进视口 → 真实点开 DraftJS →
   CDP 键盘打 `@`（execCommand 不触发弹层）→ 真实鼠标点选弹层里那一行 →
   execCommand 补正文 → 点右下红色箭头（svg `fill=FE2C55`）。
   ⚠️ 发布后进程记得 `ws.close()`，否则脚本挂着不退出（踩过）。

## 已经被砍掉的东西（别再加回来）

- `vendor/douyin-mcp/`（33 文件 / 506 KB 的内置 Python MCP）+ `lib/mcp.mjs`
  —— 走 bb-browser / playwright / cookie 三个驱动，**一个真数据都没跑通过**，还绑着"必须开浏览器"。
- `tools/im-drive.mjs` / `tools/headless-im.mjs` —— 只做「点开会话 + dump 整页文本」，
  读不出谁发的。`douyin_im_read` 改用 `tools/im-send.mjs --read` 了。
- 关键词搜索：抖音 web **没有**可用搜索接口（`general/search` 被 2483 挡），只有推荐流。
- 「采集来源」这个配置项（feed/bbbrowser/browser/cookie/manual）一起没了 —— 只剩一条路。

## 仓库结构

- `index.js` —— 宿主半端：Config（逐字段 `.extra('volatile', true)`）、工具注册、谷时定时器、
  `runDuty`（**先在插件里抓好证据包 `round-evidence.json`，再起 headless 那一轮**）、
  overlay 生成、`/api/douyin-duty/*`、health.json
- `client.js` —— 浏览器半端：**非 ESM**，`window.__ModuleLoader__.load({ id:'dsh-douyin-scroll', … })`，
  往 `settings.section` 插一页
- `tools/` —— 脚本全在，都是真在用的（`forward-pick.py` / `notice-read.py` / `api-comments.py` /
  `comment-api.mjs` / `card-share.mjs` / `im-send.mjs` / `qr-login.mjs` / `session-guard.py` / `dy-signer.mjs` …）
- `lib/` —— `hostdeps` / `state` / `credential` / `notify` / `toast`（**默认通知方式**）/ `uvfetch`
- `prompts/persona.md` —— **我的人设（插件自带，第一行 `<!-- persona: douyin-scroll -->`）**。
  `runDuty` 只从这里读身份与口吻，**插件外面任何目录都不读**
- `prompts/duty.md` —— 一轮的章程（判据 + 红线 + **交作业靠 `runs/<roundId>.submission.json`**；报告 `### <纯数字ID>` 只是给人看的导航）。章程只写"怎么干活"，不写人设
- `requirements.txt` —— 只有 `curl_cffi` + `httpx`

## 约定与红线

- 🔴 **人设分家**（2026-10-21 立的规矩）：**一个插件只读自己带的那份，绝不读外面的设定。**
  - 人设在 `prompts/persona.md`（插件包内，第一行带 `<!-- persona: douyin-scroll -->` 身份牌）。
  - `runDuty` 只从**插件自己**读这一个文件；配置项 `workspace` **已删除** ——
    它原来是"读那个目录下的 AGENTS.md 当人设"，正是那个口子让插件能读到**别的插件**的设定。
  - 踩过的坑：一个插件的台词被抄进了**另一个插件**的章程，两边的话术串了。
    现在物理上读不到外面的文件，这条路堵死了。
  - `selfcheck` 的 4d 段守着：人设来源、身份牌、口子有没有被重新打开。
  - ⚠️ **章程（`duty.md`）随包发布，里面不许出现任何具体口吻** ——
    表情符号、具体自称、特定的语气词都不行。口吻只许住各自那份 `persona.md`。
- 🔴 **先卡片，后文字**（使用者 2026-10-21 亲自立的规矩）：既要发卡片又要发文字时，
  **永远先卡片、隔几秒再文字**。反过来他先看到一句话、却不知道在说哪条视频。
  `douyin_share_card` 传 `reason` 就自动按这个顺序办，**不要再补一次 `douyin_dm`**。
  代码里有一道软拦（`orderWarning`）：刚给同一个人发过纯文字、又要发卡片时，返回值会带 `order_warning`。
- 配置与运行数据都在 `$DSH_HOME/douyin-duty/`，**不写进插件包目录**
- **Cookie / webhook URL 一律先脱敏再进日志**
- **永不静默降级**：拿不到就写"没拿到"，不许编、不许拿旧数据凑
- **发东西三道闸**：`confirm` 参数 + 设置里的开关 + 使用者当场点头
- **消息必须真能到用户眼前**：默认 `notifyMode=toast`（Windows 通知，零配置）
- 定时器回调里的异常**必须自己兜住** —— 未捕获异常会杀掉整个宿主进程
- 报告（`out/<日期>.md`）是**给人看的**；宿主记账只信 `runs/<roundId>.submission.json`（结构化 receipt）——通知、配额、面板计数全部来自它，报告格式不影响数据
