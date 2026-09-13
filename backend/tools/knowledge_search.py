"""搜索知识库的知识

原理（和 websearch 一个套路，只是数据源换成你的本地知识库）：
  LLM 判断用户问题跟知识库有关 → 调用本工具（传 query）→ 扫描知识库文件
  → 找出包含关键词的原文片段 → 返回给 LLM → LLM 基于片段回答。
"""
import json
import os

from .extract import extract_text

SCHEMA = {
    "type": "function",
    "function": {
        "name": "knowledge_search",
        "description": (
            "在用户的知识库中搜索相关资料。"
            "用户的问题涉及知识库内容（个人笔记、项目文档、收集的资料等）时使用，"
            "返回文件名和原文片段。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "搜索的关键词或问题",
                },
            },
            "required": ["query"],
        }
    }
}


def _root() -> str:
    """拿到知识库根目录。

    知识库的根目录是用户可换的（设置里点「目录」按钮），
    换完会写进 backend/data/knowledge_root.json：
        {"path": "E:\\my_repo\\Figsaw\\backend\\data\\knowledge"}
    这里读的就是同一个配置，保证和知识库页面看到的是同一个地方。
    读不到或路径失效时，退回默认目录 backend/data/knowledge/。
    """
    DATA_DIR = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"
    )
    try:
        with open(os.path.join(DATA_DIR, "knowledge_root.json"), encoding="utf-8") as f:
            p = json.load(f).get("path")
        if p and os.path.isdir(p):
            return p
    except Exception:
        pass
    return os.path.join(DATA_DIR, "knowledge")


def run(args: dict) -> str:
    """执行函数。args 是 LLM 填好的参数，比如 {"query": "签证"}。

    注意：返回值必须是字符串 —— execute() 会把这个字符串原样回给 LLM。
    """
    # 1. 取出 LLM 传来的关键词
    query = (args.get("query") or "").strip()
    if not query:
        return "请提供要搜索的关键词或问题"

    # 2. 拿到知识库根目录，不存在就直接告诉 LLM
    root = _root()
    if not os.path.isdir(root):
        return "知识库目录不存在"

    # 3. 遍历知识库下所有文件（os.walk 会进子文件夹）
    hits = []
    for dirpath, _, files in os.walk(root):
        for fn in sorted(files):
            p = os.path.join(dirpath, fn)
            #复用 extract.py —— md/txt/docx/pdf/xlsx/pptx 全能提成文本
            text = extract_text(p)
            if not text:
                continue  # 图片等提不出文本的，跳过

            # 4. 逐行找包含关键词的行，带上下一行做上下文
            lines = text.splitlines()
            for i, ln in enumerate(lines):
                if query in ln:
                    rel = os.path.relpath(p, root)          # 相对知识库根的文件名
                    ctx = " / ".join(l.strip() for l in lines[max(0, i - 1):i + 2])
                    hits.append(f"[{rel}] ...{ctx}...")

    # 5. 返回搜索结果
    if not hits:
        return f"知识库中没有找到包含「{query}」的内容"
    return f"找到 {len(hits)} 处：\n" + "\n".join(hits)
