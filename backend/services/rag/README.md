# RAG 服务

基于本地 embedding 的检索增强生成（RAG）模块。

## 模块

| 文件 | 作用 |
|---|---|
| `chunker.py` | 长文本切分成有边界的检索单元 |
| `embedding.py` | chunk 向量化（基于 bge-small-zh） |
| `model_manager.py` | 模型统一管理：本地缓存优先 + 自动下载 + 可配置镜像 |

## 首次运行（自动下载模型，约 47MB）

```bash
python backend/services/rag/model_manager.py --download embedding
```

下载源默认 `https://hf-mirror.com`，可用环境变量覆盖：

- `JIGSAW_HF_MIRROR`：镜像地址（优先级最高）
- `JIGSAW_MODELS_DIR`：模型存放目录（默认 `backend/services/rag/models/`）

查看模型本地状态：

```bash
python backend/services/rag/model_manager.py --list
```

## 离线部署

把 `models/bge-small-zh` 整个目录复制到目标机器即可，之后**完全离线运行**，不再访问网络。

## 环境要求

```bash
pip install sentence-transformers huggingface_hub numpy
```
