"""tools/execute 高危工具门控测试。

直接调用路由函数（不依赖 httpx/pytest 运行时），两种方式均可：
    cd backend && python tests/test_execute_gate.py
    cd backend && python -m pytest tests/test_execute_gate.py -q

运行前提：从 backend/ 目录执行（模块按顶层包导入 tools / routers）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from routers.tools import ExecuteIn, execute_tool_endpoint  # noqa: E402


def test_shell_denied():
    r = execute_tool_endpoint(ExecuteIn(name="shell", args={"command": "echo pwned"}))
    assert r["ok"] is False, r
    assert "shell" in r["error"]


def test_editfile_denied():
    r = execute_tool_endpoint(ExecuteIn(name="editfile", args={"file_path": "x.txt", "content": "v"}))
    assert r["ok"] is False


def test_apply_patch_denied():
    r = execute_tool_endpoint(ExecuteIn(name="apply_patch", args={"patch": "*** Begin Patch"}))
    assert r["ok"] is False


def test_askuser_denied():
    r = execute_tool_endpoint(ExecuteIn(name="AskUser", args={"question": "?"}))
    assert r["ok"] is False


def test_knowledge_write_overwrite_denied():
    r = execute_tool_endpoint(ExecuteIn(
        name="knowledge_write",
        args={"name": "a.md", "content": "x", "mode": "overwrite"},
    ))
    assert r["ok"] is False, r
    assert "overwrite" in r["error"]


def test_allowed_tool_passes_gate():
    """放行路径端到端可用：无副作用的 get_current_time 正常执行。"""
    r = execute_tool_endpoint(ExecuteIn(name="get_current_time", args={}))
    assert r.get("ok") is True, r
    assert r.get("result"), r


def test_unknown_tool_reported_not_crash():
    """未知工具不抛异常：工具层返回错误文案（ok=True + result 提示不存在）。"""
    r = execute_tool_endpoint(ExecuteIn(name="no_such_tool", args={}))
    assert isinstance(r, dict)
    assert "不存在" in str(r.get("result", "")), r


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
