"""读取文件内容"""
import asyncio
import os

SCHEMA = {
    "type": "function",
    "function": {
        "name": "readfile",
        "description": "读取文件内容，返回文件内容。当用户需要查看文件内容时使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "要读取的文件路径",
                }
            },
            "required": ["file_path"],
        },
    },
}


async def _readfile(file_path: str) -> str:
    file_path = file_path.strip()
    if not file_path:
        return f"文件路径不能为空：{file_path}"
    if not os.path.isfile(file_path):
        return f"非文件：{file_path}"
    try:
            with open(file_path, "r", encoding="utf-8") as f:
                return f.read()
    except Exception as e:
        return f"读取文件失败：{e}"

def run(args: dict) -> str:
    file_path = args.get("file_path")
    return asyncio.run(_readfile(file_path))   # ★ 执行异步函数拿到真结果，而不是返回协程