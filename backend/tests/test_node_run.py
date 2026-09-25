"""R6 第一步端到端测试：工作流节点任务走真实任务队列。

    cd backend && python tests/test_node_run.py
    cd backend && python -m pytest tests/test_node_run.py -q

无模型（未配置 Key）→ run_node 抛 ValueError → 任务 failed —— 节点失败必须真实，
不允许把"未配置"伪造成成功输出。整个链路不发起任何网络请求。
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import task_service  # noqa: E402


def _wait_task(task_id, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        t = task_service.get_task(task_id)
        if t and t["status"] in ("done", "failed", "cancelled"):
            return t
        time.sleep(0.2)
    raise AssertionError(f"任务 {task_id} 在 {timeout}s 内未结束")


def test_node_task_without_model_fails():
    task_service.start_worker()
    t = task_service.create_task(
        "c-node-test", "(工作流节点) 门控自检节点",
        model=None, kind="node",
        payload={"name": "门控自检节点", "tools": [], "input": "上游输入"},
    )
    st = _wait_task(t["task_id"])
    assert st["status"] == "failed", st
    assert "未配置" in (st["error"] or ""), st
    # 节点任务不写会话消息
    from services.store import store
    conv = store.get_conversation("c-node-test")
    assert conv is None or not conv.get("messages"), st


def test_node_task_still_fail_after_queue_concurrency():
    """第二个节点任务同样能被 Worker 领取处理（队列不因前一个失败而卡死）。"""
    task_service.start_worker()
    t = task_service.create_task(
        "c-node-test2", "(工作流节点) 第二个节点",
        model=None, kind="node",
        payload={"name": "第二个节点", "tools": ["websearch"], "input": ""},
    )
    st = _wait_task(t["task_id"])
    assert st["status"] == "failed", st


def test_chat_task_without_model_still_done_with_hint():
    """回归保护：普通对话无模型时保持既有行为（done + 提示文案），不被 node 分支影响。"""
    task_service.start_worker()
    t = task_service.create_task("c-chat-regress", "你好", model=None, kind="chat")
    st = _wait_task(t["task_id"])
    assert st["status"] == "done", st
    assert "模型" in (st["reply"] or ""), st


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
