"""AskUser询问用户"""
import threading

SCHEMA = {
    "type": "function",
    "function": {
        "name": "AskUser",
        "description": (
            "向用户提问并等待回答。当需要用户确认、决策、补充信息、"
            "或执行有风险的操作前需要用户同意时使用。"
            "用户回答后，把回答内容作为工具结果返回给你。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "要问用户的问题，需清晰、具体、可回答。",
                }
            },
            "required": ["question"],
        },
    },
}

# 通信板：task_id -> {"question": 问题, "event": 闸门, "answer": 答案}
_waiters: dict = {}


def ask(task_id: str, question: str, risk: bool = False) -> str:
    """挂起当前任务：把问题发给前端，阻塞等用户回答。

    无限等待（不超时）：用户回答 → 返回答案；用户取消 → 返回"用户取消了此操作"。
    两个出口都在前端弹窗上，所以不会永久卡死；用户直接关掉 App 不答时，
    任务会挂到后端重启为止（单 Worker 场景下会挡住后续任务，可接受）。
    risk=True 表示风险确认弹窗（前端会显示"不再提醒"勾选框）。
    """
    ev = threading.Event()
    _waiters[task_id] = {"question": question, "event": ev, "answer": None}

    # ① 问题写进任务状态 → 前端轮询看到 pendingQuestion → 弹窗
    from services import task_service
    task_service.set_pending_question(task_id, question, risk)

    # ② 阻塞：Worker 线程停在这，等 submit_answer() 里 ev.set() 唤醒（不设超时）
    ev.wait()
    w = _waiters.pop(task_id, None)
    return w["answer"] if w and w["answer"] else "用户没有回答"


def submit_answer(task_id: str, answer: str) -> bool:
    """用户在前端回答 → 找到通信板上的条子 → 放答案 → 开门唤醒 Worker。

    answer 传空字符串 = 用户取消/拒绝，AI 会收到"用户取消了此操作"。
    """
    w = _waiters.get(task_id)
    if not w:
        return False      # 找不到：任务已结束 / 没人问过
    w["answer"] = answer.strip() or "用户取消了此操作"
    w["event"].set()      # ★ 唤醒阻塞中的 Worker 线程
    return True


def cancel(task_id: str) -> bool:
    """终止任务：唤醒挂起的 Worker（如果有），让它拿到"任务已终止"。

    用于用户点"终止"按钮：卡在 AskUser 弹窗的任务立即被唤醒，
    不再继续等回答；Worker 随后按取消状态丢弃结果。
    """
    w = _waiters.get(task_id)
    if not w:
        return False
    w["answer"] = "任务已终止"
    w["event"].set()
    return True


def run(args: dict) -> str:
    """兜底：正常情况下 AskUser 由 chat_service 特殊处理（挂起等待），
    不会走到这里。走到说明调用方式不对。"""
    return f"错误：AskUser 需要任务上下文（task_id）才能询问用户，当前调用方式不支持。"
