"""Chat 路由：发送消息 → 获取回复（Mock 实现）。"""
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services import chat_service
from services.store import store

router = APIRouter()


class ChatRequest(BaseModel):
    conversation_id: str
    message: str
    # 前端设置 → 模型 里选的自定义模型信息（可选，没有就用后端默认）
    # 结构：{"model": "gpt-4o", "baseUrl": "https://api.openai.com/v1", "apiKey": "sk-..."}
    model: Optional[dict] = None


class ChatResponse(BaseModel):
    conversation_id: str
    reply: str


@router.post("/messages", response_model=ChatResponse)
def send_message(req: ChatRequest) -> ChatResponse:
    """
    前端把文字"寄"到这里。
    req.message         —— 前端输入框里的那句话
    req.conversation_id —— 哪个会话
    """
    # 找到这个会话（没有就自动建一个）
    conv = store.get_conversation(req.conversation_id)
    if conv is None:
        # 未知会话：允许自由创建，避免前端第一次发送即失败
        conv = {"id": req.conversation_id, "title": req.message[:48],
                "createdAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
                "messages": [], "modelId": "jigsaw-ultra", "workflowExecuted": False}
        store.conversations.append(conv)

    # ① 把用户消息记进会话记录
    store.add_message(req.conversation_id, chat_service.register_message(req.conversation_id, "user", req.message))

    # ② 取这个会话的完整历史（含刚存的这句），交给 chat_service 生成回复
    #    chat_service.reply() 里调用 _call_llm()（你的替换点）
    history = store.get_messages(req.conversation_id)
    # req.model 就是前端设置 → 模型 里选的那个模型（模型名/接口地址/密钥）
    reply = chat_service.reply(req.conversation_id, req.message, req.model)

    # ③ 把 AI 回复也记进会话记录
    store.add_message(req.conversation_id, chat_service.register_message(req.conversation_id, "assistant", reply))
    return ChatResponse(conversation_id=req.conversation_id, reply=reply)


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
