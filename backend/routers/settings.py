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


class RulesIn(BaseModel):
    content: str


RULES_FILE = os.path.join(DATA_DIR, "rules.md")


@router.get("/rules")
def get_rules():
    """读取用户全局规则（data/rules.md）。不存在返回空串。"""
    try:
        with open(RULES_FILE, "r", encoding="utf-8") as f:
            return {"content": f.read()}
    except FileNotFoundError:
        return {"content": ""}
    except OSError as e:
        return {"content": "", "error": str(e)}


@router.put("/rules")
def put_rules(payload: RulesIn):
    """保存用户全局规则。每次对话/节点执行时实时读取注入 system prompt，保存即生效。"""
    content = (payload.content or "").replace("\r\n", "\n").strip()
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(RULES_FILE, "w", encoding="utf-8") as f:
            f.write(content + ("\n" if content else ""))
    except OSError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "chars": len(content)}


def _mask_image(s: dict) -> dict:
    """生图配置脱敏（R7）：apiKey 不出后端，hasKey 标记是否存在。"""
    import copy
    out = copy.deepcopy(s) if isinstance(s, dict) else {}
    if out.get("apiKey"):
        out["hasKey"] = True
        out["apiKey"] = ""
    for m in out.get("models") or []:
        if isinstance(m, dict) and m.get("apiKey"):
            m["hasKey"] = True
            m["apiKey"] = ""
    return out


@router.get("/settings")
def get_settings():
    s = dict(store.settings)
    if "image" in s:
        s["image"] = _mask_image(s["image"])
    return s


@router.put("/settings")
def put_settings(payload: SettingsIn):
    for key in ("api", "model", "image", "workflow"):
        value = getattr(payload, key)
        if value is not None:
            # R7：image 部分 apiKey 留空 = 保留原密钥（前端拿到的是脱敏空串，回写不能洗掉真 Key）
            if key == "image":
                old = store.settings.get("image", {}) or {}
                incoming = dict(value)
                if not (incoming.get("apiKey") or "").strip():
                    incoming["apiKey"] = old.get("apiKey", "")
                old_models = {m.get("id"): m for m in (old.get("models") or [])
                              if isinstance(m, dict)}
                for m in incoming.get("models") or []:
                    if isinstance(m, dict) and not (m.get("apiKey") or "").strip():
                        m["apiKey"] = (old_models.get(m.get("id")) or {}).get("apiKey", "")
                value = incoming
            store.settings.setdefault(key, {}).update(value)
    if payload.image is not None:
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            with open(IMG_SETTINGS_FILE, "w", encoding="utf-8") as f:
                json.dump(store.settings.get("image", {}), f, ensure_ascii=False, indent=2)
        except Exception:
            pass
    return get_settings()
