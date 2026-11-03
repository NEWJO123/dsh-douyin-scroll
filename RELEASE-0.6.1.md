# v0.6.1

> 一个修复：**macOS / Linux 上扫码登录第二次必失败**（Issue #15 · 修复来自社区 PR #16 · icatw）。
> 根因是我在 0.5.9 修 Issue #11 时只覆盖了 Windows —— 这次把漏掉的平台补齐。

## 问题是什么

在 macOS（Apple Silicon / macOS 15 + Chrome 156）上，**第一次扫码能出二维码、也扫上了**，
但之后每次点「扫码登录 / 我扫完了」都失败，报：

```
Error: 登录用的浏览器还没开（没有进程占着插件 profile）。
```

`doctor` 显示「Cookie（登录态）：没有」—— 可实际上登录浏览器进程活着、CDP 端口也在正常监听。

**你明明扫上码了，Cookie 却永远导不出来。**

## 根因

`tools/qr-login.mjs` 里所有进程相关操作都写死 `powershell.exe`，只有 Windows 能跑。
mac / Linux 上 `execFileSync('powershell.exe', …)` 必抛异常，被 `catch` 吞掉后恒返回空列表：

| 位置 | 在 mac / Linux 上的后果 |
|---|---|
| `profileInUse()` | 恒返回 `[]` |
| `frontWindow()` | 恒返回 `no-window`（窗口不置顶） |
| `closeProfileChrome()` | 恒返回 `false` |
| `close` 子命令 | 枚举不出进程 |

于是失败链是：`profileInUse()` 恒空 → `start` 以为没浏览器占着 profile → `findFreePort()` 发现
9374 被那个活着的登录 Chrome 占着，另挑 9375 → 用同一个 `--user-data-dir` 起第二个 Chrome
（被拒、新进程秒退）→ `cdpTargets()` 在错误的 9375 上等满 30 秒超时 → 兜底诊断又用
`profileInUse()` → 还是空 → 报一句「浏览器还没开」。

0.5.9 把检测从「写死 chrome.exe」改成「按 profile 路径认进程」方向是对的，
但实现仍走 PowerShell —— **只修好了 Windows 的 Edge 场景，没覆盖 mac / Linux。**

## 还顺手修了两个连带 bug（任何平台都受影响）

- **`start` 的复用分支拿 `PORT=0` 去探活**：新进程里 `PORT` 只有 `QR_CDP_PORT` 环境变量才有值，
  `fetch('http://127.0.0.1:0/json/version')` 必失败 —— 所以「已经有登录窗口开着 ⇒ 直接复用」
  这条路径**在任何平台都走不到**，登录窗口会被误判成「后台无头占着 profile」。
- **`loadQrPort()` 用了未导入的 `readFileSync`** → 每次抛 `ReferenceError` 被 `catch` 吞掉，
  「记住上次端口」从未生效（静默失败）。

## 怎么修的

- 新增跨平台 **`profileCommandLines()`**：Windows 保持原 PowerShell 探测（Issue #11 语义不变），
  macOS / Linux 走 `ps -axo pid=,command=` 按 profile 路径字面匹配，排除 `--type=` 子进程与自身。
- 新增 **`liveQrPorts()`**：从活进程命令行读 `--remote-debugging-port`（只认 ≥9374，
  避开无头值班浏览器的 9334–9373），逐个验 `/json/version`。
- **`discoverQrPort()`** 优先用活进程端口（跨 DSH 重启也能找回）。
- **`start` 复用分支**改用 `liveQrPorts()` 探活。
- **`frontWindow()`**：macOS 用 `osascript` 激活浏览器 App（App 名从安装路径反推，
  Chrome / Edge / Chromium 都认）；Linux 安静跳过。
- **`closeProfileChrome()`**：SIGTERM 优雅关闭（不丢没落盘的新 Cookie）。
- **`close` 子命令**的进程枚举改走 `profileCommandLines()`，CDP `Browser.close` 优雅关闭逻辑保持不变。
- 补上缺失的 `readFileSync` 导入。

## 怎么升级

### 已经装过的

```bash
git -C <你的插件目录> pull
```

然后**重启一次 dsh**（插件在 bundle 层，不重启不生效）。

按版本号装的：

```bash
dsh plugin --profile <你的profile> add dsh-douyin-scroll@0.6.1
```

同样重启一次 dsh。

### 还没装过的

```bash
git clone https://github.com/NEWJO123/dsh-douyin-scroll.git
cd dsh-douyin-scroll && node selfcheck.mjs
dsh plugin --profile web add link:<本目录绝对路径>
```

重启 dsh → 设置 → 刷抖音 → 点「装主依赖」→ 扫码登录。

## 升级会不会坏我的配置

不会。配置和环境都在 `<DSH_HOME>/douyin-duty/`，不随仓库走；这一版**没有改任何配置项**。
登录态、已发的评论、报告历史全部保留。

## 验证

- `node selfcheck.mjs` = **374 通过 / 0 失败**（比 0.6.0 多 3 条）
- Windows 真机实测：`node tools/qr-login.mjs start` 正常导出 65 条 Cookie 并判已登录；
  `close` 返回 `closed: true`，事后查进程**无残留**
- 报告者（icatw）在 macOS 15 + Chrome 156 真机验证：
  `check` 不带端口能导出 68 条 Cookie 判已登录、`start` 能复用返回 `reused: true, port: 9374`
- Windows 路径行为未改动：进程枚举、conflict 分支、Issue #11 的「按 profile 路径认进程」语义全部保留

## 完整改动

见 [CHANGELOG.md](https://github.com/NEWJO123/dsh-douyin-scroll/blob/main/CHANGELOG.md)。
