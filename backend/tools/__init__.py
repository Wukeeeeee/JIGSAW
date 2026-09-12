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

from . import ask_user, fetch_url, shell, time, websearch

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

# 权限级别（Claude Code 式）：ask=始终询问 / auto=按需确认 / allow=全部允许
PERMISSION_KEY = "__permission__"
DEFAULT_PERMISSION = "allow"

# "不再提醒"标记：全部允许模式下，用户确认过风险操作后不再弹窗（放 tools.json）
RISK_ACK_KEY = "__risk_acknowledged__"

# shell 工具的"进入项目工作"开关键名（放 tools.json 里）
SHELL_CWD_KEY = "__shell_cwd_project__"
# 用户自定义的工作目录（放 tools.json 里；空字符串 = 用项目根目录）
SHELL_CWD_PATH_KEY = "__shell_cwd_path__"

# 项目根目录（backend/data 的上上级）——给前端显示、当 shell 的默认工作目录
PROJECT_ROOT = os.path.dirname(os.path.dirname(DATA_DIR))


def shell_cwd_project() -> bool:
    """"进入项目工作"开关：shell 命令是否在工作目录执行。默认关闭。"""
    return _load_state().get(SHELL_CWD_KEY, False)


def set_shell_cwd_project(enabled: bool) -> None:
    state = _load_state()
    state[SHELL_CWD_KEY] = bool(enabled)
    _save_state(state)


def shell_cwd_path() -> str:
    """用户自定义的工作目录（"" 表示未自定义，用项目根目录）。"""
    return _load_state().get(SHELL_CWD_PATH_KEY, "") or ""


def set_shell_cwd_path(path: str) -> None:
    state = _load_state()
    if path:
        state[SHELL_CWD_PATH_KEY] = path
    else:
        state.pop(SHELL_CWD_PATH_KEY, None)
    _save_state(state)


def shell_cwd() -> str | None:
    """shell 工具实际使用的工作目录：
    - 开关关 → None（继承后端进程目录）
    - 开关开 → 用户自定义目录（若有），否则项目根目录
    """
    if not shell_cwd_project():
        return None
    return shell_cwd_path() or PROJECT_ROOT


def tools_enabled() -> bool:
    """总开关：是否允许 AI 使用任何工具。默认启用。"""
    return _load_state().get(TOOLS_ENABLED_KEY, True)


def set_tools_enabled(enabled: bool) -> None:
    state = _load_state()
    state[TOOLS_ENABLED_KEY] = bool(enabled)
    _save_state(state)


def set_all_tools_enabled(enabled: bool) -> None:
    """一键允许/禁用所有工具（“全部允许”按钮）。"""
    state = _load_state()
    for name in TOOLS:
        state[name] = bool(enabled)
    _save_state(state)


def permission_level() -> str:
    """权限级别：ask=始终询问 / auto=按需确认 / allow=全部允许。默认全部允许。"""
    return _load_state().get(PERMISSION_KEY, DEFAULT_PERMISSION)


def set_permission_level(level: str) -> None:
    if level not in ("ask", "auto", "allow"):
        level = DEFAULT_PERMISSION
    state = _load_state()
    state[PERMISSION_KEY] = level
    _save_state(state)


def risk_acknowledged() -> bool:
    """"不再提醒"是否已勾选：全部允许模式下，确认过一次风险后不再弹窗。"""
    return bool(_load_state().get(RISK_ACK_KEY, False))


def set_risk_acknowledged(v: bool) -> None:
    state = _load_state()
    state[RISK_ACK_KEY] = bool(v)
    _save_state(state)


# ============================================================
# 风险判断：哪些工具调用算"高风险"，需要用户确认
# ============================================================
_RISKY_SHELL_PATTERNS = [
    "rm -rf", "rm -fr", "rm -r", "rm -f",
    "del /f", "del /s", "rd /s", "rmdir /s",
    "format", "diskpart", "clean",
    "shutdown", "restart", "reg delete",
    "del -rf", "rm -f", "mv /", "chmod 777 /",
    "> /dev/sda", "mkfs",
]

def _shell_risky(command: str) -> bool:
    """检查 shell 命令是否包含危险操作（删库、格式化、清空、关机等）。"""
    c = (command or "").lower().replace("\\", "/")
    for p in _RISKY_SHELL_PATTERNS:
        if p in c:
            return True
    return False


def is_risky(name: str, args: dict) -> bool:
    """风险判断：
    - shell：命令里含删除/格式化/清空/关机等危险操作 → 高风险
    - 其他工具：默认低风险（不弹窗）
    """
    if name == "shell":
        return _shell_risky((args or {}).get("command", ""))
    return False


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
    "fetch_url":{
        "schema": fetch_url.SCHEMA,
        "run": fetch_url.run,
        "icon": "fetch",
        "label": "网页抓取",
    },
    "shell": {
        "schema": shell.SCHEMA,
        "run": shell.run,
        "icon": "terminal",
        "label": "执行命令",
    },
    "AskUser": {
        "schema": ask_user.SCHEMA,
        "run": ask_user.run,
        "icon": "message",
        "label": "询问用户",
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
