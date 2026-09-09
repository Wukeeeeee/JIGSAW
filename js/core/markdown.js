/* ============================================================
   JIGSAW — Minimal Markdown renderer (safe, no HTML passthrough)
   Supports: headings, bold, inline code, code blocks, lists,
   blockquote, hr, tables, paragraphs.
   ============================================================ */
(function () {
  const esc = s => JIGSAW.esc(s);

  function inline(text) {
    return esc(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>");
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
    return out.join("\n");
  }

  JIGSAW.Markdown = { render: renderMarkdown };
})();
