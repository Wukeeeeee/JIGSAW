/* ============================================================
   JIGSAW — Minimal Markdown renderer (safe, no HTML passthrough)
   Supports: headings, bold, inline code, code blocks, lists,
   blockquote, hr, tables, paragraphs.
   ============================================================ */
(function () {
  const esc = s => JIGSAW.esc(s);

  function getBackendBaseUrl() {
    try {
      const s = (typeof JIGSAW !== "undefined" && JIGSAW.Store && JIGSAW.Store.get) ? JIGSAW.Store.get().settings : null;
      if (s && s.api && s.api.baseUrl) {
        return s.api.baseUrl.replace(/\/+$/, "");
      }
    } catch (_) {}
    return "http://127.0.0.1:8000";
  }

  function resolveImageSrc(src) {
    if (!src) return "";
    src = src.trim();
    // 1. 网络链接、Base64 或 Blob URL 直接返回
    if (/^(https?:|data:image\/|blob:)/i.test(src)) {
      return src;
    }
    // 2. 本地文件（如 file:///D:/..., D:/..., C:\..., ./output.png, /path/...）
    const base = getBackendBaseUrl();
    let clean = src;
    if (clean.startsWith("file:///")) clean = clean.slice(8);
    else if (clean.startsWith("file://")) clean = clean.slice(7);
    return `${base}/api/files/raw?path=${encodeURIComponent(clean)}`;
  }

  function makeImageHtml(alt, src) {
    const resolved = resolveImageSrc(src);
    const safeAlt = esc(alt || "");
    const safeSrc = esc(resolved);
    const rawSrc = esc(src);
    return `<span class="msg-img-wrap" data-img-src="${safeSrc}" data-raw-src="${rawSrc}" data-alt="${safeAlt}" title="${safeAlt || '点击查看大图'}">` +
      `<img class="msg-img" src="${safeSrc}" alt="${safeAlt}" loading="eager" decoding="async" onerror="this.classList.add('img-error');this.alt='[图片加载失败]'" />` +
      (safeAlt ? `<span class="msg-img-caption">${safeAlt}</span>` : "") +
      `</span>`;
  }

  function inline(text) {
    if (!text) return "";

    // 1. 暂存行内代码 `code`
    const codeBuf = [];
    let processed = text.replace(/`([^`]+)`/g, (_, c) => {
      const idx = codeBuf.length;
      codeBuf.push(`<code>${esc(c)}</code>`);
      return `\u0000CODE${idx}\u0000`;
    });

    // 2. 暂存 HTML <img> 标签（兼容 AI 输出 <img src="..." alt="..." />）
    const imgBuf = [];
    processed = processed.replace(/<img\s+([^>]*?)\/?>/gi, (match, attrs) => {
      const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
      if (!srcMatch) return match;
      const altMatch = attrs.match(/alt=["']([^"']*)["']/i);
      const src = srcMatch[1];
      const alt = altMatch ? altMatch[1] : "";
      const idx = imgBuf.length;
      imgBuf.push(makeImageHtml(alt, src));
      return `\u0000IMG${idx}\u0000`;
    });

    // 3. 暂存 Markdown 图片：![alt](src)
    processed = processed.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
      const idx = imgBuf.length;
      imgBuf.push(makeImageHtml(alt, src));
      return `\u0000IMG${idx}\u0000`;
    });

    // 4. 暂存 Markdown 链接：[text](url)
    const linkBuf = [];
    processed = processed.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
      const idx = linkBuf.length;
      const safeUrl = esc(url);
      linkBuf.push(`<a class="msg-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`);
      return `\u0000LINK${idx}\u0000`;
    });

    // 5. 对剩余文本进行 XSS 安全转义
    processed = esc(processed);

    // 6. 加粗格式化
    processed = processed
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>");

    // 7. 还原暂存的链接、图片和代码
    processed = processed.replace(/\u0000LINK(\d+)\u0000/g, (_, idx) => linkBuf[Number(idx)] || "");
    processed = processed.replace(/\u0000IMG(\d+)\u0000/g, (_, idx) => imgBuf[Number(idx)] || "");
    processed = processed.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => codeBuf[Number(idx)] || "");

    return processed;
  }

  function renderMarkdown(src) {
    const lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0;
    let listStack = []; // 'ul' | 'ol'

    const closeLists = () => {
      while (listStack.length) out.push(`</${listStack.pop()}>`);
    };

    const pushLine = (html) => out.push(html);

    while (i < lines.length) {
      const line = lines[i];

      // fenced code block
      const fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        closeLists();
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // skip closing fence
        pushLine(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
        continue;
      }

      // hr
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { closeLists(); pushLine("<hr>"); i++; continue; }

      // heading
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) { closeLists(); pushLine(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }

      // blockquote
      if (/^>\s?/.test(line)) {
        closeLists();
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(inline(lines[i].replace(/^>\s?/, ""))); i++; }
        pushLine(`<blockquote>${buf.join("<br>")}</blockquote>`);
        continue;
      }

      // list item
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        const kind = ul ? "ul" : "ol";
        if (listStack[listStack.length - 1] !== kind) {
          closeLists();
          listStack.push(kind);
          out.push(`<${kind}>`);
        }
        pushLine(`<li>${inline((ul || ol)[1])}</li>`);
        i++;
        continue;
      }
      if (listStack.length) closeLists();

      // table (pipe row + separator)
      if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        const head = line.split("|").map(c => c.trim()).filter(c => c !== "");
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].includes("|")) {
          rows.push(lines[i].split("|").map(c => c.trim()).filter(c => c !== ""));
          i++;
        }
        let html = "<table><thead><tr>" + head.map(c => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
        for (const r of rows) html += "<tr>" + head.map((_, ci) => `<td>${inline(r[ci] || "")}</td>`).join("") + "</tr>";
        html += "</tbody></table>";
        pushLine(html);
        continue;
      }

      // blank
      if (!line.trim()) { i++; continue; }

      // paragraph: consume consecutive plain lines
      const buf = [inline(line)];
      i++;
      while (i < lines.length && lines[i].trim() && !/^(#{1,3})\s/.test(lines[i]) && !/^\s*[-*+]\s/.test(lines[i]) && !/^\s*\d+[.)]\s/.test(lines[i]) && !/^```/.test(lines[i]) && !/^>\s?/.test(lines[i])) {
        buf.push(inline(lines[i]));
        i++;
      }
      pushLine(`<p>${buf.join("<br>")}</p>`);
    }
    closeLists();
    let rendered = out.join("\n");

    // 智能兜底：如果回答中提到了生成的图片路径（如 E:/.../xxx.png），但模型漏掉了 ![]() 语法
    if (!rendered.includes("msg-img-wrap")) {
      const rawText = String(src || "");
      const pathRegex = /(?:[A-Za-z]:[\\/]|(?:\.\/|\/)backend[\\/]data[\\/]generated_images[\\/])[^\s\n<>`"]+\.(?:png|jpg|jpeg|webp|svg)/gi;
      const matches = rawText.match(pathRegex);
      if (matches && matches.length) {
        const unique = Array.from(new Set(matches));
        const imgBlocks = unique.map(p => `<p>${makeImageHtml("生成图片", p)}</p>`).join("\n");
        rendered += "\n" + imgBlocks;
      }
    }

    return rendered;
  }

  JIGSAW.Markdown = { render: renderMarkdown };
})();
