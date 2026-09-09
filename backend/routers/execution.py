"""执行路由：运行工作流（Mock 调度）。"""
from fastapi import APIRouter, HTTPException

from services import execution_service
from services.store import store

router = APIRouter()


@router.post("/{wf_id}/run")
def run_workflow(wf_id: str):
    wf = store.get_workflow(wf_id)
    if wf is None:
        raise HTTPException(status_code=404, detail="工作流不存在")
    statuses = execution_service.run(wf)
    # 写回状态（节点仍可编辑与否由前端按 status 判定）
    by_id = {n["id"]: n for n in wf.get("nodes", [])}
    for item in statuses:
        node = by_id.get(item["id"])
        if node is not None:
            node["status"] = item["status"]
    return {"ok": True, "statuses": statuses}
