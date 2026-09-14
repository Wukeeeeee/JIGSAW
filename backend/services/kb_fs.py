"""知识库文件系统公共层
====================
知识库根目录的读取/设置，以及"隐藏文件"判定，统一放这里。
routers/knowledge.py（页面 CRUD）和 tools/knowledge_*.py（AI 读/写）
都用这一份，保证"页面看到的"和"AI 看到的"完全一致。

隐藏文件的判定（三选一即算隐藏）：
  1. 名字以 . 开头（.DS_Store、.obsidian、.git…）
  2. 名字命中常见系统垃圾文件名（Thumbs.db、desktop.ini、$RECYCLE.BIN…）
  3. Windows 上带"隐藏"或"系统"文件属性
"""
from __future__ import annotations

import json
import os

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
ROOT_FILE = os.path.join(DATA_DIR, "knowledge_root.json")

# 就算不带隐藏属性、也一律不显示的系统垃圾文件（全小写比较）
_HIDDEN_NAMES = {
    "thumbs.db", "ehthumbs.db", "desktop.ini", "iconcache.db",
    "ntuser.dat", "ntuser.ini", "boot.ini", "pagefile.sys", "hiberfil.sys",
    "swapfile.sys", "__macosx", ".ds_store", ".localized", ".spotlight-v100",
    ".trashes", ".fseventsd", ".temporaryitems", ".apdisk",
    "$recycle.bin", "system volume information", "recycler", "found.000",
}


def default_root() -> str:
    return os.path.join(DATA_DIR, "knowledge")


def get_root() -> str:
    """当前知识库根目录（用户可在知识库页面换，重启保留）。"""
    try:
        with open(ROOT_FILE, encoding="utf-8") as f:
            p = json.load(f).get("path")
        if p and os.path.isdir(p):
            return p
    except Exception:
        pass
    return default_root()


def set_root(path: str) -> str:
    """设置知识库根目录；不存在则创建。"""
    path = (path or "").strip()
    if not path:
        raise ValueError("目录不能为空")
    os.makedirs(path, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(ROOT_FILE, "w", encoding="utf-8") as f:
        json.dump({"path": path}, f, ensure_ascii=False)
    return path


def is_hidden(name: str, full: str | None = None) -> bool:
    """这个名字/文件是不是隐藏项（知识库里一律不显示、不检索）。"""
    if not name:
        return True
    if name.startswith("."):
        return True
    if name.lower() in _HIDDEN_NAMES:
        return True
    if full and os.name == "nt":
        try:
            attrs = os.stat(full).st_file_attributes
            # FILE_ATTRIBUTE_HIDDEN = 0x2, FILE_ATTRIBUTE_SYSTEM = 0x4
            if attrs & 0x2 or attrs & 0x4:
                return True
        except Exception:
            pass
    return False


def visible_names(dirpath: str) -> list[str]:
    """列出一个目录下可见（非隐藏）的条目名，已排序。"""
    try:
        names = sorted(os.listdir(dirpath))
    except Exception:
        return []
    return [n for n in names if not is_hidden(n, os.path.join(dirpath, n))]


def visible_dirs(root: str) -> list[str]:
    """知识库下所有可见文件夹（递归，含嵌套），返回相对路径列表，已排序。"""
    out = []
    for entry in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        full = os.path.join(root, entry)
        if not os.path.isdir(full) or is_hidden(entry, full):
            continue
        for dirpath, dirnames, _ in os.walk(full):
            # 原地过滤，os.walk 就不会进隐藏子目录
            dirnames[:] = [d for d in dirnames
                           if not is_hidden(d, os.path.join(dirpath, d))]
            rel = os.path.relpath(dirpath, root).replace("\\", "/")
            out.append(rel)
    out.sort()
    return out


def visible_files(dirpath: str) -> list[str]:
    """目录下可见的文件名（已排序）。"""
    return [n for n in visible_names(dirpath)
            if os.path.isfile(os.path.join(dirpath, n))]
