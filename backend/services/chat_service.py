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
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from fastapi import APIRouter
from pydantic import BaseModel

from langchain_core.messages import HumanMessage, SystemMessage,AIMessage,ToolMessage
from tools import list_tools, execute
# 数据层：在后端代码里拿会话列表 / 消息，用 store
from services.store import store

system_prompt = """你是 JIGSAW 的主控智能体。JIGSAW 是一个多智能体（Multi-Agent）协作系统：
- 简单请求：直接回答，不拆解。
- 复杂任务：拆解为多个专业 Agent 分工协作（如 研究 Agent → 分析 Agent → 写作 Agent → 终审 Agent），按依赖顺序依次执行。每个 Agent 的执行状态（等待中 / 运行中 / 已完成 / 失败）实时显示在工作流页面，用户据此知道任务进行到哪一步。

-目前还没有接入多Agent协作，先按单智能体模式处理即可。你可以调用工具（Tool）来辅助完成任务，工具列表可在前端查看。

工作方式：
1. 收到复杂任务时，先说明你的拆解计划：用哪几个 Agent、各自负责什么、先后顺序。
2. 执行过程中，各节点状态即当前进度；你在回复中简要同步"当前进行到哪个节点、下一步是什么"。
3. 全部完成后，汇总各 Agent 的结果，给出清晰可用的最终答案。

回答规范：
1. 先给直接结论，再补必要细节；简洁、准确、不空话。
2. 用结构化表达（分点、步骤）组织内容，避免堆砌。
3. 不确定或缺乏依据的信息要明确说明，不编造。
4. 始终使用与用户相同的语言。
5. 不要提及或解释"是否拆解了任务""是否简单查询"这类内部流程，直接给出答案即可。

工具与信息验证：
1. 涉及外部状态（文件内容、命令执行结果、进程、端口、网页抓取等）时，一律以工具本次实时返回的结果为准，不要仅凭对话历史或记忆推断当前状态。
2. 只有工具实际执行成功并返回结果后，才能认为该操作已完成；工具未调用或执行失败时，如实说明失败情况，不得声称操作成功。

询问用户（AskUser 工具）：
1. 遇到以下情况，使用 AskUser 工具向用户提问，不要自作主张：
   - 执行破坏性操作前（删除、移动、覆盖、格式化文件，清空目录等）；
   - 用户意图不明确、有多种合理做法需要用户拍板时；
   - 需要用户提供关键信息（账号、路径、选项、偏好等）才能继续时。
2. 问题要具体、可回答，给出选项时用「A/B/C」形式,可以给出一个推荐的选项，但不要强行替用户选择。
3. 用户回答后，按回答继续执行；用户取消时，停止该操作并说明，不要强行继续。
4. 简单查询、纯信息类问题不要用 AskUser，直接回答。"""





router = APIRouter()

class AiContextIn(BaseModel):
    human_prompt: list | str | dict   # 接住前端传来的东西

@router.post("/api/ai/context")
def receive_context(payload: AiContextIn):
    print(payload.human_prompt)       # 先打印看看收到没有
    return {"ok": True, "received": len(payload.human_prompt)}

def _run_tool(call: dict, task_id: str | None) -> str:
    """执行一次工具调用，带权限控制：
    - AskUser 工具：挂起等用户回答（普通提问，不带风险勾选框）
    - 始终询问(ask)：所有工具调用前都弹窗确认
    - 按需确认(auto)：风险操作每次弹窗确认
    - 全部允许(allow)：风险操作首次弹窗告知（带"不再提醒"），勾选后不再弹
    无 task_id（非异步调用）时跳过确认，直接执行。
    """
    from tools import permission_level, is_risky, risk_acknowledged, set_risk_acknowledged, execute
    from services import task_service

    name = call.get("name", "")
    args = call.get("args") or {}

    # 任务已被用户终止 → 不再弹窗/挂起/执行，直接给个结果让 AI 收尾
    if task_service.is_cancelled(task_id):
        return "任务已被用户终止，停止执行后续工具。"

    # ① AskUser 工具：本身就是问用户，直接挂起（普通提问）
    if name == "AskUser":
        from tools import ask_user
        if task_id:
            q = args.get("question", "请确认")
            return ask_user.ask(task_id, q)
        return "错误：AskUser 需要任务上下文（task_id）"

    # ② 其他工具：按权限级别决定要不要先问
    if task_id:
        level = permission_level()
        risky = is_risky(name, args)
        if level == "ask":
            # 始终询问：所有工具调用都问
            arg_text = "（" + "，".join(f"{k}={str(v)[:40]}" for k, v in args.items()) + "）" if args else ""
            from tools import ask_user
            return ask_user.ask(task_id, f"AI 想调用工具「{name}」{arg_text}，是否允许？")
        if risky and (level == "auto" or not risk_acknowledged()):
            # 按需确认：风险操作每次问；全部允许：风险操作首次问（带"不再提醒"）
            cmd = args.get("command", "") if name == "shell" else ""
            detail = f"「{cmd}」" if cmd else ""
            from tools import ask_user
            # risk=True：前端弹窗会显示"不再提醒"勾选框；
            # 用户勾选后由 answer 接口的 noMore 标记写入，此处只管等待回答。
            return ask_user.ask(
                task_id,
                f"⚠ 检测到风险操作：AI 要用「{name}」执行{detail}。确认继续吗？",
                risk=True,
            )

    # ③ 不需要确认 → 直接执行
    return execute(name, args)


