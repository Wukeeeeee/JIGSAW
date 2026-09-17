"""chunker
将长文本切分成有边界的检索单元
"""

import re

_SENT_END = re.compile(r"(?<=[。！？；!?;])")


def chunk_text(text: str, max_len: int = 500, overlap: int = 60) -> list[str]:
    """将长文本切分成有边界的检索单元,空文本返回[]"""
    text = (text or "").strip()
    if not text:
        return []

    chunks: list[str] = []
    # 缓冲区
    buf = ""

    def _flush_buf() -> None:
        """将缓冲区内容切分成chunk"""
        nonlocal buf
        if not buf:
            return
        pieces = _SENT_END.split(buf)
        # overlap: 把上一个chunk的尾部拼到下一块开头,保证上下文衔接
        if chunks and overlap > 0 and pieces:
            prefix = chunks[-1][-overlap:]
            pieces[0] = prefix + pieces[0]
        # 切分
        for piece in pieces:
            while len(piece) > max_len:
                chunks.append(piece[:max_len])
                piece = piece[max_len:]
            if piece:
                chunks.append(piece)
        buf = ""

    # 空行分割
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        # 长度未达上限，直接加入缓冲区
        if len(buf) + len(para) <= max_len:
            buf = f"{buf}\n\n{para}".strip()
            continue
        _flush_buf()
        if len(para) <= max_len:
            buf = para
            continue
        # 段落过长，分段
        for sent in _SENT_END.split(para):
            while len(sent) > max_len:
                chunks.append(sent[:max_len])
                sent = sent[max_len:]
            buf = f"{buf}\n\n{sent}".strip()
        _flush_buf()

    # 循环结束: flush 缓冲区残留内容
    _flush_buf()
    return chunks
