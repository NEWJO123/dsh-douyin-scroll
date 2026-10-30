#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
tools/forward-pick.py —— 刷一轮：拉候选 → 打分 → 生成「转发给我」的清单
============================================================================
只读、**不签名**、不碰写接口。判断依据全部来自 JSON 字段：
desc / tags / author / create_time / duration / digg·comment·collect·share / 高赞评论。
不看画面、不做 ASR/OCR、不读视频。

用法:
  python tools/forward-pick.py            # 拉 feed 3 页 + 热榜，出清单
  python tools/forward-pick.py --dump     # 额外打印原始结构，排错用
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _home import home_str  # noqa: E402
import time
from datetime import datetime, timezone, timedelta

from curl_cffi import requests as creq

# ⚠️ 2026-10-21 实测：Windows 上 stdout 默认 GBK，遇到标题里的 𝓋 / emoji 这类字符
#    直接 UnicodeEncodeError 崩掉（这一轮就是崩在最后打印清单那一步）。
#    插件是 spawnSync 抓管道的，崩了就等于「取候选失败」—— 一律强制 utf-8，编不出的替换掉。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HOME = home_str()
COOKIE_FILE = os.path.join(HOME, "douyin_cookie.txt")
OUT_JSON = os.path.join(HOME, "forward-pick.json")
OUT_MD = os.path.join(HOME, "out", "forward-" + datetime.now().strftime("%Y%m%d-%H%M") + ".md")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")
BASE = "https://www.douyin.com"
COMMON = ("device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1"
          "&version_code=190500&version_name=19.5.0&cookie_enabled=true"
          "&screen_width=1920&screen_height=1080&browser_language=zh-CN"
          "&browser_platform=Win32&browser_name=Chrome&browser_version=141.0.0.0"
          "&engine_name=Blink&engine_version=141.0.0.0&os_name=Windows&os_version=10"
          "&platform=PC&downlink=10&effective_type=4g&round_trip_time=50")

CST = timezone(timedelta(hours=8))


def load_cookie():
    with open(COOKIE_FILE, "r", encoding="utf-8") as f:
        return f.read().strip()


def walk_awemes(obj, bag):
    """递归找所有长成 aweme 的 dict（有 aweme_id + desc）。"""
    if isinstance(obj, list):
        for v in obj:
            walk_awemes(v, bag)
    elif isinstance(obj, dict):
        if "aweme_id" in obj and ("desc" in obj or "statistics" in obj):
            bag[obj["aweme_id"]] = obj
        else:
            for v in obj.values():
                walk_awemes(v, bag)


def stat(a, k):
    s = a.get("statistics") or {}
    try:
        return int(s.get(k) or 0)
    except Exception:
        return 0


def fmts(n):
    if n >= 100000000:
        return "%.1f亿" % (n / 100000000.0)
    if n >= 10000:
        return "%.1f万" % (n / 10000.0)
    return str(n)


def get(s, path, quiet=True):
    try:
        r = s.get(BASE + path, timeout=25)
        time.sleep(1.2)
        if r.status_code != 200:
            if not quiet:
                print("  ! %s -> HTTP %s" % (path.split("?")[0], r.status_code), file=sys.stderr)
            return None
        return r.json()
    except Exception as e:
        if not quiet:
            print("  ! %s -> %s" % (path.split("?")[0], e), file=sys.stderr)
        return None


