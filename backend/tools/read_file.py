"""读取本地文本文件（带行号，支持 offset/limit 分页）。

定位：AI Coding 场景下读代码 / 配置 / Markdown 的基础工具。
Word / PDF / Excel / PPT 请用 read_extra（统一提取层）。
此前 AI 只能用 shell cat 看文件（Windows 体验差 + 输出被截断），本工具补齐该缺口。
"""
import os

from tools.fsutil import resolve_path, looks_binary

MAX_LINES = 500        # 单次最多读取行数（防止一次调用吃满上下文）
DEFAULT_LINES = 150


SCHEMA = {
    "type": "function",
    "function": {
        "name": "read_file",
        "description": (
            "读取本地文本文件内容（代码、配置、Markdown 等纯文本），返回带行号的内容。"
            "大文件用 offset/limit 分页读取；Word/PDF/Excel/PPT 请改用 read_extra。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "文件路径（绝对路径，或相对当前工作目录）"},
                "offset": {"type": "integer", "description": "起始行号（从 1 开始，默认 1）"},
                "limit": {"type": "integer", "description": f"最多读取行数（默认 {DEFAULT_LINES}，上限 {MAX_LINES}）"},
            },
            "required": ["file_path"],
        },
    },
}


def run(args: dict) -> str:
    try:
        path = resolve_path(args.get("file_path") or args.get("path") or "")
    except ValueError as e:
        return f"错误：{e}"
    if not os.path.isfile(path):
        return f"错误：文件不存在：{path}"
    if looks_binary(path):
        return f"错误：{path} 是二进制文件，文本工具读不了（Word/PDF/Excel/PPT 用 read_extra，其余用 shell 查看说明）"

    try:
        offset = max(1, int(args.get("offset") or 1))
        limit = min(MAX_LINES, max(1, int(args.get("limit") or DEFAULT_LINES)))
    except (TypeError, ValueError):
        offset, limit = 1, DEFAULT_LINES

    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except OSError as e:
        return f"错误：读取失败：{e}"

    total = len(lines)
    start = min(offset, max(total, 1))
    chunk = lines[start - 1: start - 1 + limit]
    if not chunk:
        return f"{path} 共 {total} 行；offset={offset} 超出范围"
    body = "\n".join(f"{start + i:5d}→ {text}" for i, text in enumerate(chunk))
    more = "" if start - 1 + limit >= total else \
        f"\n…（未读完：还有第 {start + limit}~{total} 行，用 offset={start + limit} 继续读）"
    return f"{path}（共 {total} 行，显示第 {start}~{start + len(chunk) - 1} 行）\n{body}{more}"
