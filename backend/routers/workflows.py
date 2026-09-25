"""工作流路由：读取 / 保存（Mock，内存存储）。"""
from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services import task_service
from services import workflow_service
from services.store import store

router = APIRouter()


class WorkflowPayload(BaseModel):
    nodes: list[Dict[str, Any]] = []
    edges: list[Dict[str, Any]] = []
    name: str | None = None


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
    """upsert 保存：画布自动保存的入口。不存在则创建，前端无需先建后存。"""
    clean = workflow_service.normalize(payload.model_dump())
    return store.save_workflow(wf_id, clean)


@router.delete("/{wf_id}")
def delete_workflow(wf_id: str):
    """删除工作流（随会话删除调用，防止 workflows.json 残留孤儿数据）。"""
    return {"ok": True, "deleted": store.delete_workflow(wf_id)}


# ============================================================
# R6 第一步：工作流节点执行搬进后端
# ============================================================
class NodeRunIn(BaseModel):
    conversation_id: str
    node: dict                                   # {name, description, systemPrompt, tools, input, maxToolCalls}
    model_id: str = ""                           # 后端模型库里的模型 id（Key 不经过前端渲染进程）
    temperature: float | None = None


@router.post("/nodes/run")
def run_node_task(payload: NodeRunIn):
    """创建一个"工作流节点执行"异步任务，立即返回 task_id。

    复用聊天任务队列（task_service）：可取消、AskUser 挂起、实时进度；
    执行走 chat_service.run_node（工具循环 + 权限门控）。前端用
    GET /api/chat/tasks/{task_id} 轮询，拿 reply 写回画布节点。
    """
    node = dict(payload.node or {})
    if not (node.get("name") or "").strip():
        raise HTTPException(status_code=422, detail="节点缺少名称")

    # 模型按 id 从后端模型库解析（与聊天链路不同：这里 Key 无需前端提供）
    model = None
    mid = (payload.model_id or "").strip()
    if mid:
        m = next((x for x in store.custom_models if x.get("id") == mid), None)
        if m is None:
            raise HTTPException(status_code=404, detail=f"模型 {mid} 不存在于后端模型库")
        if m.get("apiKey") and m.get("baseUrl"):
            model = {"model": m.get("modelId"), "baseUrl": m.get("baseUrl"), "apiKey": m.get("apiKey")}

    task = task_service.create_task(
        payload.conversation_id,
        f"(工作流节点) {node.get('name', '')}",
        model=model, temperature=payload.temperature,
        kind="node", payload=node,
    )
    return {"task_id": task["task_id"], "conversation_id": payload.conversation_id}


# ============================================================
# R6 第二步：Captain 规划搬后端（浏览器不再直连规划 LLM）
# ============================================================
class PlanIn(BaseModel):
    user_prompt: str
    model_id: str = ""          # 指定 Captain 用的后端模型（空 = 自动级联候选）
    temperature: float = 0.1


@router.post("/plan")
def plan_workflow_endpoint(payload: PlanIn):
    """自然语言 → 多智能体 DAG 规划。

    返回 {ok, plan: {workflowName, nodes:[{id,name,desc,prompt,tools,dependsOn}]}, model_id}。
    规划失败（模型不可用/解析失败）返回 502，前端降级到本地启发式规划。
    """
    from services import chat_service
    prompt = (payload.user_prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=422, detail="任务需求为空")
    try:
        result = chat_service.plan_workflow(prompt, payload.model_id or None, payload.temperature)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True, **result}


@router.post("/{wf_id}/reset")
def reset_workflow(wf_id: str):
    wf = store.get_workflow(wf_id)
    if wf is None:
        raise HTTPException(status_code=404, detail="工作流不存在")
    for node in wf.get("nodes", []):
        node["status"] = "waiting"
    return {"ok": True, "workflow": wf}
