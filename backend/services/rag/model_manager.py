"""model_manager.py —— RAG 模型统一管理器

职责
----
1. 集中注册 / 加载所有模型（embedding，后续 reranker、LLM 等）
2. 本地缓存优先：models/ 目录已存在完整模型 → 完全离线加载
3. 本地缺失 → 自动从可配置镜像下载到 models/，下次直接离线
4. 镜像、SSL、目录等网络与路径配置集中管理，可被环境变量覆盖

用法
----
    from model_manager import ModelManager, DEFAULT_MODELS

    manager = ModelManager()                 # 自动读环境变量
    for spec in DEFAULT_MODELS.values():
        manager.register(spec)
    model = manager.get("embedding")

命令行（预下载模型，供 CI / 新同事使用）
----
    python model_manager.py --list
    python model_manager.py --download embedding

环境变量（可选）
----
    JIGSAW_HF_MIRROR   镜像地址（默认 https://hf-mirror.com）
    JIGSAW_MODELS_DIR  模型根目录（默认本文件同级 models/）
    HF_ENDPOINT        huggingface 官方端点（优先级低于 JIGSAW_HF_MIRROR）
"""

import os
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional

# ⚠️ 必须在导入任何 huggingface 库之前设置镜像端点
_DEFAULT_MIRROR = "https://hf-mirror.com"
os.environ.setdefault("HF_ENDPOINT", _DEFAULT_MIRROR)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ModelSpec:
    """单个模型的注册信息"""

    name: str       # 逻辑名称，如 "embedding"
    repo_id: str    # HuggingFace 仓库 ID，如 "BAAI/bge-small-zh"
    kind: str       # 加载器类型，当前支持 "sentence_transformer"
    local_dir: str  # 本地缓存目录名（位于 models_root 之下）


# 项目内默认注册表：新增模型只需在这里加一行
DEFAULT_MODELS: Dict[str, ModelSpec] = {
    "embedding": ModelSpec(
        name="embedding",
        repo_id="BAAI/bge-small-zh",
        kind="sentence_transformer",
        local_dir="bge-small-zh",
    ),
}


