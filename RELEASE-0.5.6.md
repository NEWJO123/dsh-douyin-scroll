# v0.5.6

> 这版两件事：**全新克隆下来的人终于能顺利装上**（预检不再自己报红），
> 以及**社区报的 5 个 issue**（#3 #5 #6 #7 #8）—— 全是「失败时不告诉你为什么」这类坑。

## 装插件的人能感觉到的变化

### 一、照文档装，不再第一步就卡住

README 让你 `git clone` 后先跑 `node selfcheck.mjs`，「全部通过再装」。
**但之前任何干净克隆都过不了**（352 通过 / 5 失败），而且那 5 条全是自检自己的错，
跟你的电脑无关：

- 自检拿**中性默认人设**当「你自己的人设」来查 —— 默认人设本来就不带正反对照，
  于是「这台机器还没配过人设」被报成「人设写坏了」。现在**没配就明说没配**，不判失败；
  但你自己写了人设、里面只有「软一点」「别腻」这种词，照样报红（闸门没松）。
- `core.hooksPath` 是本地配置，`git clone` 不会带 —— 新克隆读到的永远是空串，
  原来直接判失败。现在空着就顺手挂上（可逆、不联网）。

### 二、桌面版后台轮次（#6，最致命）

「现在跑一轮」和峰谷自动值班在桌面版上 100% 起不来，三个坑连在一起：

- 用独立 `node.exe` 去跑 `app.asar` 里的 `cli.js` ⇒ 必然 `MODULE_NOT_FOUND`
  （`app.asar` 是 Electron 的虚拟文件系统，只有 Electron 读得了）。
  现在**按目标路径挑解释器**：asar 里的入口交回 Electron。
- 「已验证可跑」本来是假阳性（只要输出里有版本号形状就算过）⇒ 改成 **status=0 且** 有版本号。
- `webServer` 服务只有桌面 / web 版有，headless 没有 ⇒ 插件在 headless 里**永不激活**，
  而值班轮偏偏用 headless 跑。现在它变成可选：缺了只少一个面板和 HTTP 接口，跑一轮照常。

第一次用 headless 的人还要建一次 profile，插件会在 `duty.log` 里把命令打给你。

### 三、评论 / 回评 / 通知（#7）

- 两个 Python 脚本里**写死**了 `C:\Program Files\nodejs\node.exe`：
  Node 装在别处（绿色版 / nvm / 自定义目录）就 `FileNotFoundError`，而你只能看到
  「评论一条都没拿到」。现在会按 `DOUYIN_NODE` → PATH → 常见目录去找，找不到也会明说。
- Windows 控制台是 GBK，昵称和评论里的 emoji 会让 `print()` 直接崩，一崩整条 MCP 链就断。
  相关脚本统一钉成 utf-8。

### 四、发不出去的时候，能看到原因了（#8）

- 分享卡片失败原来只回一个 `ok: false`。真因（`chrome-profile` 被残留浏览器进程占着）
  完全看不到。现在会分成两种报：**进程立刻退出**（profile 被占，附查 PID 的命令）
  和**进程活着但连不上调试端口**（防火墙 / 端口）。实测前者从干等 60 秒变成 **0.6 秒**报出来。
  ⚠️ 不会自动换临时 profile 重试 —— 登录态就在那个 profile 里，换一个等于把你登出。
- MCP 那层原来把子脚本的 `error` 吞了。现在 `error` / `hint` 原样透出，实在没有就给 stderr 尾巴。

### 五、webhook 校验（#5）

自定义 webhook 地址现在会先校验：非 http(s)、回环、link-local、云元数据、组播一律拒绝
（防的是把本机变成打内网的跳板）。**局域网地址照常放行**（内网机器人是真实用法）。
确实要发到本机：设环境变量 `DOUYIN_WEBHOOK_ALLOW_LOCAL=1`。

### 六、关键词（#3）

之前的说明容易误会。现在说清楚：**抖音没有能用的搜索接口**，关键词不会替你搜、也不会筛掉别的视频。
它只做一件事 —— 命中文案 / 话题的候选**排前面**（×1.35），不命中也不丢。
硬筛会把推荐流里「没写关键词但确实好看」的筛没，那才是真损失。

## 怎么升级

```bash
# 已装过的
git -C <你的插件目录> pull

# 全新装的（先跑预检，全过再装）
git clone https://github.com/NEWJO123/dsh-douyin-scroll.git
cd dsh-douyin-scroll && node selfcheck.mjs
dsh plugin --profile web add link:<本目录绝对路径>
```

**⚠️ 升级完必须重启一次 dsh** —— 面板在 bundle 层，不重启不生效。

## 升级会不会坏我的配置

不会。配置和环境都在 `<DSH_HOME>/douyin-duty/`，不随仓库走；这一版没有改配置项。

## 新增的自检

`node selfcheck.mjs` 多了一段 **4p（9 条）**，专门守这一版修的坑：
解释器分派、`runnable` 两个条件、webServer 不在 inject、没有 Python 写死 node、
utf-8 钉住、浏览器失败分开报、MCP 透传、webhook 校验、关键词软加分。
防的是「修完又被改回去」。

> 现状：`node selfcheck.mjs` = **363 通过 / 0 失败**。

## 完整改动

见 [CHANGELOG.md](https://github.com/NEWJO123/dsh-douyin-scroll/blob/main/CHANGELOG.md)。
