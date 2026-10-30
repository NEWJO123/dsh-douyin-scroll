#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/session-guard.py —— **会话保险丝**：保证"带着坏签名去打鉴权接口"这种事不再发生

事故复盘（2026-10-21 12:41）：
    登录态本来是好的，我连续发了几条**签名不正确**的写请求，抖音把它判定为异常，
    直接注销了整个 web 会话。代价是用户要重新扫码。

从此以后所有抖音请求都走这里，规则写死：

  ① 「先体检后动手」：任何写操作前，先用**不签名**的 profile/self 确认会话有效；
     不是 code=0 就**一律不发写请求**（宁可不发，也不触发风控）。
  ② 「一次一发」：写请求串行、限速（默认间隔 30s），绝不批量刷。
  ③ 「写完复检」：一条写完立刻再体检一次；会话掉了 → 立刻熔断当天所有写操作。
  ④ 「熔断落盘」：熔断状态写进 state/breaker.json，带原因和时间，人工解锁。
  ⑤ 「异常码即熔断」：写接口返回非预期 status_code（尤其 8 用户未登录 / 403）→ 立刻熔断。

用法：
    python tools/session-guard.py check           # 只体检
    python tools/session-guard.py state           # 看熔断状态
    python tools/session-guard.py reset           # 人工解锁
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _home import home_str, utf8_stdio  # noqa: E402

# 体检输出里带昵称（可能含 emoji）—— 被 api-reply.py 读 stdout，崩了整条链就断（Issue #7②）
utf8_stdio()

import time

HOME = home_str()
COOKIE_FILE = os.path.join(HOME, "douyin_cookie.txt")
STATE_DIR = os.path.join(HOME, "state")
BREAKER = os.path.join(STATE_DIR, "breaker.json")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
CHECK_URL = "https://www.douyin.com/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383"


def _cookies() -> dict:
    try:
        raw = open(COOKIE_FILE, encoding="utf-8").read().strip()
    except OSError:
        return {}
    jar = {}
    for p in raw.split(";"):
        if "=" in p:
            k, v = p.split("=", 1)
            jar[k.strip()] = v.strip()
    return jar


def _client():
    from curl_cffi import requests as creq  # noqa: WPS433
    return creq


def check_alive(timeout: float = 20.0) -> dict:
    """不签名、只读地确认会话是否有效。返回 {alive, code, nick, uid}"""
    jar = _cookies()
    if not jar.get("sessionid") and not jar.get("sessionid_ss"):
        return {"alive": False, "code": None, "why": "cookie 里没有 sessionid"}
    try:
        creq = _client()
        r = creq.get(
            CHECK_URL,
            headers={"User-Agent": UA, "Accept": "application/json, text/plain, */*",
                     "Referer": "https://www.douyin.com/"},
            cookies=jar, impersonate="chrome124", timeout=timeout,
        )
        j = r.json()
        code = j.get("status_code")
        user = j.get("user") or {}
        alive = code == 0 and bool(user.get("uid"))
        return {"alive": alive, "code": code, "nick": user.get("nickname"), "uid": user.get("uid"),
                "http": r.status_code}
    except Exception as e:  # noqa: BLE001
        return {"alive": False, "code": None, "why": f"请求异常：{e}"}


def breaker_state() -> dict:
    try:
        return json.load(open(BREAKER, encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {"open": False}


def trip(reason: str, detail: dict | None = None) -> dict:
    """熔断：当天不再发任何写请求"""
    os.makedirs(STATE_DIR, exist_ok=True)
    st = {"open": True, "since": time.strftime("%Y-%m-%dT%H:%M:%S"), "reason": reason, "detail": detail or {}}
    open(BREAKER, "w", encoding="utf-8").write(json.dumps(st, ensure_ascii=False, indent=2))
    return st


def reset() -> dict:
    os.makedirs(STATE_DIR, exist_ok=True)
    st = {"open": False, "resetAt": time.strftime("%Y-%m-%dT%H:%M:%S")}
    open(BREAKER, "w", encoding="utf-8").write(json.dumps(st, ensure_ascii=False, indent=2))
    return st


class GuardedWrite:
    """上下文管理器：① 体检 → ② 允许执行一次写 → ③ 复检；任何异常立刻熔断"""

    def __init__(self, label: str, min_interval: float = 30.0):
        self.label = label
        self.min_interval = min_interval

    def __enter__(self):
        st = breaker_state()
        if st.get("open"):
            raise RuntimeError(f"熔断中（{st.get('reason')}），今天不做写操作。人工确认后跑 reset")
        pre = check_alive()
        if not pre.get("alive"):
            trip("写操作前体检失败：会话无效", pre)
            raise RuntimeError(f"会话无效（{pre}）→ 拒绝发写请求")
        self.pre = pre
        self._t0 = time.time()
        return self

    def __exit__(self, exc_type, exc, tb):
        # 写完复检
        post = check_alive()
        if not post.get("alive"):
            trip("写操作后会话失效（可能被风控注销）", {"label": self.label, "pre": self.pre, "post": post})
        time.sleep(0.0)
        return False  # 不吞异常


def main(argv: list[str]) -> int:
    cmd = (argv[1] if len(argv) > 1 else "check").lower()
    if cmd == "check":
        r = check_alive()
        # ⚠️ 2026-10-21 修：这里原来分两行 print，第二行又是另一个 JSON（熔断状态）。
        #    插件那边是"取第一个 { 到最后一个 }"再 json.loads ⇒ 两个对象粘在一起就解不出来，
        #    `douyin_whoami` 直接报「体检没返回结果」。规矩：stdout **只许有一个 JSON 对象**，
        #    熔断状态并进同一个对象里返回。
        r = dict(r)
        r["breaker"] = breaker_state()
        print(json.dumps(r, ensure_ascii=False, indent=2))
        return 0 if r.get("alive") else 3
    if cmd == "state":
        print(json.dumps(breaker_state(), ensure_ascii=False, indent=2))
        return 0
    if cmd == "reset":
        print(json.dumps(reset(), ensure_ascii=False, indent=2))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
