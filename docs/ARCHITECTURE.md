# JIGSAW Architecture Map

> 2026-09-24 首次建立。基于对全部源码的通读（backend ~4.3k 行 / frontend ~8k 行）。
> 本文档是后续所有优化的基准：改架构先改这里，改完代码同步更新。

## 1. 真实数据流（现状，非理想态）

```
┌─ 浏览器（js/）─────────────────────────────────────────────┐
│ Home 双模式入口                                             │
│   ├─ chat 模式（mode 无/workflow≠）→ POST /api/chat/messages │
│   └─ workflow 模式（conv.mode="workflow"）→ 画布链路         │
│ ChatService 按 conv.mode 路由（R1 已修：不再靠关键词猜）      │
│   └─ ExecutionService.start()：拓扑波次 + Promise.all 并发   │
│       ├─ 逻辑节点（条件/门/循环/起点）：本地求值              │
│       └─ Agent 节点：POST /api/workflows/nodes/run（R6）     │
│             └─ 只传 node 配置 + model_id（Key 不进浏览器！）  │
│             └─ 轮询 GET /api/chat/tasks/{id} 取回节点输出     │
│       画布变更 → WorkflowService.persist（700ms 防抖 PUT）    │
└──────────────────────────────────────────────────────────────┘
┌─ FastAPI 后端（backend/）───────────────────────────────────┐
│ chat_service.reply()     ← 普通对话主链路（历史+全量工具）    │
│ chat_service.run_node()  ← 工作流节点执行（R6 新增）          │
│   └─ 共享 _agent_loop：工具循环 / _run_tool 权限门控 /        │
│      AskUser 挂起 / _invoke_cancellable 可取消 / 输出截断     │
│   └─ 节点上下文：node.systemPrompt + 上游 input（≤30k 截断）  │
│      + 时间基准；工具白名单 = node.tools ∩ 启用工具 ∪ AskUser │
│ task_service：kind=chat/node 双类型任务队列（默认4 Worker）   │
│   └─ node 任务结果只写 task.reply（前端取回），不写会话消息    │
│ store：conversations / models / workflows 三份 JSON 落盘      │
│ rag/：bge-small-zh + RRF 混合检索（关键词+向量）               │
└──────────────────────────────────────────────────────────────┘
```

## 2. State 分层现状

| 层 | 载体 | 持久化 | 问题 |
|---|---|---|---|
| Conversation | store.conversations（后端） + 前端镜像 | conversations.json | 前端 PUT 全量覆盖与 Worker 写库存在双写竞争（P2） |
| Workflow | 前端 Store 内存 + 后端内存 dict | ✓ workflows.json（R5 已完成） | 前端变更 700ms 防抖 PUT upsert；启动 GET 拉回；执行中刷新由 loadRemote 复位 running 态 |
| Agent 节点输入输出 | node.input / node.output | 同上 | input 无截断，逐层放大（P2） |
| Task | task_service.TASKS | ❌ 重启即失 | 前端已处理"任务不存在"提示 |
| 工具开关/权限/shell cwd | tools.json | ✓ | 全局单份，无锁写（P2） |
| 模型配置 | localStorage + models.json 双源 | ✓ | 双源同步风险（P2） |
| Memory/RAG | knowledge/ + 向量 | ✓ | 边界清晰，暂健康 |

## 3. 问题登记册

### P0 —— 系统错误 / Agent 主链路失效
- **R1 聊天路由架空后端主链路**：`detectTemplate()` 恒返回 `"void"`（真值）→ `conv.workflowTemplate` 恒真 → `chat-service.js _doSend` 的 `isWorkflowPrompt` 几乎恒真 → remote 模式下消息进浏览器工作流分支。后端 13 工具循环 / AskUser / 权限三档 / 任务队列全部不可达。
- **R2 `/api/tools/execute` 权限旁路**：可直调 `shell` / `editfile` / `apply_patch`，绕过 `is_risky` + 权限三档；叠加 CORS `allow_origins=["*"]` 且无任何鉴权 → 任意本地浏览器页面可对 127.0.0.1:8000 发起命令执行。
- **R3 失败伪造输出**：`execution-service.js` 节点模型调用失败/未配模型时，`generateSmartSemanticOutput` 尾部模板生成以假乱真的"研报"，违反系统自身"严禁假完成"红线。
- **R4 `max_tokens=1024`**：chat_service 硬编码，正常回复即截断。