def load_collector():
    """
    ⭐ 读设置页那两个旋钮（`collector.json`，由 index.js 的 syncCollectorCfg 写）。
    以前这里完全没读它 ⇒ 设置页「文案太短 / 评论少」两个旋钮是死的（改了不起作用）。
    """
    p = os.path.join(HOME, "collector.json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            j = json.load(f) or {}
    except Exception:
        j = {}
    return {
        "minDescLen": int(j.get("minDescLen") or 0),
        "minComments": int(j.get("minComments") or 0),
    }


def load_keywords():
    """设置页的「关注关键词」（config.json 里的 keywords）。

    ⭐ Issue #3（2026-10-30）：关键词**不参与采集** —— 抖音 web 没有可用的搜索接口
    （general/search 被 2483 挡），候选只能来自推荐流 + 热榜。所以这里的用法是
    **软偏好**：命中的候选排前面（×1.35），没命中也不丢、不扣分。
    硬筛会把推荐流里的意外惊喜筛没，那才是真损失。
    """
    p = os.path.join(HOME, "config.json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            j = json.load(f) or {}
        kws = j.get("keywords") or []
        return [str(k).strip() for k in kws if str(k).strip()]
    except Exception:
        return []


def tags_of(a):
    """话题 / 话题标签：cha_list 优先，text_extra 兜底（接口两种形态都出现过）。"""
    out = []
    for c in (a.get("cha_list") or []):
        n = (c.get("cha_name") or "").strip()
        if n:
            out.append(n)
    for t in (a.get("text_extra") or []):
        n = (t.get("hashtag_name") or "").strip()
        if n:
            out.append(n)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", action="store_true")
    ap.add_argument("--limit", type=int, default=10, help="最多取前几条（默认 10）")
    args = ap.parse_args()

    limits = load_collector()
    # ⭐ Issue #3：关键词只做**软加分**（不参与采集，也不硬筛）
    kws = load_keywords()
    kw_hits_total = 0
    # ⭐ 硬筛计数：报告里要能说清"因为什么跳过了几条"，不能只给个最终条数
    dropped = {"no_desc": 0, "too_short_video": 0, "short_and_quiet": 0}

    cookie = load_cookie()
    bag = {}
    meta = []

    with creq.Session(impersonate="chrome") as s:
        s.headers.update({
            "User-Agent": UA, "Cookie": cookie,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Referer": BASE + "/", "Origin": BASE,
        })

        # 1) 推荐流 3 页
        for i in range(1, 4):
            j = get(s, "/aweme/v1/web/tab/feed/?%s&count=20&refresh_index=%d" % (COMMON, i))
            if j:
                before = len(bag)
                walk_awemes(j, bag)
                meta.append({"src": "feed#%d" % i, "new": len(bag) - before, "status": j.get("status_code")})
                if args.dump and i == 1:
                    print("[feed#1 top-level keys] %s" % sorted(j.keys()), file=sys.stderr)

        # 2) 热榜
        j = get(s, "/aweme/v1/web/hot/search/list/?%s&detail_list=1" % COMMON)
        if j:
            before = len(bag)
            walk_awemes(j, bag)
            meta.append({"src": "hot-search", "new": len(bag) - before, "status": j.get("status_code")})

    now = time.time()
    rows = []
    for aid, a in bag.items():
        desc = (a.get("desc") or "").strip()
        if not desc:
            dropped["no_desc"] += 1
            continue
        dur = a.get("duration") or (a.get("video") or {}).get("duration") or 0
        if dur and dur < 12000:          # <12s 多数是模板/广告
            dropped["too_short_video"] += 1
            continue
        d, c, col, sh = stat(a, "digg_count"), stat(a, "comment_count"), stat(a, "collect_count"), stat(a, "share_count")
        # ⭐ 设置页那两个旋钮：文案太短**且**评论少 ⇒ 丢（单条不满足只降权不丢）
        if limits["minDescLen"] and len(desc) < limits["minDescLen"] and c < limits["minComments"]:
            dropped["short_and_quiet"] += 1
            continue
        ct = a.get("create_time") or 0
        age_h = (now - ct) / 3600.0 if ct else 999
        inter = d + c * 2 + col * 3 + sh * 2
        # 评论/点赞比：越高越"有话说"；太高的往往是争议/标题党
        ratio = (c / d) if d else 0
        score = inter
        if 0.02 <= ratio <= 0.25:
            score *= 1.25
        if age_h <= 72:
            score *= 1.15
        # ⭐ 关键词软加分（Issue #3）：命中就往前排，**不命中也不丢** ——
        #    硬筛会把推荐流里「没写关键词但确实好看」的筛没，那才是真损失。
        tags = tags_of(a)
        hay = (desc + " " + " ".join(tags)).lower()
        hits = [k for k in kws if k.lower() in hay]
        if hits:
            score *= 1.35
            kw_hits_total += 1
        si = a.get("share_info") or {}
        official = si.get("share_url") or a.get("share_url") or ""
        rows.append({
            "aweme_id": aid,
            "desc": desc,
            "author": (a.get("author") or {}).get("nickname") or "",
            "sec_uid": (a.get("author") or {}).get("sec_uid") or "",
            "duration_s": round(dur / 1000.0, 1) if dur else None,
            "digg": d, "comment": c, "collect": col, "share": sh,
            "comment_ratio": round(ratio, 4),
            "age_h": round(age_h, 1),
            "score": int(score),
            # ⭐ 官方分享链接（接口直接给的，带 share_sign）——不要自己拼 aweme_id
            "share_url": official or ("https://www.iesdouyin.com/share/video/%s/" % aid),
            # 抖音口令（"复制此链接，打开Dou音搜索"那串）
            "share_desc": (si.get("share_link_desc") or "").replace("%s", official).strip(),
            # 网页地址（能在浏览器打开，但不是分享链接）
            "web_url": "%s/video/%s" % (BASE, aid),
            # ⭐ 命中的关注关键词（软加分用；报告里可以据此标注"你说过想看这类"）
            "kw_hits": hits[:5],
        })

    rows.sort(key=lambda r: -r["score"])
    top = rows[:max(1, args.limit)]

    print("采集：%s" % json.dumps(meta, ensure_ascii=False))
    print("硬筛跳过：%s（阈值 文案≥%d 字 / 评论≥%d）" % (
        json.dumps(dropped, ensure_ascii=False), limits["minDescLen"], limits["minComments"]))
    print("去重后候选 %d 条，取前 %d" % (len(rows), len(top)))
    if kws:
        # 说清楚关键词到底做了什么、没做什么 —— 这是 Issue #3 的核心误会
        print("关键词（%d 个）只做软加分：命中 %d 条排前面；**不参与采集、不硬筛**" % (len(kws), kw_hits_total))
    for i, r in enumerate(top, 1):
        hit = ("【命中:%s】" % "/".join(r.get("kw_hits") or [])) if r.get("kw_hits") else ""
        print("%2d. [%s] %s%s" % (i, fmts(r["digg"]), r["desc"][:46], hit))
        print("    %s · %s · 赞%s 评%s 藏%s 转%s · %s" % (
            r["author"],
            ("%ss" % r["duration_s"]) if r["duration_s"] else "时长未知",
            fmts(r["digg"]), fmts(r["comment"]), fmts(r["collect"]), fmts(r["share"]),
            ("%.0f小时前" % r["age_h"]) if r["age_h"] < 900 else "时间未知"))
        print("    %s" % r["share_url"])

    os.makedirs(os.path.dirname(OUT_MD), exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "rows": top, "dropped": dropped, "thresholds": limits}, f, ensure_ascii=False, indent=1)
    with open(OUT_MD, "w", encoding="utf-8") as f:
        f.write("# 转发清单 %s\n\n" % datetime.now(CST).strftime("%Y-%m-%d %H:%M"))
        for i, r in enumerate(top, 1):
            f.write("### %s\n" % r["aweme_id"])
            f.write("- %s\n" % r["desc"])
            f.write("- %s · %ss · 赞%s 评%s 藏%s\n" % (r["author"], r["duration_s"], fmts(r["digg"]), fmts(r["comment"]), fmts(r["collect"])))
            f.write("- %s\n\n" % r["share_url"])
    print("\n清单 -> %s" % OUT_MD)


if __name__ == "__main__":
    main()
