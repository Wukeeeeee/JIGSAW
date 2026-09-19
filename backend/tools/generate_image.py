"""
JIGSAW — 通用图像生成工具（generate_image）
==========================================
支持 OpenAI 图像生成规范接口（POST /v1/images/generations），
可无缝挂接任何生图服务商（Agnes AI、SiliconFlow FLUX、OpenAI DALL-E、自定义接口等）。
自动下载/解码落盘至 backend/data/generated_images/ 永久保存，
并返回可在前端气泡内直接渲染大图的 Markdown 语法。
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import time
import urllib.parse
import urllib.request

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
MODELS_FILE = os.path.join(DATA_DIR, "models.json")
IMG_SETTINGS_FILE = os.path.join(DATA_DIR, "image_settings.json")
IMG_DIR = os.path.join(DATA_DIR, "generated_images")

SCHEMA = {
    "type": "function",
    "function": {
        "name": "generate_image",
        "description": "调用 AI 图像生成模型根据提示词创作图片。如果系统配置了多个生图模型且用户未明确指定，必须在调用前先使用 AskUser 工具向用户询问确认！若未指定 model 则使用系统默认生图模型。调用成功后，在最终回答中必须原样输出 Markdown 贴图语法 ![画面描述](路径)，以直接渲染展示图片！",
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "画面的详细视觉描述词（画面主体、构图、光影、艺术风格、色彩氛围等，中英文皆可）"
                },
                "aspect_ratio": {
                    "type": "string",
                    "enum": ["1:1", "16:9", "9:16", "4:3", "3:4"],
                    "description": "图片宽高比，默认 1:1"
                },
                "model": {
                    "type": "string",
                    "description": "指定的生图模型名称或 ID（例如 agnes-image-2.5-flash、black-forest-labs/FLUX.1-schnell、dall-e-3 等）。用户已选定或指令中明确指明时传入；若未指定则使用系统默认模型。"
                }
            },
            "required": ["prompt"]
        }
    }
}


def get_available_image_models() -> list[dict]:
    """读取所有已配置可用的生图模型列表"""
    models: list[dict] = []
    try:
        if os.path.exists(IMG_SETTINGS_FILE):
            with open(IMG_SETTINGS_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                if isinstance(cfg, dict):
                    active_id = cfg.get("activeModelId") or ""
                    # 1. 如果存在 models 数组
                    raw_list = cfg.get("models")
                    if isinstance(raw_list, list) and raw_list:
                        for m in raw_list:
                            if isinstance(m, dict) and (m.get("modelId") or m.get("name")):
                                k = (m.get("apiKey") or "").strip()
                                # 只有真正填写并配置了 API Key 密钥的模型才算有效可用模型
                                if not k:
                                    continue
                                m_id = m.get("id") or m.get("modelId") or "im-custom"
                                models.append({
                                    "id": m_id,
                                    "name": m.get("name") or m.get("modelId"),
                                    "modelId": (m.get("modelId") or "").strip(),
                                    "baseUrl": (m.get("baseUrl") or "").strip().replace("/images/generations", "").rstrip("/"),
                                    "apiKey": k,
                                    "aspectRatio": (m.get("aspectRatio") or "1:1").strip(),
                                    "isDefault": (m_id == active_id) or (not active_id and len(models) == 0)
                                })
                    # 2. 兼容单模型旧格式
                    elif cfg.get("modelId") or cfg.get("baseUrl"):
                        k = (cfg.get("apiKey") or "").strip()
                        if k:
                            models.append({
                                "id": "im-default",
                                "name": cfg.get("provider") or "默认生图模型",
                                "modelId": (cfg.get("modelId") or "agnes-image-2.5-flash").strip(),
                                "baseUrl": (cfg.get("baseUrl") or "https://apihub.agnes-ai.com/v1").strip().replace("/images/generations", "").rstrip("/"),
                                "apiKey": k,
                                "aspectRatio": (cfg.get("aspectRatio") or "1:1").strip(),
                                "isDefault": True
                            })
    except Exception:
        pass

    # 3. 兜底默认模型（若未配置任何模型）
    if not models:
        models.append({
            "id": "im-agnes",
            "name": "Agnes AI (Flash)",
            "modelId": "agnes-image-2.5-flash",
            "baseUrl": "https://apihub.agnes-ai.com/v1",
            "apiKey": "sk-GBAHpuEiGQZN4fUUzSRMFouoB6iJ8zs1LWLkjMwYQuQENfDD",
            "aspectRatio": "1:1",
            "isDefault": True
        })

    return models


def _get_image_config(target_model: str = "") -> tuple[str, str, str, str]:
    """读取匹配的生图配置：(api_key, base_url, model_id, default_ratio)"""
    models = get_available_image_models()
    target_clean = (target_model or "").strip().lower()

    if target_clean:
        # ① 精确比对 id / modelId / name
        for m in models:
            if target_clean in (m["id"].lower(), m["modelId"].lower(), m["name"].lower()):
                return m["apiKey"], m["baseUrl"], m["modelId"], m["aspectRatio"]
        # ② 模糊关键词包含比对
        for m in models:
            m_id = m["modelId"].lower()
            m_name = m["name"].lower()
            if target_clean in m_id or target_clean in m_name or m_id in target_clean or m_name in target_clean:
                return m["apiKey"], m["baseUrl"], m["modelId"], m["aspectRatio"]

    # ③ 找默认标记的模型
    for m in models:
        if m.get("isDefault"):
            return m["apiKey"], m["baseUrl"], m["modelId"], m["aspectRatio"]

    # ④ 找第一个有效模型
    if models:
        m = models[0]
        return m["apiKey"], m["baseUrl"], m["modelId"], m["aspectRatio"]

    # ⑤ 兜底默认 key
    return "sk-GBAHpuEiGQZN4fUUzSRMFouoB6iJ8zs1LWLkjMwYQuQENfDD", "https://apihub.agnes-ai.com/v1", "agnes-image-2.5-flash", "1:1"


def run(args: dict) -> str:
    prompt = (args.get("prompt") or "").strip()
    if not prompt:
        return "生成图片失败：未提供提示词 (prompt)。"

    target_model = (args.get("model") or "").strip()
    api_key, base_url, model, def_ratio = _get_image_config(target_model)
    aspect_ratio = (args.get("aspect_ratio") or def_ratio or "1:1").strip()

    if not api_key:
        return f"生成图片失败：模型【{model}】尚未配置 API Key 密钥。请在「设置 - 模型」中填入该模型的密钥后再试。"

    endpoint = f"{base_url.rstrip('/')}/images/generations"
    payload = {
        "model": model,
        "prompt": prompt,
        "n": 1,
    }

    # 针对不同服务商自适应画幅参数
    m_lower = model.lower()
    if "dall-e" in m_lower:
        if aspect_ratio == "16:9":
            payload["size"] = "1792x1024"
        elif aspect_ratio == "9:16":
            payload["size"] = "1024x1792"
        else:
            payload["size"] = "1024x1024"
    elif "flux" in m_lower or "siliconflow" in base_url.lower():
        if aspect_ratio == "16:9":
            payload["image_size"] = "1280x720"
        elif aspect_ratio == "9:16":
            payload["image_size"] = "720x1280"
        else:
            payload["image_size"] = "1024x1024"
    else:
        payload["aspect_ratio"] = aspect_ratio

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "JIGSAW/1.0"
    }

    try:
        req = urllib.request.Request(
            endpoint,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        items = data.get("data") or []
        if not items:
            return f"生成图片失败：接口未返回有效图片数据（响应：{data}）"

        first = items[0]
        img_url = first.get("url")
        b64_data = first.get("b64_json")

        os.makedirs(IMG_DIR, exist_ok=True)
        ts = int(time.time())
        p_hash = hashlib.md5(prompt.encode("utf-8")).hexdigest()[:8]
        filename = f"gen_{ts}_{p_hash}.png"
        local_path = os.path.join(IMG_DIR, filename)

        if img_url:
            dl_req = urllib.request.Request(img_url, headers={"User-Agent": "JIGSAW/1.0"})
            with urllib.request.urlopen(dl_req, timeout=60) as dl_resp:
                with open(local_path, "wb") as f:
                    f.write(dl_resp.read())
        elif b64_data:
            with open(local_path, "wb") as f:
                f.write(base64.b64decode(b64_data))
        else:
            return f"生成图片失败：响应中无可用图片链接或数据（响应：{first}）"

        norm_path = local_path.replace("\\", "/")
        clean_alt = "AI 高清绘图成品"
        return (
            f"![{clean_alt}]({norm_path})\n\n"
            f"**图片已生成完成**\n"
            f"- **模型**：`{model}`\n"
            f"- **画幅比例**：{aspect_ratio}\n"
            f"- **本地存储路径**：`{norm_path}`"
        )

    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="ignore")
        return f"调用生图接口失败 (HTTP {e.code})：{err_body or e.reason}"
    except Exception as e:
        return f"生成图片异常：{str(e)}"
