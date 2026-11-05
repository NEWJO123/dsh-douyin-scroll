# v0.7.3

## 0.7.3 — 2026-11-05（批量修复：17 个隐藏 bug，含 3 个隐私/凭证问题）

> 这次是把「装插件的人会撞上、但自己解决不了」的问题集中修了一批。
> 来源：B 站使用者反馈（设置页卡「读设置中」）+ 我自己按「全新用户 / 已装用户 / mac-Linux 用户 /
> 网络差用户」逐个模拟安装启用流程挖出来的。每一条都有实测或对照证据，每条都补了防回归断言。

## 🔴 会让你「用不了」的

**1. 设置页一直停在「读设置中」**（B 站使用者反馈）

面板加载只试一次、没有重试，而且失败信息被 `if (alive)` 挡住 —— 面板在加载途中被宿主重新挂载时
错误直接丢掉，界面既不报错、也不出「重新读取」按钮。刚装完、刚重启 DSH 时最容易撞上。
→ 改成失败自动重试 3 次（间隔递增），重试期间显示「正在重试（第 N/3 次）：原因」，
3 次都失败才给「重新读取」按钮。还修了一个隐蔽的坑：三次重试共用同一个超时控制器，
第一次 12 秒超时 abort 之后后面所有重试都会立刻失败。

**2. mac / Linux 装好了环境，功能却说「还没装运行环境」**

`index.js` 有 3 处、`tools/forward-run.mjs` 有 1 处、`tools/api-reply.py` 有 1 处**写死了 Windows 的 venv 路径**
（`.venv\Scripts\python.exe`）。mac / Linux 上 venv 的 python 在 `.venv/bin/python`，那个文件永远不存在 ⇒
用户装完环境、扫完码，点「读通知」直接报「还没装运行环境」，**他会以为装失败、反复重装**。
→ `lib/paths.mjs` 新增唯一入口 `venvPython()`（按平台给路径），所有调用点统一走它。

**3. 环境装坏一半，面板却显示「环境就绪」**

`setupFiles()` 只检查目录存不存在，不检查能不能真的 import。实测造一个「目录都在、包是空壳」的环境，
它返回 `pythonReady: true` ⇒ 面板显示就绪，用户点「跑一轮」才失败，报错还含糊。
→ 新增真 import 探针；`venvReadyNow()` 改用它判断。

**4. 安装可能永远卡在「安装中…」**

装依赖用的 `spawnTo` **没有超时**。`pip install` 卡在镜像站/代理上时 Promise 永不返回 ⇒
`installing` 永远 true ⇒ 面板永远「安装中…」、按钮全灰，用户只能重启赌一把，
而重启后 `.venv` 可能还是半成品。
→ 加超时（默认 10 分钟），超时先 SIGTERM、5 秒后还在就 SIGKILL，并写明确原因。
`probeCmd`（探测 `uv --version`）也加了 20 秒超时。

**5. 没登录时 4 个 Python 脚本抛 `FileNotFoundError` 堆栈**

`notice-read` / `api-comments` / `api-reply` / `forward-pick` 都是模块顶层裸读 `douyin_cookie.txt`。
新用户装完环境、还没扫码就点工具时，会看到一大段 traceback —— **以为插件装坏了**。
而且自动值班的 `buildEvidence` 每轮都要走 `forward-pick.py`，整轮会直接失败。
→ 统一加兜底，读不到就输出结构化错误并 `exit(2)`：
```json
{"ok": false, "error": "还没有登录（没有 douyin_cookie.txt）",
 "hint": "先在设置页扫码登录（或粘一条 Cookie），再读通知", "stage": "cookie"}
```
上层 `index.js` 也修了：原来只读 `stderr`，但结构化错误在 `stdout` ⇒ 用户只看到笼统的「取候选失败」。
现在失败时先解析 stdout 的 JSON，把 `error` / `hint` 透出来。

## 🔴 隐私 / 凭证

**6. Cookie 带 BOM 会让所有请求崩**

用户在 Windows 记事本 / PowerShell 里**粘贴 Cookie**，文件会带 UTF-8 BOM（U+FEFF）。
带 BOM 的 Cookie 塞进 `curl_cffi` 请求头会直接：
```
UnicodeEncodeError: 'latin-1' codec can't encode character '\ufeff' in position 0
```
这个报错**完全不指向「文件带 BOM」**，用户只会觉得插件坏了 —— 而设置页明确支持「粘一条 Cookie」，
这条路一定会有人走。**6 个脚本全中**（各自裸读 cookie，谁都没剥 BOM）。
→ `tools/_home.py` 新增 `read_cookie_text()` 作为**读 Cookie 的唯一入口**，剥 BOM + 兜底；6 个脚本全部改走它。

**7. Slack webhook 地址不脱敏，凭证进日志**

