"""
JIGSAW — FastAPI 后端入口
=====================
只提供接口骨架与 Mock 实现。真实 AI / Agent 运行时逻辑由你替换
services/ 下的实现（chat_service / execution_service / workflow_service），
前端无需改动。

启动:
    uvicorn main:app --reload --port 8000
或双击 run.bat
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import agents, chat, execution, files, knowledge, models, settings, stats, tools, workflows

app = FastAPI(title="JIGSAW Backend", version="0.1.0")

# 启动异步任务队列的后台 Worker（幂等）：聊天消息在这里被一条条串行处理
from services import task_service, stats_service
task_service.start_worker()

# 工具调用统计：文件不存在就建好，"记录起始时刻"≈后端启动时刻（重置会更新它）
stats_service.ensure_initialized()

# 允许本地前端（file:// 或任意本地端口）直接访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat.router, prefix="/api/chat", tags=["chat"])
app.include_router(models.router, prefix="/api/models", tags=["models"])
app.include_router(agents.router, prefix="/api/agents", tags=["agents"])
app.include_router(workflows.router, prefix="/api/workflows", tags=["workflows"])
app.include_router(execution.router, prefix="/api/workflows", tags=["execution"])
app.include_router(settings.router, prefix="/api", tags=["settings"])
app.include_router(tools.router, prefix="/api", tags=["tools"])
app.include_router(stats.router, prefix="/api", tags=["stats"])
app.include_router(knowledge.router, prefix="/api", tags=["knowledge"])
app.include_router(files.router, prefix="/api/files", tags=["files"])


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "service": "jigsaw-backend",
        "version": "0.1.0",
        "workers": task_service.worker_count(),      # 并发 Worker 数
        "running": task_service.running_count(),     # 当前正在处理的任务数
    }
