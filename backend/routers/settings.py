import json
import os

from fastapi import APIRouter
from pydantic import BaseModel

from services.store import store

router = APIRouter()

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
IMG_SETTINGS_FILE = os.path.join(DATA_DIR, "image_settings.json")


class SettingsIn(BaseModel):
    api: dict | None = None
    model: dict | None = None
    image: dict | None = None
    workflow: dict | None = None


@router.get("/settings")
def get_settings():
    return store.settings


@router.put("/settings")
def put_settings(payload: SettingsIn):
    for key in ("api", "model", "image", "workflow"):
        value = getattr(payload, key)
        if value is not None:
            store.settings.setdefault(key, {}).update(value)
    if payload.image is not None:
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            with open(IMG_SETTINGS_FILE, "w", encoding="utf-8") as f:
                json.dump(store.settings.get("image", {}), f, ensure_ascii=False, indent=2)
        except Exception:
            pass
    return store.settings
