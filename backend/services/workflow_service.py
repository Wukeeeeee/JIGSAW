"""
JIGSAW — WorkflowService（Mock / 用户替换点）
=========================================
节点锁定规则与前端一致：status != "waiting" 的节点不可修改。
"""
from __future__ import annotations

from typing import Any, Dict, List

STATUS_ORDER = ("waiting", "running", "success", "failed")


def normalize(payload: Dict[str, Any]) -> Dict[str, Any]:
    """清洗前端提交的工作流载荷（只保留节点与边，校验基本结构）。"""
    out: Dict[str, Any] = {}
    if "nodes" in payload:
        out["nodes"] = []
        for n in payload["nodes"]:
            node = dict(n)
            node.setdefault("status", "waiting")
            node.setdefault("tools", [])
            out["nodes"].append(node)
    if "edges" in payload:
        out["edges"] = [dict(e) for e in payload["edges"]]
    return out


def editable_nodes(wf: Dict[str, Any]) -> List[Dict[str, Any]]:
    """仅 status=waiting 的节点可编辑。"""
    return [n for n in wf.get("nodes", []) if n.get("status") == "waiting"]
