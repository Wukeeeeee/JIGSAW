/* ============================================================
   JIGSAW — PromptModal（通用输入/确认弹窗）
   替代 window.prompt / window.confirm（Electron 里被禁用，点了没反应）。
   - prompt(opts)  → Promise<string | null>   输入框
   - confirm(opts) → Promise<boolean>         确认
   复用 AskModal 的 ask-* 视觉（黑白灰、直角、1px 细线）。
   ============================================================ */
(function () {
  const { h, el, Icons } = JIGSAW;

  let active = null;   // 同时只弹一个

  function open(build) {
    if (active) { active.finish(null); }

    const overlay = h("div", { class: "ask-overlay" }, null);
    const box = h("div", { class: "ask-box" }, null);
    overlay.append(box);
    document.body.appendChild(overlay);

    let resolved = false;
    const inst = {
      finish(v) {
        if (resolved) return;
        resolved = true;
        overlay.remove();
        if (active === inst) active = null;
        inst.resolve(v);
      }
    };
    overlay.addEventListener("mousedown", e => { if (e.target === overlay) inst.finish(null); });
    active = inst;
    return new Promise(res => {
      inst.resolve = res;
      build(box, inst);
    });
  }

  /**
   * prompt({ title, placeholder, initial, okText }) → Promise<string|null>
   */
  function prompt(opts) {
    return open((box, inst) => {
      const title = h("div", { class: "ask-title" },
        Icons.icon("message", 13), opts.title || "输入");
      const input = h("input", { class: "ask-input", type: "text",
        placeholder: opts.placeholder || "",
        value: opts.initial || "", autocomplete: "off" });
      const row = h("div", { class: "ask-actions" }, null);
      const cancel = h("button", { class: "ask-btn", type: "button" }, "取消");
      const ok = h("button", { class: "ask-btn ask-btn-primary", type: "button" }, opts.okText || "确定");
      row.append(cancel, ok);
      box.append(title, input, row);

      const doOk = () => {
        const v = input.value.trim();
        if (!v) return;
        inst.finish(v);
      };
      input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); doOk(); } });
      cancel.addEventListener("click", () => inst.finish(null));
      ok.addEventListener("click", doOk);
      setTimeout(() => { input.focus(); input.select(); }, 30);
    });
  }

  /**
   * confirm({ title, message, okText, danger }) → Promise<boolean>
   */
  function confirm(opts) {
    return open((box, inst) => {
      const title = h("div", { class: "ask-title" },
        opts.danger ? Icons.icon("alert", 13) : Icons.icon("alert", 13),
        opts.title || "确认");
      const msg = h("div", { class: "ask-question" }, opts.message || "");
      const row = h("div", { class: "ask-actions" }, null);
      const cancel = h("button", { class: "ask-btn", type: "button" }, "取消");
      const ok = h("button", { class: "ask-btn" + (opts.danger ? " ask-btn-danger" : " ask-btn-primary"), type: "button" },
        opts.okText || (opts.danger ? "删除" : "确定"));
      row.append(cancel, ok);
      box.append(title, msg, row);

      cancel.addEventListener("click", () => inst.finish(false));
      ok.addEventListener("click", () => inst.finish(true));
    });
  }

  JIGSAW.PromptModal = { prompt, confirm };
})();
