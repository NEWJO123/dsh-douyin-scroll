# 推到 GitHub 的攻略

> 对象：`dsh-douyin-scroll`（刷抖音插件）。跟着抄命令就行，每步都给验证方法。

---

## 0. 先记住三条：这些东西**永远不许**进仓库

| 不许进 | 为什么 |
|---|---|
| `douyin_cookie.txt` / 任何 Cookie | 是**登录凭证**。推到公开仓库 = 把号交给陌生人 |
| `config.json` 里的 `dmToId`、`out/` 里的日报 | 含**账号、私信对象、你跟他聊过的话** |
| `chrome-profile/` | 里面就是登录态，体积还有几百 MB |

`.gitignore` 已经写好了。**每次 push 之前跑一次第 5 步的自查**，别嫌烦。

---

## 1. 一次性准备

```powershell
git --version          # 有输出就行（本机已有 2.54）
git config --global user.name  "你的名字"
git config --global user.email "你的邮箱"
```

没装就去 https://git-scm.com/download/win 装（一路默认即可）。

---

## 2. 本地建仓库

```powershell
cd <本目录>
git init -b main
git add -A
git status --short          # ⭐ 这一步必须眼看一遍（见第 5 步）
git commit -m "feat: 刷抖音插件 0.1.0 —— 取候选/打分/日报/私信卡片"
```

---

## 3. 在 GitHub 建仓库并推上去

**手动建**（推荐，能设成私有）：

1. 打开 https://github.com/new
2. Repository name：`dsh-douyin-scroll`
3. ⭐ **Private**（先在私有里跑通，确认没漏东西再考虑公开）
4. **不要**勾 "Add a README / .gitignore / license" —— 本地已经有了
5. Create repository → 复制它给的两行命令，回来执行：

```powershell
git remote add origin https://github.com/<你的用户名>/dsh-douyin-scroll.git
git push -u origin main
```

第一次推会弹浏览器要 GitHub 授权（Git Credential Manager），点同意就行。

**有 gh CLI 的话一条命令搞定**：

```powershell
winget install GitHub.cli
gh auth login
gh repo create dsh-douyin-scroll --private --source . --push
```

---

## 4. 以后日常改代码

```powershell
git add -A
git commit -m "fix: 说清楚改了什么"
git push
```

---

## 5. ⭐ 推之前自查（每次都要跑）

```powershell
cd <本目录>

# ① 暂存区里有没有"数据文件"被误 add
git diff --cached --name-only |
  Select-String -Pattern 'cookie\.txt|credential\.json|chrome-profile|\.venv|\.log$|^out/|seen\.md|^config\.json'

# ② 暂存内容里有没有真 token
git grep --cached -n -i -E 'sessionid=[A-Za-z0-9]{6}|pass_token=[A-Za-z0-9]{6}'

# ③ 该忽略的，确认真的忽略了
git check-ignore -v douyin_cookie.txt chrome-profile/Default/Cookies .venv/Scripts/python.exe
```

**怎么读结果（实测过的预期输出）**：

| 命令 | 正常结果 |
|---|---|
| ① | **什么都不输出**。如果出现 `lib/credential.mjs` —— 那是源码，不是凭证，忽略 |
| ② | 通常**什么都不输出**。命中 `'sessionid='` 这种在**代码里的字面量**（比如 `qr-login.mjs` 判断登录态）是正常的 |
| ③ | 三行 `.gitignore` 规则，说明都拦住了 |

三条都符合上表，才推。

万一已经推上去了：

```powershell
# 从 Git 里删掉，但保留本地文件
git rm --cached douyin_cookie.txt
git commit -m "chore: 移除误提交的凭证"
git push

# ⚠️ 更狠的情况（凭证已经推到公开仓库）：
#    Git 历史里的东西删不干净 —— 换密码 / 重新扫码登录 比改历史快得多、稳得多。
```

---

## 6. 别人怎么装这套

```bash
# 从 GitHub 装
dsh plugin --profile web add git+https://github.com/<你的用户名>/dsh-douyin-scroll.git

# 或者本地目录装
dsh plugin --profile web add link:<本目录绝对路径>
```

装完 **必须重启一次 dsh**，再进「设置 → 刷抖音」：

1. 点「装主依赖」（建 venv，装 `curl_cffi` + `httpx`）
2. 登录：`node tools/qr-login.mjs start` 扫码（唯一会开可见浏览器的场景）
3. 点「测一下」→ 会话体检 + 试取一次候选

---

## 7. 几个已经踩过的坑