def _report_activity(name: str, args: dict) -> None:
    """把"正在调用 XX 工具"实时同步给前端（写入任务进度）。

    延迟导入 task_service 避免模块循环导入；非异步任务场景调用无副作用。
    """
    try:
        from services import task_service
        if not name:
            task_service.set_activity("思考中…")
            return
        arg_text = ""
        if args:
            arg_text = "（" + "，".join(f"{k}={str(v)[:40]}" for k, v in args.items()) + "）"
        task_service.set_activity(f"正在调用 {name}{arg_text}")
    except Exception:
        pass


def reply(conversation_id: str, message: str, model: dict | None = None,
          temperature: float | None = None, task_id: str | None = None) -> dict:
    """
    生成回复。返回结构化结果，前端据此在气泡里显示"AI 用过的工具"。

    message —— 前端输入框里的那句话（http.js → chat.py 一路传过来的）
    model   —— 前端 设置 → 模型 里选的自定义模型：
               {"model": "gpt-4o", "baseUrl": "https://...", "apiKey": "sk-..."}
               没配置时为 None，这时不发请求、直接给提示。
    temperature —— 前端 设置 → 模型 → 采样温度（0~2）。没传时用默认 0.9。
    task_id —— 异步任务 id（AskUser 工具挂起/唤醒需要它）。非异步调用时可为 None。

    返回：{"reply": 回复文本, "toolsUsed": [用过的工具名, ...]}
    """

    # ① 前端没配置模型 → 直接给提示，不白等、不超时
    if not model or not model.get("model"):
        return {
            "reply": (
                "后端还没收到可用的模型配置。请到 设置 → 模型 添加自定义模型"
                "（填模型名 + OpenAI 兼容接口地址 + API Key），并在会话里选中它，"
                "这条消息才能发给真实 AI。"
            ),
            "toolsUsed": [],
        }

    # ② 用前端设置里的模型信息构建 ChatOpenAI（地址、密钥、模型名、温度都来自设置）
    #    extra_body 关闭 DeepSeek 思考模式：思考模式要求把 reasoning_content 透传回 API，
    #    而 langchain 工具循环不会透传它 → 第二次调用会 400。工具场景直接关掉思考。
    llm = ChatOpenAI(
        temperature=temperature if temperature is not None else 0.9,
        model=model["model"],
        base_url=model.get("baseUrl") or None,
        api_key=model.get("apiKey") or None,
        max_tokens=1024,
        extra_body={"thinking": {"type": "disabled"}},
    )

    # ③ 组装消息：system + 历史（chat.py 先存后取，历史已含当前句，不会重复）
    messages = [SystemMessage(content=system_prompt)]
    for m in store.get_messages(conversation_id):
        if m.get("role") == "user":
            messages.append(HumanMessage(content=m["text"]))
        elif m.get("role") == "assistant":
            messages.append(AIMessage(content=m["text"]))

    



    # ④ 把工具菜单（说明书）绑到模型上，调模型
    llm_with_tools = llm.bind_tools(list_tools())

    # ⑤ 调模型；失败时把原因转成中文提示（而不是 500 报错）
    used = []   # 记录这轮回复用过的工具名（前端气泡展示用）
    try:
        resp = llm_with_tools.invoke(messages)

        # ⑥ LLM 想用工具 → 执行 → 结果回填 → 带着结果再问一次
        while resp.tool_calls:
            messages.append(resp)                          # 它的"我要调工具"请求
            for call in resp.tool_calls:
                used.append(call["name"])                  # 记下用过的工具
                _report_activity(call["name"], call.get("args") or {})   # ★ 实时同步给前端
                result = _run_tool(call, task_id)
                messages.append(ToolMessage(
                    content=result,
                    tool_call_id=call["id"]
                ))
            _report_activity("", {})                       # 工具执行完，恢复"思考中"
            resp = llm_with_tools.invoke(messages)

        return {"reply": resp.content, "toolsUsed": used}
    except Exception as e:
        return {
            "reply": (
                f"调用模型失败：{type(e).__name__} — {str(e)[:120]}\n"
                "请检查 设置 → 模型 里的：接口地址（baseUrl）、API Key、模型名是否有效，且网络能连通。"
            ),
            "toolsUsed": used,
        }



def register_message(conversation_id: str, role: str, content: str) -> dict:
    return {
        "id": f"m-{datetime.now(timezone.utc).timestamp():.0f}-{role}",
        "role": role,
        "text": content,
        "status": "done",
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