`maskUrl` 只按「路径末段 ≥16 字符」判 token，而 **Slack 的 webhook 末段往往只有 8~12 个字符** ⇒
整条 URL（含完整凭证）被原样写进 `duty.log`。实测：
```
https://hooks.slack.com/services/T00AAAAAA/B00BBBBBB/abcdefghijk  →  没打码
```
（Discord / 飞书 / 企微 / 钉钉 都能正常打码，只有 Slack 漏）
Slack 的 webhook URL 本身就是 credential —— 拿到就能往群里发任意消息。
→ `maskUrl` 先按已知平台形状处理：Slack 的 `/services/` 后面整段都算凭证，打码成 `/services/***`。

## 🔴 数据安全

**8. 状态文件不是原子写，并发下会读到半截 JSON**

`writeJson` 直接覆盖写。并发压测（一个进程狂写、另一个进程狂读）：

| 写法 | 读取次数 | 读到坏 JSON |
|---|---|---|
| 直接 `writeFileSync` | 1582 | **16 次** |
| 写 tmp 再 `rename`（原子） | 2024 | **0 次** |

而 `readJson` 遇到坏 JSON 会返回 fallback ⇒ 后果很隐蔽：
- **配置**被读成坏 JSON → 回退默认值 →「我明明设过了，怎么又变回去了」
- **发送状态机**被读成坏 JSON → 当成「没发过」→ **同一条回复可能重复发出**（发出去了删不掉）
- **限流冷却**被读成坏 JSON → 当成「没被限流」→ 接着发就撞 403
- **端口记录**被读成坏 JSON → 白起一个浏览器

多窗口 / 多 profile / 后台轮次与面板同时写就会撞上。
→ `writeJson` 改成**原子写**（写 `<file>.tmp-<pid>-<rand>` 再 `renameSync`，失败回退直接写）；
`writeRuntime`、`comment-send` 两处状态写、`index.js` 的发送闸/冷却窗口两处写，全部改走它。

**9. 我自己引入的宿主卡顿（差点重犯 0.5.7 的卡死老坑）**

修第 3 条时，我在 `venvReadyNow()` 里加了同步 `spawnSync` 起 python 做 import 探针 ——
而它挂在 `/status`、`/run` 这些 **HTTP 接口**上，实测每次阻塞宿主 **659ms**。
这正是 0.5.7「装插件整个 DSH 卡死」的同一类错误，我自己又踩回去了。
→ 改成**两段式**：同步快速路径只看目录（**0ms**）+ 后台异步探针校准缓存。
实测：同步路径 0ms（原 659ms）；探针后台跑 727ms 期间事件循环正常转了 23 次，宿主完全没被摁住。

## 🟡 会让你「以为没事其实没收到」

**10. mac / Linux 用户默认收不到任何通知**

`notifyMode` 默认是 `toast`（Windows 通知），但 `lib/toast.mjs` 写死非 Windows 直接跳过。
所以 mac / Linux 用户装好、登录好、跑完一轮 —— **屏幕上什么都不会弹**，报告只写进文件。
而且面板和体检都不提示这件事，用户会以为插件没跑。
→ `/status` 增加 `toastSupported` / `platform`；面板在非 Windows 上标注「这个平台收不到」
并建议改用 Webhook 或仅保存文件；体检（doctor）补一行「通知通道」。

## 其它

- **文档里的「预检 N 项」过期**：README / AGENTS / PUBLISH 三处还写着 374，实际已经涨到 402。
  而且这三处曾经各写各的（110 / 59 / 198），用户根本不知道信哪个。
  → 统一改成 402 项，并加断言：**三处写的数字必须一致**。

## 验证

- `node selfcheck.mjs` = **402 通过 / 0 失败**（新增 13 条守卫，每条都做过**负向验证**：
  故意破坏 → 报红 → 恢复 → 绿）
- 设置页渲染 **42 个场景通过**（新增「非 Windows 明说收不到通知」等场景）
- 全部测试套（Node 7 组 + Python 2 组）与 `py_compile` 全过；MCP 13 工具 selftest 通过
- **全新安装实测**：建 venv 12 秒 → 装依赖 3 秒 → 探针识别就绪
- **并发压测**：原子写 2024 次读 0 次坏 JSON（原来 16 次）
- **BOM Cookie 实测**：修复前 `UnicodeEncodeError` 崩溃，修复后正常返回 `code: 8`
- **真机**：doctor 13 项全绿、`session-guard` 判 alive、`forward-pick` 正常取候选
- 隐私扫描（全仓库跟踪文件）：**0 命中**

## 怎么升级

```bash
git -C <你的插件目录> pull
```

然后**重启一次 dsh**。配置和登录态不受影响（本版没有改任何配置项）。

⚠️ **用过 Slack webhook 的人**：翻一下自己的 `duty.log`，里面可能有明文 webhook 地址；
建议在 Slack 里重新生成一个 webhook，并更新设置页里的地址。

## 完整改动

见 [CHANGELOG.md](https://github.com/NEWJO123/dsh-douyin-scroll/blob/main/CHANGELOG.md)。

---

