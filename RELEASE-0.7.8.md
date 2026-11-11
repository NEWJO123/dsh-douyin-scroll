# v0.7.8

## 0.7.8 — 2026-11-12（删除评论 403/404 修复 —— 改走被抖音 hook 的 XHR）

**根因**：抖音前端会接管页面的 XMLHttpRequest（`prototype.open` 被重写）⇒ 被 hook 的
XHR 发请求自动补签名；**fetch 没有被 hook** ⇒ 裸奔无签名 403。旧实现的删除两条通道
全用 fetch —— 通道 403 的真因。另：GET「列表删除」路径已被抖音下线（网关报路径不支持），
通道 404 的真因。

**修法**：重写 `comment-delete.mjs` —— 导航到作品页等签名 SDK 就绪 → POST
`/comment/delete/` 走被 hook 的 XHR。

**实测**：对本机发出的验证评论真删成功（`200 + status_code:0, msg:success`），
幂等重删也返回 success。

selfcheck +2 守卫：删除请求禁用 fetch、已下线路径禁止回归（461/0）。

## 怎么升级

```bash
git -C <你的插件目录> pull
```

然后**重启一次 dsh**。配置和登录态不受影响。

## 完整改动

见 [CHANGELOG.md](https://github.com/NEWJO123/dsh-douyin-scroll/blob/main/CHANGELOG.md)。

---
