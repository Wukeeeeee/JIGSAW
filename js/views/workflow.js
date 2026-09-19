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

  function getChatModels() {
    const list = (JIGSAW.ModelService && JIGSAW.ModelService.list()) || [];
    return list.filter(m => {
      const mid = (m.model || m.modelId || m.name || "").toLowerCase();
      const url = (m.baseUrl || "").toLowerCase();
      return !mid.includes("image") && !mid.includes("flux") && !mid.includes("dall-e") && !url.includes("agnes-ai");
    });
  }

  function getActiveChatModelId() {
    const c = JIGSAW.ChatService && JIGSAW.ChatService.get(convId);
    if (c && c.captainModelId) return c.captainModelId;
    const w = wf();
    if (w && w.captainModelId) return w.captainModelId;
    const chats = getChatModels();
    const active = JIGSAW.ModelService && JIGSAW.ModelService.getActive();
    if (active && chats.some(ch => ch.id === active.id)) return active.id;
    return chats[0] ? chats[0].id : (active ? active.id : "");
  }

  function getChatModels() {
    const list = (JIGSAW.ModelService && JIGSAW.ModelService.list()) || [];
    return list.filter(m => {
      const mid = (m.model || m.modelId || m.name || "").toLowerCase();
      const url = (m.baseUrl || "").toLowerCase();
      return !mid.includes("image") && !mid.includes("flux") && !mid.includes("dall-e") && !url.includes("agnes-ai");
    });
  }

  function getActiveChatModelId() {
    const c = JIGSAW.ChatService && JIGSAW.ChatService.get(convId);
    if (c && c.captainModelId) return c.captainModelId;
    const w = wf();
    if (w && w.captainModelId) return w.captainModelId;
    const chats = getChatModels();
    const active = JIGSAW.ModelService && JIGSAW.ModelService.getActive();
    if (active && chats.some(ch => ch.id === active.id)) return active.id;
    return chats[0] ? chats[0].id : (active ? active.id : "");
  }

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

  /** 获取指定节点特定端口的精确画布坐标 */
  function portPos(id, portId = "out") {
    const a = nodePos(id);
    if (!a) return null;
    const n = wf().nodes.find(x => x.id === id);
    if (portId === "in") {
      return { x: a.left, y: Math.round(a.top + a.h / 2) };
    }
    const outPorts = WF.getNodeOutputPorts(n);
    if (outPorts.length > 1) {
      const idx = outPorts.findIndex(p => p.id === portId);
      const factor = (idx === 0) ? 0.32 : 0.68;
      return { x: a.right, y: Math.round(a.top + a.h * factor) };
    }
    return { x: a.right, y: Math.round(a.top + a.h / 2) };
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
   * 核心准则：支持从多端口精准引出与接入，不穿透卡片本身，必要时走外围安全通道（Bypass Corridor）
   */
  function getOrthogonalPoints(a, b, isLoop = false, fromPort = "out", toPort = "in", fromId = null, toId = null) {
    let p1 = null, p2 = null;
    if (fromId) p1 = portPos(fromId, fromPort);
    if (toId) p2 = portPos(toId, toPort);

    const x1 = p1 ? p1.x : a.right;
    const y1 = p1 ? p1.y : Math.round(a.top + (a.h || PORT_Y_OFF * 2) / 2);
    const x2 = p2 ? p2.x : b.left;
    const y2 = p2 ? p2.y : Math.round(b.top + (b.h || PORT_Y_OFF * 2) / 2);

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
    const gapBelowA = b.top - a.bottom;
    const gapAboveA = a.top - b.bottom;

    let corridorY;
    if (gapBelowA >= 36 && b.left <= x1 + 40) {
      corridorY = Math.round((a.bottom + b.top) / 2);
    } else if (gapAboveA >= 36 && b.left <= x1 + 40) {
      corridorY = Math.round((b.bottom + a.top) / 2);
    } else {
      const topBypass = Math.min(a.top, b.top) - 28;
      const botBypass = Math.max(a.bottom, b.bottom) + 28;
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

  /** 拖拽连线时的临时正交线生成（智能避开源节点卡片，支持正向与反向双向拖拽） */
  function getTempOrthogonalPoints(fromBox, wx, wy, startPt = null, isReverse = false) {
    const x1 = startPt ? startPt.x : (fromBox ? fromBox.right : 0);
    const y1 = startPt ? startPt.y : (fromBox ? (fromBox.top + (fromBox.h || PORT_Y_OFF * 2) / 2) : 0);

    if (!isReverse) {
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
        { x: pOutX, y: routeY },
        { x: pInX, y: routeY },
        { x: pInX, y: wy },
        { x: wx, y: wy }
      ];
    } else {
      if (wx <= x1 - 32) {
        const midX = Math.round((x1 + wx) / 2);
        return [
          { x: x1, y: y1 },
          { x: midX, y: y1 },
          { x: midX, y: wy },
          { x: wx, y: wy }
        ];
      }
      const pOutX = x1 - 24;
      const pInX = wx + 20;
      const routeY = fromBox
        ? ((wy >= y1) ? Math.max(fromBox.bottom + 28, wy + 20) : Math.min(fromBox.top - 28, wy - 20))
        : (wy >= y1 ? wy + 40 : wy - 40);
      return [
        { x: x1, y: y1 },
        { x: pOutX, y: y1 },
        { x: pOutX, y: routeY },
        { x: pInX, y: routeY },
        { x: pInX, y: wy },
        { x: wx, y: wy }
      ];
    }
  }

  function edgePath(from, to, isLoop = false, fromPort = "out", toPort = "in") {
    const a = nodePos(from), b = nodePos(to);
    if (!a || !b) return "";
    const pts = getOrthogonalPoints(a, b, isLoop, fromPort, toPort, from, to);
    return roundedOrthogonalPath(pts, CORNER_RADIUS);
  }

  function getEdgeMidPoint(from, to, isLoop = false, fromPort = "out", toPort = "in") {
    const a = nodePos(from), b = nodePos(to);
    if (!a || !b) return null;
    const pts = getOrthogonalPoints(a, b, isLoop, fromPort, toPort, from, to);
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

    // 清理旧的连线删除按钮与标签
    els(".wf-edge-del-wrap", world).forEach(b => b.remove());
    els(".wf-edge-label-wrap", world).forEach(b => b.remove());

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
      if (e.fromPort === "true") cls.push("branch-true");
      if (e.fromPort === "false") cls.push("branch-false");
      if (e.fromPort === "loop") cls.push("branch-loop");
      if (e.fromPort === "catch") cls.push("branch-catch");
      if (e.status === "success" || (fromNode && fromNode.status === "success" && e.status !== "skipped")) cls.push("from-success");
      if (e.status === "skipped" || (fromNode && fromNode.status === "skipped")) cls.push("from-skipped");
      if (e.activeFlow || (toNode && toNode.status === "running" && e.status !== "skipped")) {
        cls.push("to-running", "active-flow");
      }

      const pathD = edgePath(e.from, e.to, !!e.isLoop, e.fromPort || "out", "in");
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

      // 分支/条件标签显示
      const labelText = e.label || (e.fromPort === "true" ? "True" : e.fromPort === "false" ? "False" : e.fromPort === "loop" ? "Loop" : e.fromPort === "catch" ? "Catch" : "");
      if (labelText) {
        const mid = getEdgeMidPoint(e.from, e.to, !!e.isLoop, e.fromPort || "out", e.toPort || "in");
        if (mid) {
          const lblWrap = h("div", {
            class: "wf-edge-label-wrap",
            style: { left: mid.x + "px", top: mid.y + "px" }
          },
            h("span", { class: "wf-edge-label label-" + (e.fromPort || "default") }, labelText)
          );
          world.appendChild(lblWrap);
        }
      }

      // 如果当前连线被选中，在其正交中点渲染删除按钮 [×]
      if (isSelected && !w.running) {
        const mid = getEdgeMidPoint(e.from, e.to, !!e.isLoop, e.fromPort || "out", e.toPort || "in");
        if (mid) {
          const delWrap = h("div", {
            class: "wf-edge-del-wrap",
            style: { left: mid.x + "px", top: mid.y + "px" }
          },
            h("button", {
              type: "button",
              class: "wf-edge-del-btn",
              title: "删除连线（或按 Delete 键）",
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

    // 清理旧残留引导卡片（若有）
    const oldGuide = el(".wf-empty-guide", world);
    if (oldGuide) oldGuide.remove();
  }

  function modelLabel(node) {
    const list = JIGSAW.ModelService.list();
    const m = list.find(x => x.id === node.modelId);
    let lbl = m ? m.name : (list.length ? "未选择模型" : "未配置模型");
    if (node.tools && node.tools.includes("generate_image")) {
      const imgM = JIGSAW.ImageService ? JIGSAW.ImageService.get(node.imageModelId) : null;
      if (imgM) lbl += " · 绘图: " + imgM.name;
    }
    return lbl;
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

    // 输出端口组（支持多端口分支）
    const outPorts = WF.getNodeOutputPorts(node);
    const outPortEls = outPorts.map((p, idx) => {
      const isMulti = outPorts.length > 1;
      const posCls = isMulti ? (idx === 0 ? " port-multi-top" : " port-multi-bot") : "";
      return h("div", {
        class: "port out" + posCls + " port-" + p.id,
        "data-port": p.id,
        title: p.title || p.name
      },
        p.label ? h("span", { class: "port-badge" }, p.label) : null
      );
    });

    const nodeEl = h("div", {
      class: "wf-node" + (isStart ? " node-start" : "") + (isLogic ? " node-logic" : "") + (editable ? " editable" : " locked") + (selected ? " selected" : "") + statusClass(node.status),
      "data-id": node.id,
      style: { left: node.x + "px", top: node.y + "px", width: NODE_W + "px" }
    },
      isStart ? null : h("div", { class: "port in", "data-port": "in", title: "输入端口 (可点击或拖拽连线)" }),
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
      ...outPortEls
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

  let clickConnectSource = null;

  function clearClickConnect() {
    if (clickConnectSource) {
      if (clickConnectSource.portEl) clickConnectSource.portEl.classList.remove("active-connect-source");
      clickConnectSource = null;
    }
    if (canvas) canvas.classList.remove("connecting");
    els(".port.snap-active", world).forEach(p => p.classList.remove("snap-active"));
  }

  function handlePortStart(e, node, portId, isReverse, portEl) {
    if (e.button !== 0) return;
    const w = wf();
    if (!WF.isEditable(w, node.id)) {
      JIGSAW.Toast.show("节点已锁定，重置后即可连线");
      return;
    }
    e.stopPropagation();
    e.preventDefault();

    // 如果之前已点击选中某个端口，此次点击视作完成配对
    if (clickConnectSource) {
      const src = clickConnectSource;
      if (src.nodeId === node.id && src.portId === portId) {
        clearClickConnect();
        JIGSAW.Toast.show("已取消连线");
        return;
      }
      if (src.isReverse !== isReverse) {
        const fromId = src.isReverse ? node.id : src.nodeId;
        const fromPort = src.isReverse ? portId : src.portId;
        const toId = src.isReverse ? src.nodeId : node.id;
        const toPort = src.isReverse ? src.portId : portId;

        clearClickConnect();
        if (WF.addEdge(w.id, fromId, toId, fromPort, toPort)) {
          JIGSAW.Toast.show("已添加连线");
          renderWorkflow();
        } else {
          JIGSAW.Toast.show("无法连线或连线已存在");
        }
        return;
      } else {
        clearClickConnect();
      }
    }

    const pPos = portPos(node.id, portId);
    const x1 = pPos ? pPos.x : (isReverse ? node.x : node.x + NODE_W);
    const y1 = pPos ? pPos.y : (node.y + (heights.get(node.id) || 150) / 2);

    const pts = isReverse
      ? [{ x: x1, y: y1 }, { x: x1 - 30, y: y1 }]
      : [{ x: x1, y: y1 }, { x: x1 + 30, y: y1 }];
    const temp = svg("path", { class: "wf-temp-edge", d: roundedOrthogonalPath(pts, CORNER_RADIUS) });
    const edgesGroup = el(".wf-edges-layer", edgeSvg) || edgeSvg;
    edgesGroup.appendChild(temp);

    connectState = {
      fromId: node.id,
      fromPort: portId,
      isReverse,
      temp,
      x1,
      y1,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      snapId: null,
      snapPort: null,
      portEl
    };

    canvas.classList.add("connecting");
    canvas.setPointerCapture(e.pointerId);
  }

  function wireNode(nodeEl, node, w) {
    const delBtn = el("[data-del]", nodeEl);
    if (delBtn) {
      delBtn.addEventListener("click", e => {
        e.stopPropagation();
        if (!WF.isEditable(w, node.id)) return;
        if (WF.removeNode(w.id, node.id)) JIGSAW.Toast.show("已删除节点");
      });
    }

    nodeEl.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      if (e.target.closest(".port") || e.target.closest("[data-del]")) return;
      e.stopPropagation();
      clearClickConnect();
      dragState = {
        nodeId: node.id, el: nodeEl,
        startX: e.clientX, startY: e.clientY,
        ox: node.x, oy: node.y, moved: false
      };
      canvas.setPointerCapture(e.pointerId);
      if (WF.isEditable(w, node.id)) nodeEl.classList.add("dragging");
    });

    // 绑定所有输出端口（右侧，支持多端口）
    els(".port.out", nodeEl).forEach(outPort => {
      outPort.addEventListener("pointerdown", e => {
        handlePortStart(e, node, outPort.dataset.port || "out", false, outPort);
      });
    });

    // 绑定输入端口（左侧，支持反向连线）
    const inPort = el(".port.in", nodeEl);
    if (inPort) {
      inPort.addEventListener("pointerdown", e => {
        handlePortStart(e, node, "in", true, inPort);
      });
    }
  }

  /* ---------- inspector ---------- */
  function renderInspector() {
    if (!inspector) return;
    const w = wf();
    const selId = Store.get().ui.selectedNodeId;
    const selEdgeId = Store.get().ui.selectedEdgeId;
    const node = selId ? w.nodes.find(n => n.id === selId) : null;
    const edge = selEdgeId ? w.edges.find(e => e.id === selEdgeId) : null;

    if (!node && !edge) {
      inspector.innerHTML = "";
      inspector.appendChild(h("div", { class: "inspector-empty" },
        h("div", null, Icons.icon("panel", 30)),
        h("div", { class: "es-title" }, "未选中元素"),
        h("div", { class: "es-sub" }, "点击节点或连线以查看和编辑其配置")
      ));
      return;
    }

    if (!node && edge) {
      const fromNode = w.nodes.find(n => n.id === edge.from);
      const toNode = w.nodes.find(n => n.id === edge.to);
      const editable = !w.running;

      const bodyChildren = [];

      // 起始与目标节点
      bodyChildren.push(
        h("div", { class: "field" },
          h("div", { class: "field-label" }, "起始节点与端口"),
          h("div", { style: { padding: "7px 10px", background: "var(--bg-canvas)", border: "1px solid var(--line-1)", borderRadius: "var(--radius-sm)", fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-1)" } },
            `${fromNode ? fromNode.name : edge.from}  [${edge.fromPort || "out"}]`
          )
        ),
        h("div", { class: "field" },
          h("div", { class: "field-label" }, "目标节点与端口"),
          h("div", { style: { padding: "7px 10px", background: "var(--bg-canvas)", border: "1px solid var(--line-1)", borderRadius: "var(--radius-sm)", fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-1)" } },
            `${toNode ? toNode.name : edge.to}  [${edge.toPort || "in"}]`
          )
        )
      );

      // 分支类型
      const branchDescMap = {
        out: "标准输出流 (Default Out)",
        true: "True 分支 (条件满足)",
        false: "False 分支 (条件不满足)",
        loop: "Loop 分支 (闭环迭代)",
        done: "Done 分支 (循环结束)",
        try: "Try 分支 (受保护主流程)",
        catch: "Catch 分支 (异常接管流程)"
      };
      bodyChildren.push(
        h("div", { class: "field" },
          h("div", { class: "field-label" }, "分支属性"),
          h("div", { style: { fontSize: "12px", color: "var(--text-2)", padding: "2px 0" } },
            branchDescMap[edge.fromPort] || "通用连线"
          )
        )
      );

      // 连线说明标签 (Canvas Pill)
      const labelInput = h("input", {
        class: "input",
        type: "text",
        placeholder: edge.fromPort === "true" ? "True" : edge.fromPort === "false" ? "False" : "输入连线说明...",
        value: edge.label || "",
        disabled: editable ? null : true
      });
      labelInput.addEventListener("input", () => {
        if (!editable) return;
        edge.label = labelInput.value.trim();
        Store.notify("workflows");
      });
      bodyChildren.push(
        h("div", { class: "field" },
          h("div", { class: "field-label" }, "连线说明标签 (Canvas Pill)"),
          labelInput
        )
      );

      // 标记为迭代回环 (Loop Back)
      const loopLabel = h("label", { style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", cursor: editable ? "pointer" : "default" } },
        h("input", {
          type: "checkbox",
          checked: !!edge.isLoop,
          disabled: editable ? null : true
        }),
        h("span", null, "标记为迭代回环 (Loop Back)")
      );
      const loopCheck = loopLabel.querySelector("input");
      loopCheck.addEventListener("change", () => {
        if (!editable) return;
        edge.isLoop = loopCheck.checked;
        Store.notify("workflows");
      });
      bodyChildren.push(
        h("div", { class: "field" },
          h("div", { class: "field-label" }, "流转控制"),
          loopLabel
        )
      );

      // 删除连线
      if (editable) {
        const delBtn = h("button", {
          class: "btn btn-sm",
          style: { borderColor: "var(--line-strong)", color: "var(--text-1)", width: "100%", marginTop: "var(--sp-2)" }
        }, Icons.icon("trash", 13), "删除连线 (Delete)");
        delBtn.addEventListener("click", () => {
          if (WF.removeEdge(w.id, edge.id)) {
            JIGSAW.Toast.show("已删除连线");
            Store.get().ui.selectedEdgeId = null;
            renderWorkflow();
            renderInspector();
          }
        });
        bodyChildren.push(h("div", { class: "inspector-danger" }, delBtn));
      }

      const body = h("div", { class: "inspector-body" }, ...bodyChildren);
      inspector.innerHTML = "";
      inspector.appendChild(h("div", { class: "inspector-head" },
        Icons.icon("arrow-right", 14),
        h("span", null, "连线检查器 (Edge Inspector)")
      ));
      inspector.appendChild(body);
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

    const imageModelSel = h("select", { class: "select", disabled: editable ? null : true, "data-f": "imageModelId" });
    const imgList = (JIGSAW.ImageService && JIGSAW.ImageService.list()) || [];
    if (!imgList.length) {
      imageModelSel.appendChild(h("option", { value: "" }, "未配置生图模型（请在设置中配置）"));
      imageModelSel.disabled = true;
    } else {
      imgList.forEach(m => {
        const opt = h("option", { value: m.id }, `${m.name} (${m.modelId})`);
        if (node.imageModelId === m.id || (!node.imageModelId && m.id === ((JIGSAW.ImageService.getActive() || {}).id))) {
          opt.selected = true;
        }
        imageModelSel.appendChild(opt);
      });
    }
    imageModelSel.addEventListener("change", () => {
      node.imageModelId = imageModelSel.value;
      WF.updateNode(w.id, node.id, { imageModelId: node.imageModelId });
      renderWorkflow();
    });

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
          if (t.name === "generate_image") renderInspector();
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
        h("span", null, "工作流运行中，执行完成后可随时编辑配置。")
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
      if (node.agentType === "condition_if") {
        const condSel = h("select", { class: "select", disabled: editable ? null : true, "data-f": "conditionOutcome" },
          h("option", { value: "true" }, "条件判定：满足 (走向 True 分支)"),
          h("option", { value: "false" }, "条件判定：不满足 (走向 False 分支)")
        );
        condSel.value = node.conditionOutcome || "true";
        bodyChildren.push(field("判定结果模拟 (Branch)", condSel, "（模拟判断结果，决定激活 True 还是 False 分支）"));
      }
      if (node.agentType === "start") {
        const startPromptInput = h("textarea", {
          class: "input tall",
          rows: "4",
          placeholder: "输入给 Captain Agent 或整个工作流的初始任务目标，如：帮我对比北京和上海的文旅发展现状",
          disabled: editable ? null : true,
          "data-f": "output"
        }, node.output || "");

        const planNowBtn = h("button", {
          class: "btn btn-sm",
          type: "button",
          style: {
            marginTop: "8px",
            width: "100%",
            background: "linear-gradient(135deg, rgba(37,99,235,0.2), rgba(124,58,237,0.25))",
            borderColor: "rgba(124,58,237,0.45)",
            color: "#c4b5fd",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "6px"
          }
        }, Icons.icon("sparkles", 13), "✨ 由 Captain 规划拓扑并生成图层");
        planNowBtn.addEventListener("click", () => {
          showAutoPlanModal(startPromptInput.value || node.output);
        });

        bodyChildren.push(field("初始任务目标 (Task Prompt)", h("div", null, startPromptInput, planNowBtn), "（可直接输入目标并一键让 Captain Agent 拆解生成拓扑图）"));
      } else {
        bodyChildren.push(field("逻辑说明 / 条件提示", sysInput));
        bodyChildren.push(field("输入", ioBox(node.input)));
        bodyChildren.push(field("输出", ioBox(node.output)));
      }
    } else {
      bodyChildren.push(field("模型", modelSel));
      if (node.tools && node.tools.includes("generate_image")) {
        bodyChildren.push(field("AI 绘图模型 (Image Model)", imageModelSel, "（当前 Agent 生成图片时使用的生图服务与模型）"));
      }
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

    const inEdgesCount = w.edges.filter(e => e.to === node.id).length;
    if (inEdgesCount > 1 || node.joinRule) {
      const joinSel = h("select", { class: "select", disabled: editable ? null : true, "data-f": "joinRule" },
        h("option", { value: "tolerant_and" }, "弹性汇合 (AND·部分成功即放行)"),
        h("option", { value: "strict_and" }, "严格汇合 (AND·必须全部成功)"),
        h("option", { value: "any_or" }, "竞速汇合 (OR·任一成功即触发)")
      );
      joinSel.value = node.joinRule || "tolerant_and";
      bodyChildren.push(
        field("多路汇合逻辑 (Join Barrier)", joinSel)
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

  /* ---------- Captain Agent 拓扑自主规划弹窗 (Text-to-Workflow) ---------- */
  function showAutoPlanModal(initialPrompt) {
    const w = wf();
    if (!w) return;
    if (w.running) { JIGSAW.Toast.show("工作流运行中，不可重新规划"); return; }
    const startNode = w.nodes.find(n => n.agentType === "start");
    const initVal = initialPrompt || (startNode && startNode.output !== "初始任务提示词" ? startNode.output : "") || "";

    const overlay = h("div", { class: "ask-overlay" });
    const box = h("div", { class: "ask-box", style: { width: "520px", display: "flex", flexDirection: "column", gap: "14px" } });

    const title = h("div", { class: "ask-title", style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "14px", fontWeight: "600", color: "var(--text-1)" } },
      Icons.icon("agent", 16), "Captain Agent · 拓扑自主规划"
    );

    const desc = h("div", { style: { fontSize: "12px", color: "var(--text-3)", lineHeight: "1.6" } },
      "输入任务需求或调研目标，由指定的主控智能体（Captain Agent）自动拆解业务意图，生成多智能体节点、逻辑汇聚栅栏并在画布完成连线排版。"
    );

    let selectedCaptainModelId = getActiveChatModelId();

    const modelRow = h("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 12px",
        background: "var(--bg-overlay)",
        border: "1px solid var(--line-strong)",
        borderRadius: "var(--rad-sm)",
        gap: "12px"
      }
    },
      h("div", { style: { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--text-1)", fontWeight: "500" } },
        Icons.icon("cpu", 13),
        "主控智能体模型"
      ),
      JIGSAW.Dropdown.create(
        () => getChatModels(),
        selectedCaptainModelId,
        id => {
          selectedCaptainModelId = id;
          const curW = wf();
          if (curW) curW.captainModelId = id;
          const curC = JIGSAW.ChatService && JIGSAW.ChatService.get(convId);
          if (curC) curC.captainModelId = id;
        },
        { small: true, icon: "agent", title: "选择负责拓扑自主规划的主控大模型" }
      )
    );

    const textarea = h("textarea", {
      class: "input tall",
      rows: "4",
      placeholder: "请输入任务需求或调研目标（例如：全面调研华为智能汽车业务的市场规模、技术壁垒与竞争格局，生成深度研报）",
      style: { width: "100%", boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }
    }, initVal);

    const actions = h("div", { class: "ask-actions", style: { display: "flex", justifyContent: "flex-end", gap: "8px" } });
    const cancelBtn = h("button", { class: "btn btn-sm", type: "button" }, "取消");
    const okBtn = h("button", {
      class: "btn btn-sm btn-primary",
      type: "button",
      style: { display: "inline-flex", alignItems: "center", gap: "6px" }
    }, Icons.icon("sparkles", 13), "开始规划建图");

    actions.append(cancelBtn, okBtn);
    box.append(title, desc, modelRow, textarea, actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    cancelBtn.addEventListener("click", close);
    overlay.addEventListener("mousedown", e => { if (e.target === overlay) close(); });

    okBtn.addEventListener("click", async () => {
      const prompt = textarea.value.trim();
      if (!prompt) {
        JIGSAW.Toast.show("请输入任务需求或目标");
        textarea.focus();
        return;
      }
      okBtn.disabled = true;
      okBtn.textContent = "Captain 规划建图中…";
      try {
        await WF.autoPlanWorkflow(w.id, prompt, selectedCaptainModelId);
        close();
        renderWorkflow();
        renderInspector();
        fitView();
        JIGSAW.Toast.show("Captain Agent 拓扑已生成！已在画布自动连线排版");
      } catch (err) {
        okBtn.disabled = false;
        okBtn.innerHTML = Icons.icon("sparkles", 13) + " 开始规划建图";
        JIGSAW.Toast.show("规划失败：" + (err.message || err));
      }
    });

    setTimeout(() => textarea.focus(), 50);
  }

  function renderTopbar() {
    const conv = JIGSAW.ChatService.get(convId);
    const tb = el(".wf-topbar", container);
    tb.innerHTML = "";

    const autoPlanBtn = h("button", {
      class: "btn btn-sm btn-subtle",
      "data-autoplan": "1",
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px"
      },
      title: "Captain Agent 智能规划：自然语言一键生成多智能体拓扑与连线"
    }, Icons.icon("sparkles", 13), "AI 自动编排");
    autoPlanBtn.addEventListener("click", () => showAutoPlanModal());

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
          h("span", { class: "legend-item" }, h("span", { class: "legend-swatch s-skipped" }), "已跳过"),
          h("span", { class: "legend-item" }, h("span", { class: "legend-swatch s-failed" }), "失败")
        ),
        autoPlanBtn,
        addWrap,
        resetBtn = h("button", { class: "btn btn-sm", "data-reset": "1", title: "重置并解锁全部节点" }, Icons.icon("reset", 13), "重置"),
        exportSvgBtn = h("button", { class: "btn btn-sm", "data-export-svg": "1", title: "导出当前工作流为矢量 SVG 文件", style: { display: "inline-flex", alignItems: "center", gap: "5px" } }, Icons.icon("download", 13), "导出 SVG"),
        runBtn = h("button", { class: "btn btn-sm btn-primary", "data-run": "1" })
      )
    );
    el("[data-history]", tb).addEventListener("click", () => JIGSAW.HistoryDrawer.toggle());
    el("[data-home]", tb).addEventListener("click", () => JIGSAW.Router.navigate("/"));
    resetBtn.addEventListener("click", () => { WF.reset(wf().id); updateRunBtn(); renderWorkflow(); renderInspector(); });
    exportSvgBtn.addEventListener("click", () => {
      const w = wf();
      if (!w || !w.nodes.length) {
        JIGSAW.Toast.show("画布为空，暂无节点可导出");
        return;
      }
      const svgContent = WF.toSvg(w.id);
      const blob = new Blob([svgContent], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `workflow-${convId}.svg`;
      a.click();
      URL.revokeObjectURL(url);
      JIGSAW.Toast.show("✨ 已成功导出工作流为 SVG 矢量图！");
    });
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
        const dx = Math.abs(e.clientX - connectState.startX);
        const dy = Math.abs(e.clientY - connectState.startY);
        if (dx + dy > 3) connectState.moved = true;

        const rect = canvas.getBoundingClientRect();
        let wx = (e.clientX - rect.left - pan.x) / zoom;
        let wy = (e.clientY - rect.top - pan.y) / zoom;

        // 磁吸自动吸附（Auto-Snap）：寻找吸附范围（38px）内最近的可连接目标端口
        const w = wf();
        let bestTarget = null;
        let minDist = 38;

        w.nodes.forEach(n => {
          if (n.id === connectState.fromId) return;
          if (!WF.isEditable(w, n.id)) return;

          if (!connectState.isReverse) {
            // 正向拖拽：寻找目标节点的输入端口 "in"
            if (n.agentType === "start") return;
            const pt = portPos(n.id, "in");
            if (pt) {
              const dist = Math.hypot(wx - pt.x, wy - pt.y);
              if (dist < minDist) {
                minDist = dist;
                bestTarget = { id: n.id, port: "in", x: pt.x, y: pt.y };
              }
            }
          } else {
            // 反向拖拽：寻找目标节点的各输出端口
            const outPorts = WF.getNodeOutputPorts(n);
            outPorts.forEach(op => {
              const pt = portPos(n.id, op.id);
              if (pt) {
                const dist = Math.hypot(wx - pt.x, wy - pt.y);
                if (dist < minDist) {
                  minDist = dist;
                  bestTarget = { id: n.id, port: op.id, x: pt.x, y: pt.y };
                }
              }
            });
          }
        });

        els(".port.snap-active", world).forEach(p => p.classList.remove("snap-active"));
        if (bestTarget) {
          wx = bestTarget.x;
          wy = bestTarget.y;
          connectState.snapId = bestTarget.id;
          connectState.snapPort = bestTarget.port;
          const targetNodeEl = el(`.wf-node[data-id="${bestTarget.id}"]`, world);
          if (targetNodeEl) {
            const targetPortEl = el(`.port[data-port="${bestTarget.port}"]`, targetNodeEl);
            if (targetPortEl) targetPortEl.classList.add("snap-active");
          }
        } else {
          connectState.snapId = null;
          connectState.snapPort = null;
        }

        const fromBox = nodePos(connectState.fromId);
        const startPt = { x: connectState.x1, y: connectState.y1 };
        let pts;
        if (bestTarget) {
          const toBox = nodePos(bestTarget.id);
          pts = (!connectState.isReverse)
            ? getOrthogonalPoints(fromBox, toBox, false, connectState.fromPort, bestTarget.port, connectState.fromId, bestTarget.id)
            : getOrthogonalPoints(toBox, fromBox, false, bestTarget.port, connectState.fromPort, bestTarget.id, connectState.fromId);
          if (connectState.isReverse) pts.reverse();
        } else {
          pts = getTempOrthogonalPoints(fromBox, wx, wy, startPt, connectState.isReverse);
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
        const { fromId, fromPort, isReverse, temp, snapId, snapPort, moved, portEl } = connectState;
        els(".port.snap-active", world).forEach(p => p.classList.remove("snap-active"));
        temp.remove();
        connectState = null;

        if (!moved) {
          // 点击了端口而未产生拖拽移动 -> 开启 Click-to-Connect 状态
          clearClickConnect();
          clickConnectSource = { nodeId: fromId, portId: fromPort, isReverse, portEl };
          if (portEl) portEl.classList.add("active-connect-source");
          canvas.classList.add("connecting");
          JIGSAW.Toast.show("已选中起始端口，请点击目标端口完成连接 (Esc 取消)");
          return;
        }

        canvas.classList.remove("connecting");

        // 拖拽松手：优先使用磁吸目标，其次检查落点
        let toId = snapId;
        let toPort = snapPort;
        if (!toId) {
          const target = document.elementFromPoint(e.clientX, e.clientY);
          const hitPort = target && target.closest ? target.closest(".port") : null;
          if (hitPort) {
            const hitNode = hitPort.closest(".wf-node");
            if (hitNode) {
              toId = hitNode.dataset.id;
              toPort = hitPort.dataset.port;
            }
          }
        }

        if (toId) {
          const w = wf();
          const actualFromId = isReverse ? toId : fromId;
          const actualFromPort = isReverse ? (toPort || "out") : (fromPort || "out");
          const actualToId = isReverse ? fromId : toId;
          const actualToPort = "in"; // 规范化目标端口：永远连接到卡片左侧输入端，避免大回环绕线

          if (actualFromId === actualToId) {
            JIGSAW.Toast.show("不能连自己");
          } else {
            const ok = WF.addEdge(w.id, actualFromId, actualToId, actualFromPort, actualToPort);
            if (ok) {
              JIGSAW.Toast.show("已添加连线");
              renderWorkflow();
            } else {
              JIGSAW.Toast.show("无法连线或连线已存在");
            }
          }
        }
      }
      if (panState) {
        const wasMoved = panState.moved;
        panState = null;
        canvas.classList.remove("panning");
        if (!wasMoved) {
          clearClickConnect();
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
        path.setAttribute("d", edgePath(edge.from, edge.to, !!edge.isLoop, edge.fromPort || "out", edge.toPort || "in"));
      }
    });
    // 连线标签与删除按钮同步重绘定位
    renderWorkflow();
  }

  /* ---------- keyboard ---------- */
  function onKey(e) {
    if (e.key === "Escape") {
      if (clickConnectSource) {
        clearClickConnect();
        return;
      }
      if (Store.get().ui.selectedNodeId || Store.get().ui.selectedEdgeId) {
        Store.get().ui.selectedNodeId = null;
        Store.get().ui.selectedEdgeId = null;
        Store.notify("ui");
        renderWorkflow();
      } else {
        JIGSAW.HistoryDrawer.close();
      }
      return;
    }

    // 聚焦在任何输入框、文本域或可编辑区域时，绝对不拦截 Delete 等按键
    if (e.target && (e.target.closest("input, textarea, select, [contenteditable]") || e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) {
      return;
    }

    // 仅响应 Delete 键
    if (e.key === "Delete") {
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
        const node = wf().nodes.find(n => n.id === sel);
        if (node && node.agentType === "start") return;
        if (!WF.isEditable(wf(), sel)) return;
        e.preventDefault();
        if (WF.removeNode(wf().id, sel)) JIGSAW.Toast.show("已删除节点");
        Store.get().ui.selectedNodeId = null;
        Store.notify("ui");
        renderWorkflow();
      }
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
      let lastNodeCount = (w && w.nodes) ? w.nodes.length : 0;
      unsubs = [
        Store.subscribe("workflows", () => {
          const currentWf = wf();
          const prevCount = lastNodeCount;
          const currentCount = (currentWf && currentWf.nodes) ? currentWf.nodes.length : 0;
          lastNodeCount = currentCount;

          renderWorkflow();
          if (!inspector || !inspector.contains(document.activeElement)) {
            renderInspector();
          }
          updateRunBtn();

          // 当拓扑从空白/仅起点被自动规划生成时，自动居中聚焦
          if (prevCount <= 1 && currentCount > 1) {
            setTimeout(() => fitView(), 40);
          }
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
