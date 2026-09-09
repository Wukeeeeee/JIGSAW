/* ============================================================
   JIGSAW — DOM helpers (tiny hyperscript)
   ============================================================ */
(function () {
  const NS = "http://www.w3.org/2000/svg";

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (k === "html") el.innerHTML = v;
        else el.setAttribute(k, v === true ? "" : v);
      }
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      if (typeof c === "string") {
        // HTML strings come only from Icons.icon() / Markdown.render()
        // (all dynamic text inside them is escaped by the renderers)
        if (c.trim().startsWith("<")) el.insertAdjacentHTML("beforeend", c);
        else el.appendChild(document.createTextNode(c));
      } else el.appendChild(c);
    }
  }

  function svg(tag, attrs, ...children) {
    const el = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
    append(el, children);
    return el;
  }

  function el(selector, root) {
    return (root || document).querySelector(selector);
  }

  const VIEW_CLASSES = ["view-home", "view-chat", "view-workflow", "view-settings"];

  /** swap the view-level class on the app container (single active view) */
  function setViewClass(node, name) {
    VIEW_CLASSES.forEach(c => node.classList.remove(c));
    node.classList.add(name);
  }

  function els(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  /** escape html */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  JIGSAW.h = h;
  JIGSAW.svg = svg;
  JIGSAW.el = el;
  JIGSAW.els = els;
  JIGSAW.esc = esc;
  JIGSAW.setViewClass = setViewClass;
})();
