"""
JIGSAW — ChatService（Mock 实现 / 用户替换点）
========================================
当前：按关键词返回预置中文回复。
替换为真实 LLM 时，保持函数签名 `reply(conversation_id, message) -> str`
并在本文件内调用你的模型接口即可，前端与路由无需改动。
"""
from __future__ import annotations

import threading
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
# 任务队列：is_cancelled（终止检查）/ set_activity（实时进度同步给前端）
from services import task_service


class _TaskCancelled(Exception):
    """内部信号：任务被用户终止 → 立即跳出模型调用 / 工具循环。"""


_INVOKE_POLL_SECONDS = 0.25   # 可取消模型调用的取消检查间隔（秒）


def _invoke_cancellable(llm, messages, task_id: str | None):
    """可取消的模型调用。

    问题：llm.invoke() 是一次阻塞的网络请求（可能几十秒到几分钟），用户点"终止"时
    主线程还卡在里面，单 Worker 就一直被占着 → 后面排队的任务全部推不动。

    做法：把阻塞调用放进子线程，主线程每 0.25 秒检查一次取消标记；一旦任务被终止就
    立刻抛出 _TaskCancelled（放弃这次调用），Worker 随即释放、去处理下一条排队任务。
    被放弃的子线程结果直接丢弃（写会话只发生在 Worker 主线程，不会被污染）。
    task_id 为空（非异步调用）时退化为普通 invoke。
    """
    if not task_id:
        return llm.invoke(messages)

    box: dict = {}

    def _call():
        try:
            box["resp"] = llm.invoke(messages)
        except BaseException as e:      # 原样带回主线程抛出
            box["err"] = e

    th = threading.Thread(target=_call, daemon=True, name="jigsaw-llm-call")
    th.start()
    while th.is_alive():
        if task_service.is_cancelled(task_id):
            raise _TaskCancelled()
        th.join(_INVOKE_POLL_SECONDS)
    if "err" in box:
        raise box["err"]
    return box["resp"]


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

JIGSAW 自身信息（用户问"我的知识库在哪 / 资料存在哪个文件夹 / 知识库里有什么"时）：
1. 【硬性要求】必须调用「知识库信息」(knowledge_info) 工具读取当前真实路径与目录结构，
   再据此回答。严禁凭印象、凭常识编造路径（知识库目录用户可随时更换，AI 无法事先知道）。
2. 回答时给出完整绝对路径（如 E:\\my_repo\\Figsaw\\backend\\data\\knowledge），
   并顺带说明：可在 知识库页面 → 右上「目录」按钮 更换存放位置。
3. 用户问"知识库里有什么 / 有哪些资料"：先调 knowledge_info 看结构和文件名；
   要看某篇的实际内容，再用 knowledge_search（按关键词找片段）或 read_extra（整篇读取）。
4. 查不到就如实说"知识库里没有找到相关内容"，不要编造内容。

写入知识库（用户说"加到知识库 / 记下来 / 存一份 / 保存进 XX 分类"时）：
1. 【硬性要求】必须调用「写入知识库」(knowledge_write) 工具真正落盘，
   然后才能说"已添加"。**只调用 knowledge_search 搜一下不算添加** —— 那是典型的假完成。
2. 参数：name（文件名，建议 .md，如「东京攻略.md」，也可带子目录「旅行/东京.md」）、
   content（正文）、folder（分类，可留空=根目录，不存在会自动建）、
   mode（create 新建 / append 追加 / overwrite 覆盖）。默认 create。
3. 一次要加多条 → 分多次调用（每条一个文件，或先 create 再 append）。
4. 遇到"文档已存在"报错 → 改用 append（追加）或 overwrite（整篇替换，会丢原内容，先征求用户同意）。
5. 写完后把完整路径告诉用户。

询问用户（AskUser 工具）：
【硬性要求】只要你在这一轮需要"等用户回答了才能继续"，就必须调用 AskUser 工具，
绝不能把问题写进普通回复里（那样用户只能在输入框里回你一句，任务会断掉，属于错误做法）。
如果发现自己正准备在回复文本里向用户提问 —— 停下来，改用 AskUser 工具。
判别标准：凡是"需要用户拍板 / 补充信息 / 同意风险操作"才算提问；任务已完成后的礼貌性反问、
或不需要用户回答的说明性问句，不算，直接正常回复即可。

