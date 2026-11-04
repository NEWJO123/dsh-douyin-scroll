#!/usr/bin/env python
"""Offline notification and draft-gate regressions; never load credentials or send."""
import ast
import copy
import io
import json
import pathlib
import re
import shutil
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.parse import parse_qs, urlparse


ROOT = pathlib.Path(__file__).resolve().parents[1]
WORK = "7000000000000000001"
TARGET = "9223372036854775807"
ROOT_CID = "9223372036854775806"
NOTE_URL = "https://www.douyin.com/note/" + WORK


def load_normalizer():
    """Compile just pure definitions, excluding auth reads and HTTP dependencies."""
    path = ROOT / "tools" / "notice-read.py"
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    selected = [
        node for node in tree.body
        if (isinstance(node, ast.FunctionDef) and node.name in ("work_metadata", "norm"))
        or (isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "TYPE_NAME"
            for target in node.targets
        ))
    ]
    if len(selected) != 3:
        raise AssertionError("Expected TYPE_NAME, work_metadata and norm definitions")
    namespace = {"re": re, "urlparse": urlparse, "parse_qs": parse_qs, "RAW": False}
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(path), "exec"), namespace)
    return namespace


class NotificationWorkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.namespace = load_normalizer()

    def fixture(self, **work):
        return {
            "type": 45, "nid": 9223372036854775805, "create_time": 123,
            "at": {
                "schema_url": "aweme://aweme/detail/%s?cid=%s" % (WORK, TARGET),
                "user_info": {"nickname": "sender", "uid": 9223372036854775804},
                "content": "@me hello", "aweme": {"aweme_id": int(WORK), **work},
            },
        }

    def norm(self, fixture):
        return self.namespace["norm"](fixture)

    def test_note_url_overrides_numeric_zero_type(self):
        # Live /note/ works can report aweme_type=0; route and type are independent.
        item = self.norm(self.fixture(aweme_type=0, web_url=NOTE_URL + "?from=notice"))
        self.assertEqual(item["aweme_type"], 0)
        self.assertEqual(item["work_url"], NOTE_URL)
        self.assertEqual(item["web_url"], NOTE_URL)
        self.assertEqual(item["video_url"], NOTE_URL)
        self.assertEqual(item["comment_url"], NOTE_URL + "?comment_id=" + TARGET)

    def test_photo_types_with_no_url(self):
        for value in (68, "68", 150, "150"):
            with self.subTest(aweme_type=value):
                item = self.norm(self.fixture(aweme_type=value))
                self.assertEqual(item["work_url"], NOTE_URL)
                self.assertEqual(item["aweme_type"], int(value))

    def test_images_identify_note_without_inventing_type(self):
        for metadata in ({"images": [{"uri": "fixture"}]}, {"image_post_info": {"title": "fixture"}}):
            with self.subTest(metadata=metadata):
                item = self.norm(self.fixture(**metadata))
                self.assertEqual(item["work_url"], NOTE_URL)
                self.assertNotIn("aweme_type", item)

    def test_unknown_work_is_not_silently_a_video(self):
        item = self.norm(self.fixture())
        for key in ("aweme_type", "work_url", "video_url", "comment_url"):
            self.assertNotIn(key, item)

    def test_actual_video_url_takes_priority_over_photo_type(self):
        video_url = "https://www.douyin.com/video/" + WORK
        item = self.norm(self.fixture(aweme_type=68, share_info={"share_url": video_url}))
        self.assertEqual(item["work_url"], video_url)
        self.assertEqual(item["aweme_type"], 68)

    def test_nested_reply_preserves_large_string_ids_and_target(self):
        fixture = self.fixture(aweme_type=0, web_url=NOTE_URL)
        fixture["type"] = 31
        fixture["comment"] = fixture.pop("at")
        fixture["comment"].update({
            "comment": {"cid": int(TARGET), "text": "reply", "user": {"nickname": "actual sender", "uid": 9223372036854775803}},
            "parent_id": int(ROOT_CID),
            "level1_comment": {"cid": "1111111111111111111", "text": "root"},
            "reply_comment": {"cid": 9223372036854775802, "text": "my earlier reply"},
        })
        item = self.norm(fixture)
        self.assertEqual(item["aweme_id"], WORK)
        self.assertEqual(item["comment_id"], TARGET)
        self.assertEqual(item["root_comment_id"], ROOT_CID)
        self.assertEqual(item["reply_to_comment_id"], "9223372036854775802")
        self.assertEqual(item["nid"], "9223372036854775805")
        self.assertEqual(item["uid"], "9223372036854775803")
        self.assertEqual(item["nickname"], "actual sender")
        self.assertEqual(item["content"], "reply")

    def test_level_one_fallback_supplies_root(self):
        fixture = self.fixture(aweme_type=150)
        fixture["at"]["level1_comment"] = {"cid": int(ROOT_CID)}
        self.assertEqual(self.norm(fixture)["root_comment_id"], ROOT_CID)

    def test_web_note_notice_extracts_ids_from_url(self):
        fixture = self.fixture(aweme_type=0)
        fixture["at"].pop("aweme")
        fixture["at"]["schema_url"] = NOTE_URL + "?comment_id=" + TARGET
        item = self.norm(fixture)
        self.assertEqual(item["aweme_id"], WORK)
        self.assertEqual(item["comment_id"], TARGET)
        self.assertEqual(item["work_url"], NOTE_URL)

    def test_external_or_mismatched_links_do_not_change_route(self):
        for url in ("https://example.com/note/" + WORK, "https://www.douyin.com/note/1111111111111111111"):
            with self.subTest(url=url):
                item = self.norm(self.fixture(web_url=url))
                self.assertEqual(item["aweme_id"], WORK)
                self.assertNotIn("work_url", item)

    def test_normalization_does_not_mutate_input(self):
        fixture = self.fixture(aweme_type=0, web_url=NOTE_URL)
        before = copy.deepcopy(fixture)
        self.norm(fixture)
        self.assertEqual(fixture, before)


class DraftGateTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "node unavailable")
    def test_actual_host_and_mcp_handlers_return_drafts_without_sending(self):
        # Evaluate tool declarations only in a VM. Every potential send/network
        # dependency throws, so even an accidental gate regression cannot send.
        js = r'''
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createCommentSender } from './lib/comment-send.mjs';
const fail = () => { throw new Error('SIDE EFFECT: draft crossed send gate'); };
const args = { aweme_id:'7000000000000000001', work_url:'https://www.douyin.com/note/7000000000000000001', aweme_type:0,
  comment_id:'9223372036854775807', root_comment_id:'9223372036854775806', text:'offline draft' };
const verify = (draft) => {
  assert.equal(draft.sent, false);
  assert.equal(draft.needsConfirm, true);
  assert.equal(draft.work_url, args.work_url);
  assert.equal(draft.aweme_type, 0);
};
const host = readFileSync('index.js', 'utf8');
const nameAt = host.indexOf("name: 'douyin_comment_reply'");
assert.ok(nameAt > 0);
const begin = host.lastIndexOf('const commentReplySpec = {', nameAt);
const end = host.indexOf('const executeCommentReply = ', nameAt);
assert.ok(begin >= 0 && end > begin);
const declaration = host.slice(host.indexOf('const workParameters'), host.indexOf('// ⭐ 这两样'));
const hostContext = { tool:(value) => { hostContext.reply = value; }, runNodeTool:fail, runPy:fail,
  sendGate:fail, fetch:fail, markSent:fail, readbackAfter:fail };
vm.runInNewContext(declaration + host.slice(begin, end) + ';globalThis.reply = commentReplySpec;', hostContext);
for (const confirm of [undefined, false]) {
  const draft = await hostContext.reply.execute({ ...args, confirm });
  verify(draft);
  assert.equal(draft.comment_id, args.comment_id);
  assert.equal(draft.root_comment_id, args.root_comment_id);
}
const uiDraft = await hostContext.reply.execute({ ...args, comment_id:'', root_comment_id:'', mode:'ui', mention_name:'fixture' });
verify(uiDraft);
const mcp = readFileSync('tools/mcp-server.mjs', 'utf8');
const work = mcp.slice(mcp.indexOf('const workProperties'), mcp.indexOf('const SERVER_NAME'));
const tools = mcp.slice(mcp.indexOf('const TOOLS = ['), mcp.indexOf('/* ─────────────────────────── JSON-RPC'));
const context = { needLogin:() => null, needSetup:() => null, runNode:fail, run:fail, runPy:fail, fetch:fail, createCommentSender, HOME:'unused-offline-home' };
vm.runInNewContext(work + tools + ';globalThis.testTools = TOOLS;', context);
for (const confirm of [undefined, false]) {
  const draft = context.testTools.find(t => t.name === 'douyin_comment_reply').handler({ ...args, confirm });
  verify(draft);
  assert.equal(draft.root_comment_id, args.root_comment_id);
  const mentionDraft = context.testTools.find(t => t.name === 'douyin_comment_mention').handler({ ...args, name:'fixture', confirm });
  verify(mentionDraft);
}
console.log('host/MCP API reply and mention draft gates passed');
'''
        result = subprocess.run(
            [shutil.which("node"), "--input-type=module"], input=js,
            text=True, encoding="utf-8", capture_output=True, cwd=ROOT, timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


class CommentReadFallbackTests(unittest.TestCase):
    def load_reader(self, signed=None, http=200, cdp=None, exit_code=0):
        """Only compile reader functions; every I/O dependency is a local stub."""
        path = ROOT / "tools" / "api-comments.py"
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        selected = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                    and node.name in ("validate_comment_page", "page_fetch")]
        self.assertEqual(len(selected), 2)
        response = SimpleNamespace(status_code=http, json=Mock(return_value=signed))
        child = SimpleNamespace(returncode=exit_code, stdout=json.dumps(cdp).encode("utf-8"), stderr=b"")
        ns = {
            "sign": Mock(return_value={"signedUrl": "/fixture"}),
            "httpx": SimpleNamespace(get=Mock(return_value=response)),
            "subprocess": SimpleNamespace(run=Mock(return_value=child)),
            "os": SimpleNamespace(environ={}), "sys": SimpleNamespace(stderr=io.StringIO()),
            "json": json, "UA": "fixture", "COOKIE": "fixture", "NODE": "fixture-node",
            "CDP_FETCH": "fixture-cdp", "PLUGIN": "fixture-plugin", "HOME": "fixture-home",
        }
        exec(compile(ast.Module(body=selected, type_ignores=[]), str(path), "exec"), ns)
        return ns, response

    def test_valid_empty_signed_pages_do_not_fall_back(self):
        for comments in ([], None):
            with self.subTest(comments=comments):
                page = {"status_code": 0, "comments": comments, "total": 0, "has_more": 0}
                ns, _ = self.load_reader(signed=page)
                result, mode = ns["page_fetch"]("/fixture")
                self.assertEqual(result, page)
                self.assertEqual(mode, "signed")
                ns["subprocess"].run.assert_not_called()

    def test_rejected_or_invalid_signed_pages_use_cdp(self):
        valid = {"status_code": 0, "comments": [{"cid": TARGET}]}
        for page in ({"status_code": 5, "comments": []}, {}, None,
                     {"status_code": 0}, {"status_code": 0, "comments": "invalid"},
                     {"status_code": 0, "comments": None, "total": 3}):
            with self.subTest(page=page):
                ns, _ = self.load_reader(signed=page, cdp=valid)
                self.assertEqual(ns["page_fetch"]("/fixture"), (valid, "cdp"))
                ns["subprocess"].run.assert_called_once()

    def test_http_error_cannot_override_valid_looking_body(self):
        page = {"status_code": 0, "comments": []}
        ns, _ = self.load_reader(signed=page, http=503, cdp=page)
        self.assertEqual(ns["page_fetch"]("/fixture"), (page, "cdp"))

    def test_signed_transport_and_decode_errors_fall_back(self):
        page = {"status_code": 0, "comments": []}
        for failure in ("transport", "decode", "signer"):
            with self.subTest(failure=failure):
                ns, response = self.load_reader(signed=page, cdp=page)
                if failure == "transport":
                    ns["httpx"].get.side_effect = RuntimeError("offline transport failure")
                elif failure == "decode":
                    response.json.side_effect = ValueError("empty body")
                else:
                    ns["sign"].side_effect = ValueError("malformed signer output")
                self.assertEqual(ns["page_fetch"]("/fixture"), (page, "cdp"))

    def test_both_rejected_responses_raise_instead_of_empty_success(self):
        ns, _ = self.load_reader(signed={"status_code": 5}, cdp={"status_code": 5, "comments": []})
        with self.assertRaisesRegex(RuntimeError, "status_code=5"):
            ns["page_fetch"]("/fixture")

    def test_cdp_process_failure_cannot_report_success(self):
        ns, _ = self.load_reader(signed={"status_code": 5}, cdp={"status_code": 0, "comments": []}, exit_code=1)
        with self.assertRaisesRegex(RuntimeError, "exit=1"):
            ns["page_fetch"]("/fixture")

    def test_empty_cdp_body_is_failure(self):
        ns, _ = self.load_reader(signed={"status_code": 5})
        ns["subprocess"].run.return_value.stdout = b""
        with self.assertRaises(RuntimeError):
            ns["page_fetch"]("/fixture")


if __name__ == "__main__":
    unittest.main(verbosity=2)
