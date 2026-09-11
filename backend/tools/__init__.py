"""
JIGSAW — 工具注册表
================
所有内置工具在这里登记：名字 → { schema(给LLM的说明书), run(执行函数), icon, label }。
工具的"启用/禁用"状态持久化到 data/tools.json（默认启用）。

新增工具三步：
1. 在 tools/ 下新建 <name>.py，写 SCHEMA + run
2. 在下方 TOOLS 里登记一行
3. 前端工具广场自动出现（无需改前端）
"""
import json
import os

from . import time
from . import websearch

# 工具状态文件（启用/禁用开关）
DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
TOOLS_STATE_FILE = os.path.join(DATA_DIR, "tools.json")


def _load_state() -> dict:
    """读工具开关状态：{工具名: true/false}。文件不存在或损坏时全默认启用。"""
    try:
        with open(TOOLS_STATE_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except Exception:
        return {}


# 总开关的特殊键名（放在 tools.json 里，不是工具名）
TOOLS_ENABLED_KEY = "__enabled__"


def tools_enabled() -> bool:
    """总开关：是否允许 AI 使用任何工具。默认启用。"""
    return _load_state().get(TOOLS_ENABLED_KEY, True)


def set_tools_enabled(enabled: bool) -> None:
    state = _load_state()
    state[TOOLS_ENABLED_KEY] = bool(enabled)
    _save_state(state)


def _save_state(state: dict) -> None:
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(TOOLS_STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _is_enabled(name: str) -> bool:
    """开关状态：没在文件里记录的工具默认启用。"""
    return _load_state().get(name, True)


def _tool_meta(name: str, t: dict, enabled: bool) -> dict:
    """把注册表条目整理成前端能直接渲染的元数据。"""
    fn = t["schema"]["function"]
    return {
        "name": name,
        "icon": t.get("icon", "tool"),
        "label": t.get("label", name),
        "description": fn.get("description", ""),
        "parameters": fn.get("parameters", {"type": "object", "properties": {}}),
        "enabled": enabled,
    }


# ============================================================
# 注册表：name -> { schema, run, icon, label }
# ============================================================
TOOLS = {
    "get_current_time": {
        "schema": time.SCHEMA,
        "run": time.run,
        "icon": "clock",
        "label": "获取当前时间",
    },
    "websearch": {
        "schema": websearch.SCHEMA,
        "run": websearch.run,
        "icon": "globe",
        "label": "网页搜索",
    },
}


def list_tools() -> list:
    """
    给 LLM 用的工具说明书（OpenAI function calling 格式）。
    只返回"启用"的工具 —— 被禁用的工具 LLM 看不到、不会调用。
    总开关关闭时返回空列表 —— LLM 完全没有工具可用。
    """
    if not tools_enabled():
        return []
    return [t["schema"] for name, t in TOOLS.items() if _is_enabled(name)]


def list_all_tools() -> list:
    """
    给前端工具广场用的完整列表（含禁用项，用于渲染开关）。
    """
    return [_tool_meta(name, t, _is_enabled(name)) for name, t in TOOLS.items()]


def set_enabled(name: str, enabled: bool) -> bool:
    """切换工具开关，持久化到 data/tools.json。工具不存在返回 False。"""
    if name not in TOOLS:
        return False
    state = _load_state()
    state[name] = bool(enabled)
    _save_state(state)
    return True


def execute(name: str, args: dict) -> str:
    """执行工具：按名字找到函数，传参调用。LLM 说调哪个就调哪个。"""
    tool = TOOLS.get(name)
    if not tool:
        return f"错误：工具 {name} 不存在"
    if not _is_enabled(name):
        return f"工具 {name} 已被禁用"
    try:
        return tool["run"](args or {})
    except Exception as e:
        return f"工具执行失败：{type(e).__name__}: {e}"
