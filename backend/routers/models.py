"""模型路由：用户自定义模型（OpenAI 兼容预留）。"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.store import BUILTIN_MODELS, store

router = APIRouter()


class CustomModelIn(BaseModel):
    name: str
    modelId: str
    baseUrl: str = "https://api.openai.com/v1"
    apiKey: str = ""


class CustomModelOut(CustomModelIn):
    id: str
    custom: bool = True


@router.get("")
def list_models():
    """只返回用户自定义模型（内置模型不对外展示）。"""
    return {"models": store.custom_models}


@router.post("/custom", response_model=CustomModelOut)
def add_custom_model(m: CustomModelIn) -> CustomModelOut:
    if any(x["modelId"] == m.modelId for x in store.custom_models):
        raise HTTPException(status_code=409, detail="模型已存在")
    out = CustomModelOut(
        id="cm-" + str(len(store.custom_models) + 1) + "-" + m.modelId,
        name=m.name or m.modelId, modelId=m.modelId,
        baseUrl=m.baseUrl, apiKey=m.apiKey,
    )
    store.custom_models.append(out.model_dump())
    store.save_models()
    return out


@router.put("/custom/{model_id}")
def update_custom_model(model_id: str, m: CustomModelIn):
    """编辑已有模型（名称/模型ID/BaseURL/APIKey），写盘持久化。"""
    for x in store.custom_models:
        if x["id"] == model_id:
            x.update(m.model_dump())
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
