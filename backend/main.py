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
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from routers import agents, chat, execution, files, knowledge, models, settings, stats, tools, workflows

app = FastAPI(title="JIGSAW Backend", version="0.1.0")

# 启动异步任务队列的后台 Worker（幂等）：聊天消息在这里被一条条串行处理
from services import task_service, stats_service
task_service.start_worker()

# 工具调用统计：文件不存在就建好，"记录起始时刻"≈后端启动时刻（重置会更新它）
stats_service.ensure_initialized()


def _origin_is_local(origin: str) -> bool:
    """Origin 是否来自本机：
    - 无 Origin（curl / 服务间调用）→ 放行
    - 字面量 "null" → Electron 桌面壳（file:// 页面）跨域 fetch 的 Origin
    - localhost / 127.0.0.1 / ::1 → 本地浏览器开发
    """
    if not origin:
        return True
    if origin.strip().lower() == "null":
        return True
    try:
        host = (urlsplit(origin).hostname or "").lower()
    except ValueError:
        return False
    return host in ("localhost", "127.0.0.1", "::1")


@app.middleware("http")
async def origin_guard(request: Request, call_next):
    """跨站写防护（R7 第一步）。

    CORS 只能阻止页面"读取响应"，阻止不了浏览器照常发出的 simple POST
    （请求已到达服务器并执行）—— 任意网页可借此驱动本地后端：读走模型密钥、
    创建任务、甚至替用户回答权限确认弹窗。这里在应用层校验 Origin：
    所有写请求（非 GET/HEAD/OPTIONS）若来自非本机 Origin 直接 403，
    请求不进业务逻辑。GET 保持放行（无副作用，且前端启动探测依赖它）。
    """
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin", "")
        if not _origin_is_local(origin):
            return JSONResponse({"detail": "已拒绝非本机来源的请求（跨站防护）"}, status_code=403)
    return await call_next(request)


# 允许本地前端（Electron file:// 或本地端口）跨域访问；任意网页由 origin_guard 拦截
app.add_middleware(
    CORSMiddleware,
    allow_origins=["null"],
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1)(:\d+)?$",
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
