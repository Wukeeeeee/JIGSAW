"""
JIGSAW — 内存数据存储（Mock）
==========================
所有接口当前读写此内存 store。替换为数据库 / 真实运行时后，
保持 services 层的函数签名不变即可。
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List

# 文件写锁：异步任务 worker 与请求线程可能同时写 conversations.json，
# 用同一把锁串行化写盘，避免文件损坏。
_file_lock = threading.Lock()

#用户自定义的模型
DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
MODELS_FILE = os.path.join(DATA_DIR, "models.json")
CONVERSATIONS_FILE = os.path.join(DATA_DIR, "conversations.json")


def _load_models() -> List[Dict[str, Any]]:
    try:
        with open(MODELS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception:
        return []


def _save_models(models: List[Dict[str, Any]]) -> None:
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(MODELS_FILE, "w", encoding="utf-8") as f:
            json.dump(models, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

#读写对话记录
def _load_conversations() -> List[Dict[str, Any]]:
    try:
        with open(CONVERSATIONS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            # 仅当文件内容是列表时才返回，否则返回空列表
            return data if isinstance(data, list) else []
    except Exception:
        return []

#保存对话记录
def _save_conversations(convs: List[Dict[str, Any]]) -> None:
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(CONVERSATIONS_FILE, "w", encoding="utf-8") as f:
            json.dump(convs, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

# ---------------- 种子：Agent 模板 ----------------
AGENT_TEMPLATES: List[Dict[str, Any]] = [
    {"id": "research", "name": "研究 Agent", "desc": "检索资料、收集证据", "icon": "search"},
    {"id": "analysis", "name": "分析 Agent", "desc": "结构化分析与推理", "icon": "pulse"},
    {"id": "writer", "name": "写作 Agent", "desc": "组织语言、生成文本", "icon": "pen"},
    {"id": "review", "name": "终审 Agent", "desc": "质量检查与终稿", "icon": "check"},
    {"id": "data", "name": "数据 Agent", "desc": "数据摄取与清洗", "icon": "db"},
    {"id": "deploy", "name": "创建部署 Agent", "desc": "发布与部署编排", "icon": "rocket"},
    {"id": "task", "name": "创建任务 Agent", "desc": "拆解与分配任务", "icon": "tasks"},
]

# ---------------- 种子：模型（仅作内部兜底，不展示） ----------------
BUILTIN_MODELS: List[Dict[str, Any]] = [
    {"id": "jigsaw-ultra", "name": "JIGSAW Ultra", "model": "jigsaw-ultra", "custom": False},
]

# ---------------- 种子：会话 / 工作流 ----------------
def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _wf(conv_id: str, nodes: List[Dict[str, Any]], edges: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {"id": "wf-" + conv_id, "conversationId": conv_id, "nodes": nodes, "edges": edges}


SEED_CONVERSATIONS: List[Dict[str, Any]] = []

# 预置工作流已随预置会话一并移除（孤儿数据不保留）
SEED_WORKFLOWS: Dict[str, Dict[str, Any]] = {}


class Store:
    """进程内 Mock 存储。替换真实后端时，把读写改为数据库即可。"""

    def __init__(self) -> None:
        self.conversations=_load_conversations()
        self.workflows: Dict[str, Dict[str, Any]] = {k: _deep(v) for k, v in SEED_WORKFLOWS.items()}
        # 自定义模型：从文件读入（文件不存在则空）
        self.custom_models: List[Dict[str, Any]] = _load_models()
        self.settings: Dict[str, Any] = {
            "api": {"provider": "openai", "baseUrl": "http://127.0.0.1:8000",
                    "connected": False, "mode": "remote"},
            "model": {"defaultModel": "jigsaw-ultra", "visionEnabled": True,
                      "toolsEnabled": True, "temperature": 0.7},
            "workflow": {"defaultTemplate": "default", "executionSpeed": "normal",
                         "autoRun": False, "gridSize": 40},
        }

    # ---- 自定义模型 ----
    def save_models(self) -> None:
        """把当前模型列表写盘，调用点在 models.py 的新增/更新/删除之后。"""
        _save_models(self.custom_models)

    # ---- conversations ----
    def get_conversation(self, conv_id: str) -> Dict[str, Any] | None:
        return next((c for c in self.conversations if c["id"] == conv_id), None)

    def list_conversations(self) -> List[Dict[str, Any]]:
        return sorted(self.conversations, key=lambda c: c.get("createdAt", ""), reverse=True)

    def save_conversations(self) -> None:
        """把当前会话列表写盘，调用点在 chat.py 的新建/发消息之后。"""
        with _file_lock:
            _save_conversations(self.conversations)

    def delete_conversation(self, conv_id: str) -> None:
        self.conversations = [c for c in self.conversations if c["id"] != conv_id]
        self.save_conversations()

    # ---- workflows ----
    def get_workflow(self, wf_id: str) -> Dict[str, Any] | None:
        return self.workflows.get(wf_id)

    def list_workflows(self) -> List[Dict[str, Any]]:
        return list(self.workflows.values())

    def save_workflow(self, wf_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        wf = self.workflows.setdefault(wf_id, {"id": wf_id, "conversationId": wf_id[3:],
                                               "nodes": [], "edges": []})
        for key in ("nodes", "edges"):
            if key in payload:
                wf[key] = payload[key]
        return wf

    def add_message(self, conv_id: str, msg: Dict[str, Any]) -> None:
        conv = self.get_conversation(conv_id)
        if conv is not None:
            conv.setdefault("messages", []).append(msg)

    def get_messages(self, conv_id: str) -> List[Dict[str, Any]]:
        conv = self.get_conversation(conv_id)
        return list(conv.get("messages", [])) if conv else []


def _deep(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _deep(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_deep(v) for v in obj]
    return obj


store = Store()
