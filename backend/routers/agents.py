"""Agent 模板路由。"""
from fastapi import APIRouter

from services.store import AGENT_TEMPLATES

router = APIRouter()


@router.get("/templates")
def list_templates():
    return {"templates": AGENT_TEMPLATES}
