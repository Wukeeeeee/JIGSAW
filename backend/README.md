# JIGSAW Backend (FastAPI)

JIGSAW 前端（`E:\my_repo\Figsaw\`）对应的后端骨架。**当前全部为 Mock 实现**，
真实 AI / Agent 运行时由你替换 `services/` 下的实现，前端无需改动。

## 启动

```bash
cd backend
pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8000
```

或双击 `run.bat`。接口文档：http://127.0.0.1:8000/docs

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| POST | `/api/chat/messages` | 发送消息，返回回复（Mock） |
| GET | `/api/chat/conversations` | 会话列表 |
| GET | `/api/chat/conversations/{id}/messages` | 会话消息 |
| GET | `/api/models` | 自定义模型列表 |
| POST | `/api/models/custom` | 添加自定义模型 |
| DELETE | `/api/models/custom/{id}` | 删除自定义模型 |
| GET | `/api/agents/templates` | Agent 模板 |
| GET | `/api/workflows` | 工作流列表 |
| GET | `/api/workflows/{id}` | 工作流详情 |
| PUT | `/api/workflows/{id}` | 保存工作流（节点/边） |
| POST | `/api/workflows/{id}/run` | 模拟执行 |
| POST | `/api/workflows/{id}/reset` | 重置节点状态 |
| GET/PUT | `/api/settings` | 运行设置 |

## 前端对接

1. 设置 → API → 数据源 选择「后端 API」
2. 接口地址默认 `http://127.0.0.1:8000`
3. 聊天消息会通过 `POST /api/chat/messages` 发送到后端

## 替换真实 AI 的位置

- `services/chat_service.py` → `reply()`：接入你的 LLM
- `services/execution_service.py` → `run()`：接入 Agent 调度 / 运行时
- `services/workflow_service.py`：工作流规则（锁定逻辑）
- `services/store.py`：换成数据库持久化
