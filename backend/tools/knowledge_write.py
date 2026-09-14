"""写入知识库：把内容真正加进用户的知识库文件

为什么需要：以前 AI 只有 knowledge_search / knowledge_info，
只能"查"，用户说"把这段加到知识库里"时它无从下手 —— 要么假装做了，
要么只能搜一下敷衍。这个工具让 AI 真的能往知识库里写东西。

安全：
- 所有路径都限制在当前知识库根目录内（禁 ../、禁绝对路径、禁盘符）
- mode=create 遇到同名文件不覆盖，直接报冲突，让 AI 改用 append / overwrite
- 只能写文本（utf-8），不处理二进制
"""
import os

from services import kb_fs

SCHEMA = {
    "type": "function",
    "function": {
        "name": "knowledge_write",
        "description": (
            "把内容写入用户的知识库（新建文档 / 追加 / 覆盖）。"
            "【必须调用的场景】用户说「把这个加到知识库」「记到知识库里」「存一份到知识库」"
            "「把这几条保存下来」「写进 XX 分类」时，必须调用本工具真正写入，"
            "不能只用 knowledge_search 搜一下就回复「已添加」。"
            "写入前不需要先搜索；想确认放哪个分类可先调 knowledge_info 看现有结构。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "文件名，建议带扩展名，如「东京攻略.md」。可带子目录：「旅行/东京攻略.md」",
                },
                "content": {
                    "type": "string",
                    "description": "要写入的正文内容（文本）",
                },
                "folder": {
                    "type": "string",
                    "description": "目标分类（文件夹）名，留空 = 知识库根目录。分类不存在会自动创建。",
                },
                "mode": {
                    "type": "string",
                    "enum": ["create", "append", "overwrite"],
                    "description": (
                        "create=新建（重名则报错，默认）；"
                        "append=追加到已有文档末尾；"
                        "overwrite=覆盖已有文档（会丢失原内容，慎用）"
                    ),
                },
            },
            "required": ["name", "content"],
        }
    }
}

DATA_DIR = kb_fs.DATA_DIR
ROOT_FILE = kb_fs.ROOT_FILE


def _root() -> str:
    """当前知识库根目录（和知识库页面、knowledge_search / knowledge_info 同一份配置）。"""
    return kb_fs.get_root()


def _safe_target(root: str, folder: str, name: str) -> str:
    """把 folder/name 解析成知识库内的绝对路径；越界一律拒绝。"""
    rel = "/".join(x for x in (folder.strip().strip("/"), name.strip().strip("/")) if x)
    if not rel:
        raise ValueError("文件名不能为空")
    # 拒绝绝对路径 / 盘符 / 向上穿越
    if os.path.isabs(rel) or rel.startswith(("/", "\\")) or (len(rel) > 1 and rel[1] == ":"):
        raise ValueError("文件名必须是相对路径")
    parts = [p for p in rel.replace("\\", "/").split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise ValueError("文件名不允许包含 .. ")
    # 隐藏项（.xx / Thumbs.db…）在知识库里是"看不见"的，也不允许写入，
    # 否则会出现"AI 说写了、用户在页面上找不到"的情况。
    for seg in parts:
        if kb_fs.is_hidden(seg):
            raise ValueError(f"不允许写入隐藏文件/目录：{seg}")
    full = os.path.realpath(os.path.join(os.path.realpath(root), *parts))
    root_real = os.path.realpath(root)
    if not (full == root_real or full.startswith(root_real + os.sep)):
        raise ValueError("不允许写到知识库目录之外")
    return full


def run(args: dict) -> str:
    name = (args.get("name") or "").strip()
    content = args.get("content")
    folder = (args.get("folder") or "").strip()
    mode = (args.get("mode") or "create").strip().lower() or "create"

    if not name:
        return "缺少文件名（name）"
    if content is None:
        return "缺少要写入的内容（content）"
    if mode not in ("create", "append", "overwrite"):
        return f"mode 只能是 create / append / overwrite，收到：{mode}"

    root = _root()
    if not os.path.isdir(root):
        return f"知识库目录不存在：{root}（可在知识库页面点「目录」重新选择）"

    try:
        path = _safe_target(root, folder, name)
    except ValueError as e:
        return f"写入失败：{e}"

    exists = os.path.isfile(path)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if mode == "append":
            old = ""
            if exists:
                with open(path, "r", encoding="utf-8") as f:
                    old = f.read()
            sep = "" if (not old or old.endswith("\n")) else "\n"
            with open(path, "w", encoding="utf-8") as f:
                f.write(old + sep + content)
            action = "已追加到已有文档" if exists else "已新建文档并写入"
        elif mode == "overwrite":
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            action = "已覆盖已有文档" if exists else "已新建文档并写入"
        else:  # create
            if exists:
                return (f"写入失败：文档已存在「{name}」。"
                        f"要追加请用 mode=append，要整篇替换请用 mode=overwrite。")
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            action = "已新建文档"
    except Exception as e:
        return f"写入失败：{type(e).__name__}: {e}"

    size = os.path.getsize(path)
    rel = os.path.relpath(path, root).replace("\\", "/")
    return (f"{action}：{rel}\n"
            f"完整路径：{os.path.abspath(path)}\n"
            f"写入 {len(content)} 字（文件现有 {size} 字节）")
