# v0.7.10

## 0.7.10 — 发送可靠性收尾（回读确认 ×2 / 群发言人 / 发布按钮对齐）

- **群消息带发言人昵称**（收衍生仓库 kHolmesXX fish.11 的做法）：群消息的 from 全是
  unknown（头像全在左半边），从 React fiber 挖 sender 昵称 —— 群转达能说「谁说的」。
- **card-share 发送后回读确认**：切会话页确认卡片真出现在「我发的」消息里
  —— `sent:true` 原来是乐观判定（点完按钮 ≠ 发出），回读读不到如实带出。
- **comment-publish-ui 发布按钮定位放宽**：去掉「必须在编辑器右下方」的坐标约束
  （窄/宽窗口布局不同会漏真按钮）—— 回评论链路预防性对齐 #19 修法。
- 文档：预检计数 441 → 466 同步；api-reply.py 标注为备用通道
  （日常回评论走 comment-api.mjs —— 页面 XHR 自动签名，不依赖自实现签名器）。

## ✅ 验证

- `node selfcheck.mjs`：**466 通过 / 0 失败**（+1 守卫：群 sender 提取不许丢）
- 面板边界场景 3 个全过（5000 字 emoji 输入 / 清记忆确认弹窗 / 保存失败可重试）
- `node --check` 全部改动文件过

## 怎么升级

```bash
git -C <你的插件目录> pull
```

然后**重启一次 dsh**。配置和登录态不受影响。

## 完整改动

见 [CHANGELOG.md](https://github.com/NEWJO123/dsh-douyin-scroll/blob/main/CHANGELOG.md)。

---
