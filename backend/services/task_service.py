"""
JIGSAW — 异步任务队列（多 Worker 并发）
========================================
把"发消息 → 等 LLM 回复"改成异步任务：
  1. POST /api/chat/messages 只创建任务、立即返回 task_id（不等处理）
  2. 后台 N 个 Worker 并发处理（不同会话 / 不同模型互不等待）
  3. 前端轮询 GET /api/chat/tasks/{task_id} 拿状态，实时看到：
      排队中（第 N 位）→ 处理中（正在调用 网页搜索…）→ 完成

同一会话内部仍然串行（前端按会话排队），跨会话/跨模型并行。
并发数在 data/task_workers.json 里可改（没有就用 _DEFAULT_WORKERS）。
"""
import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone

from services import chat_service
from services.store import store

_DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
_WORKERS_FILE = os.path.join(_DATA_DIR, "task_workers.json")

_DEFAULT_WORKERS = 4              # 默认并发 Worker 数（同时跑几个任务）
_MIN_WORKERS, _MAX_WORKERS = 1, 16

_lock = threading.Lock()          # 保护 TASKS / QUEUE / _thread_task
TASKS = {}                        # task_id -> 任务 dict
QUEUE = []                        # task_id 顺序队列（FIFO，只放"待处理"的任务）
# Worker 线程 -> 它正在处理的 task_id（多 Worker 下不能再用一个全局变量）
_thread_task: dict[int, str] = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def worker_count() -> int:
    """当前并发 Worker 数（读 data/task_workers.json，缺省用默认值）。"""
    try:
        with open(_WORKERS_FILE, encoding="utf-8") as f:
            n = int(json.load(f).get("workers", _DEFAULT_WORKERS))
        return max(_MIN_WORKERS, min(_MAX_WORKERS, n))
    except Exception:
        return _DEFAULT_WORKERS


def set_worker_count(n: int) -> int:
    """写入并发数（不改变已启动的 Worker 数，下次启动后端生效）。"""
    try:
        n = max(_MIN_WORKERS, min(_MAX_WORKERS, int(n)))
    except Exception:
        n = _DEFAULT_WORKERS
    try:
        os.makedirs(_DATA_DIR, exist_ok=True)
        with open(_WORKERS_FILE, "w", encoding="utf-8") as f:
            json.dump({"workers": n}, f, ensure_ascii=False, indent=2)
    except Exception:
        pass
    return n


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
            "queue_position": len(QUEUE) + 1,
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
        # QUEUE 里只放 pending：位置从 1 开始数（第 1 位 = 下一个就轮到）
        copy["queue_position"] = (QUEUE.index(task_id) + 1) if task_id in QUEUE else 0
        return copy


def set_activity(text: str) -> None:
    """更新"当前正在处理"任务的进度文案。

    由 chat_service 在工具循环里调用（如"正在调用 网页搜索（xxx）"）。
    多 Worker：按调用者所在线程找到它正在跑的那个任务，各写各的。
    """
    tid = _thread_task.get(threading.get_ident())
    if not tid:
        return
    with _lock:
        if tid in TASKS:
            TASKS[tid]["activity"] = text


def running_count() -> int:
    """当前正在处理中的任务数（并发占用情况）。"""
    with _lock:
        return sum(1 for t in TASKS.values() if t["status"] == "running")


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
                "queue_position": (QUEUE.index(tid) + 1) if tid in QUEUE else 0,
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


def _claim_task() -> str | None:
    """原子领取一个 pending 任务：取下并标记 running。

    多 Worker 同时扫队列会抢到同一个任务 → 必须在同一把锁里完成
    "找到 + 改状态 + 移出队列"，否则两个 Worker 会重复处理同一条消息。
    """
    with _lock:
        for tid in list(QUEUE):
            task = TASKS.get(tid)
            if task and task["status"] == "pending":
                task["status"] = "running"
                task["startedAt"] = _now_iso()
                task["activity"] = "思考中…"
                QUEUE.remove(tid)
                _thread_task[threading.get_ident()] = tid
                return tid
        return None


def _worker() -> None:
    """Worker 循环：领一个 pending 任务 → 处理 → 再领下一个。

    多个 Worker 同时跑 → 不同会话 / 不同模型的任务互不等待。
    同一会话内部的串行由前端保证（前端按会话排队，一次只发一条）。
    """
    while True:
        task_id = _claim_task()
        if task_id is None:
            time.sleep(0.3)
            continue

        with _lock:
            task = TASKS[task_id]
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
                _thread_task.pop(threading.get_ident(), None)
                if task_id in QUEUE:      # 兜底：理论上领取时就已移出
                    QUEUE.remove(task_id)


def start_worker() -> None:
    """启动后台 Worker 池（幂等，重复调用不会起重复线程）。"""
    started = getattr(start_worker, "_started", False)
    if started:
        return
    start_worker._started = True
    n = worker_count()
    for i in range(n):
        t = threading.Thread(target=_worker, daemon=True, name=f"jigsaw-task-worker-{i + 1}")
        t.start()
    print(f"[task_service] 已启动 {n} 个并发 Worker（可在 data/task_workers.json 调整）")
