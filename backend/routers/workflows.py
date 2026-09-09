"""工作流路由：读取 / 保存（Mock，内存存储）。"""
from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services import workflow_service
from services.store import store

router = APIRouter()


class WorkflowPayload(BaseModel):
    nodes: list[Dict[str, Any]] = []
    edges: list[Dict[str, Any]] = []


@router.get("")
def list_workflows():
    return {"workflows": store.list_workflows()}


@router.get("/{wf_id}")
def get_workflow(wf_id: str):
    wf = store.get_workflow(wf_id)
    if wf is None:
        raise HTTPException(status_code=404, detail="工作流不存在")
    return wf


@router.put("/{wf_id}")
def save_workflow(wf_id: str, payload: WorkflowPayload):
    wf = store.get_workflow(wf_id)
    if wf is None:
        raise HTTPException(status_code=404, detail="工作流不存在")
    clean = workflow_service.normalize(payload.model_dump())
    return store.save_workflow(wf_id, clean)


@router.post("/{wf_id}/reset")
def reset_workflow(wf_id: str):
    wf = store.get_workflow(wf_id)
    if wf is None:
        raise HTTPException(status_code=404, detail="工作流不存在")
    for node in wf.get("nodes", []):
        node["status"] = "waiting"
    return {"ok": True, "workflow": wf}
