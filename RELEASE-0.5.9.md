# v0.5.9

> 修一个扫码登录的硬伤：**只装了 Edge（没装 Chrome）的电脑，点「扫码登录」必失败**。
> 感谢 superscc 的报告（Issue #11）—— 证据、复现、修法、本地验证全齐。

## 你遇到了吗

点「扫码登录」→ 弹「出二维码失败」，日志里写「登录用的浏览器还没开」——
但你明明装着浏览器（Edge）。

原因：插件找浏览器进程时写死了 chrome.exe，**Edge 的进程在它眼里是隐形的**；
后台无头 Edge 占着登录目录，新的登录窗口起不来，干等 30 秒后报错。

## 怎么升级

### 已经装过的

```bash
git -C <你的插件目录> pull
```

然后**重启一次 dsh**（插件在 bundle 层，不重启不生效）。

按版本号装的：

```bash
dsh plugin --profile <你的profile> add dsh-douyin-scroll@0.5.9
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

- `node selfcheck.mjs` = **371 通过 / 0 失败** + 面板渲染检查 + MCP 13 个工具
- A/B 实测：占着登录目录的 Edge 进程，修复前在进程检测里 **0 命中（隐身）**，
  修复后能被找到并正常关闭
- 超时报错现在会写明「进程活着但端口连不上」还是「根本没有进程」——真因不再被藏

## 完整改动

见 [CHANGELOG.md](https://github.com/NEWJO123/dsh-douyin-scroll/blob/main/CHANGELOG.md)。
