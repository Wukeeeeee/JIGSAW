"""知识库信息：告诉用户"我的知识库在哪 / 里面有什么"

为什么需要单独一个工具：
  用户问"我的知识库在哪""资料存在哪个文件夹""知识库里有什么"时，
  AI 本身不知道本机路径（而且用户可以在知识库页面换目录），凭印象回答必错。
  这个工具直接读当前配置 → 返回真实绝对路径与目录结构，AI 照着念即可。
"""
import json
import os

from services import kb_fs

SCHEMA = {
    "type": "function",
    "function": {
        "name": "knowledge_info",
        "description": (
            "查询知识库的存放位置与结构：返回知识库根目录的绝对路径、有哪些分类（文件夹）、"
            "每个分类下有哪些文档、根目录直接放了几篇文档、一共有多少篇。"
            "【必须调用的场景】用户问「我的知识库在哪 / 知识库在哪个文件夹 / 资料存在哪里 / "
            "知识库路径 / 知识库里有什么 / 有哪些分类」时，一律先调用本工具拿到真实路径再回答，"
            "严禁凭记忆或猜测编造路径。"
            "想知道某篇文档的具体内容时，用 knowledge_search 或 read_extra。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "listDocs": {
                    "type": "boolean",
                    "description": "是否列出每个分类下的文档名（默认 true）。只问路径时可传 false。",
                },
            },
            "required": [],
        }
    }
}

DATA_DIR = kb_fs.DATA_DIR
ROOT_FILE = kb_fs.ROOT_FILE


def _root() -> str:
    """当前知识库根目录（与知识库页面、knowledge_search 用的是同一份配置）。"""
    return kb_fs.get_root()


def run(args: dict) -> str:
    list_docs = args.get("listDocs")
    if list_docs is None:
        list_docs = True

    root = _root()
    exists = os.path.isdir(root)
    configured = False
    try:
        with open(ROOT_FILE, encoding="utf-8") as f:
            configured = bool(json.load(f).get("path"))
    except Exception:
        pass

    lines = [
        f"知识库根目录（绝对路径）：{root}",
        f"状态：{'存在' if exists else '不存在（还没建，或目录被移动/删除了）'}",
        f"来源：{'用户自定义（知识库页面「目录」按钮设置的）' if configured else '默认目录 backend/data/knowledge'}",
    ]
    if not exists:
        lines.append("提示：用户可在 知识库页面 → 右上「目录」按钮重新选择存放位置。")
        return "\n".join(lines)

    folders, root_docs, total = [], [], 0
    for name in kb_fs.visible_dirs(root):
        dirpath = os.path.join(root, *name.split("/"))
        docs = kb_fs.visible_files(dirpath)
        folders.append((name, docs))
        total += len(docs)
    root_docs = kb_fs.visible_files(root)
    total += len(root_docs)

    lines.append(f"文档总数：{total} 篇（分类内 {total - len(root_docs)} 篇 + 根目录 {len(root_docs)} 篇）")
    lines.append(f"分类数：{len(folders)} 个")

    if folders:
        lines.append("")
        lines.append("分类：")
        for name, docs in folders:
            lines.append(f"  · {name} —— {len(docs)} 篇" + ("" if list_docs else ""))
            if list_docs and docs:
                lines.append("      " + "、".join(docs[:30]) + ("…" if len(docs) > 30 else ""))
    else:
        lines.append("")
        lines.append("分类：暂无（用户可在知识库页面点左上「+」新建分类）")

    if root_docs:
        lines.append("")
        lines.append("根目录文档：" + "、".join(root_docs[:30]) + ("…" if len(root_docs) > 30 else ""))

    lines.append("")
    lines.append("更换位置：知识库页面 → 右上「目录」按钮；配置保存在 backend/data/knowledge_root.json。")
    return "\n".join(lines)
