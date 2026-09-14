/* 知识库视图：三栏布局 —— 左：完整文件树（根目录+分类+文档） | 中：当前节点文档列表 | 右：编辑器
   数据源：后端本地文件系统（backend/data/knowledge/），纯 CRUD，不接 AI。 */
(function () {
  "use strict";

  const h = JIGSAW.h;
  const el = JIGSAW.el;

  const KB = {};

  let tree = null;          // 当前目录树
  let rootPath = "";        // 当前知识库存放目录
  let activeFolder = "";    // 当前选中的树节点（"" = 根目录，否则分类名）
  let activeDoc = null;     // 当前编辑的文档 {folder, name}
  let docContent = "";      // 编辑器内容
  let dirty = false;        // 有未保存修改
  let saving = false;
  let expanded = { root: true };  // 树的展开/收起状态 {root: bool, [分类名]: bool}

  /* ---------- 数据 ---------- */
  async function loadTree() {
    let r = null;
    try { r = await JIGSAW.Http.kbTree(); }
    catch (e) { JIGSAW.Toast.show("知识库加载失败：" + (e.message || "请检查后端连接")); tree = { folders: [], rootDocs: [] }; render(); return; }
    if (!r || !r.folders) { JIGSAW.Toast.show("知识库加载失败：请检查后端连接"); return; }
    tree = r;
    // 若当前分类已被删除，退回根
    if (activeFolder && !tree.folders.some(f => f.name === activeFolder)) {
      activeFolder = "";
      activeDoc = null;
    }
    render();
  }

  async function loadRoot() {
    try {
      const r = await JIGSAW.Http.kbRoot();
      if (r && r.path) rootPath = r.path;
    } catch (e) { /* 后端没起：保持空，界面显示"选择目录" */ }
  }

  /* ---------- 交互动作 ---------- */
  /** 统一包一层：后端 4xx/5xx 时 Http 会抛异常，不 catch 就变成"点了没反应" */
  async function api(fn, failMsg) {
    try { return await fn(); }
    catch (e) { JIGSAW.Toast.show(failMsg + "：" + (e.message || "")); return null; }
  }

  async function pickDoc(folder, name) {
    if (dirty && !(await JIGSAW.PromptModal.confirm({ title: "未保存的修改", message: "当前文档有未保存修改，放弃并切换？" }))) return;
    const r = await api(() => JIGSAW.Http.kbReadDoc(folder, name), "读取失败");
    if (!r || typeof r.content !== "string") return;
    activeDoc = { folder, name, editable: r.editable, error: r.error };
    docContent = r.content;
    dirty = false;
    render();
  }

  async function saveDoc() {
    if (!activeDoc || saving) return;
    saving = true;
    const r = await api(() => JIGSAW.Http.kbSaveDoc(activeDoc.folder, activeDoc.name, docContent), "保存失败");
    saving = false;
    if (r && r.ok) { dirty = false; JIGSAW.Toast.show("已保存"); loadTree(); render(); }
  }

  async function newDoc() {
    const name = await JIGSAW.PromptModal.prompt({ title: "新建文档", placeholder: "如：东京攻略.md", initial: "新文档.md" });
    if (!name || !name.trim()) return;
    const folder = activeFolder;
    const r = await api(() => JIGSAW.Http.kbCreateDoc(folder, name.trim(), ""), "创建失败");
    if (r && r.ok) { JIGSAW.Toast.show("已创建"); await loadTree(); pickDoc(folder, name.trim()); }
  }

  async function renameDoc() {
    if (!activeDoc) return;
    const name = await JIGSAW.PromptModal.prompt({ title: "重命名文档", initial: activeDoc.name });
    if (!name || !name.trim() || name.trim() === activeDoc.name) return;
    const { folder, name: oldName } = activeDoc;
    const r = await api(() => JIGSAW.Http.kbRenameDoc(folder, oldName, name.trim()), "重命名失败");
    if (r && r.ok) { JIGSAW.Toast.show("已重命名"); activeDoc = { folder, name: name.trim() }; loadTree(); }
  }

  async function deleteDoc() {
    if (!activeDoc) return;
    if (!(await JIGSAW.PromptModal.confirm({ title: "删除文档", message: `删除文档「${activeDoc.name}」？此操作不可恢复。`, danger: true }))) return;
    const { folder, name } = activeDoc;
    const r = await api(() => JIGSAW.Http.kbDeleteDoc(folder, name), "删除失败");
    if (r && r.ok) { activeDoc = null; docContent = ""; dirty = false; JIGSAW.Toast.show("已删除"); loadTree(); }
  }

  async function newFolder() {
    const name = await JIGSAW.PromptModal.prompt({ title: "新建分类", placeholder: "可带 / 支持嵌套，如：旅行/日本" });
    if (!name || !name.trim()) return;
    const r = await api(() => JIGSAW.Http.kbCreateFolder(name.trim()), "创建失败");
    if (r && r.ok) { JIGSAW.Toast.show("已创建分类"); expanded[name.trim()] = true; loadTree(); }
  }

  async function renameFolder(folder) {
    const name = await JIGSAW.PromptModal.prompt({ title: "重命名分类", initial: folder });
    if (!name || !name.trim() || name.trim() === folder) return;
    const r = await api(() => JIGSAW.Http.kbRenameFolder(folder, name.trim()), "重命名失败");
    if (r && r.ok) {
      if (activeFolder === folder) activeFolder = name.trim();
      expanded[name.trim()] = expanded[folder]; delete expanded[folder];
      JIGSAW.Toast.show("已重命名"); loadTree();
    }
  }

  async function deleteFolder(folder) {
    if (!(await JIGSAW.PromptModal.confirm({ title: "删除分类", message: `删除分类「${folder}」及其中全部文档？此操作不可恢复。`, danger: true }))) return;
    const r = await api(() => JIGSAW.Http.kbDeleteFolder(folder), "删除失败");
    if (r && r.ok) {
      if (activeFolder === folder) { activeFolder = ""; activeDoc = null; docContent = ""; dirty = false; }
      delete expanded[folder];
      JIGSAW.Toast.show("已删除"); loadTree();
    }
  }

  /* ---------- 拖拽导入 ---------- */
  function setupDrop(view) {
    let dragDepth = 0;
    const onEnter = e => { e.preventDefault(); dragDepth++; view.classList.add("kb-dragover"); };
    const onLeave = e => { e.preventDefault(); dragDepth--; if (dragDepth <= 0) { dragDepth = 0; view.classList.remove("kb-dragover"); } };
    const onOver = e => { e.preventDefault(); };
    const onDrop = async e => {
      e.preventDefault();
      dragDepth = 0;
      view.classList.remove("kb-dragover");
      const files = Array.from(e.dataTransfer.files || []);
      if (!files.length) return;
      const folder = activeFolder;
      let ok = 0;
      for (const f of files) {
        try {
          const r = await JIGSAW.Http.kbUpload(folder, f);
          if (r && r.ok) ok++;
        } catch (err) { /* 单个失败继续 */ }
      }
      JIGSAW.Toast.show(ok ? `已导入 ${ok} 个文件到${folder || "根目录"}` : "导入失败");
      loadTree();
    };
    view.addEventListener("dragenter", onEnter);
    view.addEventListener("dragleave", onLeave);
    view.addEventListener("dragover", onOver);
    view.addEventListener("drop", onDrop);
  }

  async function pickRoot() {
    const r = await api(() => JIGSAW.Http.kbPickRoot(), "切换目录失败");
    if (r && r.ok) {
      rootPath = r.path; activeFolder = ""; activeDoc = null; docContent = ""; dirty = false;
      JIGSAW.Toast.show("已切换知识库目录"); loadTree();
    }
    // r.cancelled = 用户关掉了选择框，什么都不做
  }

  /* ---------- 树行构造 ---------- */
  function isOpen(key) {
    // 根目录的展开状态记在 expanded.root（key 为 ""），分类记在 expanded[分类名]
    return key === "" ? expanded.root !== false : !!expanded[key];
  }

  function folderRow(key, label, count, isRoot) {
    const open = isOpen(key);
    const row = h("div", { class: "kb-folder" + (activeFolder === key ? " active" : ""), "data-folder": key },
      h("span", { class: "kb-caret" }, JIGSAW.Icons.icon(open ? "chev-down" : "chev-right", 11)),
      h("span", { class: "kb-folder-icon" }, JIGSAW.Icons.icon("folder", 13)),
      h("span", { class: "kb-folder-name" }, label),
      h("span", { class: "kb-count" }, String(count))
    );
    if (!isRoot) {
      const rf = h("button", { class: "icon-btn mini", "data-rf": key, title: "重命名" }, JIGSAW.Icons.icon("editfile", 11));
      const df = h("button", { class: "icon-btn mini", "data-df": key, title: "删除分类" }, JIGSAW.Icons.icon("trash", 11));
      // ★ 直接在这里绑：以前是在 render() 里按 [data-folder] 反查再绑，
      //   而那时 row 上没有 data-folder 属性 → 查不到 → 重命名/删除点了没反应
      rf.addEventListener("click", e => { e.stopPropagation(); renameFolder(key); });
      df.addEventListener("click", e => { e.stopPropagation(); deleteFolder(key); });
      row.appendChild(h("div", { class: "kb-folder-ops" }, rf, df));
    }
    row.addEventListener("click", async e => {
      if (e.target.closest("[data-rf]") || e.target.closest("[data-df]")) return;
      if (dirty && !(await JIGSAW.PromptModal.confirm({ title: "未保存的修改", message: "当前文档有未保存修改，放弃并切换？" }))) return;
      if (key === "") expanded.root = !expanded.root;   // 展开/收起
      else expanded[key] = !expanded[key];
      activeFolder = key;                    // 选中该节点
      activeDoc = null; docContent = ""; dirty = false;
      render();
    });
    return row;
  }

  function docLeaf(folder, d) {
    const active = activeDoc && activeDoc.folder === folder && activeDoc.name === d.name;
    const leaf = h("div", { class: "kb-leaf" + (active ? " active" : "") },
      h("span", { class: "kb-leaf-icon" }, JIGSAW.Icons.icon("file", 12)),
      h("span", { class: "kb-leaf-name" }, d.name),
      h("div", { class: "kb-leaf-ops" },
        h("button", { class: "icon-btn mini", "data-lr": d.name, title: "重命名" }, JIGSAW.Icons.icon("editfile", 11)),
        h("button", { class: "icon-btn mini", "data-ld": d.name, title: "删除" }, JIGSAW.Icons.icon("trash", 11))
      )
    );
    leaf.addEventListener("click", e => {
      if (e.target.closest("[data-lr]") || e.target.closest("[data-ld]")) return;
      pickDoc(folder, d.name);
    });
    el("[data-lr]", leaf).addEventListener("click", e => { e.stopPropagation(); pickDoc(folder, d.name).then(() => renameDoc()); });
    el("[data-ld]", leaf).addEventListener("click", e => { e.stopPropagation(); pickDoc(folder, d.name).then(() => deleteDoc()); });
    return leaf;
  }

  /* ---------- 渲染 ---------- */
  function render() {
    const root = KB.root;
    if (!root) return;
    root.innerHTML = "";

    const view = h("div", { class: "kb-view" },
      /* 顶栏 */
      h("div", { class: "kb-top" },
        h("button", { class: "icon-btn", "data-back": "1", title: "返回" }, JIGSAW.Icons.icon("back")),
        h("div", { class: "kb-top-title" }, "知识库"),
        h("div", { class: "kb-top-path", title: rootPath || "选择知识库存放目录" },
          JIGSAW.Icons.icon("folder", 12),
          h("span", null, shortPath(rootPath) || "选择目录")
        ),
        h("div", { class: "kb-top-spacer" }),
        h("button", { class: "btn btn-ghost", "data-pick-root": "1", title: "更换知识库存放目录" }, "目录"),
        h("button", { class: "btn btn-ghost", "data-new-doc": "1" }, "新文档")
      ),

      h("div", { class: "kb-body" },
        /* 左栏：完整文件树 */
        h("div", { class: "kb-side" },
          h("div", { class: "kb-side-head" },
            h("span", null, "知识库"),
            h("button", { class: "icon-btn mini", "data-new-folder": "1", title: "新建分类" }, JIGSAW.Icons.icon("plus", 13))
          ),
          h("div", { class: "kb-tree", "data-tree": "1" })
        ),

        /* 中栏：当前节点文档列表 */
        h("div", { class: "kb-main" },
          h("div", { class: "kb-main-head", "data-main-head": "1" }),
          h("div", { class: "kb-docs", "data-docs": "1" })
        ),

        /* 右栏：编辑器 */
        h("div", { class: "kb-editor-wrap", "data-editor-wrap": "1" })
      )
    );
    root.appendChild(view);

    /* 左栏：渲染树（根目录 + 分类，各自可展开显示文档） */
    const treeEl = el("[data-tree]", view);
    treeEl.innerHTML = "";
    const rootDocs = (tree && tree.rootDocs) || [];
    const folders = (tree && tree.folders) || [];

    // 根目录节点
    treeEl.appendChild(folderRow("", "根目录", rootDocs.length, true));
    if (isOpen("")) rootDocs.forEach(d => treeEl.appendChild(docLeaf("", d)));

    // 分类节点（嵌套分类的 name 是相对路径，如 "旅行/日本"）
    folders.forEach(f => {
      treeEl.appendChild(folderRow(f.name, f.name, f.docs.length, false));
      if (isOpen(f.name)) f.docs.forEach(d => treeEl.appendChild(docLeaf(f.name, d)));
    });
    if (!folders.length) {
      treeEl.appendChild(h("div", { class: "kb-empty" }, "暂无分类，点右上 + 新建"));
    }

    /* 中栏：标题 + 文档列表 */
    const head = el("[data-main-head]", view);
    head.innerHTML = "";
    head.appendChild(h("span", null, activeFolder ? activeFolder : "根目录"));
    if (activeFolder !== "") {
      head.appendChild(h("span", { class: "kb-drag-hint" }, "可拖入文件"));
    }

    const docsEl = el("[data-docs]", view);
    docsEl.innerHTML = "";
    const docList = activeFolder
      ? ((tree && tree.folders.find(f => f.name === activeFolder)) || { docs: [] }).docs
      : rootDocs;
    if (!docList.length) docsEl.innerHTML = '<div class="kb-empty">该目录暂无文档，点右上「新文档」</div>';
    docList.forEach(d => {
      const row = h("div", { class: "kb-doc" + (activeDoc && activeDoc.name === d.name && activeFolder === activeDoc.folder ? " active" : "") },
        h("span", { class: "kb-doc-icon" }, JIGSAW.Icons.icon("file", 13)),
        h("span", { class: "kb-doc-name" }, d.name),
        h("span", { class: "kb-doc-meta" }, fmtSize(d.size)),
        h("div", { class: "kb-doc-ops" },
          h("button", { class: "icon-btn mini", "data-rd": d.name, title: "重命名" }, JIGSAW.Icons.icon("editfile", 11)),
          h("button", { class: "icon-btn mini", "data-dd": d.name, title: "删除" }, JIGSAW.Icons.icon("trash", 11))
        )
      );
      row.addEventListener("click", e => {
        if (e.target.closest("[data-rd]")) return;
        if (e.target.closest("[data-dd]")) return;
        pickDoc(activeFolder, d.name);
      });
      el("[data-rd]", row).addEventListener("click", e => { e.stopPropagation(); renameDoc(); });
      el("[data-dd]", row).addEventListener("click", e => { e.stopPropagation(); deleteDoc(); });
      docsEl.appendChild(row);
    });

    /* 右栏：编辑器 */
    const ew = el("[data-editor-wrap]", view);
    ew.innerHTML = "";
    if (activeDoc) {
      if (activeDoc.editable === false) {
        const box = h("div", { class: "kb-editor kb-editor-binary" },
          h("div", { class: "kb-editor-head" },
            h("span", { class: "kb-editor-title" }, activeDoc.name),
            h("div", { class: "kb-editor-ops" },
              h("button", { class: "btn btn-ghost btn-sm", "data-rename": "1" }, "重命名"),
              h("button", { class: "btn btn-danger btn-sm", "data-del": "1" }, "删除")
            )
          ),
          h("div", { class: "kb-binary-note" },
            JIGSAW.Icons.icon("file", 22),
            h("div", { class: "kb-binary-t" }, "二进制文件无法预览"),
            h("div", { class: "kb-binary-s" }, activeDoc.error || "该文件（Word/PPT/PDF/图片等）已存入知识库，可保留、重命名或删除。将来接入解析后可预览。")
          )
        );
        ew.appendChild(box);
        el("[data-rename]", box).addEventListener("click", renameDoc);
        el("[data-del]", box).addEventListener("click", deleteDoc);
      } else {
        const editor = h("div", { class: "kb-editor" },
          h("div", { class: "kb-editor-head" },
            h("span", { class: "kb-editor-title" }, activeDoc.name + (dirty ? " •" : "")),
            h("div", { class: "kb-editor-ops" },
              h("button", { class: "btn btn-ghost btn-sm", "data-save": "1" }, saving ? "保存中…" : "保存"),
              h("button", { class: "btn btn-ghost btn-sm", "data-rename": "1" }, "重命名"),
              h("button", { class: "btn btn-danger btn-sm", "data-del": "1" }, "删除")
            )
          ),
          h("textarea", { class: "kb-textarea", "data-content": "1", spellcheck: "false" }, docContent)
        );
        ew.appendChild(editor);
        const ta = el("[data-content]", editor);
        ta.addEventListener("input", () => { docContent = ta.value; if (!dirty) { dirty = true; el(".kb-editor-title", editor).textContent = activeDoc.name + " •"; } });
        el("[data-save]", editor).addEventListener("click", saveDoc);
        el("[data-rename]", editor).addEventListener("click", renameDoc);
        el("[data-del]", editor).addEventListener("click", deleteDoc);
        ta.focus();
      }
    } else {
      ew.innerHTML = '<div class="kb-empty kb-empty-lg">在左侧选择一个文档开始编辑，或把文件拖进来</div>';
    }

    /* 顶栏动作 */
    const bind = (sel, fn) => { const n = el(sel, view); if (n) n.addEventListener("click", fn); };
    bind("[data-new-doc]", newDoc);
    bind("[data-new-folder]", newFolder);
    bind("[data-pick-root]", pickRoot);
    bind("[data-back]", () => JIGSAW.Router.goBack());

    /* 拖拽导入 */
    setupDrop(view);
  }

  function fmtSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  function shortPath(p) {
    if (!p) return "";
    p = String(p).replace(/\\/g, "/");
    const parts = p.split("/").filter(Boolean);
    if (parts.length <= 3) return p;
    return parts.slice(-3).join("/");
  }

  KB.mount = function (container) {
    KB.root = container;
    loadRoot().then(loadTree);
  };
  KB.unmount = function () {
    if (dirty && activeDoc) {
      setTimeout(async () => {
        if (dirty && activeDoc && await JIGSAW.PromptModal.confirm({ title: "未保存的修改", message: `「${activeDoc.name}」有未保存修改，离开前保存？` })) saveDoc();
      }, 0);
    }
  };

  JIGSAW.Views = JIGSAW.Views || {};
  JIGSAW.Views.Knowledge = KB;
})();
