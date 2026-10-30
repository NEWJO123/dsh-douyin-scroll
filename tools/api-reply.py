#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
tools/api-reply.py —— 走**一条接口**回评论（不用点开评论区）
============================================================================
两步，且严格按 session-guard 的规矩来：
  ① 先拿签名打**只读**接口（comment/list）—— 签名不通就立刻停，绝不往下打写接口
  ② 只读通了，才允许打 /aweme/v1/web/comment/publish/（带 reply_id）
每一步前后都做体检；掉号立刻熔断。

用法:
  python tools/api-reply.py check                     # 只验签名（只读）
  python tools/api-reply.py reply <aweme_id> <reply_id> <正文txt>   # 真回
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _home import home_str, node_bin, utf8_stdio  # noqa: E402

# ⚠️ 必须在任何 print 之前 —— GBK 控制台遇到 emoji 会崩（Issue #7②）
utf8_stdio()

import time
import urllib.parse

import httpx

HOME = home_str()
PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Issue #7①：别再写死 `C:\Program Files\nodejs\node.exe`
NODE = node_bin()
SIGNER = os.path.join(PLUGIN, "tools", "dy-signer.mjs")
VENVPY = os.path.join(HOME, ".venv", "Scripts", "python.exe")
GUARD = os.path.join(PLUGIN, "tools", "session-guard.py")
COOKIE = open(os.path.join(HOME, "douyin_cookie.txt"), encoding="utf-8").read().strip()

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")
JAR = {}
for p in COOKIE.split(";"):
    if "=" in p:
        k, v = p.split("=", 1)
        JAR[k.strip()] = v.strip()

COMMON = {
    "device_platform": "webapp", "aid": "6383", "channel": "channel_pc_web",
    "pc_client_type": "1", "version_code": "190500", "version_name": "19.5.0",
    "cookie_enabled": "true", "screen_width": "1920", "screen_height": "1080",
    "browser_language": "zh-CN", "browser_platform": "Win32",
    "browser_name": "Chrome", "browser_version": "141.0.0.0",
    "engine_name": "Blink", "engine_version": "141.0.0.0",
    "os_name": "Windows", "os_version": "10", "platform": "PC",
}

qs = lambda d: "&".join("%s=%s" % (urllib.parse.quote(str(k)), urllib.parse.quote(str(v))) for k, v in d.items())


def guard():
    r = subprocess.run([VENVPY, GUARD, "check"], capture_output=True, timeout=90,
                       env=dict(os.environ, DOUYIN_HOME=HOME))
    out = r.stdout.decode("utf-8", "replace")
    i = out.find("{")
    if i < 0:
        return {"alive": False, "why": out[:200]}
    try:
        # 输出里有两段 JSON（体检结果 + 熔断状态），只取第一段
        obj, _ = json.JSONDecoder().raw_decode(out[i:])
        return obj
    except Exception as e:
        return {"alive": False, "why": "解析体检输出失败: %s | %s" % (e, out[:160])}


def sign(rel):
    env = dict(os.environ, DY_COOKIES=json.dumps(JAR, ensure_ascii=False), DOUYIN_HOME=HOME)
    try:
        p = subprocess.run([NODE, SIGNER, rel], capture_output=True, cwd=PLUGIN, env=env, timeout=240)
    except FileNotFoundError:
        # 找不到 node 时说清楚，而不是让调用方以为「签名坏了」（Issue #7①）
        return {"err": "找不到 node（%s）—— 设环境变量 DOUYIN_NODE 指向 node.exe 试试" % NODE}
    out = p.stdout.decode("utf-8", "replace")
    i = out.find("{")
    if i < 0:
        return {"err": (out + p.stderr.decode("utf-8", "replace"))[-400:]}
    try:
        return json.loads(out[i:out.rfind("}") + 1])
    except Exception as e:
        return {"err": "解析签名输出失败: %s" % e}


def headers():
    return {
        "User-Agent": UA, "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": "https://www.douyin.com/", "Origin": "https://www.douyin.com",
        "Cookie": COOKIE, "Content-Type": "application/x-www-form-urlencoded",
    }


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "check"
    aweme = sys.argv[2] if len(sys.argv) > 2 else "7698980229549139835"

    g0 = guard()
    print("体检(前):", json.dumps(g0, ensure_ascii=False))
    if not g0.get("alive"):
        print(json.dumps({"ok": False, "stop": "会话不健康，按规矩不打任何写接口"}, ensure_ascii=False))
        return 2

    # ① 只读验签名
    rel = "/aweme/v1/web/comment/list/?" + qs({**COMMON, "aweme_id": aweme, "count": 20, "cursor": 0, "item_type": 0})
    s = sign(rel)
    if s.get("err") or not s.get("signedUrl"):
        print(json.dumps({"ok": False, "stage": "sign", "err": s.get("err") or "没有 signedUrl"}, ensure_ascii=False))
        return 3
    url = s["signedUrl"]
    if not url.startswith("http"):
        url = "https://www.douyin.com" + url
    with httpx.Client(timeout=30, follow_redirects=True) as c:
        r = c.get(url, headers={**headers(), **(s.get("headers") or {})})
    print("只读 HTTP", r.status_code, "bytes", len(r.content))
    try:
        j = r.json()
    except Exception:
        j = {}
    sc = j.get("status_code")
    n = len(j.get("comments") or [])
    print(json.dumps({"status_code": sc, "comments": n}, ensure_ascii=False))
    if sc != 0:
        print(json.dumps({"ok": False, "stop": "签名没被接受（status_code=%s），不往下打写接口" % sc,
                          "body": r.text[:300]}, ensure_ascii=False))
        return 4
    if mode == "check":
        print(json.dumps({"ok": True, "note": "签名可用（只读已验证）；写接口按需再打"}, ensure_ascii=False))
        return 0

    # ② 写：回复某条评论
    reply_id = sys.argv[3]
    txt = open(sys.argv[4], encoding="utf-8").read().strip()
    body = {**COMMON, "aweme_id": aweme, "text": txt, "text_extra": "[]",
            "reply_id": reply_id, "reply_to_reply_id": reply_id,
            "aweme_type": "0", "channel_id": "0", "city": "", "sticker_id": "", "is_fold": "0"}
    rel2 = "/aweme/v1/web/comment/publish/?" + qs({**COMMON, "app_name": "aweme"})
    s2 = sign(rel2)
    if s2.get("err"):
        print(json.dumps({"ok": False, "stage": "sign2", "err": s2["err"]}, ensure_ascii=False))
        return 5
    u2 = s2["signedUrl"]
    if not u2.startswith("http"):
        u2 = "https://www.douyin.com" + u2
    with httpx.Client(timeout=40, follow_redirects=True) as c:
        r2 = c.post(u2, headers={**headers(), **(s2.get("headers") or {})}, data=body)
    print("写 HTTP", r2.status_code)
    try:
        j2 = r2.json()
    except Exception:
        j2 = {"raw": r2.text[:400]}
    print(json.dumps(j2, ensure_ascii=False)[:800])
    time.sleep(2)
    g1 = guard()
    print("体检(后):", json.dumps(g1, ensure_ascii=False))
    return 0 if j2.get("status_code") == 0 else 6


if __name__ == "__main__":
    sys.exit(main())
