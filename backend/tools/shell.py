"""Shell命令执行工具"""

import os
import subprocess

# 命令默认在项目根目录（E:\my_repo\Figsaw）执行，让 AI 干活时是"项目视角"
# shell.py 位于 backend/tools/ 下，向上三级即项目根
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SCHEMA = {
    "type": "function",
    "function": {
        "name": "shell",
        "description": "在本地电脑上执行一条 shell 命令，返回命令输出。当用户需要查询系统信息、运行脚本或操作本地文件时使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "要执行的命令"},
            },
            "required": ["command"],
        },
    },
}

def run(args: dict) -> str:
    """执行 shell 命令；成功返回 stdout+stderr，失败返回错误信息。"""
    try:
        from tools import shell_cwd  # 运行时导入，避免循环导入
        result = subprocess.run(
            args["command"], shell=True,
            cwd=shell_cwd(),              # 开关/自定义目录决定工作目录（None=继承进程目录）
            capture_output=True, text=True,
            timeout=120, encoding="utf-8", errors="replace",
        )
        out = (result.stdout or "") + (result.stderr or "")
        return out.strip() or f"（命令执行完毕，退出码 {result.returncode}，无输出）"
    except subprocess.TimeoutExpired:
        return "命令执行超时（120 秒）"
    except Exception as e:
        return f"命令执行失败：{type(e).__name__}: {e}"
