"""
JIGSAW — ExecutionService（Mock / 用户替换点）
==========================================
当前：按拓扑顺序一次性模拟执行，全部节点置为 success。
替换为真实 Agent 运行时（A2A / LangGraph / 自定义调度）时，
保持 `run(workflow) -> statuses` 签名即可。
"""
from __future__ import annotations

from typing import Any, Dict, List


def run(workflow: Dict[str, Any]) -> List[Dict[str, Any]]:
    """模拟执行：按边拓扑排序，依次置 running → success。"""
    nodes = list(workflow.get("nodes", []))
    edges = workflow.get("edges", [])
    by_id = {n["id"]: n for n in nodes}
    indeg = {n["id"]: 0 for n in nodes}
    for e in edges:
        if e["to"] in indeg:
            indeg[e["to"]] += 1

    # 简单拓扑序（种子数据无环）
    order = [n["id"] for n in nodes if indeg[n["id"]] == 0]
    result: List[Dict[str, Any]] = []
    for nid in order:
        node = by_id[nid]
        result.append({"id": nid, "status": "success"})
        for e in edges:
            if e["from"] == nid and indeg[e["to"]] > 0:
                indeg[e["to"]] -= 1
                if indeg[e["to"]] == 0:
                    order.append(e["to"])
    return result
