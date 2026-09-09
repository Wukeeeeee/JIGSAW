"""
JIGSAW — ChatService（Mock 实现 / 用户替换点）
========================================
当前：按关键词返回预置中文回复。
替换为真实 LLM 时，保持函数签名 `reply(conversation_id, message) -> str`
并在本文件内调用你的模型接口即可，前端与路由无需改动。
"""
from __future__ import annotations

from datetime import datetime, timezone

from langchain_openai import OpenAI
from langchain_openai import ChatOpenAI
from fastapi import APIRouter
from pydantic import BaseModel

from langchain_core.messages import HumanMessage, SystemMessage

# 数据层：在后端代码里拿会话列表 / 消息，用 store
from services.store import store

system_prompt = """你是 JIGSAW 的主控智能体。JIGSAW 是一个多智能体（Multi-Agent）协作系统：
- 简单请求：直接回答，不拆解。
- 复杂任务：拆解为多个专业 Agent 分工协作（如 研究 Agent → 分析 Agent → 写作 Agent → 终审 Agent），按依赖顺序依次执行。每个 Agent 的执行状态（等待中 / 运行中 / 已完成 / 失败）实时显示在工作流页面，用户据此知道任务进行到哪一步。

工作方式：
1. 收到复杂任务时，先说明你的拆解计划：用哪几个 Agent、各自负责什么、先后顺序。
2. 执行过程中，各节点状态即当前进度；你在回复中简要同步"当前进行到哪个节点、下一步是什么"。
3. 全部完成后，汇总各 Agent 的结果，给出清晰可用的最终答案。

回答规范：
1. 先给直接结论，再补必要细节；简洁、准确、不空话。
2. 用结构化表达（分点、步骤）组织内容，避免堆砌。
3. 不确定或缺乏依据的信息要明确说明，不编造。
4. 始终使用与用户相同的语言。"""





router = APIRouter()

class AiContextIn(BaseModel):
    human_prompt: list | str | dict   # 接住前端传来的东西

@router.post("/api/ai/context")
def receive_context(payload: AiContextIn):
    print(payload.human_prompt)       # 先打印看看收到没有
    return {"ok": True, "received": len(payload.human_prompt)}

def reply(conversation_id: str, message: str, model: dict | None = None) -> str:
    """
    生成回复。

    message —— 前端输入框里的那句话（http.js → chat.py 一路传过来的）
    model   —— 前端 设置 → 模型 里选的自定义模型：
               {"model": "gpt-4o", "baseUrl": "https://...", "apiKey": "sk-..."}
               没配置时为 None，这时不发请求、直接给提示。
    """


    print(f"  会话: {conversation_id}")
    print(f"  消息: {message}")
    print(f"  模型: {model}")

    

    # ① 前端没配置模型 → 直接给提示，不白等、不超时
    if not model or not model.get("model"):
        return (
            "后端还没收到可用的模型配置。请到 设置 → 模型 添加自定义模型"
            "（填模型名 + OpenAI 兼容接口地址 + API Key），并在会话里选中它，"
            "这条消息才能发给真实 AI。"
        )

    # ② 用前端设置里的模型信息构建 ChatOpenAI（地址、密钥、模型名都来自设置）
    llm = ChatOpenAI(
        temperature=0.9,
        model=model["model"],
        base_url=model.get("baseUrl") or None,
        api_key=model.get("apiKey") or None,
        max_tokens=1024,
    )

    # ③ 组装消息：系统提示在前、用户消息在后（OpenAI 要求 system 必须在最前）
    messages = [
        SystemMessage(content=system_prompt),
        HumanMessage(content=message),
    ]

    # ④ 调模型；失败时把原因转成中文提示（而不是 500 报错）
    try:
        res = llm.invoke(messages)
        return res.content
    except Exception as e:
        return (
            f"调用模型失败：{type(e).__name__} — {str(e)[:120]}\n"
            "请检查 设置 → 模型 里的：接口地址（baseUrl）、API Key、模型名是否有效，且网络能连通。"
        )



def register_message(conversation_id: str, role: str, content: str) -> dict:
    return {
        "id": f"m-{datetime.now(timezone.utc).timestamp():.0f}-{role}",
        "role": role,
        "text": content,
        "status": "done",
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
