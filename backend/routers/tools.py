"""工具路由：前端工具广场 读取工具列表 / 切换启用状态 / 总开关。"""
from fastapi import APIRouter
from pydantic import BaseModel

from tools import list_all_tools, set_enabled, tools_enabled, set_tools_enabled

router = APIRouter()


@router.get("/tools")
def get_tools():
    """返回全部工具（含启用状态）与总开关。前端工具广场用它渲染列表。"""
    return {"tools": list_all_tools(), "enabled": tools_enabled()}


class ToggleIn(BaseModel):
    enabled: bool


@router.post("/tools/enabled")
def toggle_tools_master(payload: ToggleIn):
    """总开关：允许/不允许 AI 使用任何工具。"""
    set_tools_enabled(payload.enabled)
    return {"ok": True, "enabled": payload.enabled}


@router.post("/tools/{name}/toggle")
def toggle_tool(name: str, payload: ToggleIn):
    """开关一个工具。开关状态持久化到 data/tools.json。"""
    ok = set_enabled(name, payload.enabled)
    if not ok:
        return {"ok": False, "error": f"工具 {name} 不存在"}
    return {"ok": True, "name": name, "enabled": payload.enabled}
