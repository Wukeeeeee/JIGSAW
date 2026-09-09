"""设置路由：读写运行设置（内存存储）。"""
from fastapi import APIRouter
from pydantic import BaseModel

from services.store import store

router = APIRouter()


class SettingsIn(BaseModel):
    api: dict | None = None
    model: dict | None = None
    workflow: dict | None = None


@router.get("/settings")
def get_settings():
    return store.settings


@router.put("/settings")
def put_settings(payload: SettingsIn):
    for key in ("api", "model", "workflow"):
        value = getattr(payload, key)
        if value is not None:
            store.settings.setdefault(key, {}).update(value)
    return store.settings
