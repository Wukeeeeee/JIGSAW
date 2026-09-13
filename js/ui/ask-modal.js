/* ============================================================
   JIGSAW — AskModal（询问用户弹窗）
   AskUser 工具 + 风险确认共用：
   - 普通提问：问题 + (可点选项) + 输入框 + 取消/发送
   - 风险确认（opts.risk=true）：⚠ 风险提示样式 + "不再提醒"勾选框
   用户回答后 resolve({ answer, noMore })，取消 resolve(null)。
   黑白灰、直角、1px 细线，与全局设计语言一致。
   ============================================================ */
(function () {
  const { h, el, Icons } = JIGSAW;

  let active = null;   // 当前打开的弹窗（同时只弹一个）

  const LETTERS = "ABCD";

  /**
   * show(question, taskId, opts) → Promise<{answer, noMore} | null>
   * opts: {
   *   risk: bool,        // 风险确认模式（显示 ⚠ 和"不再提醒"勾选框）
   *   options: string[]  // 可点选答案（最多 4 项），渲染成按钮，点一下直接回答
   * }
   */
  function show(question, taskId, opts) {
    opts = opts || {};
    const options = (Array.isArray(opts.options) ? opts.options : [])
      .map(o => String(o == null ? "" : o).trim())
      .filter(Boolean)
      .slice(0, LETTERS.length);
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
      placeholder: opts.risk
        ? "可直接点「确认执行」，或输入说明后确认"
        : (options.length ? "也可以自己输入其它回答…" : "输入回答，或按 Enter 发送…"),
      autocomplete: "off" });
    const row = h("div", { class: "ask-actions" }, null);
    const cancel = h("button", { class: "ask-btn", type: "button" }, "取消");
    const ok = h("button", { class: "ask-btn ask-btn-primary", type: "button" },
      opts.risk ? "确认执行" : "发送");
    row.append(cancel, ok);

    // 可点选项（有 options 时）：点一项即等于回答该项
    let optionsEl = null;
    if (options.length && !opts.risk) {
      optionsEl = h("div", { class: "ask-options" }, null);
      options.forEach((text, i) => {
        const btn = h("button", { class: "ask-option", type: "button",
          title: "选择：" + text },
          h("span", { class: "ask-option-key" }, LETTERS[i] || String(i + 1)),
          h("span", { class: "ask-option-text" }, text)
        );
        btn.addEventListener("click", () => finishAnswer(text, false));
        optionsEl.appendChild(btn);
      });
    }

    // 风险确认模式：底部加"不再提醒"勾选框（直接持有元素引用，不靠 querySelector）
    let noMore = false;
    let noMoreEl = null;
    if (opts.risk) {
      const cb = h("input", { type: "checkbox" });
      cb.addEventListener("change", e => { noMore = e.target.checked; });
      noMoreEl = h("label", { class: "ask-nomore" },
        cb,
        h("span", null, "不再提醒：以后遇到此类风险操作直接执行")
      );
    }

    box.append(title, q);
    if (optionsEl) box.append(optionsEl);
    box.append(input);
    if (noMoreEl) box.append(noMoreEl);
    box.append(row);
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
    /** 点选项 / 提交输入框都走这里 */
    function finishAnswer(answer, withNoMore) {
      finish({ answer, noMore: !!withNoMore });
    }
    const inst = {
      close: () => finish(null),
      resolve: null
    };
    const doOk = () => {
      const v = input.value.trim();
      if (opts.risk) {
        // 风险确认：直接点"确认执行"即视为确认（避免空输入点了没反应）；
        // 输入了内容则以输入内容作为回答。
        finishAnswer(v || "继续执行", noMore);
      } else {
        if (!v) return;
        finishAnswer(v, false);
      }
    };
    input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); doOk(); } });
    cancel.addEventListener("click", () => finish(null));
    ok.addEventListener("click", doOk);
    // 注意：AI 挂起在等你回答，点遮罩不算回答 —— 不做"点空白即取消"，
    // 否则容易误触把正在跑的任务悄悄取消掉。请用「取消」按钮明确表达。

    // 有选项时默认聚焦输入框意义不大，就不抢焦点了
    if (!options.length) setTimeout(() => input.focus(), 30);
    active = inst;
    return new Promise(res => { inst.resolve = res; });
  }

  JIGSAW.AskModal = { show };
})();
