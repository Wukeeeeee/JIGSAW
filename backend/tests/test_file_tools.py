"""read_file / list_files / grep 三件套单测（全部基于临时目录，不碰用户数据）。

    cd backend && python tests/test_file_tools.py
    cd backend && python -m pytest tests/test_file_tools.py -q
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools import TOOLS                    # noqa: E402
from tools import read_file, list_files, grep  # noqa: E402

_TMP = tempfile.mkdtemp(prefix="jigsaw_filetools_")


def _setup():
    """临时项目结构：
    _TMP/
      app.py            200 行（第 100 行含 NEEDLE_MAIN）
      utils/helper.py   3 行（第 2 行含 NEEDLE_HELPER）
      note.md
      blob.bin          二进制
      node_modules/x.js 依赖目录（应被忽略）
    """
    os.makedirs(os.path.join(_TMP, "utils"), exist_ok=True)
    os.makedirs(os.path.join(_TMP, "node_modules"), exist_ok=True)
    with open(os.path.join(_TMP, "app.py"), "w", encoding="utf-8") as f:
        f.write("\n".join(f"line_{i}" if i != 100 else "NEEDLE_MAIN = 1" for i in range(1, 201)))
    with open(os.path.join(_TMP, "utils", "helper.py"), "w", encoding="utf-8") as f:
        f.write("def a():\n    return 'NEEDLE_HELPER'\n\n")
    with open(os.path.join(_TMP, "note.md"), "w", encoding="utf-8") as f:
        f.write("# note\nplain text\n")
    with open(os.path.join(_TMP, "blob.bin"), "wb") as f:
        f.write(b"\x00\x01\x02binary")
    with open(os.path.join(_TMP, "node_modules", "x.js"), "w", encoding="utf-8") as f:
        f.write("NEEDLE_MAIN_inside_node_modules = 1\n")


_setup()   # 模块加载即初始化：测试按任意顺序跑都能拿到完整夹具


def test_registered():
    for name in ("read_file", "list_files", "grep"):
        assert name in TOOLS, f"{name} 未注册"


def test_read_file_basic_and_paging():
    app = os.path.join(_TMP, "app.py")
    r = read_file.run({"file_path": app})
    assert "共 200 行" in r and "显示第 1~150 行" in r
    assert "NEEDLE_MAIN" in r            # 第 100 行在前 150 行内
    assert "offset=151" in r             # 未读完提示
    r2 = read_file.run({"file_path": app, "offset": 100, "limit": 5})
    assert "100→" in r2 and "NEEDLE_MAIN" in r2 and "104→" in r2 and "105→" not in r2


def test_read_file_missing_and_binary():
    assert "不存在" in read_file.run({"file_path": os.path.join(_TMP, "nope.py")})
    assert "二进制" in read_file.run({"file_path": os.path.join(_TMP, "blob.bin")})


def test_list_files_tree_and_ignores():
    r = list_files.run({"path": _TMP, "depth": 3})
    assert "app.py" in r and "utils/" in r and "helper.py" in r and "note.md" in r
    assert "node_modules" not in r        # 依赖目录被剪枝
    assert "blob.bin" in r                # 普通文件名照列（list_files 不看内容）
    r2 = list_files.run({"path": _TMP, "pattern": "*.py"})
    assert "app.py" in r2 and "helper.py" in r2 and "note.md" not in r2


def test_grep_finds_with_line_numbers():
    r = grep.run({"pattern": "NEEDLE_(MAIN|HELPER)", "path": _TMP})
    assert "app.py:100:" in r, r
    assert "helper.py:2:" in r, r
    assert "node_modules" not in r            # 依赖目录被剪枝
    assert "blob.bin" not in r                # 二进制被跳过


def test_grep_glob_and_caps():
    r = grep.run({"pattern": "line_", "path": _TMP, "glob": "*.py", "max_results": 3})
    assert "3 处匹配" in r and "已达上限" in r
    r2 = grep.run({"pattern": r"^\d+$", "path": _TMP, "glob": "*.py"})
    assert "没有找到" in r2   # 行内容不是纯数字


def test_grep_invalid_regex():
    assert "正则无效" in grep.run({"pattern": "([bad", "path": _TMP})


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
