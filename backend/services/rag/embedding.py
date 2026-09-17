"""embedding 模块：chunk 向量化

使用 ModelManager 统一管理模型加载：
- 本地 models/bge-small-zh 存在 → 完全离线加载
- 不存在 → 自动从可配置镜像下载并缓存（只下载一次）
"""

from typing import List, Optional

# 兼容两种运行方式：
# - 作为包被后端导入（from services.rag.embedding import ...）→ 相对导入
# - 直接在 rag 目录下运行脚本（python embedding.py / python main.py）→ 绝对导入
try:
    from .model_manager import ModelManager, default_manager
except ImportError:
    from model_manager import ModelManager, default_manager


class TextEmbedding:
    """文本向量化工具（基于 bge-small-zh 中文 embedding 模型）"""
    def __init__(self, manager: Optional[ModelManager] = None):
        manager = manager or default_manager()
        self.model = manager.get("embedding")

    def encode_single(self, text: str) -> List[float]:
        """对单个文本进行 embedding（用于用户 query）"""
        vec = self.model.encode(text, normalize_embeddings=True)
        return vec.tolist()

    def encode_batch(self, texts: List[str]) -> List[List[float]]:
        """批量对多个 chunk 进行 embedding（用于文档入库，批量更快）"""
        vecs = self.model.encode(texts, normalize_embeddings=True)
        return vecs.tolist()


if __name__ == "__main__":
    te = TextEmbedding()
    test_chunk = (
        "你说得对，但是《原神》是由米哈游自主研发的一款全新开放世界冒险游戏。"
        "游戏发生在一个被称作「提瓦特」的幻想世界，在这里，被神选中的人将被授予「神之眼」，导引元素之力。"
    )
    vec1 = te.encode_single("你好")
    print("单个向量维度：", len(vec1))
    print("单个向量前10位：", vec1[:10])

    vecs = te.encode_batch([test_chunk])
    print("批量向量数量：", len(vecs))
    print("批量向量第一条前10位：", vecs[0][:10])
