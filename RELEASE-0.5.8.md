# v0.5.8

> 三个兼容修复，全部来自社区贡献（PR #10 · 感谢 yitacls）。功能跟 0.5.7 一样，没有新东西要学。

## 修了什么

1. **挂了系统代理的机器**：NO_PROXY 里带 `[::1]` 会让插件的请求直接崩 —— 修了。
   如果你以前是「一挂代理就拉不到评论/候选」，升级后应该就好了。
2. **扫码登录偶尔「扫了却没登进去」**：登录浏览器以前是被强杀的，新 Cookie 可能没保存就被带走 ——
   现在改成正常关闭、等 Cookie 落盘。
3. **面板卡在「读设置中」/ 设置页 404**：启动顺序的时序问题 —— 现在等网页服务就绪再挂接口，
   headless 环境不受影响。

## 怎么升级

### 已经装过的

```bash
git -C <你的插件目录> pull
```

然后**重启一次 dsh**（插件在 bundle 层，不重启不生效）。

如果是按版本号装的：

```bash
dsh plugin --profile <你的profile> add dsh-douyin-scroll@0.5.8
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

不会。配置和环境都在 `<DSH_HOME>/douyin-duty/`，不随仓库走；这一版**没有改任何配置项**，
面板也一个像素都没变。登录态、已发的评论、报告历史全部保留。

## 验证

- `node selfcheck.mjs` = **368 通过 / 0 失败**（干净克隆实测）
- 面板渲染检查 + MCP 13 个工具全部通过
- 代理修复做了 A/B 实测：修复前 httpx 直接崩，修复后同环境正常拉回 20 条评论

## 完整改动

见 [CHANGELOG.md](https://github.com/NEWJO123/dsh-douyin-scroll/blob/main/CHANGELOG.md)。
