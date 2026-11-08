#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/_home.py —— Python 脚本**唯一**的家目录来源
============================================================================
为什么要有这个文件：
  2026-10-22 之前，5 个 .py 各自写死了一个绝对路径（D 盘某个目录）。
  那是"某台机器上的脚本"，不是插件 —— 换台设备会静默回落到一个不存在的 D 盘，
  然后报一个跟真实原因毫无关系的 ENOENT。

规矩：
  ① 只认环境变量 `DOUYIN_HOME`（宿主 index.js 会注入）。
  ② 没有就退到 `DSH_HOME/douyin-duty`、再退 `~/.dsh/douyin-duty`。
  ③ **绝不**写死任何盘符。全都没有就抛错，让人一眼看出是配置问题。
============================================================================
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path


def home_dir(create: bool = True) -> Path:
    """插件家目录。没有 DOUYIN_HOME 也不写死盘符，按 DSH 约定往下退。"""
    env = (os.environ.get("DOUYIN_HOME") or "").strip()
    if env:
        p = Path(env)
    else:
        dsh = (os.environ.get("DSH_HOME") or "").strip()
        p = (Path(dsh) if dsh else Path.home() / ".dsh") / "douyin-duty"
    if create:
        try:
            p.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            # ⭐ 2026-11-08：DOUYIN_HOME 指到 OneDrive 同步盘 / 网络盘 / 没权限的目录时，
            #    原来直接抛 OSError 堆栈 —— 用户全程懵。这里给人话 + 结构化退出。
            print(json.dumps({
                "ok": False,
                "error": f"插件家目录不可写：{p}",
                "hint": f"检查这个路径的磁盘/权限（{e}）；OneDrive / 网络盘目录不适合，把 DOUYIN_HOME 指到本地磁盘再试",
                "stage": "home",
            }, ensure_ascii=False))
            raise SystemExit(2)
    return p


def home_str(create: bool = True) -> str:
    return str(home_dir(create))


def cookie_file() -> Path:
    return home_dir() / "douyin_cookie.txt"


def read_cookie_text() -> str:
    """
    🔴 2026-11-05：**读 Cookie 的唯一入口** —— 必须剥 BOM。

    为什么：设置页支持「粘一条 Cookie」，而用户在 Windows 上用记事本 /
    PowerShell `Set-Content -Encoding UTF8` 存文件时会带 UTF-8 BOM（U+FEFF）。
    带 BOM 的 Cookie 塞进 curl_cffi 的请求头里会直接炸：

        UnicodeEncodeError: 'latin-1' codec can't encode character '\\ufeff'

    这个错看着完全不指向"文件带 BOM"，用户只会觉得插件坏了。
    实测：6 个脚本全都中招（forward-pick / notice-read / api-comments /
    api-reply / im-http / session-guard），因为都各自裸读这个文件。

    返回空串表示「没有 Cookie / 读不出来」，由调用方给结构化提示。
    """
    try:
        raw = cookie_file().read_text(encoding="utf-8")
    except (FileNotFoundError, PermissionError, OSError):
        return ""
    # 剥 BOM（可能在文件最前面，也可能因为复制粘贴夹在开头空白里）
    return raw.lstrip("\ufeff").strip()


def plugin_dir() -> Path:
    """插件包根目录（tools/ 的上一层）"""
    return Path(__file__).resolve().parent.parent


def node_bin() -> str:
    """node 解释器的路径 —— **唯一**来源（Issue #7①）。

    2026-10-30 之前，`api-comments.py:21` 和 `api-reply.py:29` 各自写死了
    `C:\\Program Files\\nodejs\\node.exe`。只有「用官方安装包装过 Node」的机器成立；
    绿色版 / nvm / 自定义目录一律 FileNotFoundError，而这个错误又被 MCP 那层吞掉，
    表面只剩「评论一条都没拿到」。

    顺序：DOUYIN_NODE → PATH → 家目录 runtime.json 记过的 → 常见安装目录。
    都找不到返回 "node"，让子进程在 PATH 里再试一次（**不**提前判死）。
    """
    def usable(p: str) -> bool:
        return bool(p) and os.path.isfile(p)

    cands: list[str] = []
    env = (os.environ.get("DOUYIN_NODE") or "").strip()
    if env:
        cands.append(env)
    found = shutil.which("node")
    if found:
        cands.append(found)
    try:
        rt = json.loads((home_dir(create=False) / "runtime.json").read_text(encoding="utf-8"))
        for k in ("node", "nodeExe", "nodePath"):
            if rt.get(k):
                cands.append(str(rt[k]))
    except Exception:
        pass
    cands += [
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\nodejs\node.exe"),
        os.path.expandvars(r"%APPDATA%\npm\node.exe"),
        "/usr/local/bin/node",
        "/usr/bin/node",
    ]
    for c in cands:
        if usable(c):
            return c
    return "node"


