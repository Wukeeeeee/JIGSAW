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
        "description": "在互联网上并发搜索内容（Bing），返回各搜索结果的文本。可一次传入多条 query（并发执行，最多 5 条）。当用户需要查找最新信息、新闻、网页资料、或需要对比多个关键词的结果时使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "queries": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "要搜索的关键词数组，可同时放多条查询（并发执行，建议不超过 5 条）",
                }
            },
            "required": ["queries"],
        },
    },
}


MAX_CHARS = 4000

# 并发上限
CONCURRENCY = 5


async def _single_bing_search(query: str, sem: asyncio.Semaphore):
    """单个query的bing搜索任务，加信号量限流"""
    async with sem:
        url = f"https://www.bing.com/search?q={urllib.parse.quote(query)}&setlang=zh-CN"
        async with AsyncWebCrawler() as crawler:
            result = await crawler.arun(url=url)
            content = result.markdown or result.html or "（页面没有提取到内容）"
            return {"query": query, "content": content[:MAX_CHARS]}


async def _search(queries: list[str]) -> str:
    """并发执行多条bing搜索，汇总所有结果返回"""
    # ★ 信号量必须"每次调用新建"：模块级的 Semaphore 会被跨 asyncio.run() 复用，
    #   而 run() 每次都建新的事件循环；一旦并发真的排队（query 数 > 上限），
    #   信号量就会绑定到上一个已关闭的 loop 并抛
    #   RuntimeError: ... is bound to a different event loop（第二次调用必崩）。
    sem = asyncio.Semaphore(CONCURRENCY)
    tasks = [_single_bing_search(q, sem) for q in queries]
    # 并发执行，单个失败不中断全部
    results = await asyncio.gather(*tasks, return_exceptions=True)

    output_parts = []
    for item in results:
        if isinstance(item, Exception):
            output_parts.append(f"【查询失败】{str(item)[:200]}")
        else:
            output_parts.append(f"==== Query: {item['query']} ====\n{item['content']}")
    return "\n\n".join(output_parts)

def run(args: dict) -> str:
    """工具入口：参数改成接收 queries 数组"""
    # 【重点】tool参数现在是 queries: list，不是单个query字符串
    queries = (args or {}).get("queries", [])
    if not isinstance(queries, list) or len(queries) == 0:
        return "请提供queries数组，至少一条搜索query。"
    try:
        combined_md = asyncio.run(_search(queries))
        return combined_md[:MAX_CHARS * len(queries)]
    except Exception as e:
        return f"批量搜索失败：{type(e).__name__}: {str(e)[:200]}"
