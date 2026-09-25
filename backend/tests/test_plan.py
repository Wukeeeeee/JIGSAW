"""Captain 规划（R6 第二步）单测：JSON 解析 + 无模型报错路径。

    cd backend && python tests/test_plan.py
    cd backend && python -m pytest tests/test_plan.py -q

plan_workflow 的真实 LLM 调用路径【不测】（会消耗用户 API 配额）：
无模型路径通过临时清空 store.custom_models 触发，finally 恢复。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import chat_service  # noqa: E402
from services.store import store   # noqa: E402


def test_parse_plain_json():
    text = '{"workflowName": "T", "nodes": [{"id": "a", "name": "A", "dependsOn": []}]}'
    plan = chat_service._parse_plan_json(text)
    assert plan["workflowName"] == "T" and plan["nodes"][0]["id"] == "a"


def test_parse_with_code_fence_and_prefix():
    text = '好的，以下是规划：\n```json\n{"workflowName": "T", "nodes": []}\n```\n希望有帮助'
    plan = chat_service._parse_plan_json(text)
    assert plan["workflowName"] == "T"


def test_parse_no_json_raises():
    for bad in ("", "我不知道", "[1,2,3]"):
        try:
            chat_service._parse_plan_json(bad)
            assert False, f"应当抛错: {bad!r}"
        except ValueError:
            pass


def test_parse_non_object_raises():
    import json as _json
    try:
        chat_service._parse_plan_json(_json.dumps([1, 2]))
        assert False, "数组应当抛错"
    except ValueError:
        pass


def test_plan_workflow_without_models_raises_valueerror():
    old = list(store.custom_models)
    try:
        store.custom_models = []
        try:
            chat_service.plan_workflow("测试任务")
            assert False, "无模型应当抛 ValueError"
        except ValueError as e:
            assert "没有可用的对话模型" in str(e)
    finally:
        store.custom_models = old


def test_plan_workflow_image_model_filtered_out():
    """模型库里只有纯生图模型时，等同于没有可用对话模型（过滤生效）。"""
    old = list(store.custom_models)
    try:
        store.custom_models = [{"id": "cm-img", "modelId": "flux-image", "baseUrl": "https://agnes-ai.example/v1", "apiKey": "k"}]
        try:
            chat_service.plan_workflow("测试任务")
            assert False, "纯生图模型应当被过滤"
        except ValueError as e:
            assert "没有可用的对话模型" in str(e)
    finally:
        store.custom_models = old


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