### P1 —— Harness 核心能力缺口（按收益排序）
- ~~**R5 Workflow 不持久化**~~（✅ 2026-09-24 完成：store.py 落盘 workflows.json + PUT 改 upsert + 新增 DELETE 随会话清理；前端 WorkflowService.persist 防抖自动保存挂满全部变更点，loadRemote 启动拉回并复位 running 态）。
- **R6 执行引擎迁移（进行中）**：
  - ✅ 第一步（2026-09-25）：Agent 节点"大脑"搬入后端 —— 新端点 `POST /api/workflows/nodes/run` 创建 kind=node 任务，Worker 调 `chat_service.run_node`（共享 `_agent_loop` 工具循环、权限门控、AskUser、可取消）；前端只传 node 配置 + model_id，**API Key 退出节点执行链路**；节点从"单轮+预取注入"升级为真实工具循环（maxToolCalls 封顶）；无模型时任务 failed（不伪造）。execution-service.js 893→616 行。
  - ✅ 第二步（2026-09-25）：Captain 规划搬后端 —— `POST /api/workflows/plan`（chat_service.plan_workflow：候选模型级联 + JSON 解析，规划 System Prompt 自前端原样迁入）；前端 autoPlanWorkflow 只发一次请求，失败降级本地启发式规划；节点默认模型取规划实际使用的 model_id。**浏览器直连 LLM 的链路已全部清除**。workflow-service.js 1004→921 行。
  - ✅ 复杂拓扑生成（2026-09-25，响应"AI 画不出复杂图"反馈）：
    - 规划 max_tokens 8192 + finish_reason 截断检测（截断明确报错，不再静默降级成简单模板图——这是"复杂图出不来"的直接原因之一）；
    - 提示词复杂度上限放宽（复杂任务 8~15 节点 / 4~6 阶；用户明示复杂时必须展开），新增 `type: condition|loop` + `onTrue/onFalse/onLoop/onDone/loopMax` 拓扑字段规范；
    - 前端归一化与建图支持控制节点：分支端口边（True/False/Loop/Done）取代默认依赖边、不参与 AND 门；onLoop 目标不并入 dependsOn（防层级环）+ getDepth 环保护；
    - condition_if 执行改为后端 LLM 真判定（只回 true/false，suppressAskUser 禁止挂起提问），判定失败如实熔断下游；
    - 实测：DeepSeek 对复杂任务规划出 13 节点 / 8 阶 / 含条件分支与循环评审的拓扑，建图模拟（无环、AND 门、端口边、零重复边）全部通过。
  - ⬜ 第三步（待做）：拓扑调度与重试/断点恢复整体后移（前端只留画布渲染与控制指令）；任务级步骤轨迹（task_service.add_step 仍是死代码）接入节点执行。
- **R7 CORS `*` + 零鉴权**（✅ 2026-09-25 完成，方案比原计划更优）：
  - 第一步：Origin 守卫中间件（写请求非本机 Origin 403，拦住网页驱动后端/替答权限弹窗）+ CORS 收敛为 localhost regex + null。
  - 第二步：**密钥出清**（替代原"本地 token"方案）—— `GET /api/models` 与 `GET /api/settings`（image 部分）一律脱敏（apiKey→空 + hasKey 标记），PUT/编辑时 apiKey 留空 = 保留原值；对话请求改传 `model_id` 由后端解析（`_resolve_model_config`），**Key 不再出现在任何 HTTP 响应与请求里**。
  - token 方案为何放弃：本地攻击者可直接读磁盘上的 models.json，token 只挡网络读，而脱敏已根治网络泄露且零 UX 破坏（顺带修复"清浏览器缓存丢密钥"问题）。磁盘保密=操作系统账号边界，超出应用层职责。
