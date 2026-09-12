/* ============================================================
   JIGSAW — Dropdown（自绘直角下拉）
   替代浏览器原生 <select>：原生弹出面板由操作系统渲染，必带圆角，
   CSS 管不到。这里用按钮 + 绝对定位浮层自绘，保证全直角、黑白灰。
   ============================================================ */
(function () {
  const { h, Icons } = JIGSAW;

  let openMenu = null;

  function closeAll() {
    if (openMenu) { openMenu.classList.add("hidden"); openMenu = null; }
  }
  // 点击页面任意处 → 关闭已打开的下拉
  document.addEventListener("click", () => closeAll(), true);

  function chevron() {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("class", "dd-chev");
    s.setAttribute("width", "12"); s.setAttribute("height", "12");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2"); s.setAttribute("stroke-linecap", "square");
    s.setAttribute("stroke-linejoin", "miter");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", "m6 9 6 6 6-6");
    s.appendChild(p);
    return s;
  }

  /**
   * create(options, selectedId, onChange, st) → 返回自绘下拉元素
   * options: 模型列表 [{ id, name, desc? }]，也可以是“返回列表的函数”
   *          （传函数时每次打开菜单都会重新取数据，添加/删除模型后立即生效）
   * onChange(id) —— 选中时回调
   * st: { minWidth, small, stretch, icon }（icon: 按钮左侧的 SVG 图标名，如 "shield"）
   */
  function create(options, selectedId, onChange, st) {
    st = st || {};
    const wrap = h("div", { class: "dd" + (st.small ? " dd-small" : "") + (st.stretch ? " dd-stretch" : "") }, null);
    if (st.minWidth) wrap.style.minWidth = st.minWidth + "px";
    const btn = h("button", { class: "dd-btn", type: "button" }, null);
    const label = h("span", { class: "dd-label" }, "");
    const menu = h("div", { class: "dd-menu hidden" }, null);
    if (st.icon) btn.insertAdjacentHTML("afterbegin", '<span class="dd-ico">' + Icons.icon(st.icon, 13) + "</span>");
    btn.append(label, chevron());
    wrap.append(btn, menu);

    // 支持“数组”或“函数”两种传法：函数时每次打开取最新
    function current() { return typeof options === "function" ? options() : options; }

    function render() {
      const opts = current();
      menu.innerHTML = "";
      const cur = opts.find(o => o.id === selectedId) || opts[0];
      label.textContent = cur ? cur.name : "选择模型";
      opts.forEach(o => {
        const item = h("button", {
          class: "dd-item" + (o.id === selectedId ? " sel" : ""),
          type: "button"
        }, null);
        item.append(h("span", { class: "dd-name" }, o.name));
        if (o.desc) item.append(h("span", { class: "dd-desc" }, o.desc));
        // 选中项右侧打 √（当前选中）
        if (o.id === selectedId) item.append(h("span", { class: "dd-check" }, Icons.icon("check", 12)));
        item.addEventListener("click", () => {
          selectedId = o.id;
          onChange(o.id);
          closeAll();
          render();
        });
        menu.appendChild(item);
      });
    }

    btn.addEventListener("click", e => {
      e.stopPropagation();
      const opening = menu.classList.contains("hidden");
      closeAll();
      if (opening) {
        render();
        menu.classList.remove("hidden");
        openMenu = menu;
        // 空间不足时向上展开：聊天页输入框贴屏幕底部，向下展开会被截断
        const br = btn.getBoundingClientRect();
        const spaceBelow = window.innerHeight - br.bottom;
        const spaceAbove = br.top;
        menu.style.top = "auto"; menu.style.bottom = "auto";
        if (spaceBelow < menu.offsetHeight + 8 && spaceAbove > spaceBelow) {
          menu.style.bottom = "calc(100% + 4px)";
        } else {
          menu.style.top = "calc(100% + 4px)";
        }
      }
    });

    render();
    return wrap;
  }

  JIGSAW.Dropdown = { create, closeAll };
})();
