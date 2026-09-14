"""知识库路由：本地文件系统 CRUD（backend/data/knowledge/，目录可换）

结构：知识库根 下 文件夹=分类，文件夹内 文件 = 知识点（.md/.txt 可编辑，其余文件可存取不可预览）。
纯本地存储，不接数据库；将来接 RAG 只加"向量索引"一步，结构不用动。

安全：所有路径都做规范化校验，禁止 ../ 穿越到知识库根之外。

隐藏文件（.DS_Store、Thumbs.db、.git、带隐藏/系统属性的条目等）
一律不出现在目录树里，也不能被读取/上传/新建 —— 判定逻辑统一在 services/kb_fs.py，
和 AI 侧工具（knowledge_info / knowledge_search）用的是同一份，保证两边一致。
"""
import os
import queue
import shutil
import threading
from datetime import datetime, timezone

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from services import kb_fs

router = APIRouter()

DATA_DIR = kb_fs.DATA_DIR
ROOT_FILE = kb_fs.ROOT_FILE


def get_root() -> str:
    """当前知识库根目录（用户可换目录，重启保留）。"""
    return kb_fs.get_root()


def set_root(path: str) -> str:
    """设置知识库根目录；不存在则创建。"""
    path = (path or "").strip()
    if not path:
        raise HTTPException(400, "目录不能为空")
    try:
        return kb_fs.set_root(path)
    except ValueError as e:
        raise HTTPException(400, str(e))


# ============ 路径安全 ============
def _safe_join(*parts: str) -> str:
    """把路径拼到当前根目录下；任何 '..' / 绝对路径尝试都拒绝。"""
    root = os.path.realpath(get_root())
    full = os.path.realpath(os.path.join(root, *parts))
    if not full.startswith(root + os.sep) and full != root:
        raise HTTPException(400, "非法路径：不允许访问知识库目录之外")
    return full


def _folder_path(name: str) -> str:
    """文件夹路径；name 为空 = 根目录（不存在的文件夹报错）。"""
    if not name:
        return get_root()
    p = _safe_join(name)
    if not os.path.isdir(p):
        raise HTTPException(404, f"文件夹不存在：{name}")
    return p


def _reject_hidden(*parts: str) -> None:
    """分类名 / 文档名只要有一段是隐藏名（.xx、Thumbs.db…），一律拒绝。

    前端已经不展示隐藏项，这里再挡一道，避免"看不见但能被写入/读到"的缝隙。
    """
    for part in parts:
        for seg in str(part or "").replace("\\", "/").split("/"):
            if seg and kb_fs.is_hidden(seg):
                raise HTTPException(400, f"名字不合法（不允许隐藏文件/目录）：{part}")


def _doc_path(folder: str, name: str) -> str:
    if not name:
        raise HTTPException(400, "文档名不能为空")
    if "/" in name or "\\" in name or name in (".", ".."):
        raise HTTPException(400, "文档名不合法")
    _reject_hidden(name)
    return _safe_join(folder, name)


def _meta(path: str) -> dict:
    st = os.stat(path)
    return {
        "name": os.path.basename(path),
        "size": st.st_size,
        "updatedAt": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
    }


# ============ 查询 ============
@router.get("/knowledge/tree")
def kb_tree():
    """返回完整目录树：{ folders: [{name, docs: [...]}], rootDocs: [...] }

    子目录也一并列出（扁平化）：嵌套分类 "旅行/日本" 会作为一条记录返回，
    name 就是它的相对路径 "旅行/日本"，重命名/删除/建文档都拿这个 name 当标识。
    否则在嵌套分类里建的文档会从界面上"消失"。
    """
    root = get_root()
    folders, root_docs = [], []
    if not os.path.isdir(root):
        return {"folders": folders, "rootDocs": root_docs}

    for name in kb_fs.visible_dirs(root):
        dirpath = os.path.join(root, *name.split("/"))
        docs = [_meta(os.path.join(dirpath, f)) for f in kb_fs.visible_files(dirpath)]
        folders.append({"name": name, "docs": docs})
    for f in kb_fs.visible_files(root):
        root_docs.append(_meta(os.path.join(root, f)))
    return {"folders": folders, "rootDocs": root_docs}


