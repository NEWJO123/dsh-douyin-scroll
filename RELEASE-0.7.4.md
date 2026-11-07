# v0.7.4

## 0.7.4 — 2026-11-07（值班「白跑一轮」的断点集中修 —— 社区 PR #18 · 1452vjvj）

> 这次的贡献来自社区 PR：作者（[1452vjvj](https://github.com/1452vjvj)）在自己的机器上
> 连续踩到「这一轮根本没跑成，但报告看起来像跑过了」的静默失败 —— Toast 只说「本轮异常结束」，
> 报告是空的，看不出根因。他逐条复现后一次修掉，收进主线时逐行审过、负向验证过。
> 代码原样收进（commit 93e4929，作者署名保留），下面三处收尾修正随本版本一起进。

## 🔴 会让值班「白跑 / 卡死」的

**1. 桌面版把模型换成插件型 provider 后，每一轮 3 秒就死（NO_ADAPTER）**

`ensureOverlay()` 会把桌面版 `agent-default-model` 原样抄进 headless 的 overlay，
但 headless profile 没装 `buddy` / `codearts` 这类插件型 provider 的 adapter ⇒
那一轮启动 3 秒就退出（`code=1`），日志里只有一行 `NO_ADAPTER`，报告全空。
→ 跑之前先用临时 overlay **真跑一句**（`只回复两个字：ok`）确认这条路在 headless 里通不通；
不通就自动退到 headless 自带的 `deepseek-account / deepseek-flash`；结论按 `provider/model`
缓存在 `headless-route.json`（同一个模型只探测一次）。新增配置 `headlessRoute`（`provider/model`）
可以把这一轮钉死在某条路上。

**2. 账户没余额 / 上游拦截，也当成「这条路跑不了」**

实测：探测一句 ok 能过（短请求不触发计费校验），真跑到第 3 分钟才蹦
`ACCOUNT_QUOTA: Insufficient Balance` —— 报告全空、整轮白跑。
→ 失败判定从只认 `NO_ADAPTER` 扩成 `ROUTE_FAIL_RE`（额度不足 / 欠费 / AUTH 401 / 请求被拦截等都算）；
真跑死在这些错上时**自动作废选路缓存**，下一轮重新挑一条能跑的。
另外修了「同一批请求前一条被拦、后一条正常」的偶发死法：开跑 3 分钟内被拦且没交出结果 ⇒
20 秒后自动重来一轮（最多 2 次）；跑久了不重试，避免把已发出去的卡片再发一遍。

**3. 上游把流掐了，那一轮只能干等 15 分钟看门狗**

实测：最后一条输出之后 12 分钟没有动静，连接没断，整轮只能等 15 分钟超时，日志只有一句「超时」。
→ 连续 `DOUYIN_STALL_MIN`（默认 5，可调 2–30）分钟没有任何输出 ⇒ 判定「上游卡住」，
立刻结束并记 `stage: 'stall'`；进程一个字没吐就退出时日志也明说，不再让人以为是日志漏了。

**4. IPv6 先到且不通时，读评论每条卡 200 秒**

实测（Windows 11 + 家宽）：`www.douyin.com` 的 DNS 先返回 10 个 AAAA 而机器 IPv6 不通，
httpx 没有 happy-eyeballs，按顺序逐个连 ⇒ 每个地址吃满 SYN 重试：`api-comments.py` 每条 200 秒超时，
证据包里**评论全是空的**，判断只剩文案/标签。
→ `tools/_home.py` 新增 `prefer_ipv4()`（过滤 AAAA，`DOUYIN_FORCE_IPV4=0` 可关），
`api-comments.py` / `api-reply.py` 在第一次请求前调用。作者实测同一作品 200 秒 0 条 → 13 秒 20 条。

**5. 结果文件被写成两段拼接，整轮被判「没交作业」**

小模型把 `runs/<id>.submission.json` 追加写了两遍（`{...}{...}`），`JSON.parse` 抛错 ⇒
收尾拿不到 receipt ⇒ `phase=unknown`、Toast「结果尚未确认」，但报告其实早写好了。
→ `lib/state.mjs` 新增 `readJsonLoose()`（原样 parse 失败后扫括号配平的 `{...}`，取最后一份），
收尾读 submission 改用它；正常文件的语义完全不变。

**6. 先失败后成功的那天，报告开头还是「这一轮没跑成」**

占位报告只在当天还没有报告时写，成功那一轮的内容被追加在失败横幅**下面**。
→ 成功收尾（`code=0 && phase=completed`）时把旧横幅整段挪到文末
「附：早先那轮没跑成时的诊断」；切分按围栏配对，不会把围栏里的日志尾巴切出去。

## 🟡 安全 / 行为变化

**7. 值班那一轮偷改 `config.json`，会被点名**

（作者机器真事：那一轮把 `autoSend` 打开、`mentionName` 写成某个人）

`prompts/duty.md` 明令那一轮只许写报告 / seen.md / submission.json，**不许动 config.json**；
代码再兜一层：开跑前记下原文，跑完比对，改了就在日志里点名，敏感项
（autoSend / autoComment / commentExecutor / mentionName / commentPerDay / chatWatch）额外弹一次 Toast。
**不自动还原** —— 免得把使用者这一轮在设置页里改的东西一起回滚。
顺带修了一个老毛病：`__clearKeys` 点名的文本字段现在能**真清空**（以前「空值保护」会把空串救回来，
`mentionName` 填过就清不掉）。

**8. 新配置 `roundPermission`：值班那一轮的权限档，Windows 默认给足**

实测：headless profile 的 sandbox 默认 `workspace-write`，而部分 Windows 机器的受限令牌沙箱后端
fail-closed ⇒ 那一轮的 `pwsh` 直接报「no backend usable」，模型只能用 read/edit 硬扛。
→ 留空 = **Windows 给 `danger-full-access`**（对齐桌面版默认档），mac / Linux 保持 `workspace-write`；
机器上沙箱好用的，把它改成 `workspace-write` / `read-only` 就回到受限模式。
⚠️ 对 Windows 用户这是默认放宽（原来这一轮跑在受限沙箱里），敏感操作仍受 confirm 闸与发送闸约束。

## 🧹 收进主线时的三处收尾修正

- **设置改动 Toast 原实现弹的是空正文**：PR 里走 `notifyRoundEnd` 但传的形状它读不到
  ⇒ 弹出「结果尚未确认」+ 空正文；改成直接 `toastSend`，标题正文都说真话。
- **备选模型名单收窄**：`FALLBACK_ROUTES` 原来还带着作者机器私有的 `baomiao-oneapi` 渠道
  （别的机器上没有这个 provider），公开仓库不带私人配置，只留 headless 自带的一条。
- **CHANGELOG 清理**：PR 附带的 CHANGELOG 草稿里有 5 个控制符乱码，本条目为重写版。

## ✅ 验证

- `node selfcheck.mjs`：**434 通过 / 0 失败**（新增 ⑥h / ⑦b-l 共 31 条守卫；拿这套断言跑未修改的
  0.7.3 → 31 条全红，负向验证过）
- **全新克隆实测**（模拟没装过的人）：`430 通过 / 0 失败`（本地多出的 4 条是人设三层断言，
  只在装了 `prompts/persona.md` 的环境跑）
- `node --check index.js`、`py_compile`（`_home.py` / `api-comments.py` / `api-reply.py`）全过
- 作者侧端到端：真跑了一轮完整值班 —— `code=0`、报告落盘、submission + result 都在、Toast「本轮已完成」
- 横幅挪移与 `prefer_ipv4` 在收审时另做了 4 场景 / DNS 级功能自测，全过

## 怎么升级

```bash
git -C <你的插件目录> pull
```

然后**重启一次 dsh**。登录态和已有配置不受影响。

- **已经装过的**：直接 pull + 重启即可，什么都不用配（新配置项留空就是原来的行为）。
- **还没装过的**：按 README 的安装步骤走，先 `node selfcheck.mjs`（430 项）看一眼环境。
- ⚠️ **Windows 用户注意**：本版起，值班那一轮的权限档默认是 `danger-full-access`
  （原来跑在受限沙箱里）。不放心就在设置里把 `roundPermission` 填成 `workspace-write`；
  但填了之后，沙箱后端不可用的机器上那一轮会没有 shell。

## 完整改动

见 [CHANGELOG.md](https://github.com/NEWJO123/dsh-douyin-scroll/blob/main/CHANGELOG.md)。

---