class ModelManager:
    """模型统一管理器：加载、下载、缓存、镜像配置全部收敛到这里"""

    def __init__(
        self,
        models_root: Optional[Path] = None,
        mirror: Optional[str] = None,
        auto_download: bool = True,
    ) -> None:
        # 模型根目录：显式参数 > 环境变量 > 默认（本文件同级 models/）
        self.models_root = Path(models_root) if models_root else Path(
            os.environ.get("JIGSAW_MODELS_DIR")
            or (Path(__file__).resolve().parent / "models")
        )
        # 镜像：显式参数 > JIGSAW_HF_MIRROR > HF_ENDPOINT > 默认镜像
        self.mirror = (
            mirror
            or os.environ.get("JIGSAW_HF_MIRROR")
            or os.environ.get("HF_ENDPOINT")
            or _DEFAULT_MIRROR
        )
        self.auto_download = auto_download
        self._specs: Dict[str, ModelSpec] = {}
        self._loaded: Dict[str, object] = {}

    # ---------- 对外 API ----------

    def register(self, spec: ModelSpec) -> None:
        """注册一个模型"""
        if spec.name in self._specs:
            raise ValueError(f"模型已注册: {spec.name}")
        self._specs[spec.name] = spec

    def get(self, name: str) -> object:
        """获取模型实例（懒加载 + 进程内缓存，重复调用不重复加载）"""
        if name in self._loaded:
            return self._loaded[name]
        spec = self._require(name)
        model = self._load(spec)
        self._loaded[name] = model
        return model

    def download(self, name: str) -> Path:
        """确保指定模型在本地可用（缓存命中或下载），返回本地路径"""
        spec = self._require(name)
        return self._ensure_local(spec)

    def local_path(self, name: str) -> Path:
        """返回模型本地缓存路径（不触发下载）"""
        spec = self._require(name)
        return self.models_root / spec.local_dir

    # ---------- 内部实现 ----------

    def _require(self, name: str) -> ModelSpec:
        spec = self._specs.get(name)
        if spec is None:
            raise KeyError(f"模型未注册: {name}，可用: {list(self._specs)}")
        return spec

    def _load(self, spec: ModelSpec) -> object:
        local = self._ensure_local(spec)
        logger.info("加载模型 %s <- %s", spec.name, local)
        return self._build_model(spec, local)

    def _ensure_local(self, spec: ModelSpec) -> Path:
        """确保模型在本地可用：命中缓存直接返回，否则按配置下载"""
        local = self.models_root / spec.local_dir
        if self._is_complete(local):
            logger.info("本地缓存命中：%s（%s）", spec.name, local)
            return local
        if not self.auto_download:
            raise FileNotFoundError(
                f"本地模型缺失：{local}\n"
                f"请运行 `python model_manager.py --download {spec.name}` 预下载，"
                f"或手动下载 {spec.repo_id} 放入该目录。"
            )
        self._download(spec, local)
        return local

    @staticmethod
    def _is_complete(local: Path) -> bool:
        """模型目录是否完整：有 config.json 且至少一个权重文件"""
        if not (local / "config.json").exists():
            return False
        if list(local.glob("*.safetensors")) or list(local.glob("*.bin")):
            return True
        return False

    def _download(self, spec: ModelSpec, target: Path) -> None:
        """从镜像下载模型到 target（幂等：已存在则增量校验）"""
        target.mkdir(parents=True, exist_ok=True)
        logger.info("⬇️ 正在从 %s 下载 %s ...", self.mirror, spec.repo_id)
        os.environ["HF_ENDPOINT"] = self.mirror

        # 延迟导入：避免不需要模型时拖慢启动
        from huggingface_hub import snapshot_download

        try:
            snapshot_download(repo_id=spec.repo_id, local_dir=str(target))
            logger.info("✅ %s 下载完成：%s", spec.name, target)
        except Exception as exc:
            # Windows 常见：SSL 证书校验失败 → 降级为关闭校验重试（仅下载阶段）
            if "SSL" in str(exc) or "certificate" in str(exc).lower():
                logger.warning("SSL 证书校验失败，关闭校验重试（仅本次下载）...")
                self._disable_ssl_verify()
                try:
                    snapshot_download(repo_id=spec.repo_id, local_dir=str(target))
                    logger.info("✅ %s 下载完成（关闭 SSL 校验）：%s", spec.name, target)
                    return
                except Exception as exc2:
                    raise RuntimeError(
                        self._download_fail_msg(spec, target, exc2)
                    ) from exc2
            raise RuntimeError(self._download_fail_msg(spec, target, exc)) from exc

    @staticmethod
    def _disable_ssl_verify() -> None:
        os.environ["HF_HUB_DISABLE_SSL_VERIFY"] = "1"
        try:
            from huggingface_hub import constants

            constants.HF_HUB_DISABLE_SSL_VERIFY = True
        except Exception:
            pass

    @staticmethod
    def _download_fail_msg(spec: ModelSpec, target: Path, exc: Exception) -> str:
        return (
            f"模型 {spec.name}（{spec.repo_id}）下载失败：{exc}\n"
            f"手动方案：浏览器打开 https://hf-mirror.com/{spec.repo_id}/tree/main，"
            f"下载全部文件放入 {target}"
        )

    def _build_model(self, spec: ModelSpec, path: Path) -> object:
        if spec.kind == "sentence_transformer":
            from sentence_transformers import SentenceTransformer

            return SentenceTransformer(str(path))
        raise ValueError(f"不支持的模型类型: {spec.kind}")


# 便捷入口：直接拿一个已注册好默认模型的 manager
_default_manager: Optional[ModelManager] = None


def default_manager() -> ModelManager:
    """返回全局默认 manager（注册了 DEFAULT_MODELS 全部模型）"""
    global _default_manager
    if _default_manager is None:
        _default_manager = ModelManager()
        for spec in DEFAULT_MODELS.values():
            _default_manager.register(spec)
    return _default_manager


if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    parser = argparse.ArgumentParser(description="RAG 模型预下载 / 查看工具")
    parser.add_argument("--list", action="store_true", help="列出已注册模型及本地状态")
    parser.add_argument(
        "--download",
        nargs="+",
        choices=list(DEFAULT_MODELS),
        help="预下载指定模型到本地缓存",
    )
    args = parser.parse_args()

    manager = default_manager()

    if args.list:
        print("已注册模型：")
        for name, spec in DEFAULT_MODELS.items():
            local = manager.local_path(name)
            status = "✅ 本地就绪" if manager._is_complete(local) else "⬜ 未下载"
            print(f"  - {name:<12} {spec.repo_id:<24} {status}  {local}")
    if args.download:
        for name in args.download:
            manager.download(name)
