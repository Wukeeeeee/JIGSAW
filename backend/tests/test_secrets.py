"""R7 第二步（密钥出清）单测：GET 脱敏 + PUT 空 Key 保留 + model_id 解析。

    cd backend && python tests/test_secrets.py
    cd backend && python -m pytest tests/test_secrets.py -q

models.json / image_settings.json 重定向到临时文件，不碰真实数据。
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from routers import models as models_router   # noqa: E402
from routers import settings as settings_router  # noqa: E402
from routers.chat import _resolve_model_config  # noqa: E402
from services.store import store              # noqa: E402


def test_list_models_masks_api_key():
    old = list(store.custom_models)
    try:
        store.custom_models = [{"id": "cm-t", "name": "T", "modelId": "m1",
                                "baseUrl": "https://x/v1", "apiKey": "sk-secret"}]
        res = models_router.list_models()
        m = res["models"][0]
        assert m["apiKey"] == "", m
        assert m["hasKey"] is True
        assert "sk-secret" not in json.dumps(res)
    finally:
        store.custom_models = old


def test_put_model_keeps_existing_key_when_blank():
    old_models_file = __import__("services.store", fromlist=["MODELS_FILE"]).MODELS_FILE
    old = [dict(m) for m in store.custom_models]
    tmp = tempfile.mkdtemp(prefix="jigsaw_sec_")
    try:
        __import__("services.store", fromlist=["MODELS_FILE"]).MODELS_FILE = os.path.join(tmp, "models.json")
        store.custom_models = [{"id": "cm-t", "name": "T", "modelId": "m1",
                                "baseUrl": "https://x/v1", "apiKey": "sk-real"}]
        # 模拟脱敏回写：apiKey 留空
        r = models_router.update_custom_model("cm-t", models_router.CustomModelIn(
            id="cm-t", name="T2", modelId="m1", baseUrl="https://x/v1", apiKey=""))
        assert r["ok"] is True
        assert store.custom_models[0]["apiKey"] == "sk-real"   # 原 Key 保留
        assert store.custom_models[0]["name"] == "T2"          # 其他字段正常更新
    finally:
        __import__("services.store", fromlist=["MODELS_FILE"]).MODELS_FILE = old_models_file
        store.custom_models = old


def test_get_settings_masks_image_keys():
    old = json.loads(json.dumps(store.settings))
    try:
        store.settings["image"] = {
            "apiKey": "sk-img-secret",
            "models": [{"id": "im1", "name": "Agnes", "modelId": "flash", "apiKey": "sk-model-secret"}],
        }
        s = settings_router.get_settings()
        assert s["image"]["apiKey"] == ""
        assert s["image"]["hasKey"] is True
        assert s["image"]["models"][0]["apiKey"] == ""
        assert s["image"]["models"][0]["hasKey"] is True
        assert "sk-img-secret" not in json.dumps(s) and "sk-model-secret" not in json.dumps(s)
    finally:
        store.settings = old


def test_put_settings_keeps_image_keys_when_blank():
    old_settings = json.loads(json.dumps(store.settings))
    old_img_file = settings_router.IMG_SETTINGS_FILE
    tmp = tempfile.mkdtemp(prefix="jigsaw_sec_")
    try:
        settings_router.IMG_SETTINGS_FILE = os.path.join(tmp, "image_settings.json")
        store.settings["image"] = {
            "apiKey": "sk-img-real",
            "models": [{"id": "im1", "name": "Agnes", "modelId": "flash", "apiKey": "sk-m-real"}],
        }
        settings_router.put_settings(settings_router.SettingsIn(image={
            "apiKey": "",
            "models": [{"id": "im1", "name": "Agnes2", "modelId": "flash", "apiKey": ""}],
        }))
        assert store.settings["image"]["apiKey"] == "sk-img-real"
        assert store.settings["image"]["models"][0]["apiKey"] == "sk-m-real"
        assert store.settings["image"]["models"][0]["name"] == "Agnes2"
    finally:
        settings_router.IMG_SETTINGS_FILE = old_img_file
        store.settings = old_settings


def test_resolve_model_config():
    old = list(store.custom_models)
    try:
        store.custom_models = [
            {"id": "cm-ok", "modelId": "deep", "baseUrl": "https://x/v1", "apiKey": "sk-real"},
            {"id": "cm-nokey", "modelId": "nk", "baseUrl": "https://z/v1", "apiKey": ""},
        ]
        # model_id 命中 → 后端配置（真 Key）
        m = _resolve_model_config("cm-ok", None)
        assert m == {"model": "deep", "baseUrl": "https://x/v1", "apiKey": "sk-real"}, m
        # model_id 未命中 → 回退请求自带配置
        fallback = {"model": "gpt", "baseUrl": "https://y/v1", "apiKey": "sk-b"}
        assert _resolve_model_config("cm-nope", fallback) is fallback
        assert _resolve_model_config("cm-nope", None) is None
        assert _resolve_model_config(None, fallback) is fallback
        # 命中但模型库记录无 Key → 回退
        assert _resolve_model_config("cm-nokey", fallback) is fallback
    finally:
        store.custom_models = old


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS  {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
