/* ============================================================
   JIGSAW — Workflow view
   Canvas: pan / zoom / drag / connect / select / delete.
   Inspector: edit pending (editable) nodes only.
   ============================================================ */
(function () {
  const { h, el, els, svg, Icons } = JIGSAW;
  const Store = JIGSAW.Store;
  const WF = JIGSAW.WorkflowService;
  const EX = JIGSAW.ExecutionService;

  const NODE_W = 252;
  const PORT_Y_OFF = 19; // head center approx (used as fallback)

  let container = null;
  let convId = null;
  let canvas = null;
  let world = null;
  let edgeSvg = null;
  let inspector = null;
  let runBtn = null;
  let resetBtn = null;
  let zoomReadout = null;

  let pan = { x: 80, y: 60 };
  let zoom = 1;
  let heights = new Map(); // nodeId -> px height
  let unsubs = [];

  // interaction state
  let panState = null;
  let dragState = null;
  let connectState = null;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const wf = () => WF.getForConversation(convId);

  /* ---------- transform ---------- */
  function updateTransform() {
    if (!world) return;
    world.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  }

  function zoomAt(sx, sy, factor) {
    const rect = canvas.getBoundingClientRect();
    const mx = sx - rect.left, my = sy - rect.top;
    const nz = clamp(zoom * factor, 0.25, 2.5);
    const wx = (mx - pan.x) / zoom, wy = (my - pan.y) / zoom;
    pan.x = mx - wx * nz;
    pan.y = my - wy * nz;
    zoom = nz;
    updateTransform();
    if (zoomReadout) zoomReadout.textContent = Math.round(zoom * 100) + "%";
  }

  function fitView() {
    const w = wf();
    if (!w || !w.nodes.length) return;
    const rect = canvas.getBoundingClientRect();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    w.nodes.forEach(n => {
      const hh = heights.get(n.id) || 150;
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + NODE_W); maxY = Math.max(maxY, n.y + hh);
    });
    const pad = 80;
    const nz = clamp(Math.min((rect.width - pad * 2) / (maxX - minX), (rect.height - pad * 2) / (maxY - minY)), 0.25, 1.1);
    zoom = nz;
    pan.x = (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom;
    pan.y = (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom;
    updateTransform();
    if (zoomReadout) zoomReadout.textContent = Math.round(zoom * 100) + "%";
  }

  /* ---------- edge geometry ---------- */
  function nodePos(id) {
    const n = wf().nodes.find(x => x.id === id);
    if (!n) return null;
    const hh = heights.get(id) || 150;
    return { x: n.x, y: n.y, h: hh };
  }

  function edgePath(from, to) {
    const a = nodePos(from), b = nodePos(to);
    if (!a || !b) return "";
    const x1 = a.x + NODE_W, y1 = a.y + (a.h || PORT_Y_OFF * 2) / 2;
    const x2 = b.x, y2 = b.y + (b.h || PORT_Y_OFF * 2) / 2;
    const dx = Math.max(48, Math.abs(x2 - x1) * 0.5);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  /* ---------- render ---------- */
  const STATUS_LABEL = { waiting: "等待中", running: "运行中", success: "已完成", failed: "失败" };

  function renderWorkflow() {
    const w = wf();
    if (!world || !w) return;

    // edges
    edgeSvg.innerHTML = "";
    w.edges.forEach(e => {
      const fromNode = w.nodes.find(n => n.id === e.from);
      const toNode = w.nodes.find(n => n.id === e.to);
      const cls = ["wf-edge"];
      if (fromNode && fromNode.status === "success") cls.push("from-success");
      if (toNode && toNode.status === "running") cls.push("to-running");
      edgeSvg.appendChild(svg("path", {
        class: cls.join(" "),
        d: edgePath(e.from, e.to),
        "data-eid": e.id
      }));
    });

    // nodes
    const existing = new Map();
    els(".wf-node", world).forEach(n => existing.set(n.dataset.id, n));
    const seen = new Set();

    w.nodes.forEach(node => {
      seen.add(node.id);
      let nodeEl = existing.get(node.id);
      if (nodeEl) {
        nodeEl.style.left = node.x + "px";
        nodeEl.style.top = node.y + "px";
        patchNodeEl(nodeEl, node, w);
      } else {
        nodeEl = buildNodeEl(node, w);
        world.appendChild(nodeEl);
      }
      heights.set(node.id, nodeEl.offsetHeight || 150);
    });

    existing.forEach((nodeEl, id) => {
      if (!seen.has(id)) { nodeEl.remove(); heights.delete(id); }
    });
  }

  function modelLabel(node) {
    const list = JIGSAW.ModelService.list();
    const m = list.find(x => x.id === node.modelId);
    return m ? m.id : (list.length ? node.modelId : "未配置");
  }

  function statusClass(s) {
    return { waiting: "", running: " running", success: "", failed: " failed" }[s] || "";
  }

  function buildNodeEl(node, w) {
    const editable = WF.isEditable(w, node.id);
    const selected = Store.get().ui.selectedNodeId === node.id;
    const nodeEl = h("div", {
      class: "wf-node" + (editable ? " editable" : " locked") + (selected ? " selected" : "") + statusClass(node.status),
      "data-id": node.id,
      style: { left: node.x + "px", top: node.y + "px", width: NODE_W + "px" }
    },
      h("div", { class: "port in", "data-port": "in" }),
      h("div", { class: "wf-node-head" },
        h("div", { class: "wf-node-icon" }, Icons.icon(node.icon || "dot", 12)),
        h("div", { class: "wf-node-drag" }, h("span", { class: "wf-node-name" }, node.name)),
        h("span", { class: "node-status-badge s-" + node.status, "data-role": "badge" }, STATUS_LABEL[node.status])
      ),
      h("div", { class: "wf-node-body" },
        h("div", { class: "wf-node-desc", "data-role": "desc" }, node.description || ""),
        h("div", { class: "wf-node-model", "data-role": "model" }, h("span", { class: "lbl" }, "MODEL "), modelLabel(node)),
        h("div", { class: "wf-node-tools", "data-role": "tools" }, node.tools.map(t => h("span", { class: "tool-tag" }, t)))
      ),
      h("div", { class: "wf-node-foot" },
        h("button", { class: "icon-btn", "data-del": "1", title: editable ? "删除节点" : "已锁定" },
          Icons.icon("trash", 13))
      ),
      h("div", { class: "port out", "data-port": "out" })
    );
    wireNode(nodeEl, node, w);
    return nodeEl;
  }

  function patchNodeEl(nodeEl, node, w) {
    const editable = WF.isEditable(w, node.id);
    nodeEl.classList.toggle("editable", editable);
    nodeEl.classList.toggle("locked", !editable);
    nodeEl.classList.toggle("selected", Store.get().ui.selectedNodeId === node.id);
    nodeEl.classList.toggle("running", node.status === "running");
    nodeEl.classList.toggle("failed", node.status === "failed");
    el(".wf-node-name", nodeEl).textContent = node.name;
    const badge = el("[data-role=badge]", nodeEl);
    badge.textContent = STATUS_LABEL[node.status];
    badge.className = "node-status-badge s-" + node.status;
    el("[data-role=desc]", nodeEl).textContent = node.description || "";
    el("[data-role=model]", nodeEl).innerHTML = `<span class="lbl">MODEL </span>` + modelLabel(node);
    const tools = el("[data-role=tools]", nodeEl);
    tools.innerHTML = "";
    node.tools.forEach(t => tools.appendChild(h("span", { class: "tool-tag" }, t)));
    const del = el("[data-del]", nodeEl);
    del.title = editable ? "删除节点" : "已锁定";
    // ports visibility by lock
    els(".port", nodeEl).forEach(p => { });
  }

  function wireNode(nodeEl, node, w) {
    // delete
    el("[data-del]", nodeEl).addEventListener("click", e => {
      e.stopPropagation();
      if (!WF.isEditable(w, node.id)) return;
      if (WF.removeNode(w.id, node.id)) JIGSAW.Toast.show("已删除节点");
    });

    // drag + select: whole node (except ports / delete button)
    nodeEl.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      if (e.target.closest(".port") || e.target.closest("[data-del]")) return;
      e.stopPropagation();
      dragState = {
        nodeId: node.id, el: nodeEl,
        startX: e.clientX, startY: e.clientY,
        ox: node.x, oy: node.y, moved: false
      };
      canvas.setPointerCapture(e.pointerId);
      if (WF.isEditable(w, node.id)) nodeEl.classList.add("dragging");
    });

    // connect from output port
    el(".port.out", nodeEl).addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      if (!WF.isEditable(w, node.id)) {
        JIGSAW.Toast.show("节点已锁定，重置后即可连线");
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const a = nodePos(node.id);
      const x1 = a.x + NODE_W, y1 = a.y + a.h / 2;
      const temp = svg("path", { class: "wf-temp-edge", d: `M ${x1} ${y1} L ${x1 + 60} ${y1}` });
      edgeSvg.appendChild(temp);
      connectState = { fromId: node.id, temp, x1, y1 };
      canvas.setPointerCapture(e.pointerId);
    });
  }

  /* ---------- inspector ---------- */
  function renderInspector() {
    if (!inspector) return;
    const w = wf();
    const selId = Store.get().ui.selectedNodeId;
    const node = selId ? w.nodes.find(n => n.id === selId) : null;

    if (!node) {
      inspector.innerHTML = "";
      inspector.appendChild(h("div", { class: "inspector-empty" },
        h("div", null, Icons.icon("panel", 30)),
        h("div", { class: "es-title" }, "未选中 Agent"),
        h("div", { class: "es-sub" }, "选中节点以查看和编辑其配置")
      ));
      return;
    }

    const editable = WF.isEditable(w, node.id);
    const model = JIGSAW.ModelService.get(node.modelId);

    const field = (label, control, extra) => h("div", { class: "field" },
      h("div", { class: "field-label" }, label, extra || ""),
      control
    );

    const nameInput = h("input", { class: "input", type: "text", value: node.name, disabled: editable ? null : true, "data-f": "name" });
    const descInput = h("textarea", { class: "input", rows: "2", value: node.description, disabled: editable ? null : true, "data-f": "description" });
    const sysInput = h("textarea", { class: "input tall", value: node.systemPrompt, disabled: editable ? null : true, "data-f": "systemPrompt" });
    const modelSel = h("select", { class: "select", disabled: editable ? null : true, "data-f": "modelId" });
    JIGSAW.ModelService.populate(modelSel, node.modelId);
    if (!JIGSAW.ModelService.list().length) modelSel.disabled = true;

    const toolsWrap = h("div", { class: "field-tools" });

    // 自定义工具（不在预置列表里的 node.tools 条目）
    const customTools = node.tools.filter(t => !AGENT_TOOL_ORDER.includes(t));
    customTools.forEach(t => {
      const tag = h("span", { class: "tool-tag custom" }, t);
      if (editable) {
        const rm = h("button", { type: "button", class: "tool-rm", title: "移除工具" }, Icons.icon("x", 9));
        rm.addEventListener("click", () => {
          WF.updateNode(w.id, node.id, { tools: node.tools.filter(x => x !== t) });
          renderWorkflow();
        });
        tag.appendChild(rm);
      }
      toolsWrap.appendChild(tag);
    });

    // 预置工具开关
    AGENT_TOOL_ORDER.forEach(t => {
      const on = node.tools.includes(t);
      const chip = h("button", { type: "button", class: "tool-check" + (on ? " on" : ""), disabled: editable ? null : true, "data-tool": t }, t);
      if (editable) chip.addEventListener("click", () => {
        const idx = node.tools.indexOf(t);
        if (idx >= 0) node.tools.splice(idx, 1); else node.tools.push(t);
        WF.updateNode(w.id, node.id, { tools: node.tools.slice() });
        chip.classList.toggle("on", node.tools.includes(t));
        renderWorkflow();
      });
      toolsWrap.appendChild(chip);
    });

    // 添加自定义工具
    if (editable) {
      const add = h("button", { type: "button", class: "tool-add", title: "添加自定义工具" }, Icons.icon("plus-sm", 12));
      add.addEventListener("click", () => {
        const inp = h("input", { class: "tool-input", placeholder: "工具名，回车添加", value: "" });
        const commit = () => {
          const v = inp.value.trim();
          if (v && !node.tools.includes(v)) {
            WF.updateNode(w.id, node.id, { tools: [...node.tools, v] });
            renderWorkflow();
          }
          inp.remove();
          toolsWrap.appendChild(add);
        };
        inp.addEventListener("keydown", e => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") { inp.remove(); toolsWrap.appendChild(add); }
        });
        add.remove();
        toolsWrap.appendChild(inp);
        inp.focus();
      });
      toolsWrap.appendChild(add);
    }

    const ioBox = v => h("div", { class: "io-box" }, v || "—");

    const statusBadge = h("span", { class: "badge badge-" + (node.status === "waiting" ? "waiting" : node.status) }, STATUS_LABEL[node.status]);

    const body = h("div", { class: "inspector-body" },
      !editable ? h("div", { class: "inspector-lock-notice" },
        Icons.icon("lock", 13),
        h("span", null, "该节点已锁定。已完成或运行中的节点不可修改——仅待执行节点可编辑。")
      ) : null,
      field("Agent 名称", nameInput),
      field("描述", descInput),
      field("模型", modelSel),
      field("系统提示词", sysInput),
      field("输入", ioBox(node.input)),
      field("输出", ioBox(node.output)),
      field("工具", toolsWrap),
      h("div", { class: "field" },
        h("div", { class: "field-label" }, "状态"),
        statusBadge
      ),
      editable ? h("div", { class: "inspector-danger" },
        h("button", { class: "btn btn-sm", style: { borderColor: "var(--line-strong)", color: "var(--text-1)", width: "100%" }, "data-del-insp": "1" }, Icons.icon("trash", 13), "删除节点")
      ) : null
    );

    inspector.innerHTML = "";
    inspector.appendChild(h("div", { class: "inspector-head" },
      Icons.icon("sliders", 14),
      h("span", null, "节点检查器")
    ));
    inspector.appendChild(body);

    // wire edits (targeted updates, keep focus)
    els("[data-f]", inspector).forEach(ctrl => {
      ctrl.addEventListener("input", () => {
        if (!editable) return;
        const patch = {};
        patch[ctrl.dataset.f] = ctrl.value;
        WF.updateNode(w.id, node.id, patch);
        renderWorkflow();
      });
      if (ctrl.tagName === "SELECT") ctrl.addEventListener("change", () => {
        WF.updateNode(w.id, node.id, { modelId: ctrl.value });
        renderWorkflow();
      });
    });
    const delBtn = el("[data-del-insp]", inspector);
    if (delBtn) delBtn.addEventListener("click", () => {
      if (WF.removeNode(w.id, node.id)) {
        JIGSAW.Toast.show("已删除节点");
        Store.get().ui.selectedNodeId = null;
        Store.notify("ui");
      }
    });
  }

  /* ---------- topbar ---------- */
  function updateRunBtn() {
    const w = wf();
    if (!runBtn) return;
    if (w.running) {
      runBtn.innerHTML = Icons.icon("x", 13) + "<span>Stop</span>";
      runBtn.disabled = false;
    } else {
      const allDone = w.executed && w.nodes.length && w.nodes.every(n => n.status === "success");
      runBtn.innerHTML = Icons.icon("play", 13) + "<span>" + (allDone ? "再次运行" : "运行") + "</span>";
      runBtn.disabled = false;
    }
    resetBtn.disabled = w.running;
  }

  /* ---------- add node ---------- */
  let addPop = null;

  function addNodeOfType(type) {
    const w = wf();
    if (!w || w.running) return;
    const rect = canvas.getBoundingClientRect();
    const wx = Math.round((rect.left + rect.width / 2 - pan.x) / zoom - 90);
    const wy = Math.round((rect.top + rect.height / 2 - pan.y) / zoom - 40);
    const node = WF.addNode(w.id, type, wx, wy);
    if (!node) return;
    Store.get().ui.selectedNodeId = node.id;
    Store.notify("ui");
    renderWorkflow();
    renderInspector();
    JIGSAW.Toast.show("已添加节点：" + node.name);
  }

  function renderTopbar() {
    const conv = JIGSAW.ChatService.get(convId);
    const tb = el(".wf-topbar", container);
    tb.innerHTML = "";
    const addWrap = h("div", { class: "add-node-wrap" });
    const addBtn = h("button", { class: "btn btn-sm", "data-add-node": "1", title: "添加新节点" }, Icons.icon("plus-sm", 13), "添加节点");
    const pop = h("div", { class: "wf-popover" });
    addPop = pop;
    addWrap.append(addBtn, pop);
    addBtn.addEventListener("click", e => {
      e.stopPropagation();
      if (wf().running) { JIGSAW.Toast.show("运行中不可修改画布"); return; }
      const open = pop.classList.toggle("open");
      if (open && !pop.children.length) {
        WF.templates().forEach(t => {
          const item = h("button", { class: "wf-pop-item", "data-type": t.type },
            Icons.icon(t.icon, 14),
            h("span", { class: "wpi-text" },
              h("span", { class: "wpi-name" }, t.name),
              h("span", { class: "wpi-desc" }, t.desc)
            )
          );
          item.addEventListener("click", () => {
            pop.classList.remove("open");
            addNodeOfType(t.type);
          });
          pop.appendChild(item);
        });
      }
    });
    tb.append(
      h("button", { class: "icon-btn", "data-back": "1", title: "返回对话" }, Icons.icon("back")),
      h("div", { class: "topbar-title", style: { marginLeft: "var(--sp-1)" } }, "工作流"),
      h("div", { class: "topbar-spacer" }),
      h("div", { class: "legend", style: { marginRight: "var(--sp-3)" } },
        h("span", { class: "legend-item" }, h("span", { class: "legend-swatch s-waiting" }), "等待中"),
        h("span", { class: "legend-item" }, h("span", { class: "legend-swatch s-running" }), "运行中"),
        h("span", { class: "legend-item" }, h("span", { class: "legend-swatch s-success" }), "已完成"),
        h("span", { class: "legend-item" }, h("span", { class: "legend-swatch s-failed" }), "失败")
      ),
      h("div", { class: "topbar", style: { border: "none", padding: "0", gap: "var(--sp-2)" } },
        addWrap,
        resetBtn = h("button", { class: "btn btn-sm", "data-reset": "1", title: "重置并解锁全部节点" }, Icons.icon("reset", 13), "重置"),
        runBtn = h("button", { class: "btn btn-sm btn-primary", "data-run": "1" })
      )
    );
    el("[data-back]", tb).addEventListener("click", () => JIGSAW.Router.navigate("/chat/" + convId));
    resetBtn.addEventListener("click", () => { WF.reset(wf().id); updateRunBtn(); renderWorkflow(); renderInspector(); });
    runBtn.addEventListener("click", () => {
      const w = wf();
      if (w.running) { EX.stop(convId); updateRunBtn(); return; }
      EX.start(convId).then(() => {
        JIGSAW.Toast.show("工作流执行完成");
        updateRunBtn();
      });
    });
    updateRunBtn();
  }

  function renderControls() {
    const ctl = el(".wf-controls", container);
    ctl.innerHTML = "";
    const minus = h("button", { class: "icon-btn", "data-zoom": "-", title: "缩小" }, Icons.icon("zoom-out", 14));
    zoomReadout = h("span", { class: "wf-zoom-readout" }, Math.round(zoom * 100) + "%");
    const plus = h("button", { class: "icon-btn", "data-zoom": "+", title: "放大" }, Icons.icon("zoom-in", 14));
    const fit = h("button", { class: "icon-btn wf-fit", "data-zoom": "fit", title: "适应视图" }, Icons.icon("fit", 14));
    ctl.append(minus, zoomReadout, plus, fit);
    els("[data-zoom]", ctl).forEach(b => b.addEventListener("click", () => {
      const r = canvas.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (b.dataset.zoom === "+") zoomAt(cx, cy, 1.25);
      else if (b.dataset.zoom === "-") zoomAt(cx, cy, 0.8);
      else fitView();
    }));
  }

  /* ---------- canvas events ---------- */
  function wireCanvas() {
    canvas.addEventListener("wheel", e => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0016));
    }, { passive: false });

    canvas.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      if (e.target.closest(".wf-node") || e.target.closest(".port")) return;
      panState = { startX: e.clientX, startY: e.clientY, px: pan.x, py: pan.y, moved: false };
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add("panning");
    });

    canvas.addEventListener("pointermove", e => {
      if (dragState) {
        const dx = (e.clientX - dragState.startX) / zoom;
        const dy = (e.clientY - dragState.startY) / zoom;
        if (Math.abs(e.clientX - dragState.startX) + Math.abs(e.clientY - dragState.startY) > 2) dragState.moved = true;
        const node = wf().nodes.find(n => n.id === dragState.nodeId);
        if (node) {
          node.x = Math.round(dragState.ox + dx);
          node.y = Math.round(dragState.oy + dy);
          dragState.el.style.left = node.x + "px";
          dragState.el.style.top = node.y + "px";
          updateEdgesForNode(node.id);
        }
        return;
      }
      if (connectState) {
        const rect = canvas.getBoundingClientRect();
        const wx = (e.clientX - rect.left - pan.x) / zoom;
        const wy = (e.clientY - rect.top - pan.y) / zoom;
        connectState.temp.setAttribute("d", `M ${connectState.x1} ${connectState.y1} C ${(connectState.x1 + wx) / 2} ${connectState.y1}, ${(connectState.x1 + wx) / 2} ${wy}, ${wx} ${wy}`);
        return;
      }
      if (panState) {
        pan.x = panState.px + (e.clientX - panState.startX);
        pan.y = panState.py + (e.clientY - panState.startY);
        if (Math.abs(e.clientX - panState.startX) + Math.abs(e.clientY - panState.startY) > 2) panState.moved = true;
        updateTransform();
      }
    });

    const endPointer = e => {
      if (dragState) {
        if (dragState.moved) {
          const node = wf().nodes.find(n => n.id === dragState.nodeId);
          if (node) WF.moveNode(wf().id, node.id, node.x, node.y);
        } else {
          // plain click → select the node
          Store.get().ui.selectedNodeId = dragState.nodeId;
          Store.notify("ui");
        }
        dragState.el.classList.remove("dragging");
        dragState = null;
      }
      if (connectState) {
        const { fromId, temp } = connectState;
        temp.remove();
        connectState = null;
        const target = document.elementFromPoint(e.clientX, e.clientY);
        const portIn = target && target.closest ? target.closest(".port.in") : null;
        if (portIn) {
          const toNode = portIn.closest(".wf-node");
          if (toNode) {
            const ok = WF.addEdge(wf().id, fromId, toNode.dataset.id);
            if (ok) JIGSAW.Toast.show("已添加连线");
          }
        }
      }
      if (panState) {
        const wasMoved = panState.moved;
        panState = null;
        canvas.classList.remove("panning");
        if (!wasMoved) {
          // background click → deselect
          Store.get().ui.selectedNodeId = null;
          Store.notify("ui");
        }
      }
    };
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);
  }

  function updateEdgesForNode(nodeId) {
    const w = wf();
    els(".wf-edge", edgeSvg).forEach(path => {
      const edge = w.edges.find(ed => ed.id === path.dataset.eid);
      if (edge && (edge.from === nodeId || edge.to === nodeId)) {
        path.setAttribute("d", edgePath(edge.from, edge.to));
      }
    });
  }

  /* ---------- keyboard ---------- */
  function onKey(e) {
    if (e.key === "Delete" || e.key === "Backspace") {
      const sel = Store.get().ui.selectedNodeId;
      if (sel && wf()) {
        e.preventDefault();
        if (WF.removeNode(wf().id, sel)) JIGSAW.Toast.show("已删除节点");
        Store.get().ui.selectedNodeId = null;
        Store.notify("ui");
      }
    } else if (e.key === "Escape") {
      if (Store.get().ui.selectedNodeId) { Store.get().ui.selectedNodeId = null; Store.notify("ui"); }
      else JIGSAW.HistoryDrawer.close();
    }
  }

  /* ---------- view ---------- */
  const Workflow = {
    mount(root, params) {
      container = root;
      convId = params.id;
      const conv = JIGSAW.ChatService.get(convId);
      if (!conv) { JIGSAW.Router.navigate("/"); return; }
      Store.set({ activeConversationId: convId });

      root.innerHTML = "";
      JIGSAW.setViewClass(root, "view-workflow");

      const topbar = h("div", { class: "topbar wf-topbar" });
      canvas = h("div", { class: "wf-canvas" });
      world = h("div", { class: "wf-world" });
      edgeSvg = h("svg", { class: "wf-svg", width: "20000", height: "20000" });
      world.appendChild(edgeSvg);
      canvas.append(world,
        h("div", { class: "wf-controls" }),
        h("div", { class: "wf-hint" },
          h("span", null, "拖拽节点"),
          h("kbd", null, "滚轮"),
          h("span", null, "缩放"),
          h("kbd", null, "拖拽画布"),
          h("span", null, "平移"),
          h("span", null, "· 连接端口")
        )
      );
      inspector = h("div", { class: "wf-inspector" });
      root.append(topbar, h("div", { class: "wf-body" }, canvas, inspector));

      renderTopbar();
      renderControls();

      // initial layout
      heights.clear();
      const w = wf();
      w.nodes.forEach(n => { heights.set(n.id, 150); });
      renderWorkflow();
      renderInspector();
      fitView();

      wireCanvas();
      window.addEventListener("keydown", onKey);
      const closePop = e => { if (addPop && !e.target.closest(".add-node-wrap")) addPop.classList.remove("open"); };
      document.addEventListener("click", closePop);
      unsubs = [
        Store.subscribe("workflows", () => {
          renderWorkflow();
          renderInspector();
          updateRunBtn();
        }),
        Store.subscribe("ui", () => {
          renderWorkflow();
          renderInspector();
        })
      ];
      this.__closePop = closePop;
    },

    unmount() {
      unsubs.forEach(u => u());
      unsubs = [];
      window.removeEventListener("keydown", onKey);
      if (this.__closePop) document.removeEventListener("click", this.__closePop);
      panState = dragState = connectState = null;
      pan = { x: 80, y: 60 };
      zoom = 1;
      heights.clear();
    }
  };

  const AGENT_TOOL_ORDER = ["web_search", "fetch_url", "read_doc", "code_interpreter", "data_frame", "math", "editor", "style_check", "review", "merge", "file_ingest", "api_fetch", "catalog", "gdal", "rasterio", "shapely", "renderer", "style_lib"];

  JIGSAW.Views = JIGSAW.Views || {};
  JIGSAW.Views.Workflow = Workflow;
})();
