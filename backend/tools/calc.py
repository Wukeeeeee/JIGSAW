"""计算器工具：计算数学表达式"""
import ast

SCHEMA = {
    "type": "function",
    "function": {
        "name": "calc",
        "description": "计算数学表达式，支持四则运算、括号、幂运算，例如 1+2*3、2**10、(5+5)/2。",
        "parameters": {
            "type": "object",
            "properties": {
                "expression": {"type": "string", "description": "要计算的数学表达式，例如 1+2*3"}
            },
            "required": ["expression"]
        }
    }
}


def run(args: dict) -> str:
    expr = (args.get("expression") or "").strip()
    if not expr:
        return "错误：expression 不能为空"
    try:
        # 白名单安全求值：只允许数字和运算符，禁止任意代码
        tree = ast.parse(expr, mode="eval")
        allowed = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant,
                   ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow,
                   ast.Mod, ast.FloorDiv, ast.USub, ast.UAdd)
        for node in ast.walk(tree):
            if not isinstance(node, allowed):
                return f"错误：表达式含不允许的语法（{type(node).__name__}）"
        result = eval(compile(tree, "<expr>", "eval"))
        return f"计算结果：{result}"
    except Exception as e:
        return f"计算失败：{type(e).__name__}: {e}"
