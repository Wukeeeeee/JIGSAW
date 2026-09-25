"""
JIGSAW — ChatService（Mock 实现 / 用户替换点）
========================================
当前：按关键词返回预置中文回复。
替换为真实 LLM 时，保持函数签名 `reply(conversation_id, message) -> str`
并在本文件内调用你的模型接口即可，前端与路由无需改动。
"""
from __future__ import annotations

import json
import os
import re
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

- 你可以调用工具（Tool）来辅助完成任务（如检索、运行代码、知识库读写、生图等），工具列表可在前端查看。

工作方式：
1. 收到复杂任务时，先说明你的拆解计划：用哪几个 Agent、各自负责什么、先后顺序。
2. 执行过程中，各节点状态即当前进度；你在回复中简要同步"当前进行到哪个节点、下一步是什么"。
3. 全部完成后，汇总各 Agent 的结果，给出清晰可用的最终答案。

回答规范：
1. 先给直接结论，再补必要细节；简洁、准确、不空话。
2. 用结构化表达（分点、步骤）组织内容，避免堆砌。
3. 不确定或缺乏依据的信息要明确说明，不编造。严禁无中生有编造商业口号（Slogan）或空洞套话。
4. 始终使用与用户相同的语言。
5. 不要提及或解释"是否拆解了任务""是否简单查询"这类内部流程，直接给出答案即可。

工具与信息验证：
1. 涉及外部状态（文件内容、命令执行结果、进程、端口、网页抓取等）时，一律以工具本次实时返回的结果为准，不要仅凭对话历史或记忆推断当前状态。
2. 只有工具实际执行成功并返回结果后，才能认为该操作已完成；工具未调用或执行失败时，如实说明失败情况，不得声称操作成功。

JIGSAW 自身信息（用户问"我的知识库在哪 / 资料存在哪个文件夹 / 知识库里有什么"时）：
1. 【硬性要求】必须调用「知识库信息」(knowledge_info) 工具读取当前真实路径与目录结构，
   再据此回答。严禁凭印象、凭常识编造路径（知识库目录用户可随时更换，AI 无法事先知道）。
2. 回答时给出完整绝对路径（如 E:\\my_repo\\Jigsaw\\backend\\data\\knowledge），
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
5. 同一个问题只问一次：用户已经回答过，就按回答继续，不要重复提出同样的问题。

图像生成与展示（generate_image 工具）：
1. 当用户希望画画、创作插画、生成海报或图片时，调用 generate_image 工具。
2. 【硬性要求】当生图工具返回图片路径后，你在最终回答中必须原样包含该图片的 Markdown 贴图语法：
   ![画面描述](图片路径)
   例如：![蔚蓝海水与浪花](E:/my_repo/Jigsaw/backend/data/generated_images/agnes_xxx.png)
   严禁只把路径作为纯文本或代码输出！必须原样带上 ![]() 语法，前端界面才能直接把大图渲染在气泡里给用户看。

科学绘图与数据可视化（Python / MATLAB / 代码作图）：
1. 当用户需要进行数据分析、绘制数学函数图像、统计图表（折线图、柱状图、散点图、饼图、热力图、三维曲面等）或工程仿真图时：
   - 优先编写 Python 脚本（使用 matplotlib、seaborn、pandas、numpy 等），利用 shell 工具运行脚本并将图表保存为本地图片（建议存为 .png 或 .svg）；
   - 若用户指定使用 MATLAB，可编写 MATLAB 绘图代码并通过 shell 工具运行导出图片；
2. 【图表展示硬性要求】：
   图表文件生成后，你在最终回复中【必须】原样包含该本地图片的 Markdown 贴图语法：
   ![图表名称](图片完整绝对路径)
   例如：![阻尼正弦衰减曲线图](E:/my_repo/Jigsaw/sine_wave.png)
   严禁只输出路径文字！原样带上 ![]() 贴图语法后，JIGSAW 前端界面就会直接将图表大图渲染在气泡里，支持点击放大全屏预览！"""


def _time_rules() -> str:
    """当前系统时间基准（对话与节点执行共用）。"""
    now = datetime.now().astimezone()
    return f"""

