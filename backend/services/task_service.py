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
            "pendingQuestion": None,  # 待用户回答的问题（AskUser 工具用，非空时前端弹窗）
            "pendingRisk": False,     # 该弹窗是否是"风险确认"（是则显示不再提醒勾选框）
            "pendingOptions": [],     # 该问题的可点选答案（前端渲染成按钮，最多 4 项）
            "pendingQuestionSeq": 0,  # 提问序号：每次提问 +1，前端据此判断"这是新问题"
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


def set_pending_question(task_id: str, question: str, risk: bool = False,
                         options: list | None = None) -> None:
    """把"待用户回答的问题"写进任务状态（AskUser 工具 / 风险确认）。

    前端轮询 GET /tasks/{id} 时看到 pendingQuestion 非空 → 弹窗给用户。
    risk=True 表示这是风险确认弹窗（显示"不再提醒"勾选框）。
    options 是可点选答案（最多 4 项），前端渲染成按钮。
    pendingQuestionSeq 每次 +1：前端只在序号变化时弹窗，
    避免"用户已经答过、但状态还没清干净"时把同一个问题又弹一次。
    用户回答后由 chat.py 的 answer 接口调用 ask_user.submit_answer() 唤醒。
    """
    with _lock:
        if task_id in TASKS:
            t = TASKS[task_id]
            t["pendingQuestion"] = question
            t["pendingRisk"] = bool(risk)
            t["pendingOptions"] = [str(o) for o in (options or [])][:4]
            t["pendingQuestionSeq"] = int(t.get("pendingQuestionSeq") or 0) + 1
            t["activity"] = "等待用户回答…"


def clear_pending_question(task_id: str) -> None:
    """任务结束/失败/用户已回答时清掉待回答问题，防止前端残留或重复弹窗。"""
    with _lock:
        if task_id in TASKS:
            TASKS[task_id]["pendingQuestion"] = None
            TASKS[task_id]["pendingRisk"] = False
            TASKS[task_id]["pendingOptions"] = []


def cancel_task(task_id: str) -> bool:
    """终止任务（用户点"终止"按钮）：
    - 排队中(pending)：直接标记取消，从队列移除，不再处理
    - 处理中(running)：标记取消；若卡在 AskUser 弹窗 → 立即唤醒；
      Worker 检测到取消后立刻放弃正在进行的模型调用，并丢弃结果、不写进会话
    """
    with _lock:
        task = TASKS.get(task_id)
        if task is None or task["status"] in ("done", "failed", "cancelled"):
            return False
        stuck_on_question = bool(task.get("pendingQuestion"))   # 清空前先记下是否卡在提问
        task["status"] = "cancelled"
        task["activity"] = None
        task["pendingQuestion"] = None
        task["pendingRisk"] = False
        task["pendingOptions"] = []
        task["finishedAt"] = _now_iso()
        if task_id in QUEUE:
            QUEUE.remove(task_id)
    if stuck_on_question:
        # 卡在 AskUser 挂起 → 唤醒它（返回"任务已终止"），Worker 随后丢弃结果
        from tools import ask_user
        ask_user.cancel(task_id)
    return True


def list_active_tasks() -> list:
    """列出所有活跃任务（排队中 / 处理中），供前端"任务队列面板"展示。

    按创建时间排序（早的在前）。每条含：id、会话、消息摘要、状态、进度、队列位置。
    """
    with _lock:
        items = []
        for tid, task in TASKS.items():
            if task["status"] not in ("pending", "running"):
                continue
            items.append({
                "task_id": tid,
                "conversation_id": task["conversation_id"],
                "message": (task["message"] or "")[:60],
                "messageFull": task["message"] or "",   # 完整内容（队列面板展开查看用）
                "status": task["status"],
                "queue_position": QUEUE.index(tid) if tid in QUEUE else 0,
                "activity": task.get("activity"),
                "pendingQuestion": task.get("pendingQuestion"),
                "pendingRisk": bool(task.get("pendingRisk")),
                "pendingOptions": task.get("pendingOptions") or [],
                "pendingQuestionSeq": int(task.get("pendingQuestionSeq") or 0),
                "createdAt": task.get("createdAt"),
            })
        items.sort(key=lambda t: t["createdAt"] or "")
        return items


def is_cancelled(task_id: str | None) -> bool:
    """工具循环里检查：任务是否已被用户终止（终止后不再发起新的确认/挂起）。"""
    if not task_id:
        return False
    with _lock:
        t = TASKS.get(task_id)
        return bool(t and t["status"] == "cancelled")


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
            # 传 task_id：AskUser 工具靠它挂起/唤醒（问题写入任务状态，等用户回答）
            result = chat_service.reply(conv_id, message, model, temperature, task_id)
            reply_text = result["reply"] if isinstance(result, dict) else result
            tools_used = result.get("toolsUsed", []) if isinstance(result, dict) else []

            with _lock:
                if task["status"] == "cancelled":
                    # 用户点了"终止"：丢弃结果，不写进会话
                    task["status"] = "cancelled"
                    task["activity"] = None
                    task["pendingQuestion"] = None
                    task["finishedAt"] = _now_iso()
                    if task_id in QUEUE:
                        QUEUE.remove(task_id)
                    continue

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
                task["pendingQuestion"] = None   # 任务结束，清掉待回答问题
                task["finishedAt"] = _now_iso()
        except Exception as e:
            with _lock:
                if task["status"] == "cancelled":
                    # 已被用户终止 → 保持 cancelled，不要把状态改成 failed
                    task["activity"] = None
                    task["pendingQuestion"] = None
                    task["finishedAt"] = _now_iso()
                else:
                    task["status"] = "failed"
                    task["error"] = f"{type(e).__name__}: {str(e)[:200]}"
                    task["activity"] = None
                    task["pendingQuestion"] = None   # 任务失败，同样清掉
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
