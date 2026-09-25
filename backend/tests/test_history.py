"""R8 会话历史预算截断单测。

    cd backend && python tests/test_history.py
    cd backend && python -m pytest tests/test_history.py -q

直接向 store 单例注入临时会话（finally 恢复），不落盘、不发起任何 LLM 调用。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import chat_service  # noqa: E402
from services.store import store   # noqa: E402

import langchain_core.messages as lcm  # noqa: E402


def _inject(conv_id, msgs):
    conv = {"id": conv_id, "title": "t", "createdAt": "now", "messages": msgs, "modelId": "x"}
    store.conversations.append(conv)
    return conv


def _msg(role, text):
    return {"id": f"m-{role}-{len(text)}", "role": role, "text": text, "status": "done", "createdAt": "now"}


def test_short_history_fully_kept():
    conv = _inject("c-h1", [_msg("user", "你好"), _msg("assistant", "你好！")])
    try:
        out = chat_service._build_history_messages("c-h1")
        assert len(out) == 2
        assert not any(isinstance(m, lcm.SystemMessage) for m in out)
    finally:
        store.conversations.remove(conv)


def test_message_count_cap():
    msgs = []
    for i in range(50):
        msgs.append(_msg("user", f"问题{i}"))
        msgs.append(_msg("assistant", f"回答{i}"))
    conv = _inject("c-h2", msgs)
    try:
        out = chat_service._build_history_messages("c-h2")
        kept = [m for m in out if not isinstance(m, lcm.SystemMessage)]
        assert len(kept) <= chat_service._HISTORY_MAX_MESSAGES
        # 最新消息必须在
        assert kept[-1].content == "回答49"
        # 有丢弃 → 有说明
        assert any(isinstance(m, lcm.SystemMessage) and "省略" in m.content for m in out)
    finally:
        store.conversations.remove(conv)


def test_char_budget_drops_old():
    # 40 条 2000 字的老消息（8 万字）+ 2 条最近的短消息 → 预算只留最近的若干条
    msgs = [_msg("user", "旧" * 2000) if i % 2 == 0 else _msg("assistant", "旧" * 2000) for i in range(40)]
    msgs += [_msg("user", "最近的问题"), _msg("assistant", "最近的回答")]
    conv = _inject("c-h3", msgs)
    try:
        out = chat_service._build_history_messages("c-h3")
        kept = [m for m in out if not isinstance(m, lcm.SystemMessage)]
        assert kept[-1].content == "最近的回答"
        total = sum(len(m.content) for m in kept)
        # 最近两条无条件保留（哪怕超预算），其余受预算约束
        assert total - len("最近的回答") - len("最近的问题") <= chat_service._HISTORY_CHAR_BUDGET + 2000
        assert len(kept) < len(msgs)
    finally:
        store.conversations.remove(conv)


def test_huge_recent_message_still_kept():
    conv = _inject("c-h4", [_msg("user", "x" * 50000)])
    try:
        out = chat_service._build_history_messages("c-h4")
        assert len(out) == 1 and out[0].content == "x" * 50000
    finally:
        store.conversations.remove(conv)


def test_unknown_roles_skipped():
    conv = _inject("c-h5", [
        {"id": "m-s", "role": "system", "text": "内部状态", "status": "done", "createdAt": "now"},
        _msg("user", "问题"),
    ])
    try:
        out = chat_service._build_history_messages("c-h5")
        assert len(out) == 1 and isinstance(out[0], lcm.HumanMessage)
    finally:
        store.conversations.remove(conv)


def test_empty_conversation():
    conv = _inject("c-h6", [])
    try:
        assert chat_service._build_history_messages("c-h6") == []
        assert chat_service._build_history_messages("c-not-exist") == []
    finally:
        store.conversations.remove(conv)


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
