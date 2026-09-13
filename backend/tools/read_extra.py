"""读取额外后缀的文件（docx / xlsx / pptx / pdf 等）
实现复用 extract.py 统一提取层，不重复写解析逻辑。"""

SCHEMA = {
    "type": "function",
    "function": {
        "name": "read_extra",
        "description": "读取 docx / xlsx / pptx / pdf 等文件内容（提取文本）。",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "文件路径"
                }
            },
            "required": ["path"]
        }
    }
}

from .extract import extract_text


def read_extra(path: str) -> str:
    """读取额外后缀的文件，返回提取出的文本。"""
    if not path:
        return "文件路径不能为空"
    text = extract_text(path)
    if text is None:
        return f"暂不支持读取该格式或读取失败：{path}"
    return text


async def run(args: dict) -> str:
    res = read_extra(args.get("path") or "")
    try:
        return res
    except Exception as e:
        return f"读取文件失败：{type(e).__name__}: {str(e)[:200]}"