| 坑 | 说明 |
|---|---|
| 中文乱码 | 仓库里全是 UTF-8。PowerShell 直接 `Get-Content` 会显示成乱码 —— 用 `Get-Content -Encoding utf8` 或拿编辑器看，**别以为文件坏了** |
| CRLF 警告 | Windows 提交时 git 可能提示 `LF will be replaced by CRLF`。无害，想消掉就加一行 `.gitattributes`：`* text=auto eol=lf` |
| 没重启就说插件不生效 | bundle 层要重启才组装。**每次改完 `index.js` 都要重启**；`tools/*.mjs` 是每次现读的，改完立即生效 |
| 公开仓库被人考古 | 日报里可能写着你的账号和你看过什么。建议**先私有**，真要开源就把 `out/` 整个排除并且别把它当示例贴进 README |
| `files` 整目录会带上 `__pycache__` | `package.json` 的 `files` 写 `tools` ⇒ npm 把 `tools/__pycache__/*.pyc` 也打进包（根 `.npmignore` 拦不住被 files 点名的目录）。**解法：`tools/.npmignore` 里写 `__pycache__/`** —— 2026-10-22 实测 59→51 个文件、-81KB |
| headless overlay 挂 MCP 插件要用 `- insert:` | Loader 方言：带 `id` 的条目是「覆盖已有行」，目标不存在**静默跳过**；新增插件必须写 `- insert: [...]`（见 `index.js` 的 `ensureOverlay` 注释） |
| git push 连不上 github.com（`Failed to connect ... port 443`） | 本机直连 github.com 不通、但 127.0.0.1:7897 有代理。给 git 配**仅对 GitHub 走代理** + 换 OpenSSL 后端（schannel 握手会挂）：`git config --global http.https://github.com.proxy http://127.0.0.1:7897` + `git config --global http.sslBackend openssl` —— 2026-10-22 实测生效 |

---

## 8. 这个包现在有什么（推之前对一眼）

```
index.js  client.js  cordis.patch.yml  package.json  AI-USAGE.md
lib/           14 个（state / credential / notify / toast / hostdeps / uvfetch / paths / chrome / memory / douyin-work / comment-publish-ui / pet-brain / pet-observe / pet-relay）
prompts/       duty.md（值班章程）、persona.default.md（中性默认人设）、sample-candidates.json
tools/         41 个（采集 / 评论 / 私信 / 发卡片 / 扫码 / 自检 / MCP server / 渲染检查）
selfcheck.mjs  433 项预检，不用装 dsh 也能跑
requirements.txt  只有 curl_cffi + httpx
```

推之前跑一遍：

```powershell
node selfcheck.mjs      # 应该 264 通过 / 0 失败
```

> ⚠️ 仓库里**没有** `prompts/persona.md`（本地私有配置，`.gitignore` 拦着）。
> 别人 clone 下来只有 `persona.default.md`（中性那份）—— 这是有意的，别"补回去"。

## 9. 发到 npm（可选，但推荐）

`dsh plugin add` 装的是 npm 包，所以想让人一条命令装上，就发 npm：

```powershell
cd <本目录>
npm pack --dry-run     # ⭐ 先眼看一遍文件清单：没有 pyc、没有 persona.md、没有 cookie/日志
npm publish --access public
```

发了之后，别人就能 `dsh plugin --profile <profile> add dsh-douyin-scroll`。

⭐ **发 npm 还有个副作用是好的**：设置页的「检查更新」能直接查到新版本
（它按 `registry.npmjs.org/<包名>/latest` 查）。只发 GitHub 也能查
（插件会读仓库根目录的 `package.json`，前提是 `package.json` 里填了 `repository`）。

## 10. 发布前最后一遍对账（2026-10-22 状态）

| 项 | 状态 |
|---|---|
| `node selfcheck.mjs` | ✅ 198 通过 / 0 失败 |
| `npm pack --dry-run` | ✅ 51 个文件 / 221.6 kB，无 pyc、无 persona.md |
| 面板渲染检查 `node tools/panel-render-check.mjs` | ✅ 通过 |
| MCP 自测 `node tools/mcp-server.mjs --selftest` | ✅ 通过 |
| 发送链路实测 | ✅ 评论区 @（cid 落库）+ 分享卡片+理由（私信回读确认） |
| git remote / repository 字段 | ❌ **还没填** —— 建 GitHub 仓库后 `git remote add` + 在 package.json 加 `"repository": {"type":"git","url":"git+https://github.com/<你的用户名>/dsh-douyin-scroll.git"}`（不填的话「检查更新」的 GitHub 来源废） |
| npm 账号 | ❌ 还没 `npm login`（发 npm 才需要） |
