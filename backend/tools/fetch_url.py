"""网页抓取工具"""

from crawl4ai import AsyncWebCrawler
import asyncio

SCHEMA = {
    "type": "function",
    "function": {
        "name": "fetch_url",
        "description": "抓取指定网页的文本内容，返回网页的文本。当用户需要查看网页内容时使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "要抓取的网页地址",
                }
            },
            "required": ["url"],
        },
    },
}

MAX_CHARS = 4000

async def _fetch_url(url: str) -> str:
    """抓取网页内容"""
    try:
        res = await AsyncWebCrawler().arun(url=url)
        return res.markdown or res.html or "（页面没有提取到内容）"[:MAX_CHARS]
    except Exception as e:
        return f"抓取失败：{type(e).__name__}: {str(e)[:200]}"


def run(args: dict) -> str:
    return asyncio.run(_fetch_url(args["url"]))