【当前系统基准时间与时效要求】：
当前真实系统时间：{now.strftime('%Y-%m-%d %H:%M:%S')}（{now.strftime('%A')}，本地时区）
基准年份：{now.year} 年。
进行任何市场数据检索、事实核验、财务测算、新闻时事及时间线推演时，必须严格以当前真实时间为基准，杜绝使用陈旧过时的时间假定！
"""


_RULES_MAX_CHARS = 4000


def _rules_path() -> str:
    """用户全局规则文件路径（data/rules.md）。"""
    import tools as _tools
    return os.path.join(_tools.DATA_DIR, "rules.md")


def _load_user_rules() -> str:
    """用户全局规则（Rules）：存在且非空则注入 system prompt。

    每次调用实时读取 —— 用户在设置页保存后立即生效，无需重启。
    规则是用户对 AI 的持久偏好（语言/风格/项目约定），对话与工作流节点都遵守；
    条件判定器等"只许输出结论"的内部节点（suppressAskUser 标记）跳过注入，
    避免语言偏好污染 true/false 硬性输出。
    """
    try:
        with open(_rules_path(), "r", encoding="utf-8") as f:
            text = (f.read() or "").strip()
    except Exception:
        return ""
    if not text:
        return ""
    if len(text) > _RULES_MAX_CHARS:
        text = text[:_RULES_MAX_CHARS] + "\n…（规则过长已截断，请到 设置 → 常规 → 全局规则 精简）"
    return f"\n\n【用户全局规则（必须遵守）】：\n{text}"


# ============================================================
# Captain Agent：自然语言 → 多智能体 DAG 规划（R6 第二步自前端迁入）
# ============================================================
_CAPTAIN_SYSTEM_PROMPT = """你是一个顶尖的多智能体工作流架构师（Captain Agent）。请深入剖析用户的真实任务目标与依赖关系，规划出符合人类逻辑常理的多智能体协作图（DAG 拓扑链路）。

【绝对红线（严禁犯逻辑死循环错误）】：
❌ 严禁把“最终交付动作”（如：生成图片/画图/输出方案/编写代码/撰写综合报告）误当成和前期素材采集“同时并行的子任务”！
   - 严重错误：若用户指令包含“搜集素材后生成图片/报告”，把“生成图片/报告”也当成起点分发的并行任务。此时图片/报告还没任何素材，同时启动属于严重逻辑错误！
   - 正确逻辑：
     1. 前置各素材采集/专项调研节点必须直接依赖任务起点（dependsOn: []）；
     2. 终极创作/总成报告节点必须依赖上述所有前置节点（dependsOn: ["node1_id", "node2_id", ...]），在上游素材全部到位后再聚合启动！

【任务复杂度自适应伸缩准则（Dynamic Complexity Scaling）】：
智能体数量和流水线深度必须根据用户任务的实际复杂度【自适应伸缩】：
1. 极简/单点任务（如：润色一段文字、单一概念查询、单句翻译、单一简短问答）：
   - 节点规模：1 ~ 2 个节点；拓扑：单节点直出，严禁滥用门控与多阶段。
2. 中等专项任务（如：单一实体资料调研、宣传配图绘制、两项事物基础对比）：
   - 节点规模：3 ~ 5 个节点；拓扑：2~3路并行前置探索 ➔ 终极总成交付。
3. 复杂长文本/重型课题任务（如：长篇需求、多约束业务命题、跨行业竞争推演、万字报告）：
   - 节点规模：6 ~ 10 个节点；拓扑：3 ~ 5 阶纵深流水线（事实情报 ➔ 量化建模 ➔ 战略研判 ➔ 落地路线图 ➔ 交付文档）。
4. 用户明确要求"复杂 / 深度 / 多阶段 / 系统性 / 全景"时，必须认真展开：
   - 节点规模：8 ~ 15 个节点，4 ~ 6 阶纵深；
   - 每个阶段可有 2 ~ 4 路并行的专业智能体分工；
   - 该用条件分支、循环迭代的场景大胆使用（见下方分支与循环语法），不要把所有逻辑都压成线性流水线。
   严禁以"保持简洁"为由把复杂任务偷工减料成 3 个节点。

【分支与循环语法（重要！让工作流具备真正的逻辑控制能力）】：
除普通智能体节点外，你还可以生成两种控制节点：
1. 条件分支节点（type: "condition"）：对上游成果做一次判定，走 True/False 两条不同支路。
   - 字段：onTrue: ["节点id", ...]（条件成立时激活的下游）、onFalse: ["节点id", ...]（不成立时的下游）
   - 典型场景：资料充足 ➔ 直接出报告；资料不足 ➔ 补充调研后再出报告（两条支路最终汇聚到同一交付节点）。
