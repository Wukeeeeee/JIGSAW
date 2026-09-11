"""
JIGSAW — 异步任务队列（单 Worker 串行）
========================================
把"发消息 → 等 LLM 回复"改成异步任务：
  1. POST /api/chat/messages 只创建任务、立即返回 task_id（不等处理）
  2. 后台 Worker 按队列顺序一条条处理（一次只处理一条，绝不并行）
  3. 前端轮询 GET /api/chat/tasks/{task_id} 拿状态，实时看到：
      排队中（第 N 位）→ 处理中（正在调用 网页搜索…）→ 完成

以后要"多个并发"：把 _WORKERS 从 1 改成 N 即可，其余不用动。
"""
import threading
import time
import uuid
from datetime import datetime, timezone

from services import chat_service
from services.store import store

_WORKERS = 1          # 并发 Worker 数：现在是单任务串行，以后要并发改成 >1
_lock = threading.Lock()          # 保护 TASKS / QUEUE / _current_task_id
TASKS = {}                        # task_id -> 任务 dict
QUEUE = []                        # task_id 顺序队列（FIFO）
_current_task_id = None           # 当前 Worker 正在处理的任务 id（单 worker 足够）


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_task(conversation_id: str, message: str,
                model: dict | None = None, temperature: float | None = None) -> dict:
    """创建任务 → 立即返回任务信息（不等待处理）。"""
    task_id = f"t-{uuid.uuid4().hex[:10]}"
    with _lock:
        TASKS[task_id] = {
            "task_id": task_id,
            "conversation_id": conversation_id,
            "message": message,
            "model": model,
            "temperature": temperature,
            "status": "pending",      # pending(排队) → running(处理中) → done / failed
            "queue_position": len(QUEUE),
            "activity": None,         # 实时进度文案，如 "正在调用 网页搜索（关岛签证）"
            "reply": None,
            "toolsUsed": [],
            "error": None,
            "createdAt": _now_iso(),
            "startedAt": None,
            "finishedAt": None,
        }
        QUEUE.append(task_id)
    return get_task(task_id)


def get_task(task_id: str) -> dict | None:
    """查询任务状态（前端轮询用）。返回副本，避免外部改内部。"""
    with _lock:
        task = TASKS.get(task_id)
        if task is None:
            return None
        copy = dict(task)
        copy["queue_position"] = QUEUE.index(task_id) if task_id in QUEUE else 0
        return copy


def set_activity(text: str) -> None:
    """更新"当前正在处理"任务的进度文案。

    由 chat_service 在工具循环里调用（如"正在调用 网页搜索（xxx）"）。
    单 worker 场景：直接改 _current_task_id 指向的任务。
    """
    global _current_task_id
    with _lock:
        tid = _current_task_id
        if tid and tid in TASKS:
            TASKS[tid]["activity"] = text


def _worker() -> None:
    """单 Worker 循环：从队列头取 pending 任务，串行处理。"""
    global _current_task_id
    while True:
        task_id = None
        with _lock:
            for tid in QUEUE:
                if TASKS[tid]["status"] == "pending":
                    task_id = tid
                    break

        if task_id is None:
            time.sleep(0.5)
            continue

        with _lock:
            _current_task_id = task_id
            task = TASKS[task_id]
            task["status"] = "running"
            task["startedAt"] = _now_iso()
            task["activity"] = "思考中…"
            conv_id = task["conversation_id"]
            message = task["message"]
            model = task["model"]
            temperature = task["temperature"]

        try:
            # 调 LLM（内部会循环调用工具，每调一个工具就 set_activity 一次）
            result = chat_service.reply(conv_id, message, model, temperature)
            reply_text = result["reply"] if isinstance(result, dict) else result
            tools_used = result.get("toolsUsed", []) if isinstance(result, dict) else []

            # AI 回复入库（含工具使用记录）
            asst_msg = chat_service.register_message(conv_id, "assistant", reply_text)
            if tools_used:
                asst_msg["toolsUsed"] = tools_used
            with _lock:
                store.add_message(conv_id, asst_msg)
                store.save_conversations()
                task["reply"] = reply_text
                task["toolsUsed"] = tools_used
                task["status"] = "done"
                task["activity"] = None
                task["finishedAt"] = _now_iso()
        except Exception as e:
            with _lock:
                task["status"] = "failed"
                task["error"] = f"{type(e).__name__}: {str(e)[:200]}"
                task["activity"] = None
                task["finishedAt"] = _now_iso()
        finally:
            with _lock:
                _current_task_id = None
                if task_id in QUEUE:
                    QUEUE.remove(task_id)


def start_worker() -> None:
    """启动后台 Worker（幂等，重复调用不会起重复线程）。"""
    started = getattr(start_worker, "_started", False)
    if started:
        return
    start_worker._started = True
    for _ in range(_WORKERS):
        t = threading.Thread(target=_worker, daemon=True, name="jigsaw-task-worker")
        t.start()
