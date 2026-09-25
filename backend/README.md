# JIGSAW Backend (FastAPI)

JIGSAW 的真实运行时后端：Agent 对话主链路（工具循环 / 权限门控 / AskUser 挂起）、
工作流节点执行与 Captain 规划、异步任务队列（多 Worker 可中断）、本地知识库 RAG、
模型配置与密钥托管、跨站防护。前端只负责画布渲染与编排控制。

## 启动

```bash
cd backend
pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8000
```

接口文档：http://127.0.0.1:8000/docs

## 架构速览

| 模块 | 说明 |
|---|---|
| `services/chat_service.py` | Agent 主链路：`reply()` 对话（全量工具循环）、`run_node()` 工作流节点执行、`plan_workflow()` Captain 规划；共享 `_agent_loop` 工具循环与 `_run_tool` 权限门控（ask/auto/allow 三档 + 风险确认） |
| `services/task_service.py` | 异步任务队列：`kind=chat`（写会话）/ `kind=node`（结果由前端取回写画布）；多 Worker 并发、AskUser 挂起、1 秒内可取消 |
| `services/store.py` | JSON 落盘：`conversations.json` / `models.json` / `workflows.json`（画布持久化） |
| `services/rag/` | 本地知识库：bge-small-zh 向量 + 关键词 RRF 混合检索，无依赖时降级 |
| `tools/` | 16 个内置工具注册表（`tools/__init__.py`）：`read_file` / `list_files` / `grep` 代码文件三件套、`websearch`、`generate_image`、知识库读写、`shell` 等；开关与权限持久化于 `tools.json` |
| `main.py` | Origin 守卫中间件：写请求非本机 Origin 直接 403（跨站防护）；CORS 收敛为本机白名单 |

## 密钥与安全

- **密钥不出后端**：`/api/models` 与 `/api/settings` 一律脱敏（只回 `hasKey`）；
  对话 / 节点执行 / 规划只传 `model_id`，后端从 `models.json` 解析密钥；
  编辑模型时密钥留空 = 保留原值
- **权限门控**：`shell` / 文件写入 / 覆盖知识库等高危工具只能在任务链路中经用户确认后调用；
  `/api/tools/execute` 直接拒绝高危工具
- **会话历史预算**：注入上下文按 30 条 / 18000 字符截断（最新优先），防长会话爆炸
- **全局规则**：`data/rules.md` 每次对话实时注入 system prompt（设置页可编辑）

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（Worker 数 / 运行中任务数） |
| POST | `/api/chat/messages` | 发送消息 → 创建异步任务（`model_id` 由后端解析密钥） |
| GET | `/api/chat/tasks/{id}` | 任务状态轮询（进度 / AskUser / 结果） |
| POST | `/api/chat/tasks/{id}/answer` | 回答 AskUser / 风险确认 |
| POST | `/api/chat/tasks/{id}/cancel` | 终止任务 |
| PUT | `/api/chat/conversations/{id}/messages` | 全量同步会话消息（含 `mode` 持久化） |
| GET | `/api/models` | 模型列表（密钥脱敏，`hasKey` 标记） |
| POST/PUT/DELETE | `/api/models/custom[/{id}]` | 模型 CRUD（PUT 留空密钥 = 保留原值） |
| GET/PUT | `/api/rules` | 全局规则（rules.md）读写 |
| GET | `/api/workflows` | 工作流列表（画布持久化数据） |
| PUT/DELETE | `/api/workflows/{id}` | 画布 upsert 保存 / 删除 |
| POST | `/api/workflows/nodes/run` | 工作流节点执行任务（后端跑，只传 model_id） |
| POST | `/api/workflows/plan` | Captain 规划：任务需求 → 多智能体 DAG（支持 condition/loop 拓扑） |
| POST | `/api/workflows/{id}/reset` | 重置节点状态 |
| GET/POST | `/api/tools[...]` | 工具广场：列表 / 开关 / 权限三档 / 工作目录 |
| POST | `/api/tools/execute` | 低危工具直调（高危工具拒绝） |
| GET/PUT | `/api/settings` | 运行设置（image 部分密钥脱敏） |
| GET/PUT | `/api/knowledge[...]` | 本地知识库文件 CRUD 与检索 |
| GET | `/api/files/raw` | 本地图片预览（仅图片后缀白名单） |
| GET | `/api/stats` | 工具调用统计 |

## 测试

```bash
cd backend
python tests/test_execute_gate.py      # 高危工具门控
python tests/test_workflow_persist.py  # 画布落盘往返
python tests/test_node_run.py          # 节点任务队列端到端
python tests/test_plan.py              # Captain 规划 JSON 解析
python tests/test_history.py           # 会话历史预算截断
python tests/test_secrets.py           # 密钥脱敏 / 保留语义
python tests/test_file_tools.py        # read_file / list_files / grep
python tests/test_rules.py             # 全局规则注入
```

全部为纯本地测试（不发真实 LLM 请求、不碰 `data/` 真实数据），共 42 个用例。

## 数据目录 `data/`

`conversations.json`（会话）、`models.json`（模型与密钥）、`workflows.json`（画布）、
`tools.json`（工具开关/权限）、`rules.md`（全局规则）、`knowledge/`（知识库）、
`stats.json`（调用统计）。替换为数据库时保持 `services/store.py` 的接口签名即可。
