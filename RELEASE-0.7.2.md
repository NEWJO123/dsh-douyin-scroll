# v0.7.2

> 一个修复：**私信回复把「发送方读不出来」当成了「不能回」**。
> 对照 [LockyBee/dsh-douyin-agent Issue #17](https://github.com/LockyBee/dsh-douyin-agent/issues/17) 发现的同类坑。

## 问题是什么

私信回复前要判断「最新一条是谁发的」。原来的代码这样写：

```js
if (last.from !== 'them') return { reason: 'unknown_sender', note: '最新一条消息的发送方不明确，没有发送' }
```

最新一条消息的发送方读不出来时，整条「DSH 回复」直接跳过 —— 而且下次还是同一条，**永久发不出去**。
病根是把「**读不出来**」当成了「**判定为不能回**」。

## 修法：不靠猜，也不绕开

回复私信走的是 `tools/im-http.py` 的接口路径 —— **发送者是协议里的 uid（field7），与自己的 uid 一比就是确定答案**，
这条路根本不会出现「认不出」。会认不出的只有浏览器 DOM 路径（靠头像在左还是右猜），
那条路径本来就不该参与「要不要发」的判断。

所以：

- 发送方读不出来 ⇒ 视为**数据不可信**，明确报 `untrusted_sender`，提示改用接口路径重读；
  **不拿猜测结果去决定回复谁**（不再「跳过它去回上一条」）。
- 最后一条明确是我发的 ⇒ 仍然跳过（防重复回复，安全语义不变）。
- 最后一条是对方发的但没有文字（图片/表情/卡片）⇒ `unsupported_message`，不回更早的消息。

## 怎么升级

```bash
git -C <你的插件目录> pull
```

然后重启一次 dsh。配置和登录态不受影响；本版没有改任何配置项。

## 验证

- `node selfcheck.mjs` = **389 通过 / 0 失败**
- `tests/dm-reply.test.mjs` = **21/21**（新增「方向不明的尾巴报不可信、绝不靠猜回复」）
- 其余测试套全过、设置页渲染 40 场景通过、MCP 13 工具 selftest 通过
- 接口路径真机验证：`im-http.py --read` 返回每条消息都带确定的 `from`（me / them），无一条「认不出」

## 完整改动

见 [CHANGELOG.md](https://github.com/NEWJO123/dsh-douyin-scroll/blob/main/CHANGELOG.md)。
