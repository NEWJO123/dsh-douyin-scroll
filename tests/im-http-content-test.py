"""Offline content parsing: never import HTTP dependencies, credentials, or the script entrypoint."""
import ast
import json
from pathlib import Path
import unittest


SOURCE = Path(__file__).resolve().parents[1] / "tools" / "im-http.py"
tree = ast.parse(SOURCE.read_text(encoding="utf-8"), filename=str(SOURCE))
definitions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "message_content"]
if len(definitions) != 1:
    raise AssertionError("Expected the pure message_content parser")
namespace = {"json": json}
exec(compile(ast.Module(body=definitions, type_ignores=[]), str(SOURCE), "exec"), namespace)
message_content = namespace["message_content"]


class ImContentTests(unittest.TestCase):
    def test_default_consumer_still_omits_messages_without_text(self):
        self.assertIsNone(message_content('{"image":{"url":"fixture-only"}}'))
        self.assertIsNone(message_content('{"text":"  "}'))

    def test_explicit_nontext_marker_preserves_latest_message_position(self):
        raw = ['{"text":"older question"}', '{"image":{"url":"fixture-only"}}']
        parsed = [message_content(value, include_nontext=True) for value in raw]
        self.assertEqual(parsed[0], {"text": "older question", "kind": "text"})
        self.assertEqual(parsed[-1], {"text": "", "kind": "unsupported"})
        self.assertNotIn("fixture-only", str(parsed))

    def test_existing_text_card_and_unstructured_content_remain_unchanged(self):
        self.assertEqual(message_content('{"text":" hello "}', True), {"text": "hello", "kind": "text"})
        self.assertEqual(message_content('{"content_title":"fixture card","aweType":800}', True),
                         {"text": "fixture card", "kind": "card"})
        self.assertEqual(message_content("fixture non-json", True), {"text": "fixture non-json", "kind": "text"})


if __name__ == "__main__":
    unittest.main()
