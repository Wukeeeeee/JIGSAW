"""工作流落盘（R5）单测：normalize 白名单 + store upsert/落盘/删除往返。

    cd backend && python tests/test_workflow_persist.py
    cd backend && python -m pytest tests/test_workflow_persist.py -q

落盘测试把 WORKFLOWS_FILE 指向临时目录，不碰真实 backend/data/workflows.json。
"""
import io
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import store as store_mod              # noqa: E402
from services.workflow_service import normalize      # noqa: E402


def test_normalize_keeps_name_and_defaults():
    out = normalize({"nodes": [{"id": "a", "status": "success"}], "edges": [], "name": " 测试画布 "})
    assert out["name"] == "测试画布", out
    assert out["nodes"][0]["status"] == "success"   # 已有状态透传，不重置
    assert out["nodes"][0]["tools"] == []


def test_normalize_drops_runtime_flags():
    out = normalize({"nodes": [], "edges": [], "name": "x", "running": True, "executed": True})
    assert "running" not in out and "executed" not in out


def test_normalize_empty_name_not_kept():
    out = normalize({"nodes": [], "edges": [], "name": "   "})
    assert "name" not in out


def test_save_upsert_delete_roundtrip():
    old_file = store_mod.WORKFLOWS_FILE
    old_wfs = dict(store_mod.store.workflows)
    tmp = tempfile.mkdtemp(prefix="jigsaw_wf_test_")
    try:
        store_mod.WORKFLOWS_FILE = os.path.join(tmp, "workflows.json")
        store_mod.store.workflows = {}

        # upsert：不存在则创建（此前 PUT 对未知 wf_id 返回 404，前端无法先存后建）
        wf = store_mod.store.save_workflow("wf-t1", {
            "nodes": [{"id": "n1", "status": "success"}], "edges": [], "name": "T1",
        })
        assert wf["conversationId"] == "t1"
        assert wf["name"] == "T1"

        # 落盘可读回
        with io.open(store_mod.WORKFLOWS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        assert data["wf-t1"]["nodes"][0]["status"] == "success"

        # 二次保存 merge（更新 name）
        store_mod.store.save_workflow("wf-t1", {"nodes": [{"id": "n1"}], "edges": [], "name": "T1b"})
        assert store_mod.store.get_workflow("wf-t1")["name"] == "T1b"

        # 删除同步落盘
        assert store_mod.store.delete_workflow("wf-t1") is True
        with io.open(store_mod.WORKFLOWS_FILE, encoding="utf-8") as f:
            assert "wf-t1" not in json.load(f)
        assert store_mod.store.delete_workflow("wf-t1") is False
    finally:
        store_mod.WORKFLOWS_FILE = old_file
        store_mod.store.workflows = old_wfs


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
