import asyncio
"""编辑文本文件（精确替换，带唯一性校验）

用法：
- oldcontent 在文件中恰好出现 1 处 → 直接替换。
- 出现多处 → 必须用 number 指定第几个（从 1 开始）；不填则报错提示。
- 0 处 → 报错，不静默"成功"。
"""
import os

SCHEMA = {
    "type": "function",
    "function": {
        "name": "editfile",
        "description": (
            "精确编辑文本文件：把 oldcontent 替换为 newcontent。"
            "oldcontent 必须与文件中的内容完全一致（逐字节匹配）。"
            "匹配规则：出现 0 处报错；出现 1 处直接替换；出现多处时需用 number 指定第几个（从 1 开始），否则报错。"
            "适用于修改代码、配置、文档等 UTF-8 文本文件，不适合二进制文件（Word/PDF/Excel/CAD 等）。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "filepath": {
                    "type": "string",
                    "description": "要编辑的文件路径",
                },
                "newcontent": {
                    "type": "string",
                    "description": "替换后的新内容",
                },
                "oldcontent": {
                    "type": "string",
                    "description": "要被替换的原文（必须与文件中完全一致，尽量带足够上下文使其唯一）",
                },
                "oldplace": {
                    "type": "string",
                    "description": "（可选）原文所在位置的大致描述，仅供说明，不参与匹配",
                },
                "number": {
                    "type": "integer",
                    "description": "（可选）oldcontent 出现多处时，指定替换第几个（从 1 开始）。不填且出现多处时报错。",
                },
            },
            "required": ["filepath", "newcontent", "oldcontent"],
        },
    },
}


def _find_all(content: str, needle: str) -> list:
    """返回 needle 在 content 中的所有起始位置（不重叠）。"""
    positions = []
    start = 0
    while True:
        idx = content.find(needle, start)
        if idx == -1:
            break
        positions.append(idx)
        start = idx + len(needle)
    return positions


async def _editfile(filepath: str, newcontent: str, oldcontent: str, oldplace: str = "", number=None) -> str:
    """编辑文件：唯一匹配校验 + number 指定第几个。"""
    if not oldcontent:
        return "oldcontent 不能为空"
    if not os.path.exists(filepath):
        return f"文件不存在：{filepath}"
    if newcontent == oldcontent:
        return "新内容与原内容相同，无需编辑"
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return f"读取文件失败：{e}"

    positions = _find_all(content, oldcontent)
    if not positions:
        return (
            f"编辑失败：oldcontent 在文件中找不到（0 处匹配）。"
            f"请重新读取文件，确认要替换的内容与文件完全一致（含空格/换行）。目标片段：{oldcontent[:60]}"
        )
    if len(positions) > 1:
        if number is None:
            return (
                f"编辑失败：oldcontent 在文件中出现 {len(positions)} 处，无法确定替换哪一处。"
                f"请提供更长的 oldcontent（带上下文使其唯一），或用 number 指定第几个（1~{len(positions)}）。"
            )
        if not (1 <= int(number) <= len(positions)):
            return f"编辑失败：number={number} 超出范围，有效范围 1~{len(positions)}"
        pos = positions[int(number) - 1]
    else:
        if number is not None and int(number) != 1:
            return f"编辑失败：oldcontent 在文件中只有 1 处，number={number} 无效（只允许 1）"
        pos = positions[0]

    new_content = content[:pos] + newcontent + content[pos + len(oldcontent):]
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(new_content)
    except Exception as e:
        return f"写入文件失败：{e}"
    return f"文件已成功写入：{filepath}（{len(oldcontent)} 字符 → {len(newcontent)} 字符，第 {positions.index(pos) + 1} 处匹配）"


def run(args: dict) -> str:
    filepath = args["filepath"]
    newcontent = args["newcontent"]
    oldcontent = args["oldcontent"]
    oldplace = args.get("oldplace", "")
    number = args.get("number")
    try:
        return asyncio.run(_editfile(filepath, newcontent, oldcontent, oldplace, number))
    except Exception as e:
        return f"编辑文件时出错：{str(e)}"
