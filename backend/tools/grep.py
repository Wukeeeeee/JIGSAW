"""在文件内容中搜索正则表达式（带 文件:行号 前缀）。

定位：在代码库/文档中查找函数、关键字、实现位置。跳过二进制与依赖目录。
"""
import os
import re

from tools.fsutil import resolve_path, iter_files, looks_binary

MAX_FILE_BYTES = 1_000_000   # 跳过超大文件
MAX_FILES = 3000             # 最多扫描文件数（防超时）
LINE_CLIP = 200              # 单行显示截断


SCHEMA = {
    "type": "function",
    "function": {
        "name": "grep",
        "description": (
            "在文件内容中按正则表达式搜索，返回「文件路径:行号: 匹配行」。"
            "自动跳过二进制文件与 node_modules/.git 等目录。用于在代码库中查找函数、关键字、实现位置。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "正则表达式（Python 语法）"},
                "path": {"type": "string", "description": "搜索的文件或目录（默认当前工作目录）"},
                "glob": {"type": "string", "description": "可选，按文件名过滤（glob，如 \"*.py\"）"},
                "max_results": {"type": "integer", "description": "最多返回匹配数（默认 50，上限 200）"},
            },
            "required": ["pattern"],
        },
    },
}


def run(args: dict) -> str:
    pattern = (args.get("pattern") or "").strip()
    if not pattern:
        return "错误：pattern 不能为空"
    try:
        rx = re.compile(pattern)
    except re.error as e:
        return f"错误：正则无效：{e}"

    try:
        root = resolve_path(args.get("path") or ".")
    except ValueError as e:
        return f"错误：{e}"

    if os.path.isfile(root):
        files = iter([root])
        root_label = root
    elif os.path.isdir(root):
        glob = (args.get("glob") or "").strip() or None
        files = iter_files(root, glob)
        root_label = root
    else:
        return f"错误：路径不存在：{root}"

    try:
        max_results = min(200, max(1, int(args.get("max_results") or 50)))
    except (TypeError, ValueError):
        max_results = 50

    out: list[str] = []
    scanned = 0
    for fp in files:
        if len(out) >= max_results or scanned >= MAX_FILES:
            break
        scanned += 1
        try:
            if os.path.getsize(fp) > MAX_FILE_BYTES or looks_binary(fp):
                continue
            with open(fp, "r", encoding="utf-8", errors="replace") as f:
                for i, line in enumerate(f, 1):
                    if rx.search(line):
                        out.append(f"{fp}:{i}: {line.rstrip()[:LINE_CLIP]}")
                        if len(out) >= max_results:
                            break
        except OSError:
            continue

    if not out:
        return f"在 {root_label} 没有找到匹配 /{pattern}/ 的内容（已扫描 {scanned} 个文件）"
    head = f"搜索 /{pattern}/ @ {root_label}：{len(out)} 处匹配（扫描 {scanned} 个文件）"
    tail = "" if len(out) < max_results and scanned < MAX_FILES else \
        f"\n…（已达上限，可用更精确的 pattern/glob/path 缩小范围）"
    return head + "\n" + "\n".join(out) + tail