2. 循环节点（type: "loop"）：对成果做最多 loopMax 轮迭代打磨，达标前回环、达标后放行。
   - 字段：loopMax: 2~3、onLoop: ["被打回重做的节点id"]、onDone: ["达标后的下游节点id"]
   - 典型场景：初稿 ➔ 循环评审（不满轮回初稿重写，最多 N 轮）➔ 达标后进入终稿交付。
注意：
- 分支目标 / 循环目标的节点同样要在 nodes 里定义（写全 name/desc/prompt/tools）；
- onTrue / onFalse / onLoop / onDone 里列出的目标【不要再写进这些控制节点的 dependsOn】，
  但这些目标节点自己的 dependsOn 里要包含该控制节点的 id（保证先后层级）。

【多智能体纵深递进架构准则（针对中高复杂度任务打破单层扁平模式，具备向下深度拓展能力）】：
真正专业的高级工作流必须具备【纵向阶段递进（Multi-Stage Depth）】与【下游落地拓展（Downstream Extension）】的能力：

1. 纵深递进分层：
   - 第一阶段【多维数据与事实情报层】：（dependsOn: []，并行业务探索，必须明确配置 tools: ["websearch"] 或 ["websearch", "fetch_url"] 获取客观数据）；
   - 第二阶段【深度交叉分析与量化推演层】：（dependsOn: [第一阶段对应节点]，基于前期采集数据，展开技术壁垒深度解构、量化财务测算 tools: ["calc"]、竞品攻防博弈等深入推演）；
   - 第三阶段【全局战略研判与决策总成层】：（dependsOn: [第二阶段节点]，汇总各维深入成果，形成全景研报与核心判断）；
   - 第四阶段【下游方案落地与全景交付文档】：（dependsOn: [第三阶段节点]，进一步向下拓展：规划落地行动路线图 Roadmap、商业化策略落地方案与风险预案，输出一份排版严整、可直接交付的完整全景分析文档；仅在用户明确要求存库时才配置 tools: ["knowledge_write"]）。

2. 节点工具调用指令必须具体明确（Explicit Tool Directives）：
   - 在每个智能体的 desc 与 prompt 中，必须明确交代：
     - 本节点明确调用的工具名称（如 websearch / calc / generate_image / knowledge_write）；
     - 检索的具体关键词、指标定义或测算模型；
     - 明确交付物格式与结构，严禁泛泛空谈！

【系统可用工具库清单】：
- websearch: 网页实时搜索。必配场景：市场调研、竞品分析、最新行业资讯、事实数据核查、外部资料采集等任何需要联网获取客观信息的节点。
- fetch_url: 网页正文深度抓取。适用场景：抓取特定网页长文、深度研报或长文解析。
- read_file: 读取本地文本文件（代码/配置/Markdown，带行号分页）。适用场景：阅读项目代码、分析配置文件、检查文本内容。
- list_files: 树状列出目录结构与文件大小（自动忽略 node_modules/.git 等）。适用场景：了解项目布局、定位文件。
- grep: 按正则搜索文件内容（返回 文件:行号:匹配行）。适用场景：在代码库中查找函数/关键字、定位实现位置。
- generate_image: AI 图像/海报生成。必配场景：海报制作、画面构思、视觉概念图、插画、宣传配图与渲染图绘制节点。
- knowledge_search: 本地知识库检索。适用场景：查询私有资料、内部文档、行业白皮书等已收录资料。
- knowledge_write: 写入本地知识库。适用场景：将最终综合调研报告或结构化结论归档保存至知识库。
- calc: 精确计算器。适用场景：财务指标测算、复合年均增长率(CAGR)、估值建模、量化数据计算。
- get_current_time: 获取当前系统时间。适用场景：事件时间线梳理、最新时效性对比。

【智能体节点工具分配准则（非常重要！务必根据节点职责精准赋予 tools 数组，绝不可一律留空）】：
1. 专项调研 / 行业情报 / 竞品信息 / 外部数据采集节点：
   👉 必须配置 tools: ["websearch"] 或 tools: ["websearch", "fetch_url"]！赋予智能体实时的互联网检索能力，严禁无工具闭门造车！
2. 涉及生图 / 海报 / 概念图 / 视觉创作节点：
   👉 必须配置 tools: ["generate_image"]！
