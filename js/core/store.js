/* ============================================================
   JIGSAW — Store (central state + pub/sub)
   UI reads state, mutates ONLY through services.
   ============================================================ */
(function () {
  const state = {
    conversations: [],   // [{ id, title, modelId, createdAt, messages:[...], workflowId }]
    workflows: {},       // workflowId -> { id, conversationId, name, nodes:[], edges:[], running:false, executed:false }
    models: [],          // [{ id, name, desc, context, vision, tools }]
    activeModelId: null,
    activeConversationId: null,
    settings: null,
    ui: { historyOpen: false, selectedNodeId: null }
  };

  const listeners = new Map(); // key -> Set<fn>
  const all = new Set();

  function emit(key) {
    if (key && listeners.has(key)) listeners.get(key).forEach(fn => { try { fn(state); } catch (e) { console.error(e); } });
    all.forEach(fn => { try { fn(state, key); } catch (e) { console.error(e); } });
  }

  const Store = {
    state,
    get: () => state,
    set(partial) {
      Object.assign(state, partial);
      emit("__all__");
    },
    /** update a slice; returns nothing */
    update(slice, fn) {
      const next = fn(state[slice]);
      if (next !== undefined) state[slice] = next;
      emit(slice);
      emit("__all__");
    },
    subscribe(key, fn) {
      if (key === "*") { all.add(fn); return () => all.delete(fn); }
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
      return () => listeners.get(key).delete(fn);
    },
    notify(slice) { emit(slice); }
  };

  JIGSAW.Store = Store;
})();