def utf8_stdio() -> None:
    """把 stdout/stderr 钉成 utf-8（Issue #7②）。

    Windows 控制台默认 GBK，而昵称和评论正文里必然带 emoji（🍀 🫵 🐱）——
    `print()` 直接抛 UnicodeEncodeError。这几个脚本是被 MCP 用 subprocess 读 stdout 的，
    一崩整条链就失败，报错还完全不指向编码。
    """
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def prefer_ipv4(force: bool | None = None) -> bool:
    """让 httpx 只连 IPv4（默认开，`DOUYIN_FORCE_IPV4=0` 可关）。

    2026-11-05 实测（本机必现，读评论每条约 200 秒才超时）：
      www.douyin.com 的 DNS **先返回 10 个 AAAA**（2409:8c6a:…），而这条网络
      **IPv6 不通**（`connect` 5 秒 TimeoutError，同域名 IPv4 45ms 连上）。httpx
      没有 happy-eyeballs，会按 getaddrinfo 顺序逐个连 ⇒ 每个地址吃满系统 SYN
      重试，看起来就是「卡住不动」：`api-comments.py` 200 秒超时、`api-reply.py`
      同理，最后只剩 CDP 兜底（无头浏览器没开会再等 180 秒）。
    ⇒ 把 AAAA 过滤掉，只留 A。curl_cffi（推荐流那条）自己做 IPv4 回退，不受影响。
    """
    import socket

    if force is None:
        raw = (os.environ.get("DOUYIN_FORCE_IPV4") or "1").strip().lower()
        force = raw not in ("0", "false", "off", "no")
    if not force:
        return False
    if getattr(socket, "_douyin_ipv4_patch", False):
        return True

    orig = socket.getaddrinfo

    def _gai(host, port, family=0, type=0, proto=0, flags=0):
        infos = orig(host, port, family, type, proto, flags)
        if family in (0, socket.AF_UNSPEC):
            v4 = [i for i in infos if i[0] == socket.AF_INET]
            if v4:
                return v4
        return infos

    socket.getaddrinfo = _gai  # type: ignore[assignment]
    socket._douyin_ipv4_patch = True  # type: ignore[attr-defined]
    return True


def bootstrap(cookie: bool = True, ipv4: bool = True,
              hint: str = "先在设置页扫码登录（或粘一条 Cookie）"):
    """入口脚本的**一键开工**（2026-11-08 设计收敛）。

    utf-8 输出 → IPv4 偏好 →（可选）Cookie 闸，一行办完。
    为什么要有它：BOM、GBK、node 路径、IPv6 卡死这类坑，以前每个脚本各修各的，
    修一个漏一个（Issue #4、#7，BOM 一次修 6 个脚本）—— 根因是「样板长在每个脚本里」。
    现在样板收在这里：入口脚本第一行 `COOKIE = bootstrap(hint=...)`，
    新脚本忘了调会被 selfcheck 点名。

    cookie=True：返回剥好 BOM 的 Cookie 文本；缺失/为空 ⇒ 打印结构化 JSON
        错误并 exit(2)（把各脚本自己的 _require_cookie() 语义收进来，hint 按脚本传）。
    cookie=False：只做 utf8 + ipv4，返回 ""。给 session-guard / im-http 这种
        「体检员」用 —— 没 Cookie 要活着返回 alive:false，不许在这里退出。
    """
    utf8_stdio()
    if ipv4:
        prefer_ipv4()
    if not cookie:
        return ""
    text = read_cookie_text()
    if not text:
        print(json.dumps({
            "ok": False,
            "error": "还没有登录（没有 douyin_cookie.txt）",
            "hint": hint,
            "stage": "cookie",
        }, ensure_ascii=False))
        sys.exit(2)
    return text
