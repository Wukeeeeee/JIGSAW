"""Chat 路由：发送消息 → 异步任务（创建 → 后台处理 → 前端轮询）。"""
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services import chat_service, task_service
from services.store import store

router = APIRouter()


class ChatRequest(BaseModel):
    conversation_id: str
    message: str
    # 前端设置 → 模型 里选的自定义模型信息（可选，没有就用后端默认）
    # 结构：{"model": "gpt-4o", "baseUrl": "https://api.openai.com/v1", "apiKey": "sk-..."}
    model: Optional[dict] = None
    # 前端 设置 → 模型 → 采样温度（可选，没有就用后端默认 0.9）
    temperature: Optional[float] = None


@router.post("/messages")
def send_message(req: ChatRequest):
    """
    前端把文字"寄"到这里，立刻返回 task_id（不等待 LLM 处理）。
    处理在后台任务队列进行，前端用 GET /api/chat/tasks/{task_id} 轮询。
    """
    # 找到这个会话（没有就自动建一个）
    conv = store.get_conversation(req.conversation_id)
    if conv is None:
        # 未知会话：允许自由创建，避免前端第一次发送即失败
        conv = {"id": req.conversation_id, "title": req.message[:48],
                "createdAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
                "messages": [], "modelId": "jigsaw-ultra", "workflowExecuted": False}
        # 保存到本地
        store.conversations.append(conv)
        store.save_conversations()

    # ① 把用户消息记进会话记录（立即落库，AI 回复由后台任务完成后落库）
    store.add_message(req.conversation_id, chat_service.register_message(req.conversation_id, "user", req.message))
    store.save_conversations()

    # ② 创建异步任务，立即返回 task_id；后台 Worker 会调用 chat_service.reply()
    task = task_service.create_task(req.conversation_id, req.message, req.model, req.temperature)
    return {
        "task_id": task["task_id"],
        "conversation_id": req.conversation_id,
        "queue_position": task["queue_position"],
    }


@router.get("/tasks/{task_id}")
def get_task(task_id: str):
    """前端轮询：排队中 / 处理中（含实时工具调用进度）/ 完成（含回复）。"""
    task = task_service.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="任务不存在（后端可能重启过）")
    return task


@router.get("/tasks")
def list_tasks():
    """任务队列面板：列出所有排队中 / 处理中的任务（可逐条终止）。"""
    return {"tasks": task_service.list_active_tasks()}


class AnswerIn(BaseModel):
    answer: str
    noMore: bool = False   # 用户勾选了"不再提醒"（风险确认弹窗）→ 此后不再弹


@router.post("/tasks/{task_id}/answer")
def answer_task(task_id: str, payload: AnswerIn):
    """用户回答了 AskUser 的问题 → 唤醒挂起的任务，AI 继续执行。

    noMore=True：用户在风险确认弹窗勾了"不再提醒" → 记到 tools.json，
    全部允许模式下以后遇到风险操作直接执行、不再弹窗。
    """
    from tools import ask_user, set_risk_acknowledged
    ok = ask_user.submit_answer(task_id, (payload.answer or "").strip())
    if ok and payload.noMore:
        set_risk_acknowledged(True)
    return {"ok": ok, "task_id": task_id}


@router.post("/tasks/{task_id}/cancel")
def cancel_task(task_id: str):
    """终止任务（用户点"终止"按钮）：
    - 排队中的任务：取消并从队列移除
    - 处理中的任务：标记取消，卡在 AskUser 时立即唤醒；结果不写进会话
    """
    ok = task_service.cancel_task(task_id)
    return {"ok": ok, "task_id": task_id}


@router.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: str):
    """删除一个会话（历史记录）。前端删除时同步调用，否则重启后又会拉回来。"""
    existed = store.get_conversation(conversation_id) is not None
    store.delete_conversation(conversation_id)
    return {"ok": True, "deleted": existed, "conversation_id": conversation_id}


@router.get("/conversations/{conversation_id}/messages")
def get_messages(conversation_id: str):
    return {"conversation_id": conversation_id, "messages": store.get_messages(conversation_id)}


@router.get("/conversations")
def list_conversations():
    return {"conversations": store.list_conversations()}


# ============================================================
# 演示接口：前端把数据寄到这里，后端拆开收到
# ============================================================
class DemoIn(BaseModel):
    human_prompt: list | str | dict


@router.post("/demo/context")
def demo_context(payload: DemoIn):
    got = payload.human_prompt
    count = len(got) if isinstance(got, list) else 1
    # 在这里，前端寄来的数据已经变成 Python 变量 got，
    # 你的 AI 代码可以从这里开始使用它
    return {"ok": True, "后端收到了": True, "数量": count, "第一条": (got[0] if isinstance(got, list) and got else got)}