- **R8 会话上下文无限增长**（✅ 2026-09-25 已修：`_build_history_messages` 预算截断 —— 30 条 / 18000 字符双预算，最新优先，最近两条无条件保留，丢弃时注入 SystemMessage 说明；摘要式 compaction 待有真实需求再加）。
- **R9 AskUser 无超时**：用户关 App 则 Worker 挂死（单 Worker 时阻塞队列），需要可配置超时 + 自动放弃。
- **R10 模式丢失**：workflow 会话的 `mode` 不持久化，刷新后执行入口失效（R1 修复的配套项）。

### P2 —— 重要增强
- task_service.add_step/finish_last_step 为死代码（后端步骤轨迹从未写入/展示，前端时间线只用 workflow 分支的 steps）。
- readfile.py / screenshot.py 未注册（死代码）；_shell_risky 子串匹配误报（`clean` 命中文件名）。
- 节点 input 无长度上限；前端 settle() PUT 全量 messages 与后端 Worker 写库竞争。
- 双模型配置源（localStorage / models.json）同步逻辑脆弱。
- detectTemplate 死逻辑与 `workflowTemplate:"void"` 语义混乱（R1 修复后应清理）。
- 根目录 pelican_bicycle.html 垃圾文件；rag/vector_store.py 未提交改动含无意义注释。

### P3 —— UX / 卫生
- README 声称"后端真实 LLM 链路"，实际主链路曾在前端（R1 修复后需复核表述）。
- 零测试覆盖；mock 命名误导（mock-data 实为工作流模板系统）；SVG 导出配色偏离黑白灰设计语言。

## 4. 修复节奏

- 第一轮（✅ 2026-09-24）：R1 + R10（路由与模式持久化）、R2（高危工具门控）、R3（禁止伪造输出）、R4（max_tokens）。
- 第二轮（✅ 2026-09-24）：R5（工作流落盘：workflows.json + upsert PUT + DELETE 清理 + 防抖自动保存 + 启动拉取）。
- 第三轮（✅ 2026-09-25）：R6 第一步（节点执行搬后端：kind=node 任务 + run_node 共享工具循环 + model_id 后端解析 + 前端轮询取回）。
- 第四轮（✅ 2026-09-25）：R6 第二步（Captain 规划搬后端 `/api/workflows/plan`，浏览器直连 LLM 清零）。
- 第五轮（✅ 2026-09-25）：R8（会话历史预算截断：30 条/18k 字符，最新优先保留）+ R7 第一步（Origin 守卫中间件 + CORS 收敛，冒烟 7/7）。
- 第六轮（✅ 2026-09-25）：R7 第二步（密钥出清：models/settings GET 脱敏 + 空 Key 保留语义 + 对话 model_id 化，冒烟确认零泄露）。
- 第七轮（✅ 2026-09-25）：**代码文件三件套**（AI Coding 基础工具面）—— `read_file`（带行号 offset/limit 分页，二进制嗅探）、`list_files`（树状+大小，剪枝 node_modules/.git 等）、`grep`（正则搜索 文件:行号，glob 过滤，限量）；公共辅助 fsutil.py（相对路径以 shell 工作目录为基准）；工具截断 3000→6000 字（配合分页正好够用）；Captain 提示词补三件套与分配准则；删除死代码 readfile.py。README 同步更新（16 工具 / 复杂拓扑 / 后端执行 / 安全小节）。
- 第八轮（✅ 2026-09-25）：**全局规则（Rules）**—— `data/rules.md` 经 `GET/PUT /api/rules` 读写，`_load_user_rules()` 每次实时读取注入 system prompt（对话 + 工作流节点；条件判定器经 suppressAskUser 标记跳过，防污染 true/false 硬性输出）；超 4000 字截断；设置 → 常规 → 全局规则卡片（textarea + 保存即生效）。
- 第九轮候选：设置高级区（并发数/轮数/历史预算/会话保留）、MCP 最小闭环、R6 第三步（调度/重试后移 + 步骤轨迹进前端时间线）、P2 双写竞争。
