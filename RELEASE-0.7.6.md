# v0.7.6

## 0.7.6 — 2026-11-08（数据和展示分家 + 安装启用加固 —— 含面板功能全量回归）

> 老根子：`out/<日期>.md` 一个文件同时当日报、失败日志、占位符、数据源四个用 ——
> 「今天挑了几条」靠数报告里的 `### ID` 行、通知正文靠从报告文本反向解析（2026-10-22
> 因为只认旧格式炸过一次）、先失败后成功还得写「挪横幅」的补丁。这次把数据和展示彻底分开：
> **宿主记账只信 `runs/<roundId>.submission.json`（结构化 receipt），报告纯粹给人看。**
> 另外模拟新用户的完整安装启用流程（全新家目录 / 未登录 / 半成品环境 / JSON Cookie /
> 不可写目录），坐实并修掉四个坑；面板 42+5 场景全量回归全过。

## 🔴 数据和展示分家

**1. 计数只信 ledger**

`recommendationCounts` / `dayRecommendations` 不再扫报告文本；「模型没交作业」就老实
显示 0（不再拿「报告里提到过」凑 unknown）。报告扫描只剩 `importLegacyPicks` 一处
（升级当天的显式迁移，named legacy）。

**2. 通知正文从 receipt 构造**

`toastSummary`（报告反向解析，2026-10-22 炸过）退役，新增 `picksBody` —— completed 的
通知列出《标题》·@作者（author 由 submitRoundResult 从证据包补存进 receipt）；
0 条明说「没有挑出」。

**3. 失败记录独立化**

失败诊断写 `out/failed-<日期>.md`（一天多轮追加），日报永远是干净的；成功但没报告时
补**中性**短日报。「补横幅 + 挪横幅」的补丁整个删除。

**4. 面板构建标识自动化**

手写「改完 client.js 记得 +1」的 `PANEL_BUILD` 常量退役 —— 宿主 /status 与 /progress
都返回 `panelJsMtime`（client.js 文件时间），页面记下第一眼的值，变了 4 秒内在角标
提示「请刷新」。（/progress 这一处是面板全量回归抓出来的：只放 /status 的话提示
永远不会出现。）

**5. Python 样板收敛**

`_home.bootstrap()` 一键开工（utf8 + IPv4 + Cookie 闸），6 个入口脚本全部改走它；
`forward-pick` 顺手补上一直缺失的 utf-8 钉死。新脚本忘了调会被 selfcheck 点名。

## 🔴 安装启用加固（模拟新用户全流程坐实）

模拟全新家目录 / 未登录 / 半成品环境 / JSON Cookie / 不可写目录，坐实并修掉四个坑：

1. **值班开跑前两道闸**：环境/登录没就绪就不跑，弹人话 + 面板给指引 —— 原来通知只有
   「新增推荐 0 条」，真因（ModuleNotFoundError）埋在日志里。
2. **MCP 工具认得出「环境装了一半」**：`ModuleNotFoundError` traceback → 「依赖不完整，
   重新点一次装主依赖」，8 处失败点统一出口。
3. **粘 JSON 形状 Cookie 也认**：F12 Cookies 面板复制的 `[{name,value}]` 直接归一化，
   不再卡在「复制得不完整」。
4. **家目录不可写（OneDrive/网络盘）**：给人话 + 结构化退出，不再 OSError 堆栈。

## 🟡 文档同步

README / AGENTS / duty.md 里「宿主数报告的 `###` 行算配额」的旧说法全部更正
（记账只认 submission.json，报告 `###` 行是给人看的导航）。

⚠️ **0.7.5 升级用户**：当天旧报告可能残留「没跑成」横幅（新机制不再挪它），隔天自愈，不用管。

## ✅ 验证

- `node selfcheck.mjs`：**450 通过 / 0 失败**（本机；全新克隆 441，三处文档计数一致）
- 负向验证贯穿全程：新守卫放进改动前代码逐一变红（31 + 4 + 2 + 1 + 4 条四批）
- 面板渲染检查：**42 基线 + 5 补充场景全过**（前置闸拒绝的人话提示 / 构建标识 /
  mtime 变化提示刷新 / 检查更新 / counts 形状）；补充场景沙箱已导出，后续回归可持续复用
- 单测：settings-backend 14 过、run-status 7 过、MCP selftest 13 工具 0 错误、
  `py_compile` 全部 Python 脚本过
- 仓库发布审计通过（隐私 0 命中 / 无私货 / 新装依赖完整）

## 怎么升级

```bash
git -C <你的插件目录> pull
```

然后**重启一次 dsh**。配置和登录态不受影响（本版没有删除任何配置项）。

## 完整改动

见 [CHANGELOG.md](https://github.com/NEWJO123/dsh-douyin-scroll/blob/main/CHANGELOG.md)。

---
