"""R8+ 全局规则（rules.md）注入单测。

    cd backend && python tests/test_rules.py
    cd backend && python -m pytest tests/test_rules.py -q

_rules_path 重定向到临时文件，不碰真实 data/rules.md。
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import chat_service  # noqa: E402


def test_no_rules_file_returns_empty():
    old = chat_service._rules_path
    try:
        chat_service._rules_path = lambda: os.path.join(tempfile.mkdtemp(prefix="jigsaw_r_"), "rules.md")
        assert chat_service._load_user_rules() == ""
    finally:
        chat_service._rules_path = old


def test_rules_injected_with_marker():
    old = chat_service._rules_path
    try:
        p = os.path.join(tempfile.mkdtemp(prefix="jigsaw_r_"), "rules.md")
        with open(p, "w", encoding="utf-8") as f:
            f.write("始终使用简体中文回复\n代码注释用中文")
        chat_service._rules_path = lambda: p
        r = chat_service._load_user_rules()
        assert "【用户全局规则（必须遵守）】" in r
        assert "始终使用简体中文回复" in r
        # system prompt 整体注入
        assert "始终使用简体中文回复" in chat_service._build_system_prompt()
    finally:
        chat_service._rules_path = old


def test_rules_truncated_when_too_long():
    old = chat_service._rules_path
    try:
        p = os.path.join(tempfile.mkdtemp(prefix="jigsaw_r_"), "rules.md")
        with open(p, "w", encoding="utf-8") as f:
            f.write("规" * (chat_service._RULES_MAX_CHARS + 500))
        chat_service._rules_path = lambda: p
        r = chat_service._load_user_rules()
        assert len(r) < chat_service._RULES_MAX_CHARS + 200
        assert "已截断" in r
    finally:
        chat_service._rules_path = old


def test_empty_rules_file_returns_empty():
    old = chat_service._rules_path
    try:
        p = os.path.join(tempfile.mkdtemp(prefix="jigsaw_r_"), "rules.md")
        open(p, "w", encoding="utf-8").close()
        chat_service._rules_path = lambda: p
        assert chat_service._load_user_rules() == ""
    finally:
        chat_service._rules_path = old


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS  {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
