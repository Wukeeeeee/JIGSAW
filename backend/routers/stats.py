"""统计路由：工具调用次数查询 / 重置（设置 → 统计 用）。"""
from fastapi import APIRouter

from services import stats_service

router = APIRouter()


@router.get("/stats")
def get_stats():
    """工具调用统计：since(统计起始时刻) / tz(时区标签) / calls(各工具次数) / total / lastUsed。"""
    return stats_service.snapshot()


@router.post("/stats/reset")
def reset_stats():
    """重置统计：次数清零，记录起始时间更新为当前时刻。返回重置后的快照。"""
    snap = stats_service.reset()
    return {"ok": True, **snap}
