"""
JIGSAW — 本地图片与媒体文件安全服务路由
===================================
支持前端以 /api/files/raw?path=... 安全预览本地生成的图片（PNG/JPG/SVG/WebP 等），
解决浏览器与 Electron 沙箱跨域加载 file:// 协议受限的问题。
"""
from __future__ import annotations

import mimetypes
import os
import urllib.parse
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

router = APIRouter()

# 允许预览的安全图片后缀列表
ALLOWED_IMAGE_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico", ".tiff"
}


@router.get("/raw")
def get_raw_file(path: str = Query(..., description="本地图片文件的绝对或相对路径")):
    """读取本地生成的图片并以流式响应文件返回。"""
    raw_path = urllib.parse.unquote(path).strip()
    if raw_path.startswith("file:///"):
        raw_path = raw_path[8:]
    elif raw_path.startswith("file://"):
        raw_path = raw_path[7:]

    # 规范化路径
    real_path = os.path.normpath(os.path.abspath(raw_path))

    if not os.path.exists(real_path) or not os.path.isfile(real_path):
        raise HTTPException(status_code=404, detail=f"文件不存在: {os.path.basename(real_path)}")

    ext = os.path.splitext(real_path)[1].lower()
    if ext not in ALLOWED_IMAGE_EXTS:
        raise HTTPException(
            status_code=403,
            detail=f"安全限制：仅允许预览图片文件（当前文件后缀 {ext or '无'} 不在白名单中）"
        )

    mime_type, _ = mimetypes.guess_type(real_path)
    if not mime_type:
        if ext == ".svg":
            mime_type = "image/svg+xml"
        elif ext == ".webp":
            mime_type = "image/webp"
        else:
            mime_type = "application/octet-stream"

    return FileResponse(
        real_path,
        media_type=mime_type,
        filename=os.path.basename(real_path),
        headers={
            "Cache-Control": "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
        }
    )
