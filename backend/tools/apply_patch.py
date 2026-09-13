"""应用补丁（apply_patch）—— 批量修改一个或多个文本文件

格式（Codex apply_patch 风格，靠上下文定位，不用行号）：

*** Begin Patch
*** Update File: 相对或绝对路径
@@
 上下文行（以空格开头，用于定位，不改动）
-要被删除的旧行
+要新增的新行
@@
 第二个块...
*** Create File: 新文件路径
@@
+新文件第一行
+新文件第二行
@@
*** Delete File: 要删除的文件路径
*** End Patch

规则：
- 每个块内的行必须有前缀：空格=上下文、减号=删除、加号=新增；空行写作 "+" 或 " "。
- 块会按"上下文+删除行"整体在文件中匹配，必须恰好出现 1 处，否则报错。
- 先校验全部块、全部通过后才写入，避免改到一半失败。
"""
import os

SCHEMA = {
    "type": "function",
    "function": {
        "name": "apply_patch",
        "description": (
            "用补丁批量修改一个或多个 UTF-8 文本文件（适合大规模/多文件改动，editfile 适合改单处）。"
            "patch 参数格式：以 *** Begin Patch 开头、*** End Patch 结尾；"
            "*** Update File: 路径 表示改已有文件；*** Create File: 路径 表示新建；*** Delete File: 路径 表示删除；"
            "每个 @@ 块内的行以空格开头=上下文（定位用，不改）、减号开头=删除、加号开头=新增。"
            "块必须唯一匹配目标文件，否则报错。示例：\n"
            "*** Begin Patch\n"
            "*** Update File: app.py\n"
            "@@\n"
            " def main():\n"
            "-    print('old')\n"
            "+    print('new')\n"
            "@@\n"
            "*** End Patch"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "patch": {
                    "type": "string",
                    "description": "补丁全文（从 *** Begin Patch 到 *** End Patch）",
                }
            },
            "required": ["patch"],
        },
    },
}


class _PatchError(Exception):
    pass


def _parse_patch(patch: str) -> list:
    """解析补丁 → [{'op': 'update'|'create'|'delete', 'path': str, 'blocks': [[(prefix, text), ...]]}]"""
    if not patch or "*** Begin Patch" not in patch or "*** End Patch" not in patch:
        raise _PatchError("补丁格式错误：必须包含 *** Begin Patch 和 *** End Patch")
    body = patch.split("*** Begin Patch", 1)[1].split("*** End Patch", 1)[0]
    ops = []
    current = None
    block = None
    for raw in body.splitlines():
        line = raw.rstrip("\n")
        if line.startswith("*** Update File:") or line.startswith("*** Create File:") or line.startswith("*** Delete File:"):
            if block:
                current["blocks"].append(block)
                block = None
            if current is not None:
                ops.append(current)
            op = "update" if "Update" in line else ("create" if "Create" in line else "delete")
            p = line.split(":", 1)[1].strip()
            if not p:
                raise _PatchError("文件路径不能为空")
            current = {"op": op, "path": p, "blocks": []}
        elif line.strip() == "@@":
            if block:
                current["blocks"].append(block)
            block = []
        elif current is not None:
            if block is None:
                continue  # @@ 之前的散行忽略
            if not line:
                continue  # 空行忽略
            prefix, text = line[0], line[1:]
            if prefix not in (" ", "-", "+"):
                # Create 块里允许无前缀裸行（模型常直接写内容）；Update/Delete 保持严格
                if current and current["op"] == "create":
                    block.append(("+", line))
                    continue
                raise _PatchError(f"块内行必须以 空格/-/+ 开头：{line[:40]}")
            block.append((prefix, text))
    if block and current is not None:
        current["blocks"].append(block)
    if current is not None:
        ops.append(current)
    if not ops:
        raise _PatchError("补丁里没有任何文件操作")
    return ops


def _apply_block(lines: list, block: list):
    """在行列表里找块的搜索序列（上下文+删除行），恰好 1 处则替换。返回 (新行列表, 匹配数)。"""
    search = [t for p, t in block if p in (" ", "-")]
    replace = [t for p, t in block if p in (" ", "+")]
    matches = []
    for i in range(len(lines) - len(search) + 1):
        if lines[i:i + len(search)] == search:
            matches.append(i)
    if not matches:
        return None, 0
    if len(matches) > 1:
        return None, len(matches)
    i = matches[0]
    return lines[:i] + replace + lines[i + len(search):], 1


def _apply_patch_file(path: str, op: str, blocks: list, cwd: str = "") -> str:
    full = os.path.join(cwd, path) if cwd and not os.path.isabs(path) else path
    if op == "delete":
        if not os.path.exists(full):
            raise _PatchError(f"要删除的文件不存在：{full}")
        os.remove(full)
        return f"删除 {path}"
    if op == "create":
        lines = []
        for block in blocks:
            for prefix, text in block:
                # 新文件没有旧内容可定位：+ 和 空格（模型常把内容当"上下文"写）都算内容
                if prefix == "+" or prefix == " ":
                    lines.append(text)
        parent = os.path.dirname(full)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(full, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + ("\n" if lines else ""))
        return f"创建 {path}（{len(lines)} 行）"
    # update
    if not os.path.exists(full):
        raise _PatchError(f"要修改的文件不存在：{full}")
    with open(full, "r", encoding="utf-8") as f:
        content = f.read()
    lines = content.splitlines()
    new_lines = lines
    for block in blocks:
        new_lines, n = _apply_block(new_lines, block)
        if n == 0:
            snippet = " | ".join(t[:30] for _, t in block[:3])
            raise _PatchError(f"在 {path} 中找不到块（0 处匹配），块内容开头：{snippet}")
        if n > 1:
            raise _PatchError(f"在 {path} 中块匹配到 {n} 处，上下文不够唯一，请扩大上下文")
    with open(full, "w", encoding="utf-8") as f:
        f.write("\n".join(new_lines) + ("\n" if content.endswith("\n") else ""))
    return f"更新 {path}（{len(blocks)} 个块）"


def _apply_patch(patch: str, cwd: str = "") -> str:
    ops = _parse_patch(patch)
    # 第一阶段：只校验（全部块都匹配），不写入
    for op in ops:
        if op["op"] in ("update", "create"):
            full = os.path.join(cwd, op["path"]) if cwd and not os.path.isabs(op["path"]) else op["path"]
            if op["op"] == "update":
                if not os.path.exists(full):
                    raise _PatchError(f"要修改的文件不存在：{full}")
                with open(full, "r", encoding="utf-8") as f:
                    lines = f.read().splitlines()
                for block in op["blocks"]:
                    _, n = _apply_block(lines, block)
                    if n == 0:
                        snippet = " | ".join(t[:30] for _, t in block[:3])
                        raise _PatchError(f"校验失败：{op['path']} 中块匹配 0 处，块开头：{snippet}")
                    if n > 1:
                        raise _PatchError(f"校验失败：{op['path']} 中块匹配 {n} 处，请扩大上下文")
    # 第二阶段：全部通过，统一写入
    results = []
    for op in ops:
        results.append(_apply_patch_file(op["path"], op["op"], op["blocks"], cwd))
    return "补丁应用成功\n" + "\n".join(results)


def run(args: dict) -> str:
    patch = args.get("patch", "")
    try:
        return _apply_patch(patch)
    except _PatchError as e:
        return f"补丁应用失败：{e}"
    except Exception as e:
        return f"补丁应用出错：{type(e).__name__} — {str(e)[:200]}"