【选项必须走 options 参数】当用户需要从几个答案里选时，把每个答案放进 options 数组
（最多 4 个），不要把 A/B/C/D 选项堆在 question 文字里 —— 前端会把 options 渲染成可点击按钮，
用户点一下就回答了。question 只写问题本身，可以带一句"请选一个"。
推荐项放 options 第一项，并在该项文字末尾标注「（推荐）」。
选项文字要能独立看懂，例如「只删最明确的 3 个：debug.log、temp_output.tmp（推荐）」，
不要写成「A」「方案一」这种脱离了题目就看不懂的短标签。

1. 遇到以下情况，使用 AskUser 工具向用户提问，不要自作主张：
   - 执行破坏性操作前（删除、移动、覆盖、格式化文件，清空目录等）；
   - 用户意图不明确、有多种合理做法需要用户拍板时；
   - 需要用户提供关键信息（账号、路径、选项、偏好等）才能继续时。
2. 问题要具体、可回答；给选项时一律用 options 参数，不要强行替用户选择。
3. 用户回答后，按回答继续执行；用户取消时，停止该操作并说明，不要强行继续。
4. 简单查询、纯信息类问题不要用 AskUser，直接回答。
5. 同一个问题只问一次：用户已经回答过，就按回答继续，不要重复提出同样的问题。"""





router = APIRouter()

class AiContextIn(BaseModel):
    human_prompt: list | str | dict   # 接住前端传来的东西

@router.post("/api/ai/context")
def receive_context(payload: AiContextIn):
    print(payload.human_prompt)       # 先打印看看收到没有
    return {"ok": True, "received": len(payload.human_prompt)}

_REJECT_ANSWERS = ("用户取消了此操作", "用户没有回答", "任务已终止")

# 可能长时间阻塞的工具：放子线程跑，好让"终止"能立刻把 Worker 释放出来
_SLOW_TOOLS = {"shell", "websearch", "fetch_url", "apply_patch", "read_extra",
               "knowledge_search", "editfile", "calc", "get_current_time"}


def _answer_is_reject(answer: str) -> bool:
    """用户在确认弹窗里选的是"取消/拒绝"（或任务已被终止）→ 视为不同意执行。"""
    a = (answer or "").strip()
    return (not a) or a in _REJECT_ANSWERS or a.startswith("任务已终止")


def _execute_cancellable(name: str, args: dict, task_id: str | None) -> str:
    """可取消的工具执行。

    有些工具本身就慢（shell 命令最多 120 秒、网页抓取等）。如果在 Worker 线程里直接
    等待，用户点"终止"后 Worker 仍要等它跑完才释放，后面的排队任务继续推不动。

    做法与 _invoke_cancellable 一致：慢工具放子线程，主线程每 0.25s 查一次取消；
    一旦终止就抛 _TaskCancelled 交回工具循环收尾。
    注意：被放弃的 shell 子进程无法从 Python 侧强杀，它会自己跑完（最长 120 秒），
    但结果会被丢弃、不会写进会话，也不会再影响后续任务。
    """
    if not task_id or name not in _SLOW_TOOLS:
        return execute(name, args)

    box: dict = {}

    def _call():
        try:
            box["r"] = execute(name, args)
        except BaseException as e:      # 原样带回主线程抛出
            box["err"] = e

    th = threading.Thread(target=_call, daemon=True, name="jigsaw-tool-call")
    th.start()
    while th.is_alive():
        if task_service.is_cancelled(task_id):
            raise _TaskCancelled()
        th.join(_INVOKE_POLL_SECONDS)
    if "err" in box:
        raise box["err"]
    return box["r"]


def _run_tool(call: dict, task_id: str | None) -> str:
    """执行一次工具调用，带权限控制：
    - AskUser 工具：挂起等用户回答（普通提问，不带风险勾选框）
    - 始终询问(ask)：所有工具调用前都弹窗确认；同意才执行，拒绝则不执行
    - 按需确认(auto)：风险操作弹窗确认；勾选过"不再提醒"后不再弹
    - 全部允许(allow)：同上（风险操作首次弹窗告知，带"不再提醒"）
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
            opts = args.get("options") or []
            if isinstance(opts, str):          # 模型偶尔会传字符串，容错成单选项
                opts = [opts]
            # AskUser 走特殊通道（不经过 execute），这里单独记一次调用统计
            try:
                from services import stats_service
                stats_service.record("AskUser")
            except Exception:
                pass
            return ask_user.ask(task_id, q, options=opts)
        return "错误：AskUser 需要任务上下文（task_id）"

    # ② 其他工具：按权限级别决定要不要先问
    if task_id:
        from tools import ask_user
        level = permission_level()
        risky = is_risky(name, args)
        if level == "ask":
            # 始终询问：所有工具调用都问；用户同意后真正执行该工具
            arg_text = "（" + "，".join(f"{k}={str(v)[:40]}" for k, v in args.items()) + "）" if args else ""
            ans = ask_user.ask(task_id, f"AI 想调用工具「{name}」{arg_text}，是否允许？")
            if _answer_is_reject(ans):
                return f"用户拒绝了对工具「{name}」的调用，已跳过，请停止该操作并向用户说明。"
            return _execute_cancellable(name, args, task_id)
        # 风险操作：弹窗确认（带"不再提醒"勾选框）。
        # ★ 只要用户勾过"不再提醒"，按需确认 / 全部允许两种模式下都不再弹窗。
        if risky and not risk_acknowledged():
            cmd = args.get("command", "") if name == "shell" else ""
            detail = f"「{cmd}」" if cmd else ""
            # risk=True：前端弹窗会显示"不再提醒"勾选框；
            # 用户勾选后由 answer 接口的 noMore 标记写入，此处只管等待回答。
            ans = ask_user.ask(
                task_id,
                f"⚠ 检测到风险操作：AI 要用「{name}」执行{detail}。确认继续吗？",
                risk=True,
            )
            if _answer_is_reject(ans):
                return f"用户拒绝了风险操作「{name}」，已跳过，请停止该操作并向用户说明。"
            return _execute_cancellable(name, args, task_id)

    # ③ 不需要确认 → 直接执行
    return _execute_cancellable(name, args, task_id)


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
        timeout=300,   # ★ 单次模型调用最多等 5 分钟：超时抛异常 → 任务结束，不会无限卡
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
    MAX_TOOL_ROUNDS = 200   # 工具调用轮数上限：几乎无限（写大文档都够），
                            # 仅防"模型失控永远循环"这种真故障；正常长任务跑不完这么多轮
    try:
        resp = _invoke_cancellable(llm_with_tools, messages, task_id)

        # ⑥ LLM 想用工具 → 执行 → 结果回填 → 带着结果再问一次（最多 MAX_TOOL_ROUNDS 轮）
        rounds = 0
        while resp.tool_calls and rounds < MAX_TOOL_ROUNDS:
            # ★ 用户点了"终止" → 工具循环立即退出，不再发起新的工具调用/确认
            if task_id and task_service.is_cancelled(task_id):
                raise _TaskCancelled()
            rounds += 1
            messages.append(resp)                          # 它的"我要调工具"请求
            for call in resp.tool_calls:
                # ★ 每次工具调用前再查一次终止：终止后不再执行后续工具
                if task_id and task_service.is_cancelled(task_id):
                    raise _TaskCancelled()
                used.append(call["name"])                  # 记下用过的工具
                _report_activity(call["name"], call.get("args") or {})   # ★ 实时同步给前端
                result = _run_tool(call, task_id)
                # 工具输出截断：防止几十轮后上下文爆炸（模型变慢/失忆/卡死）
                if len(result) > 3000:
                    result = result[:3000] + "\n…（工具输出过长已截断，仅保留开头 3000 字）"
                messages.append(ToolMessage(
                    content=result,
                    tool_call_id=call["id"]
                ))
            _report_activity("", {})                       # 工具执行完，恢复"思考中"
            resp = _invoke_cancellable(llm_with_tools, messages, task_id)

        if resp.tool_calls:
            # 达到轮数上限仍要工具 → 强制收尾：让模型停止调用，基于已有结果直接总结
            messages.append(SystemMessage(
                content=f"你已经连续调用了 {MAX_TOOL_ROUNDS} 轮工具，请立即停止调用工具，"
                        "直接基于目前已获取的信息，给用户一个完整、可用的最终回答。"
            ))
            resp = _invoke_cancellable(llm_with_tools, messages, task_id)

        return {"reply": resp.content or "（已完成，但没有生成文字回复）", "toolsUsed": used}
    except _TaskCancelled:
        # 用户终止：Worker 会按取消状态丢弃这条结果，不写进会话
        return {"reply": "任务已终止（你中途取消了它）", "toolsUsed": used}
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
