#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
tools/notice-read.py —— 读抖音互动通知（@ 我的 / 评论 / 点赞 / 关注 / 粉丝）
============================================================================
关键（踩了很久才摸出来）：
  · 列表在响应的 **notice_list_v2** 里，不是 notice_list
  · 必须**同时**给 `group` 和 `notice_group` 两个参数，缺一个就 status_code=5
  · `min_time=0` 才会把历史拉出来
  · 网页端**没有**通知中心页面（/notice /notification /message /interaction 全 404），
    所以只能走这个接口

只读：is_mark_read=0（不把消息标成已读）

用法:
  python tools/notice-read.py            # 输出干净的 JSON
  python tools/notice-read.py --raw      # 连原始条目一起给
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _home import home_str, utf8_stdio  # noqa: E402

# ⚠️ 通知里必然有昵称 + emoji，GBK 控制台直接崩（Issue #7②）
utf8_stdio()

import time

from curl_cffi import requests as creq

HOME = home_str()
COOKIE = open(os.path.join(HOME, "douyin_cookie.txt"), encoding="utf-8").read().strip()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")
BASE = "https://www.douyin.com"
COMMON = ("device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1"
          "&version_code=190500&version_name=19.5.0&cookie_enabled=true"
          "&screen_width=1920&screen_height=1080&browser_language=zh-CN"
          "&browser_platform=Win32&browser_name=Chrome&browser_version=141.0.0.0"
          "&engine_name=Blink&engine_version=141.0.0.0&os_name=Windows&os_version=10"
          "&platform=PC")

# 通知类型（实测 + 推断）
# ⚠️ 31 / 32 是"回复"类（2026-10-23 实测补上）：以前只认 45/46，
#    于是「别人在我的评论下面回复我」这类通知**全被漏掉**（type=31 里 comment_type=2）。
TYPE_NAME = {
    31: "回复了评论 / 在我的评论下回复",
    32: "回复了你的评论",
    33: "关注了你",
    34: "点赞了你的作品",
    35: "评论了你的作品",
    41: "点赞了你的评论",
    45: "@了你（评论区）",
    46: "@了你（作品）",
}

GROUPS = [700, 960, 401, 601]
RAW = "--raw" in sys.argv


