"""网页搜索工具
用 Crawl4AI 抓取搜索结果页并提取为 Markdown 文本，
比 requests 直接抓 HTML 更可靠（能渲染 JS、去噪、输出正文）。
"""
import asyncio
import urllib.parse

from crawl4ai import AsyncWebCrawler

# 工具的"说明书"（给 LLM 看的）
SCHEMA = {
    "type": "function",
    "function": {
        "name": "websearch",
        "description": "在互联网上搜索指定内容，返回搜索结果页的文本。当用户需要查找最新信息、新闻、网页资料时使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "要搜索的关键词",
                }
            },
            "required": ["query"],
        },
    },
}


MAX_CHARS = 4000


async def _search(query: str) -> str:
    """异步抓取 Bing 搜索结果页"""
    url = f"https://www.bing.com/search?q={urllib.parse.quote(query)}&setlang=zh-CN"
    async with AsyncWebCrawler() as crawler:
        result = await crawler.arun(url=url)
        return result.markdown or result.html or "（页面没有提取到内容）"


def run(args: dict) -> str:
    """执行搜索：注册表 execute() 会按名字调用到这里。"""
    query = (args or {}).get("query", "").strip()
    if not query:
        return "请提供要搜索的内容（query 参数不能为空）。"
    try:
        md = asyncio.run(_search(query))
        md = md.strip()
        if not md:
            return "搜索完成，但没有提取到结果文本。"
        return md[:MAX_CHARS]
    except Exception as e:
        return f"搜索失败：{type(e).__name__}: {str(e)[:200]}"
