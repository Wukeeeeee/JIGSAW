"""kb_rag.py —— 知识库 RAG 索引服务

把 chunker / embedding / vector_store / retriever 接进项目：
1. 扫描知识库全部可解析文件（复用 kb_fs.is_hidden + tools.extract.extract_text）
2. 文本分块 + 向量化，构建内存索引（懒加载，进程内缓存，首次搜索才建）
3. 检索 = 关键词 + 向量 + RRF 融合（retriever.retrieve）
4. 检测知识库变更（文件 mtime/size），有变化自动重建索引
"""

import logging
import os
import time
from typing import Dict, List, Optional, Tuple

from services import kb_fs
from tools.extract import extract_text

from services.rag.chunker import chunk_text
from services.rag.embedding import TextEmbedding
from services.rag.vector_store import VectorStore
from services.rag.retriever import Retriever

logger = logging.getLogger(__name__)


class KnowledgeRAG:
    """知识库检索服务：索引构建（懒加载 + 变更自动重建）+ RAG 融合检索。"""

    def __init__(self, max_len: int = 500, overlap: int = 60, top_k: int = 5):
        self.max_len = max_len
        self.overlap = overlap
        self.top_k = top_k
        self._emb: Optional[TextEmbedding] = None
        self._vs: Optional[VectorStore] = None
        self._ret: Optional[Retriever] = None
        self._root: Optional[str] = None
        self._signature: Dict[str, Tuple[int, int]] = {}
        self._src: List[Tuple[str, str]] = []   # (chunk文本, 相对路径) 一一对应
        self.last_error: str = ""

    # ---------- 索引构建 ----------

    def _ensure_models(self):
        """懒加载 embedding 模型 + 向量库 + 检索器（模型只加载一次）。"""
        if self._ret is None:
            self._emb = TextEmbedding()
            self._vs = VectorStore()
            self._ret = Retriever(self._vs, self._emb)
        return self._emb, self._vs, self._ret

    @staticmethod
    def _scan_signature(root: str) -> Dict[str, Tuple[int, int]]:
        """知识库当前"指纹"：每个可见文件的 (mtime_ns, size)，用于判断是否要重建。"""
        sig: Dict[str, Tuple[int, int]] = {}
        for dirpath, dirnames, files in os.walk(root):
            dirnames[:] = [d for d in dirnames
                           if not kb_fs.is_hidden(d, os.path.join(dirpath, d))]
            for fn in sorted(files):
                p = os.path.join(dirpath, fn)
                if kb_fs.is_hidden(fn, p):
                    continue
                try:
                    st = os.stat(p)
                    rel = os.path.relpath(p, root).replace("\\", "/")
                    sig[rel] = (st.st_mtime_ns, st.st_size)
                except OSError:
                    continue
        return sig

    def _needs_rebuild(self, root: str) -> bool:
        """根目录换了，或任一文件有增删改 → 需要重建。"""
        return self._root != root or self._signature != self._scan_signature(root)

    def _rebuild(self, root: str) -> None:
        """全量重建索引：扫描 → 分块 → 向量化 → 存入 vector_store。"""
        t0 = time.time()
        emb, _vs, _ret = self._ensure_models()
        # 换新实例，等价于清空旧索引
        self._vs = VectorStore()
        self._ret = Retriever(self._vs, emb)
        self._src = []

        file_count = 0
        for dirpath, dirnames, files in os.walk(root):
            dirnames[:] = [d for d in dirnames
                           if not kb_fs.is_hidden(d, os.path.join(dirpath, d))]
            for fn in sorted(files):
                p = os.path.join(dirpath, fn)
                if kb_fs.is_hidden(fn, p):
                    continue
                try:
                    text = extract_text(p)
                except Exception:
                    text = ""
                if not text:
                    continue
                file_count += 1
                rel = os.path.relpath(p, root).replace("\\", "/")
                for chunk in chunk_text(text, self.max_len, self.overlap):
                    self._src.append((chunk, rel))

        # 分批向量化，避免一次吃太多内存
        all_chunks = [c for c, _ in self._src]
        for i in range(0, len(all_chunks), 32):
            batch = all_chunks[i:i + 32]
            self._vs.add(batch, emb.encode_batch(batch))

        self._root = root
        self._signature = self._scan_signature(root)
        logger.info(
            "知识库 RAG 索引构建完成：%d 个文件 → %d 个 chunk，耗时 %.1fs",
            file_count, len(all_chunks), time.time() - t0,
        )

    # ---------- 对外检索 ----------

    def search(self, query: str, top_k: Optional[int] = None) -> str:
        """检索知识库，返回带文件来源的片段文本（每行 [相对路径] ...片段...）。

        返回空串表示：知识库目录不存在 / 无可索引内容 / 检索异常（调用方自行 fallback）。
        """
        root = kb_fs.get_root()
        if not os.path.isdir(root):
            return ""
        try:
            if self._needs_rebuild(root):
                logger.info("检测到知识库变更或首次使用，正在重建索引…")
                self._rebuild(root)
            _emb, vs, ret = self._ensure_models()
            if not vs.chunks:
                return ""
            k = top_k or self.top_k
            result = ret.retrieve(query, vs.chunks, top_k=10, final_top_k=k)
            lines = []
            for chunk, _score in result:
                rel = next((r for c, r in self._src if c == chunk), "?")
                lines.append(f"[{rel}] ...{chunk.strip()}...")
            logger.info("RAG 检索 query=%r → 命中 %d 处", query, len(lines))
            return "\n".join(lines)
        except Exception as exc:
            self.last_error = f"{type(exc).__name__}: {exc}"
            logger.warning("RAG 检索不可用（退回关键词扫描）：%s", self.last_error)
            return ""


# 进程级单例：后端进程内复用索引，不用每次搜索都重新扫描/向量化
knowledge_rag = KnowledgeRAG()
