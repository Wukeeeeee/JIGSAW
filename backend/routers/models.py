"""模型路由：用户自定义模型（OpenAI 兼容）。

并存规则：多个模型可以同时存在 ——
  两个模型的"模型 ID"相同但接口地址不同（比如两家服务商都叫 deepseek-chat），
  属于不同模型，允许并存；只有「接口地址 + 模型 ID」都相同才算重复。
每次新增都生成唯一 id（客户端传来的 id 若可用就沿用，保证前后端对得上）。
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.store import store

router = APIRouter()


class CustomModelIn(BaseModel):
    # 客户端（前端）已有的 id：带上它能让前后端是同一条记录，避免同步时重复出现
    id: str = ""
    name: str
    modelId: str
    baseUrl: str = "https://api.openai.com/v1"
    apiKey: str = ""


class CustomModelOut(CustomModelIn):
    custom: bool = True


def _key(m: dict) -> tuple:
    """模型唯一性判据：接口地址 + 模型 ID（同 ID 不同地址 = 两个不同模型）。"""
    return ((m.get("baseUrl") or "").strip().rstrip("/").lower(),
            (m.get("modelId") or "").strip())


@router.get("")
def list_models():
    """只返回用户自定义模型（内置模型不对外展示）。"""
    return {"models": store.custom_models}


@router.post("/custom", response_model=CustomModelOut)
def add_custom_model(m: CustomModelIn) -> CustomModelOut:
    data = m.model_dump()
    if any(_key(x) == _key(data) for x in store.custom_models):
        raise HTTPException(status_code=409, detail="已存在相同接口地址 + 模型 ID 的模型")
    mid = (m.id or "").strip()
    if not mid or any(x.get("id") == mid for x in store.custom_models):
        mid = "cm-" + uuid.uuid4().hex[:10]
    out = CustomModelOut(
        id=mid,
        name=m.name or m.modelId, modelId=m.modelId,
        baseUrl=m.baseUrl or "https://api.openai.com/v1", apiKey=m.apiKey,
    )
    store.custom_models.append(out.model_dump())
    store.save_models()
    return out


@router.put("/custom/{model_id}")
def update_custom_model(model_id: str, m: CustomModelIn):
    """编辑已有模型（名称/模型ID/BaseURL/APIKey），写盘持久化。id 不允许被覆盖。"""
    data = m.model_dump()
    data.pop("id", None)      # id 是主键，编辑时不能被请求体改掉
    for x in store.custom_models:
        if x["id"] == model_id:
            # 改名/改地址后不能和另一条记录撞车（撞的是自己除外）
            if any(o is not x and _key(o) == _key(data) for o in store.custom_models):
                raise HTTPException(status_code=409, detail="已存在相同接口地址 + 模型 ID 的模型")
            x.update(data)
            store.save_models()
            return {"ok": True, "model": x}
    raise HTTPException(status_code=404, detail="模型不存在")


@router.delete("/custom/{model_id}")
def remove_custom_model(model_id: str):
    before = len(store.custom_models)
    store.custom_models = [m for m in store.custom_models if m["id"] != model_id]
    if len(store.custom_models) == before:
        raise HTTPException(status_code=404, detail="模型不存在")
    store.save_models()
    return {"ok": True}