3. 涉及财务指标测算 / 复合增长率(CAGR) / 估值 / 精确统计节点：
   👉 必须配置 tools: ["calc"]！
4. 涉及企业内部私有资料 / 历史研报分析节点：
   👉 配置 tools: ["knowledge_search"]！
5. 最终综合决策研报 / 方案总成交付节点：
   👉 可配置 tools: ["knowledge_write"]（将最终研报归档入知识库）或兼配 tools: ["calc"]！
6. 纯逻辑控制 / 聚合汇总但无需额外工具的节点：可填 []。
7. 涉及阅读 / 分析本地代码与文本文件、了解项目目录结构的节点：
   👉 配置 tools: ["read_file", "list_files", "grep"]（按需裁剪）！让智能体真正看得到项目文件。

【输出格式规范】：
必须直接返回纯 JSON 对象（无需 markdown 包裹）：
{
  "workflowName": "根据用户任务定制的工作流总体标题",
  "nodes": [
    {
      "id": "简短英文id",
      "type": "agent",
      "name": "针对用户任务的智能体名称",
      "desc": "职责说明",
      "prompt": "专业系统提示词，规定其工作范畴与产出标准",
      "tools": ["websearch"],
      "dependsOn": []
    },
    {
      "id": "check",
      "type": "condition",
      "name": "条件判定节点名称",
      "desc": "判定逻辑说明",
      "dependsOn": ["上游节点id"],
      "onTrue": ["成立时下游节点id"],
      "onFalse": ["不成立时下游节点id"]
    },
    {
      "id": "review",
      "type": "loop",
      "name": "循环评审节点名称",
      "desc": "迭代判定说明",
      "dependsOn": ["上游节点id"],
      "loopMax": 3,
      "onLoop": ["被打回重做的节点id"],
      "onDone": ["达标后下游节点id"]
    }
  ]
}
说明：type 省略时默认 "agent"；普通 agent 节点必须有 prompt 与 tools；
condition / loop 节点不需要 prompt 与 tools，但要写清 desc（判定逻辑）。"""


def _parse_plan_json(text: str) -> dict:
    """从模型输出中提取规划 JSON（容忍 ```json 围栏与前后缀文本）。"""
    cleaned = (text or "").strip()
    cleaned = cleaned.replace("```json", "").replace("```", "").replace("JSON", "json")
    m = re.search(r"\{[\s\S]*\}", cleaned)
    if not m:
        raise ValueError("模型输出中没有找到 JSON 规划对象")
    plan = json.loads(m.group(0))
    if not isinstance(plan, dict):
        raise ValueError("规划 JSON 不是对象")
    return plan


def plan_workflow(user_prompt: str, model_id: str | None = None,
                  temperature: float = 0.1) -> dict:
    """Captain Agent 规划：用户任务 → 多智能体 DAG（不落任何存储，纯计算）。

    候选模型级联：指定 model_id 优先，其后遍历后端模型库中其余可用对话模型
    （过滤纯生图模型：名称含 image/flux/dall-e 或地址含 agnes-ai）；
    任一模型解析成功即返回 {plan, model_id}。全部失败抛 RuntimeError。
    """
    from services.store import store

    def _is_chat_model(m: dict) -> bool:
        mid = (m.get("modelId") or "").lower()
        url = (m.get("baseUrl") or "").lower()
        return not ("image" in mid or "flux" in mid or "dall-e" in mid or "agnes-ai" in url)

    candidates: list[dict] = []
    preferred = next((x for x in store.custom_models if x.get("id") == (model_id or "")), None)
    if preferred and preferred.get("apiKey") and preferred.get("baseUrl") and _is_chat_model(preferred):
        candidates.append(preferred)
    for x in store.custom_models:
        if (x.get("apiKey") and x.get("baseUrl") and _is_chat_model(x)
                and all(x.get("id") != c.get("id") for c in candidates)):
            candidates.append(x)
    if not candidates:
        raise ValueError("后端模型库中没有可用的对话模型（请到 设置 → 模型 添加并填写密钥）")

    last_err: Exception | None = None
    for m in candidates:
        try:
            llm = ChatOpenAI(
                temperature=temperature if temperature is not None else 0.1,
                model=m.get("modelId"),
                base_url=m.get("baseUrl") or None,
                api_key=m.get("apiKey") or None,
                max_tokens=8192,   # 复杂大图的规划 JSON 很长，4096 会截断导致解析失败 → 静默降级简单模板图
                timeout=120,
                extra_body={"thinking": {"type": "disabled"}},
            )
            resp = llm.invoke([
                SystemMessage(content=_CAPTAIN_SYSTEM_PROMPT),
                HumanMessage(content=f"用户任务需求：{user_prompt}"),
            ])
            # 截断检测：finish_reason=length 说明 JSON 没写完，解析必失败，
            # 明确报错换下一个候选，绝不静默降级成简单模板图
            finish = ((resp.response_metadata or {}).get("finish_reason")
                      or (resp.response_metadata or {}).get("stop_reason") or "")
            if str(finish).lower() in ("length", "max_tokens", "incomplete"):
                raise ValueError("规划输出被 max_tokens 截断（图太大），请缩小任务范围或降低节点规模")
            plan = _parse_plan_json(resp.content or "")
            return {"plan": plan, "model_id": m.get("id")}
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(f"Captain 规划失败（所有候选模型）：{type(last_err).__name__}: {str(last_err)[:200]}")


def _build_system_prompt() -> str:
    """动态组装包含当前已配置生图模型列表与规则的 System Prompt"""
    try:
        from tools.generate_image import get_available_image_models
        img_models = get_available_image_models()
    except Exception:
        img_models = []

    model_rules = ""
    if img_models:
        default_model = next((m for m in img_models if m.get("isDefault")), img_models[0])
        model_list_str = "\n".join([
            f"- {m['name']} (模型 ID: `{m['modelId']}`)" + ("【当前界面已选激活】" if m.get("isDefault") else "")
            for m in img_models
        ])
        model_rules = f"""

【AI 图像生成规则】：
系统当前已配置生图模型列表：
{model_list_str}
当前用户在界面上已选定激活的生图模型为：【{default_model['name']}】(ID: `{default_model['modelId']}`)。

1. 当用户提出绘图需求（如画画、生成配图、创作插画、概念图等）时：
   - 积极引导并执行绘图创作！从画面主体、环境背景、构图视角、光影、色彩与艺术风格出发构建画面意境；
   - 【严防幻化与套话】：严禁自作主张编造未经证实的商业宣传口号（Slogan）、大标题排版或空洞广告语，纯粹聚焦于画面美学与视觉表现力；
   - 用户已在界面输入栏选定了生图模型【{default_model['name']}】，直接调用 generate_image 工具，将 model 参数设为 `{default_model['modelId']}`（或用户消息中明确指定的其他模型）执行真实绘图！
   - 无需多余询问，立即调用 generate_image(prompt=..., model=...) 执行绘图！
2. 每次完成绘图后，在回复中原样输出生成的 Markdown 贴图语法：![画面描述](本地图片路径)。
"""
    return system_prompt + model_rules + _time_rules() + _load_user_rules()


def _agent_loop(llm_with_tools, messages, task_id: str | None, used: list, max_rounds: int):
    """工具循环核心（对话与工作流节点共用）。

    调模型 → 模型要工具就执行（_run_tool 内含权限门控）→ 结果回填 → 再调模型，
    直到模型不再要工具；达到轮数上限时注入系统消息强制收尾。
    抛出 _TaskCancelled（用户终止）或网络/接口异常，由调用方决定如何收尾。
    """
    resp = _invoke_cancellable(llm_with_tools, messages, task_id)

    rounds = 0
    while resp.tool_calls and rounds < max_rounds:
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
            # 工具输出截断：防止几十轮后上下文爆炸（模型变慢/失忆/卡死）。
            # 6000 字 ≈ 150 行代码，配合 read_file 的 offset/limit 分页正好够用
            if len(result) > 6000:
                result = result[:6000] + "\n…（工具输出过长已截断，仅保留开头 6000 字）"
            messages.append(ToolMessage(
                content=result,
                tool_call_id=call["id"]
            ))
        _report_activity("", {})                       # 工具执行完，恢复"思考中"
        resp = _invoke_cancellable(llm_with_tools, messages, task_id)

    if resp.tool_calls:
        # 达到轮数上限仍要工具 → 强制收尾：让模型停止调用，基于已有结果直接总结
        messages.append(SystemMessage(
            content=f"你已经连续调用了 {max_rounds} 轮工具，请立即停止调用工具，"
                    "直接基于目前已获取的信息，给用户一个完整、可用的最终回答。"
        ))
        resp = _invoke_cancellable(llm_with_tools, messages, task_id)
    return resp





router = APIRouter()

class AiContextIn(BaseModel):
    human_prompt: list | str | dict   # 接住前端传来的东西

@router.post("/api/ai/context")
def receive_context(payload: AiContextIn):
    print(payload.human_prompt)       # 先打印看看收到没有
    return {"ok": True, "received": len(payload.human_prompt)}

_REJECT_ANSWERS = ("用户取消了此操作", "用户没有回答", "任务已终止")

# ============================================================
# R8：会话历史预算截断（防长会话上下文爆炸）
# ============================================================
_HISTORY_MAX_MESSAGES = 30    # 历史消息条数上限
_HISTORY_CHAR_BUDGET = 18000  # 历史总字符预算（中文约 1.2~1.8 万 token，为 system+工具+回复留空间）


def _build_history_messages(conversation_id: str) -> list:
    """从会话存储组装带预算的历史消息（最新优先保留）。

    - 从最新往回收集，受消息条数与总字符双重预算约束
    - 预算只约束"更早的消息"：最近两条始终保留（即使超预算），
      保证模型至少知道当前任务与上一轮回答
    - 有丢弃时插入一条 SystemMessage 说明，避免模型困惑上下文从中间开始
    """
    msgs = store.get_messages(conversation_id)
    if not msgs:
        return []
    kept: list = []
    used = 0
    for m in reversed(msgs):
        if m.get("role") not in ("user", "assistant"):
            continue
        text = m.get("text") or ""
        cost = len(text)
        # 最近两条无条件保留；之后按预算与条数截断
        if len(kept) >= 2 and (len(kept) >= _HISTORY_MAX_MESSAGES or used + cost > _HISTORY_CHAR_BUDGET):
            break
        kept.append(m)
        used += cost
    kept.reverse()
    total = sum(1 for m in msgs if m.get("role") in ("user", "assistant"))
    dropped = total - len(kept)
    out = []
    if dropped > 0:
        out.append(SystemMessage(
            content=f"（注：为控制上下文长度，已省略较早的 {dropped} 条对话记录，仅保留最近内容；"
                    "涉及早期细节时请如实说明或让用户重新提供，不要凭空编造。）"
        ))
    for m in kept:
        if m.get("role") == "user":
            out.append(HumanMessage(content=m.get("text") or ""))
        else:
            out.append(AIMessage(content=m.get("text") or ""))
    return out

# 可能长时间阻塞的工具：放子线程跑，好让"终止"能立刻把 Worker 释放出来
_SLOW_TOOLS = {"shell", "websearch", "fetch_url", "apply_patch", "read_extra",
               "knowledge_search", "editfile", "calc", "get_current_time",
               "grep", "list_files"}


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
        max_tokens=4096,  # 单次回复上限：1024 会把正常长回答拦腰截断（中文约 2~3k 字就到顶）
        timeout=300,   # ★ 单次模型调用最多等 5 分钟：超时抛异常 → 任务结束，不会无限卡
        extra_body={"thinking": {"type": "disabled"}},
    )

    # ③ 组装消息：system + 历史（R8：预算截断，最新优先保留，防长会话上下文爆炸）
    messages = [SystemMessage(content=_build_system_prompt())]
    messages.extend(_build_history_messages(conversation_id))

    



    # ④ 把工具菜单（说明书）绑到模型上，调模型
    llm_with_tools = llm.bind_tools(list_tools())

    # ⑤ 调模型；失败时把原因转成中文提示（而不是 500 报错）
    used = []   # 记录这轮回复用过的工具名（前端气泡展示用）
    MAX_TOOL_ROUNDS = 200   # 工具调用轮数上限：几乎无限（写大文档都够），
                            # 仅防"模型失控永远循环"这种真故障；正常长任务跑不完这么多轮
    try:
        resp = _agent_loop(llm_with_tools, messages, task_id, used, MAX_TOOL_ROUNDS)
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


def run_node(node: dict, model: dict | None, temperature: float | None,
             task_id: str | None) -> dict:
    """执行一个工作流节点（R6 第一步：节点"大脑"搬进后端）。

    与 reply 共用同一套工具循环（_agent_loop）、权限门控（_run_tool）、
    AskUser 挂起与可取消机制。区别仅在上下文组装：
    - 不带会话历史：节点的上下文是上游交付物 node["input"]，不是聊天记录
    - System Prompt 来自节点自身配置（systemPrompt），注入时间基准与生图规则
    - 工具白名单 = 节点 tools ∩ 后端已启用工具；AskUser 始终可用（节点需要用户拍板时挂起）

    模型未配置 → 抛 ValueError → 任务 failed → 前端节点如实标失败（绝不伪造成功输出）。
    """
    if not model or not model.get("model"):
        raise ValueError("工作流节点未配置可用对话模型（请到 设置 → 模型 添加并填写密钥）")

    llm = ChatOpenAI(
        temperature=temperature if temperature is not None else 0.7,
        model=model["model"],
        base_url=model.get("baseUrl") or None,
        api_key=model.get("apiKey") or None,
        max_tokens=4096,
        timeout=300,
        extra_body={"thinking": {"type": "disabled"}},
    )

    # ---- 上下文组装：节点 System Prompt ----
    name = (node.get("name") or "未命名节点").strip()
    sp = (node.get("systemPrompt") or "").strip()
    if not sp:
        sp = f"你是一个专注于【{name}】专业任务的智能体，请直接输出高质量、结构化、详尽的专业成果。"
    sp += ("\n\n【输出准则】你是多智能体工作流中的独立专业节点：直接输出本次任务的核心成果，"
           "严禁任何客套寒暄或自我介绍；严格忠实于上游事实与工具实时返回结果，"
           "严禁无依据虚构；工具未成功执行时如实说明，不得声称完成。")
    declared = {str(t) for t in (node.get("tools") or [])}
    if "generate_image" in declared:
        sp += ("\n\n【图像生成】本节点已分配生图工具：需要作图时调用 generate_image"
               "（prompt 用详尽的画面描述）；工具返回图片路径后，最终输出中必须原样包含"
               " Markdown 贴图语法：![画面描述](图片完整路径)。")
    sp += _time_rules()
    if not node.get("suppressAskUser"):
        sp += _load_user_rules()   # 条件判定器等内部节点不注入用户规则（防污染硬性输出格式）

    # ---- 工具白名单：节点声明 ∩ 后端启用；AskUser 始终兜底可用 ----
    enabled_schemas = list_tools()
    schemas = [t for t in enabled_schemas if t["function"]["name"] in declared]
    from tools import ask_user as _ask_user
    # suppressAskUser：条件判定等"只许输出结论"的内部节点，不允许挂起问用户
    if not node.get("suppressAskUser") and all(t["function"]["name"] != "AskUser" for t in schemas):
        schemas.append(_ask_user.SCHEMA)

    # ---- 用户消息：节点任务书 ----
    parts = [f"【当前任务节点】：{name}"]
    desc = (node.get("description") or "").strip()
    if desc:
        parts.append(f"【节点目标说明】：{desc}")
    upstream = (node.get("input") or "").strip()
    if upstream:
        if len(upstream) > 30000:
            upstream = upstream[:30000] + "\n…（上游输入过长已截断，仅保留开头 30000 字）"
        parts.append(f"【上游各节点流转输入】：\n{upstream}")
    if any(t["function"]["name"] not in ("AskUser",) for t in schemas):
        parts.append("你可以按需调用分配给你的工具获取外部数据或执行操作：先取数据，再综合输出最终成果。")
    else:
        parts.append("本节点未分配外部工具，请基于上游输入直接完成任务。")
    messages = [SystemMessage(content=sp), HumanMessage(content="\n\n".join(parts))]

    used = []
    try:
        max_rounds = max(3, min(50, int(node.get("maxToolCalls") or 12)))
    except (TypeError, ValueError):
        max_rounds = 12

    llm_run = llm.bind_tools(schemas) if schemas else llm
    try:
        resp = _agent_loop(llm_run, messages, task_id, used, max_rounds)
        return {"reply": resp.content or "（节点已完成，但没有生成文字输出）", "toolsUsed": used}
    except _TaskCancelled:
        # 让 Worker 按取消状态丢弃结果；不把"已终止"伪造成节点输出
        raise
    except Exception as e:
        raise RuntimeError(f"节点模型调用失败：{type(e).__name__}: {str(e)[:200]}") from e



def register_message(conversation_id: str, role: str, content: str) -> dict:
    return {
        "id": f"m-{datetime.now(timezone.utc).timestamp():.0f}-{role}",
        "role": role,
        "text": content,
        "status": "done",
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
