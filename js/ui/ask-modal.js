/* ============================================================
   JIGSAW — AskModal（询问用户弹窗）
   AskUser 工具 + 风险确认共用：
   - 普通提问：问题 + 输入框 + 取消/发送
   - 风险确认（opts.risk=true）：⚠ 风险提示样式 + "不再提醒"勾选框
   用户回答后 resolve({ answer, noMore })，取消 resolve(null)。
   黑白灰、直角、1px 细线，与全局设计语言一致。
   ============================================================ */
(function () {
  const { h, el, Icons } = JIGSAW;

  let active = null;   // 当前打开的弹窗（同时只弹一个）

  /**
   * show(question, taskId, opts) → Promise<{answer, noMore} | null>
   * opts: { risk: bool } —— 风险确认模式（显示 ⚠ 和"不再提醒"勾选框）
   */
  function show(question, taskId, opts) {
    opts = opts || {};
    // 已有弹窗 → 直接关掉旧的（防叠层）
    if (active) { active.resolve(null); active.close(); }

    const overlay = h("div", { class: "ask-overlay" }, null);
    const box = h("div", { class: "ask-box" + (opts.risk ? " ask-risk" : "") }, null);
    const title = h("div", { class: "ask-title" },
      opts.risk
        ? (Icons.icon("alert", 13) + " 风险操作确认")
        : "JIGSAW 需要确认");
    const q = h("div", { class: "ask-question" }, question);
    const input = h("input", { class: "ask-input", type: "text",
      placeholder: opts.risk ? "输入“继续”确认，或取消" : "输入回答，或按 Enter 发送…",
      autocomplete: "off" });
    const row = h("div", { class: "ask-actions" }, null);
    const cancel = h("button", { class: "ask-btn", type: "button" }, "取消");
    const ok = h("button", { class: "ask-btn ask-btn-primary", type: "button" },
      opts.risk ? "确认执行" : "发送");
    row.append(cancel, ok);

    // 风险确认模式：底部加"不再提醒"勾选框
    let noMore = false;
    let noMoreEl = null;
    if (opts.risk) {
      noMoreEl = h("label", { class: "ask-nomore" },
        h("input", { type: "checkbox" }),
        h("span", null, "不再提醒：以后遇到此类风险操作直接执行")
      );
      noMoreEl.querySelector("input").addEventListener("change", e => { noMore = e.target.checked; });
      box.append(title, q, input, noMoreEl, row);
    } else {
      box.append(title, q, input, row);
    }
    overlay.append(box);
    document.body.appendChild(overlay);

    let resolved = false;
    function finish(value) {
      if (resolved) return;
      resolved = true;
      overlay.remove();
      if (active === inst) active = null;
      inst.resolve(value);
    }
    const inst = {
      close: () => finish(null),
      resolve: null
    };
    const doOk = () => {
      const v = input.value.trim();
      if (opts.risk) {
        // 风险确认：输入任意确认词（或"继续"）即执行；空输入不响应
        if (!v) return;
        finish({ answer: v, noMore });
      } else {
        if (!v) return;
        finish({ answer: v, noMore: false });
      }
    };
    input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); doOk(); } });
    cancel.addEventListener("click", () => finish(null));
    ok.addEventListener("click", doOk);
    overlay.addEventListener("mousedown", e => { if (e.target === overlay) finish(null); });

    setTimeout(() => input.focus(), 30);
    active = inst;
    return new Promise(res => { inst.resolve = res; });
  }

  JIGSAW.AskModal = { show };
})();