def norm(it):
    """把一条通知压成人类可读的形状"""
    t = it.get("type")
    rec = {"type": t, "type_name": TYPE_NAME.get(t, "type_%s" % t), "nid": it.get("nid"), "create_time": it.get("create_time")}
    for key in ("at", "comment", "digg", "follow", "fans", "im", "system"):
        blk = it.get(key)
        if not isinstance(blk, dict):
            continue
        ui = blk.get("user_info") or blk.get("from_user") or {}
        # ⭐ "评论类"通知（31/32/35/41）里，真正说话的人在 blk["comment"]["user"]，
        #    不在 user_info / from_user。以前只读前者 ⇒ 这类通知读出来 nickname 是空的。
        inner = blk.get("comment") if isinstance(blk.get("comment"), dict) else None
        if inner:
            iu = inner.get("user") or {}
            if iu.get("nickname"):
                ui = iu
            if inner.get("cid"):
                rec["comment_id"] = str(inner["cid"])
            if inner.get("text"):
                rec["content"] = str(inner["text"]).strip()
        rec["nickname"] = ui.get("nickname") or ""
        rec["uid"] = ui.get("uid") or ""
        rec["content"] = (rec.get("content") or (blk.get("content") or "").strip())
        sch = blk.get("schema_url") or ""
        rec["schema_url"] = sch
        # aweme://aweme/detail/<aweme_id>?cid=<comment_id>
        if "aweme/detail/" in sch:
            try:
                rec["aweme_id"] = sch.split("aweme/detail/")[1].split("?")[0].split("&")[0]
            except Exception:
                pass
            if "cid=" in sch:
                rec.setdefault("comment_id", sch.split("cid=")[1].split("&")[0])
        if blk.get("aweme_id"):
            rec.setdefault("aweme_id", str(blk["aweme_id"]))
        aw = blk.get("aweme") if isinstance(blk.get("aweme"), dict) else None
        if aw and aw.get("aweme_id"):
            rec.setdefault("aweme_id", str(aw["aweme_id"]))
            rec["aweme_desc"] = (aw.get("desc") or "")[:80]

        # ⭐⭐ 楼根（2026-10-23 加的，这是"我该用什么方式回"的关键）：
        #    · 通知里的 `parent_id` = 那条回复所在楼的**顶层评论 cid**（实测：
        #      拿它去 /comment/list/reply/ 能查出整栋楼 7 条，都是 level=2）
        #    · `level1_comment` = 别人评论的那条（可能就是我的评论）
        #    · `reply_comment`  = 我/别人被回的那条
        #    回楼中楼的人时，reply_id 必须填**楼根**，塞对方那条 level2 的 cid
        #    会变成一条冒出来的顶层评论（实测确认过的 bug）。
        if blk.get("parent_id"):
            rec["root_comment_id"] = str(blk["parent_id"])
        lv1 = blk.get("level1_comment") if isinstance(blk.get("level1_comment"), dict) else None
        if lv1:
            if lv1.get("cid"):
                rec.setdefault("root_comment_id", str(lv1["cid"]))
            lu = lv1.get("user") or {}
            rec["root_author"] = lu.get("nickname") or ""
            rec["root_text"] = (lv1.get("text") or "")[:60]
        rep = blk.get("reply_comment") if isinstance(blk.get("reply_comment"), dict) else None
        if rep:
            ru = rep.get("user") or {}
            rec["reply_to_nickname"] = ru.get("nickname") or ""
            rec["reply_to_text"] = (rep.get("text") or "")[:60]
            if rep.get("cid"):
                rec["reply_to_comment_id"] = str(rep["cid"])

        if rec.get("aweme_id"):
            rec["video_url"] = "https://www.douyin.com/video/%s" % rec["aweme_id"]
            if rec.get("comment_id"):
                rec["comment_url"] = "https://www.douyin.com/video/%s?comment_id=%s" % (rec["aweme_id"], rec["comment_id"])
        break
    if RAW:
        rec["raw"] = it
    return rec


def main():
    out = {"ok": True, "counts": {}, "items": []}
    with creq.Session(impersonate="chrome") as s:
        s.headers.update({"User-Agent": UA, "Cookie": COOKIE, "Referer": BASE + "/"})
        try:
            cj = s.get(BASE + "/aweme/v1/web/notice/count/?" + COMMON + "&is_new_notice=1&need_social_count=1", timeout=20).json()
            for c in cj.get("notice_count") or []:
                out["counts"][str(c.get("group"))] = c.get("count")
        except Exception as e:
            out.setdefault("warnings", []).append("count 失败: " + str(e)[:120])
        time.sleep(1.0)

        seen = set()
        for g in GROUPS:
            q = "is_new_notice=1&is_mark_read=0&count=20&min_time=0&group=%d&notice_group=%d" % (g, g)
            try:
                j = s.get(BASE + "/aweme/v1/web/notice/?" + COMMON + "&" + q, timeout=20).json()
                if j.get("status_code") not in (0, None):
                    out.setdefault("warnings", []).append("group=%s status_code=%s" % (g, j.get("status_code")))
                for it in j.get("notice_list_v2") or []:
                    nid = it.get("nid")
                    if nid in seen:
                        continue
                    seen.add(nid)
                    r = norm(it)
                    r["group"] = g
                    out["items"].append(r)
            except Exception as e:
                out.setdefault("warnings", []).append("group=%s %s" % (g, str(e)[:100]))
            time.sleep(1.2)

    out["items"].sort(key=lambda x: x.get("create_time") or 0, reverse=True)
    out["n"] = len(out["items"])
    out["at_n"] = len([x for x in out["items"] if x.get("type") in (45, 46)])
    print(json.dumps(out, ensure_ascii=False, indent=1))
    with open(os.path.join(HOME, "notice.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
