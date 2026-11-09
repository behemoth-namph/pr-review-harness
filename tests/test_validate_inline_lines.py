"""Run: python3 -I tests/test_validate_inline_lines.py"""
import importlib.util
import pathlib

root = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("v", root / "skills/pr-review/scripts/validate_inline_lines.py")
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)

DIFF = """diff --git a/src/a.rb b/src/a.rb
--- a/src/a.rb
+++ b/src/a.rb
@@ -10,3 +10,4 @@ def x
 keep
-old
+new
+added
 tail
"""
f = v.parse(DIFF)["src/a.rb"]
assert f["RIGHT"] == {10, 11, 12, 13}, f["RIGHT"]
assert f["LEFT"] == {10, 11, 12}, f["LEFT"]
assert 99 not in f["RIGHT"]
print("ok  hunk parsing: right/left line sets")
