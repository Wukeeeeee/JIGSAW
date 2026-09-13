"""
JIGSAW — 工具调用统计
====================
记录每个工具被调用的累计次数与最近一次调用时间，并记录"统计起始时刻"。
用户在 设置 → 统计 里可以一键重置：次数清零，起始时间更新为当前时刻。

落盘 backend/data/stats.json（已 gitignore，属本机数据）。
统计失败绝不影响工具执行本身（所有写操作都吞异常）。
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timedelta

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
STATS_FILE = os.path.join(DATA_DIR, "stats.json")

# 用 RLock：reset() 内部会再调 snapshot()，普通 Lock 会自锁死
_lock = threading.RLock()


def _now_iso() -> str:
    """本地时区的 ISO 时间（带偏移），如 2026-09-14T00:49:26+08:00。"""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def tz_label() -> str:
    """当前本地时区标签，如 UTC+08:00（用于前端展示"自 XX 开始记录"）。"""
    off = datetime.now().astimezone().utcoffset() or timedelta(0)
    minutes = int(off.total_seconds() // 60)
    sign = "+" if minutes >= 0 else "-"
    h, m = divmod(abs(minutes), 60)
    return f"UTC{sign}{h:02d}:{m:02d}"


def _blank() -> dict:
    return {"since": _now_iso(), "calls": {}, "lastUsed": {}}


def _load() -> dict:
    """读统计文件；不存在或损坏时就地新建一份并落盘。

    ★ 一定要落盘：否则"读"和"写"会各自生成一个"现在"当起始时间，
    导致 since 在第一次写入前漂移（用户看到的时间会莫名其妙变来变去）。
    """
    try:
        with open(STATS_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict):
            out = _blank()
            if isinstance(d.get("since"), str) and d["since"]:
                out["since"] = d["since"]
            if isinstance(d.get("calls"), dict):
                out["calls"] = {str(k): int(v or 0) for k, v in d["calls"].items()}
            if isinstance(d.get("lastUsed"), dict):
                out["lastUsed"] = {str(k): str(v) for k, v in d["lastUsed"].items()}
            return out
    except Exception:
        pass
    fresh = _blank()
    _save(fresh)
    return fresh


def ensure_initialized() -> dict:
    """后端启动时调用：文件不存在就建好，让"记录起始时刻"≈后端启动时刻。"""
    with _lock:
        return _load()


def _save(d: dict) -> None:
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(STATS_FILE, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def snapshot() -> dict:
    """给前端的统计快照：起始时间、各工具次数、最近一次、时区标签。"""
    with _lock:
        d = _load()
        calls = {k: int(v or 0) for k, v in d["calls"].items()}
        return {
            "since": d["since"],
            "tz": tz_label(),
            "calls": calls,
            "lastUsed": dict(d["lastUsed"]),
            "total": int(sum(calls.values())),
            "now": _now_iso(),
        }


def record(name: str) -> None:
    """记一次工具调用。任何异常都吞掉，不影响工具执行。"""
    if not name:
        return
    try:
        with _lock:
            d = _load()
            d["calls"][name] = int(d["calls"].get(name) or 0) + 1
            d["lastUsed"][name] = _now_iso()
            _save(d)
    except Exception:
        pass


def reset() -> dict:
    """重置统计：次数清零，记录起始时间改为当前时刻。返回重置后的快照。"""
    with _lock:
        _save(_blank())
        return snapshot()


def count_of(name: str) -> int:
    with _lock:
        return int(_load()["calls"].get(name) or 0)
