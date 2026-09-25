"""列出目录结构（树状 + 文件大小，默认忽略依赖/构建/隐藏目录）。

定位：让 AI 快速了解项目布局、定位文件，替代不可靠的 shell ls/dir。
"""
import os
from fnmatch import fnmatch

from tools.fsutil import resolve_path, IGNORE_DIRS

MAX_ENTRIES = 400


SCHEMA = {
    "type": "function",
    "function": {
        "name": "list_files",
        "description": (
            "列出目录下的文件与子目录（树状结构、含文件大小），"
            "自动跳过 node_modules / .git / __pycache__ 等依赖与构建目录。用于了解项目结构、定位文件。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "目录路径（默认当前工作目录）"},
                "depth": {"type": "integer", "description": "展开层级（默认 2，最大 4）"},
                "pattern": {"type": "string", "description": "可选，按文件名过滤（glob，如 \"*.py\"）；目录结构仍会显示"},
            },
        },
    },
}


def _human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}GB"


def run(args: dict) -> str:
    try:
        root = resolve_path(args.get("path") or ".")
    except ValueError as e:
        return f"错误：{e}"
    if not os.path.isdir(root):
        return f"错误：目录不存在：{root}"

    try:
        depth = min(4, max(1, int(args.get("depth") or 2)))
    except (TypeError, ValueError):
        depth = 2
    pattern = (args.get("pattern") or "").strip() or None

    entries: list[str] = []
    truncated = False

    def walk(d: str, prefix: str, level: int) -> None:
        nonlocal truncated
        if truncated or level > depth:
            return
        try:
            items = sorted(
                os.listdir(d),
                key=lambda s: (not os.path.isdir(os.path.join(d, s)), s.lower()),
            )
        except OSError as e:
            entries.append(f"{prefix}[无法读取: {e}]")
            return
        for name in items:
            if len(entries) >= MAX_ENTRIES:
                truncated = True
                return
            full = os.path.join(d, name)
            if os.path.isdir(full):
                if name in IGNORE_DIRS or name.startswith("."):
                    continue
                entries.append(f"{prefix}{name}/")
                walk(full, prefix + "  ", level + 1)
            else:
                if pattern and not fnmatch(name, pattern):
                    continue
                try:
                    size = os.path.getsize(full)
                except OSError:
                    size = 0
                entries.append(f"{prefix}{name}  ({_human(size)})")

    walk(root, "", 1)
    if not entries:
        return f"{root}：（空目录，或没有匹配 {pattern} 的文件）"
    tail = ""
    if truncated:
        tail = f"\n…（已达 {MAX_ENTRIES} 条输出上限，请用更具体的 path/depth/pattern 缩小范围）"
    return f"{root}\n" + "\n".join(entries) + tail
