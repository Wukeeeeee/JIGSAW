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

  /* ---------- edge geometry (Orthogonal Straight Edges + Subtle Rounded Bends) ---------- */
  const CORNER_RADIUS = 10; // 默认 8–12px，硬朗克制的小圆角转角

  function nodePos(id) {
    const n = wf().nodes.find(x => x.id === id);
    if (!n) return null;
    const hh = heights.get(id) || 150;
    return {
      x: n.x, y: n.y, h: hh, w: NODE_W,
      top: n.y, bottom: n.y + hh,
      left: n.x, right: n.x + NODE_W
    };
  }

  /**
   * 将一系列正交折线点转换成在 90° 拐角处带有轻微圆角的 SVG path
   * 所有线段绝对保持纯水平或纯垂直（笔直），只有转折处产生微小圆角
   */
  function roundedOrthogonalPath(pts, radius = CORNER_RADIUS) {
    if (!pts || pts.length < 2) return "";
    if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;

    let d = `M ${pts[0].x} ${pts[0].y}`;

    for (let i = 1; i < pts.length - 1; i++) {
      const prev = pts[i - 1];
      const curr = pts[i];
      const next = pts[i + 1];

      const v1x = prev.x - curr.x;
      const v1y = prev.y - curr.y;
      const v2x = next.x - curr.x;
      const v2y = next.y - curr.y;

      const len1 = Math.hypot(v1x, v1y);
      const len2 = Math.hypot(v2x, v2y);

      if (len1 < 1 || len2 < 1) continue;

      // 允许的最大圆角半径不超过相邻线段长度的一半
      const r = Math.min(radius, len1 / 2, len2 / 2);

      const startX = curr.x + (v1x / len1) * r;
      const startY = curr.y + (v1y / len1) * r;
      const endX = curr.x + (v2x / len2) * r;
      const endY = curr.y + (v2y / len2) * r;

      // 直线走到圆角起点，然后用二阶贝塞尔转弯至圆角终点
      d += ` L ${startX} ${startY} Q ${curr.x} ${curr.y}, ${endX} ${endY}`;
    }

    const last = pts[pts.length - 1];
    d += ` L ${last.x} ${last.y}`;
    return d;
  }

  /**
   * 智能避障正交布线算法：计算从节点 a 到节点 b 的曼哈顿折线点序列
   * 核心准则：不穿透卡片本身，必要时走外围安全通道（Bypass Corridor）
   */
  function getOrthogonalPoints(a, b, isLoop = false) {
    const x1 = a.right;
    const y1 = a.top + (a.h || PORT_Y_OFF * 2) / 2;
    const x2 = b.left;
    const y2 = b.top + (b.h || PORT_Y_OFF * 2) / 2;

    // 1. 水平基本共线且向前无遮挡：一条干净的纯水平线
    if (Math.abs(y1 - y2) <= 1 && x2 >= x1 + 16 && !isLoop) {
      return [{ x: x1, y: y1 }, { x: x2, y: y2 }];
    }

    // 2. 正向且两卡片水平留有安全布线通道 (x2 >= x1 + 44) 且非回环
    if (x2 >= x1 + 44 && !isLoop) {
      const midX = Math.round((x1 + x2) / 2);
      return [
        { x: x1, y: y1 },
        { x: midX, y: y1 },
        { x: midX, y: y2 },
        { x: x2, y: y2 }
      ];
    }

    // 3. 复杂重叠/反向/回环场景（目标在源左侧、或者垂直段会撞卡片）：走外围安全走廊
    const stubOut = 24; // 从 a 右侧探出的安全引线
    const stubIn = 24;  // 向 b 左侧切入的安全引线
    const pOutX = x1 + stubOut;
    const pInX = x2 - stubIn;

    // 计算两卡片之间的垂直净空
    const gapBelowA = b.top - a.bottom; // b 在 a 下方时的垂直净空间隙
    const gapAboveA = a.top - b.bottom; // b 在 a 上方时的垂直净空间隙

    let corridorY;
    if (gapBelowA >= 36 && b.left <= x1 + 40) {
      // b 在 a 下方且有空档：穿行于 a 底部和 b 顶部之间的中线
      corridorY = Math.round((a.bottom + b.top) / 2);
    } else if (gapAboveA >= 36 && b.left <= x1 + 40) {
      // b 在 a 上方且有空档：穿行于 b 底部和 a 顶部之间的中线
      corridorY = Math.round((b.bottom + a.top) / 2);
    } else {
      // 垂直高度有交叠或靠得太近：走彻底避开两节点的外部上下走廊（保留 28px 外围安全边距）
      const topBypass = Math.min(a.top, b.top) - 28;
      const botBypass = Math.max(a.bottom, b.bottom) + 28;
      // 如果目标在上方，走顶部走廊；目标在下方，走底部走廊
      corridorY = (y2 < y1) ? topBypass : botBypass;
    }

    return [
      { x: x1, y: y1 },
      { x: pOutX, y: y1 },
      { x: pOutX, y: corridorY },
      { x: pInX, y: corridorY },
      { x: pInX, y: y2 },
      { x: x2, y: y2 }
    ];
  }

  /** 拖拽连线时的临时正交线生成（智能避开源节点卡片） */
  function getTempOrthogonalPoints(fromBox, wx, wy) {
    const x1 = fromBox ? fromBox.right : 0;
    const y1 = fromBox ? (fromBox.top + (fromBox.h || PORT_Y_OFF * 2) / 2) : 0;
    if (wx >= x1 + 32) {
      const midX = Math.round((x1 + wx) / 2);
      return [
        { x: x1, y: y1 },
        { x: midX, y: y1 },
        { x: midX, y: wy },
        { x: wx, y: wy }
      ];
    }
    const pOutX = x1 + 24;
    const pInX = wx - 20;
    const routeY = fromBox
      ? ((wy >= y1) ? Math.max(fromBox.bottom + 28, wy + 20) : Math.min(fromBox.top - 28, wy - 20))
      : (wy >= y1 ? wy + 40 : wy - 40);
    return [
      { x: x1, y: y1 },
      { x: pOutX, y: y1 },
      { x: pOutX, routeY },
      { x: pInX, routeY },
      { x: pInX, y: wy },
      { x: wx, y: wy }
    ];
  }

  function edgePath(from, to, isLoop = false) {
    const a = nodePos(from), b = nodePos(to);
    if (!a || !b) return "";
    const pts = getOrthogonalPoints(a, b, isLoop);
    return roundedOrthogonalPath(pts, CORNER_RADIUS);
  }

  function getEdgeMidPoint(from, to, isLoop = false) {
    const a = nodePos(from), b = nodePos(to);
    if (!a || !b) return null;
    const pts = getOrthogonalPoints(a, b, isLoop);
    if (!pts || pts.length < 2) return null;
    if (pts.length === 2) {
      return { x: Math.round((pts[0].x + pts[1].x) / 2), y: Math.round((pts[0].y + pts[1].y) / 2) };
    }
    const midIdx = Math.floor((pts.length - 1) / 2);
    const pA = pts[midIdx], pB = pts[midIdx + 1];
    return { x: Math.round((pA.x + pB.x) / 2), y: Math.round((pA.y + pB.y) / 2) };
  }

  /* ---------- render ---------- */
  const STATUS_LABEL = { waiting: "等待中", running: "运行中", success: "已完成", failed: "失败", skipped: "已跳过" };

  function renderWorkflow() {
    const w = wf();
    if (!world || !w) return;

    // 清理旧的连线删除按钮
    els(".wf-edge-del-wrap", world).forEach(b => b.remove());

    const selEdgeId = Store.get().ui.selectedEdgeId;

    // edges（只清空连线层，保留 defs 里的 marker）
    const edgesGroup = el(".wf-edges-layer", edgeSvg) || edgeSvg;
    while (edgesGroup.firstChild) edgesGroup.removeChild(edgesGroup.firstChild);
    w.edges.forEach(e => {
      const fromNode = w.nodes.find(n => n.id === e.from);
      const toNode = w.nodes.find(n => n.id === e.to);
      const isSelected = selEdgeId === e.id;
      const cls = ["wf-edge"];
      if (isSelected) cls.push("selected");
      if (e.isLoop) cls.push("is-loop");
      if (fromNode && fromNode.status === "success") cls.push("from-success");
      if (fromNode && fromNode.status === "skipped") cls.push("from-skipped");
      if (toNode && toNode.status === "running") cls.push("to-running");

      const pathD = edgePath(e.from, e.to, !!e.isLoop);
      edgesGroup.appendChild(svg("path", {
        class: cls.join(" "),
        d: pathD,
        "data-eid": e.id
      }));

      // 透明命中粗线，方便鼠标轻松点中连线
      const hitBox = svg("path", {
        class: "wf-edge-hitbox",
        d: pathD,
        "data-eid": e.id
      });
      hitBox.addEventListener("pointerdown", ev => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        Store.get().ui.selectedEdgeId = e.id;
        Store.get().ui.selectedNodeId = null;
        renderWorkflow();
        renderInspector();
      });
      edgesGroup.appendChild(hitBox);

      // 如果当前连线被选中，在其正交中点渲染删除按钮 [×]
      if (isSelected && !w.running) {
        const mid = getEdgeMidPoint(e.from, e.to, !!e.isLoop);
        if (mid) {
          const delWrap = h("div", {
            class: "wf-edge-del-wrap",
            style: { left: mid.x + "px", top: mid.y + "px" }
          },
            h("button", {
              type: "button",
              class: "wf-edge-del-btn",
              title: "删除连线（或按 Delete / Backspace）",
              "data-eid": e.id
            }, Icons.icon("x", 11))
          );
          const delBtn = delWrap.querySelector("button");

          const handleDelete = ev => {
            ev.stopPropagation();
            ev.preventDefault();
            if (WF.removeEdge(w.id, e.id)) {
              JIGSAW.Toast.show("已删除连线");
              Store.get().ui.selectedEdgeId = null;
              renderWorkflow();
            }
          };

          // 彻底阻止点击删除按钮时触发画布的抓取或取消选中逻辑
          delWrap.addEventListener("pointerdown", ev => ev.stopPropagation());
          delWrap.addEventListener("pointerup", ev => ev.stopPropagation());
          delWrap.addEventListener("click", ev => ev.stopPropagation());

          delBtn.addEventListener("pointerdown", ev => ev.stopPropagation());
          delBtn.addEventListener("pointerup", ev => ev.stopPropagation());
          delBtn.addEventListener("click", handleDelete);

          world.appendChild(delWrap);
        }
      }
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
    return m ? m.name : (list.length ? "未选择模型" : "未配置模型");
  }

  /* ---------- 工具：一律用后端真实注册的工具，不再写死假名字 ---------- */
  /** 真实工具列表（后端 /api/tools，ToolService 缓存） */
  function realTools() { return JIGSAW.ToolService.list() || []; }

  /** 工具的中文名（工具广场 / 气泡标签用的是同一份元数据） */
  function toolMeta(name) { return JIGSAW.ToolService.getMeta(name); }
  function toolLabel(name) {
    const m = toolMeta(name);
    return m ? (m.label || name) : name;      // 未注册的旧数据：原样显示
  }
  function toolIcon(name) {
    const m = toolMeta(name);
    return (m && m.icon) || "tool";
  }
  function isRealTool(name) { return !!toolMeta(name); }

  /** 节点卡片上的工具标签行 */
  function toolsRow(node) {
    if (!node.tools || !node.tools.length) {
      return h("div", { class: "wf-node-tools", "data-role": "tools" },
        h("span", { class: "tool-none" }, "未分配工具"));
    }
    return h("div", { class: "wf-node-tools", "data-role": "tools" },
      node.tools.map(t => h("span", { class: "tool-tag" + (isRealTool(t) ? "" : " unknown") },
        h("span", { class: "tool-tag-ico" }, Icons.icon(toolIcon(t), 9)),
        h("span", null, toolLabel(t))
      ))
    );
  }

  function statusClass(s) {
    return { waiting: "", running: " running", success: "", failed: " failed", skipped: " skipped" }[s] || "";
  }

  function isLogicNode(node) {
    return node.category === "logic" || ["start", "gate_and", "gate_or", "gate_not", "condition_if", "loop_ctrl", "try_catch"].includes(node.agentType);
  }

  function logicBadgeText(node) {
    if (node.agentType === "start") return "TRIGGER · 任务输入起点";
    if (node.agentType === "gate_and") return "GATE · 与门 (AND 汇聚)";
    if (node.agentType === "gate_or") return "GATE · 或门 (OR 竞争)";
    if (node.agentType === "gate_not") return "GATE · 非门 (NOT 取反)";
    if (node.agentType === "condition_if") return "BRANCH · 条件分支 (IF)";
    if (node.agentType === "loop_ctrl") return `LOOP · 循环闭环 (上限 ${node.loopMax || 3} 轮)`;
    if (node.agentType === "try_catch") return "GUARD · 异常守护 (Try-Catch)";
    return "LOGIC · 控制门";
  }

  function toleranceBadge(node) {
    if (!node.onError || node.onError === "abort") return null;
    const isSkip = node.onError === "skip";
    return h("div", {
      class: "wf-node-tolerance",
      "data-role": "tolerance",
      title: isSkip ? "容错策略：失败时自动跳过并放行后续流程" : "容错策略：失败时注入预设兜底数据"
    },
      Icons.icon(isSkip ? "skip" : "shield", 10),
      h("span", null, isSkip ? "容错: 自动跳过" : "容错: 注入兜底")
    );
  }

  function buildNodeEl(node, w) {
    const isStart = node.agentType === "start";
    const editable = WF.isEditable(w, node.id) && !isStart;
    const selected = Store.get().ui.selectedNodeId === node.id;
    const isLogic = isLogicNode(node);
    const tolEl = toleranceBadge(node);
    const nodeEl = h("div", {
      class: "wf-node" + (isStart ? " node-start" : "") + (isLogic ? " node-logic" : "") + (editable ? " editable" : " locked") + (selected ? " selected" : "") + statusClass(node.status),
      "data-id": node.id,
      style: { left: node.x + "px", top: node.y + "px", width: NODE_W + "px" }
    },
      isStart ? null : h("div", { class: "port in", "data-port": "in" }),
      h("div", { class: "wf-node-head" },
        h("div", { class: "wf-node-icon" }, Icons.icon(node.icon || "dot", 12)),
        h("div", { class: "wf-node-drag" }, h("span", { class: "wf-node-name" }, node.name)),
        h("span", { class: "node-status-badge s-" + node.status, "data-role": "badge" }, STATUS_LABEL[node.status])
      ),
      h("div", { class: "wf-node-body" },
        h("div", { class: "wf-node-desc", "data-role": "desc" }, node.description || ""),
        tolEl,
        isLogic
          ? h("div", { class: "wf-node-logic-badge", "data-role": "logic-badge" }, logicBadgeText(node))
          : h("div", { class: "wf-node-model", "data-role": "model" }, h("span", { class: "lbl" }, "MODEL "), modelLabel(node)),
        isLogic ? null : toolsRow(node)
      ),
      h("div", { class: "wf-node-foot" },
        isStart ? null : h("button", { class: "icon-btn", "data-del": "1", title: editable ? "删除节点" : "已锁定" },
          Icons.icon("trash", 13))
      ),
      h("div", { class: "port out", "data-port": "out" })
    );
    wireNode(nodeEl, node, w);
    return nodeEl;
  }

  function patchNodeEl(nodeEl, node, w) {
    const isStart = node.agentType === "start";
    const editable = WF.isEditable(w, node.id) && !isStart;
    const isLogic = isLogicNode(node);
    nodeEl.classList.toggle("node-start", isStart);
    nodeEl.classList.toggle("editable", editable);
    nodeEl.classList.toggle("locked", !editable);
    nodeEl.classList.toggle("selected", Store.get().ui.selectedNodeId === node.id);
    nodeEl.classList.toggle("running", node.status === "running");
    nodeEl.classList.toggle("failed", node.status === "failed");
    nodeEl.classList.toggle("skipped", node.status === "skipped");
    nodeEl.classList.toggle("node-logic", isLogic);
    el(".wf-node-name", nodeEl).textContent = node.name;
    const badge = el("[data-role=badge]", nodeEl);
    badge.textContent = STATUS_LABEL[node.status] || node.status;
    badge.className = "node-status-badge s-" + node.status;
    el("[data-role=desc]", nodeEl).textContent = node.description || "";
    const oldTol = el("[data-role=tolerance]", nodeEl);
    const newTol = toleranceBadge(node);
    if (oldTol && !newTol) oldTol.remove();
    else if (!oldTol && newTol) {
      const desc = el("[data-role=desc]", nodeEl);
      if (desc) desc.after(newTol);
    } else if (oldTol && newTol) {
      oldTol.replaceWith(newTol);
    }
    const lBadge = el("[data-role=logic-badge]", nodeEl);
    if (lBadge) lBadge.textContent = logicBadgeText(node);
    const modelEl = el("[data-role=model]", nodeEl);
    if (modelEl) modelEl.innerHTML = `<span class="lbl">MODEL </span>` + modelLabel(node);
    const tools = el("[data-role=tools]", nodeEl);
    if (tools) tools.replaceWith(toolsRow(node));
    const del = el("[data-del]", nodeEl);
    if (del) del.title = editable ? "删除节点" : "已锁定";
  }

  function wireNode(nodeEl, node, w) {
    // delete (起点节点无删除按钮，必须判空)
    const delBtn = el("[data-del]", nodeEl);
    if (delBtn) {
      delBtn.addEventListener("click", e => {
        e.stopPropagation();
        if (!WF.isEditable(w, node.id)) return;
        if (WF.removeNode(w.id, node.id)) JIGSAW.Toast.show("已删除节点");
      });
    }

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
    const outPort = el(".port.out", nodeEl);
    if (outPort) {
      outPort.addEventListener("pointerdown", e => {
        if (e.button !== 0) return;
        if (!WF.isEditable(w, node.id)) {
          JIGSAW.Toast.show("节点已锁定，重置后即可连线");
          return;
        }
        e.stopPropagation();
        e.preventDefault();
        const a = nodePos(node.id);
        const x1 = a.x + NODE_W, y1 = a.y + a.h / 2;
        const pts = [{ x: x1, y: y1 }, { x: x1 + 30, y: y1 }];
        const temp = svg("path", { class: "wf-temp-edge", d: roundedOrthogonalPath(pts, CORNER_RADIUS) });
        const edgesGroup = el(".wf-edges-layer", edgeSvg) || edgeSvg;
        edgesGroup.appendChild(temp);
        connectState = { fromId: node.id, temp, x1, y1, snapId: null };
        canvas.classList.add("connecting");   // 高亮所有可连的输入端口
        canvas.setPointerCapture(e.pointerId);
      });
    }
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

    /*
      工具区：只列后端真实注册的工具（ToolService ← /api/tools）。
      以前这里是一个写死的假列表（web_search / code_interpreter / gdal …），
      那些工具根本不存在，勾选了也没有任何实际效果。
    */
    const toolsWrap = h("div", { class: "field-tools" });
    const allTools = realTools();

    const refreshTools = () => {
      toolsWrap.innerHTML = "";
      if (!allTools.length) {
        toolsWrap.appendChild(h("div", { class: "tool-none" },
          JIGSAW.Http.isRemote() ? "正在读取工具列表…" : "本地 Mock 模式下无工具（切到「后端 API」可见）"));
        return;
      }
      allTools.forEach(t => {
        const on = node.tools.includes(t.name);
        const chip = h("button", {
          type: "button",
          class: "tool-check" + (on ? " on" : "") + (t.enabled === false ? " off" : ""),
          disabled: editable ? null : true,
          title: t.description || t.name,
          "data-tool": t.name
        }, Icons.icon(t.icon || "tool", 11), h("span", null, t.label || t.name));
        if (editable) chip.addEventListener("click", () => {
          const idx = node.tools.indexOf(t.name);
          if (idx >= 0) node.tools.splice(idx, 1); else node.tools.push(t.name);
          WF.updateNode(w.id, node.id, { tools: node.tools.slice() });
          chip.classList.toggle("on", node.tools.includes(t.name));
          renderWorkflow();
        });
        toolsWrap.appendChild(chip);
      });

      // 旧数据里残留的、后端已不存在的工具名：单独列出来，方便移除
      const ghosts = node.tools.filter(t => !isRealTool(t));
      ghosts.forEach(t => {
        const tag = h("span", { class: "tool-tag custom unknown", title: "后端已无此工具，点 × 移除" }, t);
        if (editable) {
          const rm = h("button", { type: "button", class: "tool-rm", title: "移除" }, Icons.icon("x", 9));
          rm.addEventListener("click", () => {
            WF.updateNode(w.id, node.id, { tools: node.tools.filter(x => x !== t) });
            renderWorkflow();
            refreshTools();
          });
          tag.appendChild(rm);
        }
        toolsWrap.appendChild(tag);
      });
    };
    refreshTools();

    const ioBox = v => h("div", { class: "io-box" }, v || "—");

    const statusBadge = h("span", { class: "badge badge-" + (node.status === "waiting" ? "waiting" : node.status) }, STATUS_LABEL[node.status]);

    const isLogic = isLogicNode(node);
    const bodyChildren = [
      !editable ? h("div", { class: "inspector-lock-notice" },
        Icons.icon("lock", 13),
        h("span", null, "该节点已锁定。已完成或运行中的节点不可修改——仅待执行节点可编辑。")
      ) : null,
      field(isLogic ? "节点名称" : "Agent 名称", nameInput),
      field("描述", descInput)
    ];

    if (isLogic) {
      if (node.agentType === "loop_ctrl") {
        const loopInput = h("input", {
          class: "input", type: "number", min: "1", max: "20",
          value: node.loopMax || 3, disabled: editable ? null : true, "data-f": "loopMax"
        });
        bodyChildren.push(field("最大循环轮次 (Max Loops)", loopInput));
      }
      bodyChildren.push(field("逻辑说明 / 条件提示", sysInput));
      bodyChildren.push(field("输入", ioBox(node.input)));
      bodyChildren.push(field("输出", ioBox(node.output)));
    } else {
      bodyChildren.push(field("模型", modelSel));
      bodyChildren.push(field("系统提示词", sysInput));
      bodyChildren.push(field("输入", ioBox(node.input)));
      bodyChildren.push(field("输出", ioBox(node.output)));
      bodyChildren.push(field("工具分配", toolsWrap));
      const maxCallsInput = h("input", {
        class: "input", type: "number", min: "1", max: "30",
        value: node.maxToolCalls || 5, disabled: editable ? null : true, "data-f": "maxToolCalls"
      });
      bodyChildren.push(field("最大工具调用轮次 (Max Tool Calls)", maxCallsInput, "（限制单次任务最大工具步数，防死循环与配额打爆）"));
    }

    // 异常容错策略 (Error Handling & Fallback)
    if (node.agentType !== "start") {
      const errorSel = h("select", { class: "select", disabled: editable ? null : true, "data-f": "onError" },
        h("option", { value: "abort" }, "中断报错 (Abort & Fail)"),
        h("option", { value: "skip" }, "自动跳过 (Auto-Skip · 标记 skipped: true)"),
        h("option", { value: "fallback" }, "注入预设兜底 (Fallback Value)")
      );
      errorSel.value = node.onError || "abort";

      const isCustomFallback = node.onError === "fallback" || node.onError === "skip";
      const fallbackWrap = h("div", {
        class: "field-fallback-wrap",
        style: { display: isCustomFallback ? "block" : "none", marginTop: "6px" }
      },
        h("div", { style: { fontSize: "10px", color: "var(--text-3)", marginBottom: "3px" } }, "兜底输出内容 (传递给下游的备选数据)："),
        h("textarea", {
          class: "input", rows: "2",
          placeholder: "如：{\"status\": \"fallback\", \"message\": \"上游未响应，采用默认兜底输出\"}",
          disabled: editable ? null : true,
          "data-f": "fallbackValue"
        }, node.fallbackValue || "")
      );

      const simErrCheck = h("input", {
        type: "checkbox",
        checked: !!node.simulateError,
        disabled: editable ? null : true,
        "data-f": "simulateError",
        style: { width: "13px", height: "13px", margin: "0", cursor: editable ? "pointer" : "not-allowed" }
      });
      const simErrWrap = h("label", {
        style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "var(--text-3)", cursor: editable ? "pointer" : "not-allowed", marginTop: "6px" }
      }, simErrCheck, h("span", null, "模拟故障（用于验证容错/跳过流转）"));

      bodyChildren.push(
        field("异常容错策略 (Error Policy)", h("div", null, errorSel, fallbackWrap, simErrWrap))
      );
    }

    bodyChildren.push(
      h("div", { class: "field" },
        h("div", { class: "field-label" }, "状态"),
        statusBadge
      ),
      editable ? h("div", { class: "inspector-danger" },
        h("button", { class: "btn btn-sm", style: { borderColor: "var(--line-strong)", color: "var(--text-1)", width: "100%" }, "data-del-insp": "1" }, Icons.icon("trash", 13), "删除节点")
      ) : null
    );

    const body = h("div", { class: "inspector-body" }, ...bodyChildren.filter(Boolean));

    inspector.innerHTML = "";
    inspector.appendChild(h("div", { class: "inspector-head" },
      Icons.icon("sliders", 14),
      h("span", null, isLogic ? "控制节点检查器" : "Agent 检查器")
    ));
    inspector.appendChild(body);

    // wire edits (targeted updates, keep focus)
    els("[data-f]", inspector).forEach(ctrl => {
      if (ctrl.type === "checkbox") {
        ctrl.addEventListener("change", () => {
          if (!editable) return;
          const patch = {};
          patch[ctrl.dataset.f] = ctrl.checked;
          WF.updateNode(w.id, node.id, patch);
          renderWorkflow();
        });
        return;
      }
      ctrl.addEventListener("input", () => {
        if (!editable) return;
        const patch = {};
        const fieldKey = ctrl.dataset.f;
        patch[fieldKey] = fieldKey === "loopMax"
          ? (parseInt(ctrl.value, 10) || 3)
          : fieldKey === "maxToolCalls"
            ? (parseInt(ctrl.value, 10) || 5)
            : ctrl.value;
        WF.updateNode(w.id, node.id, patch);
        renderWorkflow();
      });
      if (ctrl.tagName === "SELECT") ctrl.addEventListener("change", () => {
        const patch = {};
        patch[ctrl.dataset.f] = ctrl.value;
        WF.updateNode(w.id, node.id, patch);
        renderInspector();
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
      const allDone = w.executed && w.nodes.length && w.nodes.every(n => n.status === "success" || n.status === "skipped");
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

  function buildTitleEl(conv) {
    const currentTitle = (conv ? conv.title : "") || (wf() ? wf().name : "未命名工作流");
    const wrap = h("div", { class: "topbar-title-wrap", title: "点击编辑标题" },
      h("span", { class: "topbar-title" }, currentTitle),
      h("span", { class: "topbar-title-edit-icon" }, Icons.icon("edit", 11))
    );

    wrap.addEventListener("click", (e) => {
      e.stopPropagation();
      if (wrap.querySelector("input")) return;

      const input = h("input", {
        type: "text",
        class: "topbar-title-input",
        value: currentTitle,
        maxlength: "60"
      });

      wrap.innerHTML = "";
      wrap.appendChild(input);
      input.focus();
      input.select();

      let committed = false;
      const finish = (commit) => {
        if (committed) return;
        committed = true;
        const val = input.value.trim();
        if (commit && val && val !== currentTitle) {
          JIGSAW.ChatService.rename(convId, val);
          JIGSAW.Toast.show("标题已更新");
        } else {
          wrap.innerHTML = "";
          wrap.append(
            h("span", { class: "topbar-title", title: currentTitle }, currentTitle),
            h("span", { class: "topbar-title-edit-icon" }, Icons.icon("edit", 11))
          );
        }
      };

      input.addEventListener("click", ke => ke.stopPropagation());
      input.addEventListener("keydown", ke => {
        ke.stopPropagation();
        if (ke.key === "Enter") {
          ke.preventDefault();
          finish(true);
        } else if (ke.key === "Escape") {
          ke.preventDefault();
          finish(false);
        }
      });

      input.addEventListener("blur", () => finish(true));
    });

    return wrap;
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
        const tpls = WF.templates();
        const logics = tpls.filter(t => t.category === "logic");
        const agents = tpls.filter(t => t.category !== "logic");

        const tabsWrap = h("div", { class: "wf-pop-tabs" });
        const tabLogic = h("button", { class: "wf-pop-tab active", type: "button" }, `逻辑控制 (${logics.length})`);
        const tabAgent = h("button", { class: "wf-pop-tab", type: "button" }, `智能体 (${agents.length})`);
        tabsWrap.append(tabLogic, tabAgent);

        const listWrap = h("div", { class: "wf-pop-list" });

        const renderItems = list => {
          listWrap.innerHTML = "";
          list.forEach(t => {
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
            listWrap.appendChild(item);
          });
        };

        tabLogic.addEventListener("click", () => {
          tabLogic.classList.add("active");
          tabAgent.classList.remove("active");
          renderItems(logics);
        });

        tabAgent.addEventListener("click", () => {
          tabAgent.classList.add("active");
          tabLogic.classList.remove("active");
          renderItems(agents);
        });

        // 默认显示逻辑控制节点（包含 START、与门、或门、非门、条件IF、循环Loop）
        renderItems(logics);
        pop.append(tabsWrap, listWrap);
      }
    });
    tb.append(
      h("div", { class: "topbar-left-group" },
        h("button", { class: "icon-btn", "data-home": "1", title: "返回主页" }, Icons.icon("home", 14)),
        h("button", { class: "icon-btn", "data-history": "1", title: "历史记录" }, Icons.icon("menu")),
        h("div", { class: "topbar-divider" }),
        buildTitleEl(conv)
      ),
      h("div", { class: "topbar-right-group" },
        h("div", { class: "legend", style: { marginRight: "var(--sp-2)" } },
          h("span", { class: "legend-item" }, h("span", { class: "legend-swatch s-waiting" }), "等待中"),
          h("span", { class: "legend-item" }, h("span", { class: "legend-swatch s-running" }), "运行中"),
          h("span", { class: "legend-item" }, h("span", { class: "legend-swatch s-success" }), "已完成"),
          h("span", { class: "legend-item" }, h("span", { class: "legend-swatch s-failed" }), "失败")
        ),
        addWrap,
        resetBtn = h("button", { class: "btn btn-sm", "data-reset": "1", title: "重置并解锁全部节点" }, Icons.icon("reset", 13), "重置"),
        runBtn = h("button", { class: "btn btn-sm btn-primary", "data-run": "1" })
      )
    );
    el("[data-history]", tb).addEventListener("click", () => JIGSAW.HistoryDrawer.toggle());
    el("[data-home]", tb).addEventListener("click", () => JIGSAW.Router.navigate("/"));
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
      if (e.target.closest(".wf-node") || e.target.closest(".port") || e.target.closest(".wf-edge-del-wrap") || e.target.closest(".wf-edge-hitbox")) return;
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
          // 16px 栅格微对齐，保证相邻节点的连线天然正交水平/垂直
          const GRID = 16;
          node.x = Math.round((dragState.ox + dx) / GRID) * GRID;
          node.y = Math.round((dragState.oy + dy) / GRID) * GRID;
          dragState.el.style.left = node.x + "px";
          dragState.el.style.top = node.y + "px";
          updateEdgesForNode(node.id);
        }
        return;
      }
      if (connectState) {
        const rect = canvas.getBoundingClientRect();
        let wx = (e.clientX - rect.left - pan.x) / zoom;
        let wy = (e.clientY - rect.top - pan.y) / zoom;

        // 磁吸自动吸附（Auto-Snap）：寻找吸附范围（36px）内最近的可连接目标输入端口
        const w = wf();
        let bestTarget = null;
        let minDist = 36;

        w.nodes.forEach(n => {
          if (n.id === connectState.fromId) return;
          if (!WF.isEditable(w, n.id)) return;
          const pos = nodePos(n.id);
          if (!pos) return;
          const px = pos.x;
          const py = pos.y + pos.h / 2;
          const dist = Math.hypot(wx - px, wy - py);
          if (dist < minDist) {
            minDist = dist;
            bestTarget = { id: n.id, x: px, y: py };
          }
        });

        els(".port.in.snap-active", world).forEach(p => p.classList.remove("snap-active"));
        if (bestTarget) {
          wx = bestTarget.x;
          wy = bestTarget.y;
          connectState.snapId = bestTarget.id;
          const targetNodeEl = el(`.wf-node[data-id="${bestTarget.id}"]`, world);
          if (targetNodeEl) {
            const inPort = el(".port.in", targetNodeEl);
            if (inPort) inPort.classList.add("snap-active");
          }
        } else {
          connectState.snapId = null;
        }

        const fromBox = nodePos(connectState.fromId);
        let pts;
        if (bestTarget) {
          const toBox = nodePos(bestTarget.id);
          pts = (fromBox && toBox)
            ? getOrthogonalPoints(fromBox, toBox)
            : getTempOrthogonalPoints(fromBox, wx, wy);
        } else {
          pts = getTempOrthogonalPoints(fromBox, wx, wy);
        }
        connectState.temp.setAttribute("d", roundedOrthogonalPath(pts, CORNER_RADIUS));
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
        const { fromId, temp, snapId } = connectState;
        els(".port.in.snap-active", world).forEach(p => p.classList.remove("snap-active"));
        temp.remove();
        connectState = null;
        canvas.classList.remove("connecting");

        // 优先使用磁吸命中的目标，其次检查光标落点
        let toId = snapId;
        if (!toId) {
          const target = document.elementFromPoint(e.clientX, e.clientY);
          const hit = target && target.closest
            ? (target.closest(".port.in") || target.closest(".wf-node"))
            : null;
          const toNode = hit ? hit.closest(".wf-node") : null;
          if (toNode) toId = toNode.dataset.id;
        }

        if (toId) {
          const w = wf();
          const ok = WF.addEdge(w.id, fromId, toId);
          if (ok) {
            JIGSAW.Toast.show("已添加连线");
            renderWorkflow();
          } else if (toId === fromId) {
            JIGSAW.Toast.show("不能连自己");
          } else {
            if (w.running) {
              JIGSAW.Toast.show("运行中不可修改画布，请先停止");
            } else if (!WF.isEditable(w, fromId) || !WF.isEditable(w, toId)) {
              JIGSAW.Toast.show("节点已锁定，点「重置」解锁后可连线");
            } else if (w.edges.some(ed => ed.from === fromId && ed.to === toId)) {
              JIGSAW.Toast.show("该连线已存在");
            } else {
              JIGSAW.Toast.show("无法连线");
            }
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
          Store.get().ui.selectedEdgeId = null;
          Store.notify("ui");
          renderWorkflow();
        }
      }
    };
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);
  }

  function updateEdgesForNode(nodeId) {
    const w = wf();
    const edgesGroup = el(".wf-edges-layer", edgeSvg) || edgeSvg;
    els(".wf-edge", edgesGroup).forEach(path => {
      const edge = w.edges.find(ed => ed.id === path.dataset.eid);
      if (edge && (edge.from === nodeId || edge.to === nodeId)) {
        path.setAttribute("d", edgePath(edge.from, edge.to, !!edge.isLoop));
      }
    });
  }

  /* ---------- keyboard ---------- */
  function onKey(e) {
    if (e.key === "Delete" || e.key === "Backspace") {
      const selEdge = Store.get().ui.selectedEdgeId;
      const sel = Store.get().ui.selectedNodeId;
      if (selEdge && wf()) {
        e.preventDefault();
        if (WF.removeEdge(wf().id, selEdge)) JIGSAW.Toast.show("已删除连线");
        Store.get().ui.selectedEdgeId = null;
        renderWorkflow();
        return;
      }
      if (sel && wf()) {
        e.preventDefault();
        if (WF.removeNode(wf().id, sel)) JIGSAW.Toast.show("已删除节点");
        Store.get().ui.selectedNodeId = null;
        Store.notify("ui");
      }
    } else if (e.key === "Escape") {
      if (Store.get().ui.selectedNodeId || Store.get().ui.selectedEdgeId) {
        Store.get().ui.selectedNodeId = null;
        Store.get().ui.selectedEdgeId = null;
        Store.notify("ui");
        renderWorkflow();
      }
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
      edgeSvg = svg("svg", { class: "wf-svg", width: "20000", height: "20000" });

      // 正交工业风箭头 marker 定义
      const defs = svg("defs", null);
      const makeMarker = (id, fill) => svg("marker", {
        id, viewBox: "0 0 10 10", refX: "7", refY: "5",
        markerWidth: "6", markerHeight: "6", orient: "auto"
      }, svg("path", { d: "M 1 2 L 8 5 L 1 8 Z", fill }));
      defs.appendChild(makeMarker("wf-arrow", "var(--line-strong)"));
      defs.appendChild(makeMarker("wf-arrow-selected", "var(--white)"));
      defs.appendChild(makeMarker("wf-arrow-success", "var(--st-success)"));
      defs.appendChild(makeMarker("wf-arrow-running", "var(--st-running)"));
      defs.appendChild(makeMarker("wf-arrow-skipped", "var(--st-skipped)"));
      edgeSvg.appendChild(defs);

      const edgesGroup = svg("g", { class: "wf-edges-layer" });
      edgeSvg.appendChild(edgesGroup);

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
      const switchFloat = h("div", { class: "view-switch-float" },
        h("button", { class: "view-switch-tab", "data-tab": "chat", title: "切换至对话视图" },
          Icons.icon("message", 13),
          h("span", null, "对话")
        ),
        h("button", { class: "view-switch-tab active", "data-tab": "workflow", title: "当前：工作流画布" },
          Icons.icon("branch", 13),
          h("span", null, "工作流")
        )
      );
      root.append(topbar, switchFloat, h("div", { class: "wf-body" }, canvas, inspector));
      el("[data-tab='chat']", switchFloat).addEventListener("click", () => JIGSAW.Router.navigate("/chat/" + convId));

      renderTopbar();
      renderControls();

      // 启动自愈：上次运行中断导致画布锁死时，先解锁再渲染
      EX.recover(convId);

      // initial layout
      heights.clear();
      const w = wf();
      w.nodes.forEach(n => { heights.set(n.id, 150); });
      renderWorkflow();
      renderInspector();
      fitView();

      // 工具列表来自后端：缓存为空（后端当时没起）时补拉一次，拉到后重渲染
      if (JIGSAW.Http.isRemote() && JIGSAW.ToolService.list().length === 0) {
        JIGSAW.ToolService.load()
          .then(() => { renderWorkflow(); renderInspector(); })
          .catch(() => {});
      }

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
        Store.subscribe("conversations", () => {
          renderTopbar();
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

  JIGSAW.Views = JIGSAW.Views || {};
  JIGSAW.Views.Workflow = Workflow;
})();