@router.get("/knowledge/doc")
def kb_read_doc(folder: str = "", name: str = ""):
    """读文档内容。folder 为空 = 根目录下的文档。
    二进制文件（Word/PPT/PDF…）返回 editable=false，前端显示"无法预览"。"""
    p = _doc_path(folder, name)
    if not os.path.isfile(p):
        raise HTTPException(404, f"文档不存在：{folder}/{name}")
    try:
        with open(p, "r", encoding="utf-8") as f:
            content = f.read()
        return {"folder": folder, "name": name, "content": content, "editable": True}
    except UnicodeDecodeError:
        return {"folder": folder, "name": name, "content": "", "editable": False,
                "error": "二进制文件（Word/PPT/PDF 等）暂不支持预览，可保留、重命名或删除"}


# ============ 知识库根目录 ============
class RootIn(BaseModel):
    path: str = ""


def _ask_directory(initial: str) -> str | None:
    """弹系统目录选择框（桌面端）。askdirectory 必须在其 Tk 实例自己的线程里跑。"""
    q = queue.Queue()

    def _run():
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            path = filedialog.askdirectory(initialdir=initial or None, title="选择知识库存放目录")
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


@router.get("/knowledge/root")
def kb_get_root():
    """当前知识库存放目录。"""
    return {"path": get_root()}


@router.post("/knowledge/root/pick")
def kb_pick_root():
    """弹系统目录选择框，选择知识库存放目录。"""
    try:
        path = _ask_directory(get_root())
        if not path:
            return {"ok": False, "cancelled": True}
        set_root(path)
        return {"ok": True, "path": path}
    except Exception as e:
        return {"ok": False, "error": f"无法弹出目录选择框：{type(e).__name__}: {e}"}


@router.post("/knowledge/root")
def kb_set_root(payload: RootIn):
    """手动设置知识库存放目录（不弹框）。"""
    path = (payload.path or "").strip()
    if not path:
        raise HTTPException(400, "目录不能为空")
    set_root(path)
    return {"ok": True, "path": path}


# ============ 上传（拖拽导入） ============
@router.post("/knowledge/upload")
async def kb_upload(folder: str = "", file: UploadFile = File(...)):
    """把文件（Word/PPT/PDF/图片…）存进知识库。folder 为空 = 根目录。
    重名自动追加序号（xx (1).docx），不覆盖。"""
    name = os.path.basename(file.filename or "")
    if not name:
        raise HTTPException(400, "文件名不能为空")
    p = _doc_path(folder, name)
    if os.path.exists(p):
        base, ext = os.path.splitext(name)
        i = 1
        while os.path.exists(os.path.join(os.path.dirname(p), f"{base} ({i}){ext}")):
            i += 1
        p = os.path.join(os.path.dirname(p), f"{base} ({i}){ext}")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
    return {"ok": True, "folder": folder, "name": os.path.basename(p)}


# ============ 文件夹操作 ============
class FolderIn(BaseModel):
    name: str = ""
    newName: str = ""


@router.post("/knowledge/folder")
def kb_create_folder(payload: FolderIn):
    """新建文件夹（分类）。name 带 / 支持嵌套，如 "旅行/日本"。"""
    name = (payload.name or "").strip().strip("/")
    if not name:
        raise HTTPException(400, "文件夹名不能为空")
    _reject_hidden(name)
    p = _safe_join(name)
    if os.path.exists(p):
        raise HTTPException(400, f"文件夹已存在：{name}")
    os.makedirs(p)
    return {"ok": True, "name": name}


