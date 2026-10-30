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
        p.mkdir(parents=True, exist_ok=True)
    return p


def home_str(create: bool = True) -> str:
    return str(home_dir(create))


def cookie_file() -> Path:
    return home_dir() / "douyin_cookie.txt"


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
