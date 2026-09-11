"""内置工具：获取当前时间（含时区信息）"""
from datetime import datetime, timezone, timedelta

# 工具的"说明书"（以后给 LLM 看的，告诉它有什么工具、参数怎么传）
SCHEMA = {
    "type": "function",
    "function": {
        "name": "get_current_time",
        "description": "获取当前日期和时间，含本地时区偏移与 UTC 对照。当用户问现在几点、今天几号、几月几日、时区换算时使用。",
        "parameters": {
            "type": "object",
            "properties": {},      # time 工具不需要参数
            "required": [],
        },
    },
}

def run(args: dict) -> str:
    now = datetime.now().astimezone()          # 带时区偏移的本地时间（关键：先 astimezone 才有 %z）
    utc = datetime.now(timezone.utc)           # UTC 对照
    off = now.utcoffset() or timedelta(0)
    total_min = int(off.total_seconds() // 60)
    sign = "+" if total_min >= 0 else "-"
    hh = abs(total_min) // 60
    mm = abs(total_min) % 60
    offset_str = f"UTC{sign}{hh:02d}:{mm:02d}"
    return (
        f"当前时间：{now.strftime('%Y-%m-%d %H:%M:%S')}（{now.strftime('%A')}）\n"
        f"本地时区：{offset_str}\n"
        f"UTC 时间：{utc.strftime('%Y-%m-%d %H:%M:%S')}"
    )
