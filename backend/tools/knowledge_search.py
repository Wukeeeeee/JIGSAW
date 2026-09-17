"""搜索知识库的知识

原理（和 websearch 一个套路，只是数据源换成你的本地知识库）：
  LLM 判断用户问题跟知识库有关 → 调用本工具（传 query）→ 扫描知识库文件
  → 找出包含关键词的原文片段 → 返回给 LLM → LLM 基于片段回答。
"""
import os
import re

from services import kb_fs
from .extract import extract_text

SCHEMA = {
    "type": "function",
    "function": {
        "name": "knowledge_search",
        "description": (
            "在用户的知识库中搜索相关资料。"
            "用户的问题涉及知识库内容（个人笔记、项目文档、收集的资料等）时使用，"
            "返回文件名和原文片段（支持 md/txt/docx/pdf/xlsx/pptx）。"
            "注意：用户问的是「知识库在哪 / 路径 / 有哪些分类」时用 knowledge_info，不要用本工具。"
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
        {"path": "E:\\my_repo\\Jigsaw\\backend\\data\\knowledge"}
    这里读的就是同一个配置，保证和知识库页面看到的是同一个地方。
    读不到或路径失效时，退回默认目录 backend/data/knowledge/。
    """
    return kb_fs.get_root()


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

    # 2.5 RAG 检索优先：关键词 + 向量 + RRF 融合（services/rag/kb_rag.py）
    #     能命中就返回最相关片段；RAG 不可用（缺依赖/模型加载失败）时自动退回关键词扫描。
    try:
        from services.rag.kb_rag import knowledge_rag
        rag_result = knowledge_rag.search(query, top_k=5)
        if rag_result:
            n = len(rag_result.splitlines())
            return f"找到 {n} 处最相关片段：\n{rag_result}"
    except Exception:
        pass  # 退回下面的关键词扫描

    # 3. 关键词切分 + 归一：中英混排、整句提问也能命中
    #    "东京签证怎么办" → 先整句试，再拆成 2 字以上的词逐个试；
    #    英文统一转小写，避免 "DeepSeek"/"deepseek" 大小写不同就搜不到。
    keys = [query.lower()]
    for part in re.split(r"[\s,，。、;；/|]+", query):
        part = part.strip().lower()
        if len(part) >= 2 and part not in keys:
            keys.append(part)
    if len(query) >= 4:                       # 中文整句 → 再切 2 字词，提高命中率
        for i in range(0, len(query) - 1):
            part = query[i:i + 2].lower()
            if part not in keys:
                keys.append(part)

    # 4. 遍历知识库下所有文件（os.walk 会进子文件夹）
    #    隐藏项（.DS_Store / Thumbs.db / .git / 带隐藏属性的文件）全部跳过，
    #    隐藏文件夹内部也不会进去 —— 判定逻辑与知识库页面共用 services/kb_fs.py。
    hits, files_scanned = [], 0
    for dirpath, dirnames, files in os.walk(root):
        dirnames[:] = [d for d in dirnames
                       if not kb_fs.is_hidden(d, os.path.join(dirpath, d))]
        for fn in sorted(files):
            if kb_fs.is_hidden(fn, os.path.join(dirpath, fn)):
                continue
            p = os.path.join(dirpath, fn)
            #复用 extract.py —— md/txt/docx/pdf/xlsx/pptx 全能提成文本
            try:
                text = extract_text(p)
            except Exception:
                text = ""
            if not text:
                continue  # 图片等提不出文本的，跳过
            files_scanned += 1

            # 5. 逐行找包含关键词的行，带上下一行做上下文
            lines = text.splitlines()
            per_file = 0
            for i, ln in enumerate(lines):
                low = ln.lower()
                if not any(k in low for k in keys):
                    continue
                rel = os.path.relpath(p, root).replace("\\", "/")   # 相对知识库根的路径
                ctx = " / ".join(l.strip() for l in lines[max(0, i - 1):i + 2])
                hits.append(f"[{rel}] ...{ctx}...")
                per_file += 1
                if per_file >= 8:             # 单篇最多 8 条，别让一篇刷屏
                    break
            if len(hits) >= 40:               # 全局上限，防止上下文爆炸
                break
        if len(hits) >= 40:
            break

    # 6. 返回搜索结果
    if not hits:
        return (f"知识库中没有找到与「{query}」相关的内容"
                f"（已扫描 {files_scanned} 个可解析文件）。"
                f"想看知识库里到底有哪些资料，可调用 knowledge_info。")
    return f"找到 {len(hits)} 处：\n" + "\n".join(hits)