@router.put("/knowledge/folder")
def kb_rename_folder(payload: FolderIn):
    """重命名文件夹。"""
    old, new = (payload.name or "").strip(), (payload.newName or "").strip()
    if not old or not new:
        raise HTTPException(400, "旧名与新名都不能为空")
    _reject_hidden(new)
    old_p = _folder_path(old)
    new_p = _safe_join(new)
    if os.path.exists(new_p):
        raise HTTPException(400, f"目标文件夹已存在：{new}")
    os.makedirs(os.path.dirname(new_p), exist_ok=True)   # 新名字带层级时先建父目录
    try:
        os.rename(old_p, new_p)
    except Exception as e:
        raise HTTPException(500, f"重命名失败：{type(e).__name__}: {e}")
    return {"ok": True, "name": new}


@router.delete("/knowledge/folder")
def kb_delete_folder(folder: str = ""):
    """删除文件夹（整个分类，含内部全部文档）。

    Windows 上文件被占用（比如在 Word 里开着）会 PermissionError：
    先尝试改权限再删一次；仍失败就返回明确原因，前端据此提示用户。
    """
    if not folder:
        raise HTTPException(400, "不能删除知识库根目录")
    p = _folder_path(folder)

    def _onerror(func, path, exc):
        try:
            os.chmod(os.path.dirname(path), 0o777)
            os.chmod(path, 0o777)
            func(path)
        except Exception:
            pass

    try:
        shutil.rmtree(p, onerror=_onerror)
    except Exception as e:
        raise HTTPException(500, f"删除失败：{type(e).__name__}: {e}（文件可能被其他程序占用）")
    return {"ok": True, "name": folder}


# ============ 文档操作 ============
class DocIn(BaseModel):
    folder: str = ""
    name: str = ""
    newName: str = ""
    content: str = ""


@router.post("/knowledge/doc")
def kb_create_doc(payload: DocIn):
    """新建文档。folder 为空 = 根目录。"""
    p = _doc_path(payload.folder, payload.name)
    if os.path.exists(p):
        raise HTTPException(400, f"文档已存在：{payload.folder}/{payload.name}")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(payload.content or "")
    return {"ok": True, "folder": payload.folder, "name": payload.name}


@router.put("/knowledge/doc")
def kb_save_doc(payload: DocIn):
    """保存（覆盖写入）文档内容。"""
    p = _doc_path(payload.folder, payload.name)
    if not os.path.isfile(p):
        raise HTTPException(404, f"文档不存在：{payload.folder}/{payload.name}")
    with open(p, "w", encoding="utf-8") as f:
        f.write(payload.content or "")
    return {"ok": True, "folder": payload.folder, "name": payload.name}


@router.put("/knowledge/doc/rename")
def kb_rename_doc(payload: DocIn):
    """重命名文档。"""
    old, new = (payload.name or "").strip(), (payload.newName or "").strip()
    if not old or not new:
        raise HTTPException(400, "旧名与新名都不能为空")
    old_p = _doc_path(payload.folder, old)
    new_p = _doc_path(payload.folder, new)
    if not os.path.isfile(old_p):
        raise HTTPException(404, f"文档不存在：{payload.folder}/{old}")
    if os.path.exists(new_p):
        raise HTTPException(400, f"目标文档已存在：{new}")
    os.rename(old_p, new_p)
    return {"ok": True, "folder": payload.folder, "name": new}


@router.delete("/knowledge/doc")
def kb_delete_doc(folder: str = "", name: str = ""):
    """删除文档。"""
    p = _doc_path(folder, name)
    if not os.path.isfile(p):
        raise HTTPException(404, f"文档不存在：{folder}/{name}")
    try:
        os.remove(p)
    except Exception as e:
        raise HTTPException(500, f"删除失败：{type(e).__name__}: {e}（文件可能被其他程序占用）")
    return {"ok": True, "folder": folder, "name": name}
