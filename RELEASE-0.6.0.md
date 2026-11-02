# v0.6.0

> 两个内容：**图文（`/note/`）作品的评论回复**（社区贡献 · yitacls），
> 以及**duty.log 时间戳从 UTC 改为本地时区**（Issue #14 · 感谢 404notfoundzzy）。

## 一、图文作品的评论也能回了

以前评论回复只认 `/video/` 视频；通知里来了一条图文下的 @ 或回复，
回复时会因为路由对不上而失败。现在视频和图文共用同一条回复链路：

- 通知、DSH 工具与 MCP 会把作品链接、类型、评论 ID 和楼根原样带过去；
- 发布由抖音原生前端构造凭据，发送前校验作品、正文、回复楼层，只放行一次；
- 成功必须有服务端 `cid`，并回读确认落在目标楼层。
- 已实测：图文回复拿到 `cid`、回读为目标楼根下的 `level=2`。

## 二、日志时间不再是「另一个日期」

以前 duty.log 用 UTC 时间戳（带 Z），Windows 通知用的是本地时区 ——
跨日的时候「日志写 02 号、弹窗写 03 号」，排查时容易看岔（Issue #14）。
现在 duty.log 用**本地时区 + 明确偏移量**（如 `2026-11-03T02:30:00.123+08:00`），
跟弹窗日期一致，也不丢排序性。

## 怎么升级

### 已经装过的

```bash
git -C <你的插件目录> pull
```

然后**重启一次 dsh**（插件在 bundle 层，不重启不生效）。

按版本号装的：

```bash
dsh plugin --profile <你的profile> add dsh-douyin-scroll@0.6.0
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
- 图文回复实发验证：拿到服务端 `cid`、回读 `level=2`
- 专项测试：Node 侧 11/11、Python 侧 18/18

## 完整改动

见 [CHANGELOG.md](https://github.com/NEWJO123/dsh-douyin-scroll/blob/main/CHANGELOG.md)。
