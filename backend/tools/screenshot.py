"""
JIGSAW — 屏幕截图工具 (screenshot)
================================
截取当前电脑桌面或主要显示器的屏幕图像，保存至本地图片目录，
并返回可直接被 Markdown 渲染与显示的完整绝对路径。
"""
import os
import time

SCHEMA = {
    "type": "function",
    "function": {
        "name": "screenshot",
        "description": "截取当前电脑屏幕画面/桌面快照，保存为图片文件并返回本地绝对路径与贴图语法。在需要查看用户当前屏幕、程序界面或排查报错时使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "label": {
                    "type": "string",
                    "description": "可选的截图标识说明（如「报错窗口截图」）"
                }
            },
            "required": []
        }
    }
}


def run(args: dict) -> str:
    label = (args or {}).get("label") or "屏幕截图"
    try:
        from PIL import ImageGrab
    except ImportError:
        return "截屏失败：后端 Python 环境缺失 Pillow 依赖包，请运行 `pip install Pillow` 安装。"

    try:
        # 获取 backend/data/generated_images 目录
        data_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
        save_dir = os.path.join(data_dir, "generated_images")
        os.makedirs(save_dir, exist_ok=True)

        filename = f"screenshot_{int(time.time())}.png"
        filepath = os.path.normpath(os.path.abspath(os.path.join(save_dir, filename)))

        # 抓取全屏图像
        img = ImageGrab.grab()
        img.save(filepath, "PNG")

        raw_url = f"/api/files/raw?path={filepath}"
        return (
            f"成功完成屏幕截图！\n\n"
            f"![{label}]({filepath})\n\n"
            f"图片文件保存在：`{filepath}`"
        )
    except Exception as e:
        return f"屏幕截图执行失败：{type(e).__name__} — {e}"
