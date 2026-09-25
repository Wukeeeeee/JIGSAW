"""工具路由：前端工具广场 读取工具列表 / 切换启用状态 / 总开关 / 进入项目工作。"""
import queue
import threading

from fastapi import APIRouter
from pydantic import BaseModel

from tools import (
    list_all_tools, set_enabled, tools_enabled, set_tools_enabled,
    set_all_tools_enabled,
    permission_level, set_permission_level,
    risk_acknowledged, set_risk_acknowledged,
    shell_cwd_project, set_shell_cwd_project,
    shell_cwd_path, set_shell_cwd_path, PROJECT_ROOT,
)

router = APIRouter()


@router.get("/tools")
def get_tools():
    """返回全部工具（含启用状态）、总开关、"进入项目工作"开关与自定义目录。"""
    return {
        "tools": list_all_tools(),
        "enabled": tools_enabled(),
        "permission": permission_level(),
        "riskAck": risk_acknowledged(),   # 风险确认弹窗是否已勾选"不再提醒"
        "cwdProject": shell_cwd_project(),
        "cwdPath": shell_cwd_path(),
        "projectRoot": PROJECT_ROOT,
    }


class ToggleIn(BaseModel):
    enabled: bool


class CwdPathIn(BaseModel):
    path: str


def _ask_directory(initial: str) -> str | None:
    """弹系统目录选择框。askdirectory 必须在其 Tk 实例自己的线程里跑，
    这里为每次选择单独起一个线程 + 实例，返回选中的路径（取消返回 None）。"""
    q = queue.Queue()

    def _run():
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            path = filedialog.askdirectory(initialdir=initial or None, title="选择 JIGSAW 工作目录")
            root.destroy()
            q.put(path)
        except Exception as e:
            q.put(e)

    threading.Thread(target=_run, daemon=True).start()
    try:
        result = q.get(timeout=300)
    except queue.Empty:
        return None
    if isinstance(result, Exception):
        raise result
    return result or None


@router.post("/tools/enabled")
def toggle_tools_master(payload: ToggleIn):
    """总开关：允许/不允许 AI 使用任何工具。"""
    set_tools_enabled(payload.enabled)
    return {"ok": True, "enabled": payload.enabled}


@router.post("/tools/enable-all")
def enable_all_tools(payload: ToggleIn):
    """一键允许/禁用所有工具（“全部允许”按钮）。"""
    set_all_tools_enabled(payload.enabled)
    return {"ok": True, "enabled": payload.enabled}


class PermissionIn(BaseModel):
    level: str


@router.post("/tools/permission")
def set_permission(payload: PermissionIn):
    """权限级别：ask=始终询问 / auto=按需确认 / allow=全部允许。"""
    set_permission_level(payload.level)
    return {"ok": True, "level": payload.level}


@router.post("/tools/risk-ack")
def set_risk_ack(payload: ToggleIn):
    """"不再提醒"开关：true=以后风险操作直接执行（不再弹窗）；false=恢复每次提醒。"""
    set_risk_acknowledged(payload.enabled)
    return {"ok": True, "riskAck": payload.enabled}


@router.post("/tools/cwd-project")
def toggle_cwd_project(payload: ToggleIn):
    """"进入项目工作"开关：shell 命令是否在自定义工作目录执行。"""
    set_shell_cwd_project(payload.enabled)
    return {"ok": True, "enabled": payload.enabled}


@router.post("/tools/cwd-pick")
def pick_cwd_project():
    """弹出系统目录选择框（桌面端）。选中 → 保存目录并自动开启"进入项目工作"。"""
    try:
        path = _ask_directory(shell_cwd_path() or PROJECT_ROOT)
        if not path:
            return {"ok": False, "cancelled": True}
        set_shell_cwd_path(path)
        set_shell_cwd_project(True)
        return {"ok": True, "path": path}
    except Exception as e:
        return {"ok": False, "error": f"无法弹出目录选择框：{type(e).__name__}: {e}"}


@router.post("/tools/cwd-path")
def set_cwd_path(payload: CwdPathIn):
    """手动设置工作目录（不弹框，由前端输入路径）。"""
    path = (payload.path or "").strip()
    if path:
        set_shell_cwd_path(path)
        set_shell_cwd_project(True)
    return {"ok": True, "path": path}


@router.post("/tools/{name}/toggle")
def toggle_tool(name: str, payload: ToggleIn):
    """开关一个工具。开关状态持久化到 data/tools.json。"""
    ok = set_enabled(name, payload.enabled)
    if not ok:
        return {"ok": False, "error": f"工具 {name} 不存在"}
    return {"ok": True, "name": name, "enabled": payload.enabled}


class ExecuteIn(BaseModel):
    name: str
    args: dict = {}


# 该接口没有任务上下文（无 AskUser 挂起、无权限三档弹窗），
# 高危工具一旦放行，等于绕过 chat_service._run_tool 的整套权限门控。
# shell/文件写入类工具只允许 AI 在任务链路里经用户确认后调用。
_DENIED_ON_EXECUTE = {"shell", "editfile", "apply_patch", "AskUser"}


@router.post("/tools/execute")
def execute_tool_endpoint(payload: ExecuteIn):
    """通用工具执行接口（用于工作流节点自动生图、设置页测试工具等）。

    仅开放只读/低危工具；高危工具在此直接拒绝，防止绕过权限体系。
    """
    name = (payload.name or "").strip()
    if name in _DENIED_ON_EXECUTE:
        return {"ok": False, "error": (
            f"工具「{name}」涉及本机命令执行、文件写入或用户交互，"
            "仅允许 AI 在任务链路中经权限确认后调用，不能通过该接口直接执行。"
        )}
    if name == "knowledge_write" and (payload.args or {}).get("mode") == "overwrite":
        return {"ok": False, "error": (
            "knowledge_write 的 overwrite 模式会覆盖原文档，"
            "仅允许 AI 在任务链路中经用户确认后调用。"
        )}
    from tools import execute
    try:
        res = execute(name, payload.args or {})
        return {"ok": True, "result": res}
    except Exception as e:
        return {"ok": False, "error": str(e)}

