"""文件类工具（read_file / list_files / grep）的公共辅助：
路径解析、忽略目录、二进制嗅探、目录遍历。不依赖 tools/__init__（避免循环导入）。
"""
from __future__ import annotations

import fnmatch
import os

# 遍历时默认跳过的目录（依赖 / 构建产物 / 版本库内部 / 应用私有数据）
IGNORE_DIRS = {
    ".git", ".svn", ".hg", "node_modules", "__pycache__", ".venv", "venv",
    ".idea", ".vscode", "dist", "build", ".pytest_cache", ".mypy_cache",
    "generated_images", ".workbuddy",
}

_BinarySniff = 8192


def resolve_path(p: str) -> str:
    """把工具入参路径解析为绝对路径：相对路径以 shell 工作目录（或当前目录）为基准。

    运行时导入 tools.shell_cwd，避免与 tools/__init__ 循环导入。
    """
    p = (p or "").strip().strip('"').strip("'")
    if not p:
        raise ValueError("路径为空")
    if not os.path.isabs(p):
        try:
            from tools import shell_cwd   # 运行时导入，避免循环导入
            base = shell_cwd() or os.getcwd()
        except Exception:
            base = os.getcwd()
        p = os.path.join(base, p)
    return os.path.normpath(p)


def looks_binary(path: str) -> bool:
    """嗅探文件头是否含 NUL 字节（粗判二进制）。"""
    try:
        with open(path, "rb") as f:
            return b"\x00" in f.read(_BinarySniff)
    except OSError:
        return False


def iter_files(root: str, glob: str | None = None):
    """遍历目录下的文件（剪枝忽略目录与隐藏目录），yield 绝对路径。

    glob 形如 "*.py"，按文件名过滤；None = 全部文件。
    """
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            d for d in dirnames if d not in IGNORE_DIRS and not d.startswith(".")
        )
        for name in sorted(filenames):
            if glob and not fnmatch.fnmatch(name, glob):
                continue
            yield os.path.join(dirpath, name)
