/* ============================================================
   JIGSAW — Icon System
   Stroke-based inline SVG, 24x24 viewBox, consistent 1.7px stroke.
   Grayscale only. No emoji anywhere in the app.
   ============================================================ */
(function () {
  const P = {
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.7,
    "stroke-linecap": "round",
    "stroke-linejoin": "round"
  };

  const PATHS = {
    menu:      '<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="14" y2="17"/>',
    search:    '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.2" y2="16.2"/>',
    plus:      '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    "plus-sm": '<line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
    send:      '<path d="M4.5 12.5 20 4l-8 16-1.6-6.4L4.5 12.5Z"/><path d="M11 13.5 20 4"/>',
    sliders:   '<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2.2"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2.2"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="9" cy="18" r="2.2"/>',
    tool:      '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    branch:    '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7v10M8 6h6a4 4 0 0 1 4 4v0"/>',
    back:      '<path d="m14 6-6 6 6 6"/>',
    "chev-right": '<path d="m9 6 6 6-6 6"/>',
    "chev-down": '<path d="m6 9 6 6 6-6"/>',
    trash:     '<path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13"/><line x1="10" y1="11" x2="10" y2="16"/><line x1="14" y1="11" x2="14" y2="16"/>',
    edit:      '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="m13.5 6.5 3 3"/>',
    play:      '<path d="M7 4.5v15l12-7.5L7 4.5Z"/>',
    reset:     '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v4h4"/>',
    check:     '<path d="m4.5 12.5 5 5 10-11"/>',
    x:         '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
    copy:      '<rect x="9" y="9" width="11" height="11"/><path d="M5 15V5h10"/>',
    refresh:   '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    "zoom-in": '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.2" y2="16.2"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>',
    "zoom-out": '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.2" y2="16.2"/><line x1="8" y1="11" x2="14" y2="11"/>',
    fit:       '<path d="M8 3H4a1 1 0 0 0-1 1v4"/><path d="M16 3h4a1 1 0 0 1 1 1v4"/><path d="M8 21H4a1 1 0 0 1-1-1v-4"/><path d="M16 21h4a1 1 0 0 0 1-1v-4"/>',
    grip:      '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
    lock:      '<rect x="5" y="11" width="14" height="9"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    shield:    '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z"/>',
    folder:    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
    list:      '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" stroke-width="2.5"/>',
    message:   '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1Z"/>',
    file:      '<path d="M6 3h8l4 4v14H6V3Z"/><path d="M14 3v4h4"/>',
    readfile:  '<path d="M6 3h8l4 4v14H6V3Z"/><path d="M14 3v4h4"/><path d="M9.5 12.5h5"/><path d="M9.5 16h5"/>',
    editfile:  '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="m13.5 6.5 3 3"/><path d="M4 20h16"/>',
    patch:     '<path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9l-6-5H9Z"/><path d="M9 4v5h6"/><path d="M12 12v6M9 15h6"/>',
    calc:      '<rect x="5" y="3" width="14" height="18"/><path d="M8 3v4h8V3"/><path d="M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h.01M12 19h.01M16 19h.01" stroke-width="2.2"/>',
    book:      '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z"/><path d="M4 19a2 2 0 0 1 2-2h13"/><path d="M9 7h7M9 10.5h7"/>',
    fetch:     '<path d="M6 3h8l4 4v14H6V3Z"/><path d="M14 3v4h4"/><path d="M12 17v-6"/><path d="m9 14 3 3 3-3"/>',
    clock:     '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
    layers:    '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
    terminal:  '<path d="m5 7 4 5-4 5"/><path d="M11 17h8"/>',
    cpu:       '<rect x="6" y="6" width="12" height="12"/><rect x="10" y="10" width="4" height="4"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    globe:     '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.8 2.4 4 5.4 4 8.5s-1.2 6.1-4 8.5c-2.8-2.4-4-5.4-4-8.5s1.2-6.1 4-8.5Z"/>',
    database:  '<ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/><path d="M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/>',
    code:      '<path d="m8 7-5 5 5 5"/><path d="m16 7 5 5-5 5"/><path d="m13.5 4-3 16"/>',
    alert:     '<path d="M12 3 2.8 20h18.4L12 3Z"/><line x1="12" y1="9" x2="12" y2="13.5"/><line x1="12" y1="17" x2="12" y2="17.1"/>',
    dot:       '<circle cx="12" cy="12" r="4"/>',
    "x-oct":   '<path d="M8.5 3.5h7L19.5 8.5v7l-4 4h-7l-4-4v-7l4-4Z"/><line x1="9.5" y1="9.5" x2="14.5" y2="14.5"/><line x1="14.5" y1="9.5" x2="9.5" y2="14.5"/>',
    panel:     '<rect x="3" y="4" width="18" height="16"/><line x1="15" y1="4" x2="15" y2="20"/>',
    close:     '<rect x="3" y="3" width="18" height="18"/><path d="m8 3-5 5-3-3" transform="translate(2,0)"/>',
    home:      '<path d="m3 11 9-8 9 8"/><path d="M5 9.5V20h14V9.5"/>',
    key:       '<circle cx="8" cy="14" r="4"/><path d="m11 11 8-8M15 7l3 3M17 5l2 2"/>',
    spark:     '<path d="M12 3v0"/><path d="m12 4 1.2 3.8L17 9l-3.8 1.2L12 14l-1.2-3.8L7 9l3.8-1.2L12 4Z"/>',
    bolt:      '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/>',
    "eye-off": '<path d="m3 3 18 18"/><path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c5 0 8.5 4 9.5 7-.4 1.2-1.3 2.7-2.6 4M6.6 6.6C4.4 8 2.8 10 2 12c1 3 4.5 7 9.5 7 .9 0 1.7-.1 2.5-.3"/>',
    link:      '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>',
    arrowUp:   '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
    arrowUpRight: '<path d="M7 17 17 7"/><path d="M7 7h10v10"/>',
    user:      '<circle cx="12" cy="8" r="4"/><path d="M4.5 20c1.5-3.2 4-4.5 7.5-4.5s6 1.3 7.5 4.5"/>',
    jigsaw:    '<rect x="3.5" y="3.5" width="8" height="8"/><rect x="12.5" y="3.5" width="8" height="8"/><rect x="3.5" y="12.5" width="8" height="8"/><rect x="12.5" y="12.5" width="8" height="8"/>',
    "gate-and": '<path d="M4 6h6a6 6 0 0 1 6 6 6 6 0 0 1-6 6H4V6Z"/><line x1="16" y1="12" x2="21" y2="12"/><line x1="2" y1="8" x2="4" y2="8"/><line x1="2" y1="16" x2="4" y2="16"/>',
    "gate-or":  '<path d="M4 5c3 3 3 11 0 14 6 0 10-2 13-7-3-5-7-7-13-7Z"/><line x1="17" y1="12" x2="22" y2="12"/><line x1="2" y1="8" x2="5.5" y2="8"/><line x1="2" y1="16" x2="5.5" y2="16"/>',
    "gate-not": '<path d="M4 5v14l11-7-11-7Z"/><circle cx="18" cy="12" r="2.5"/><line x1="2" y1="12" x2="4" y2="12"/>',
    condition: '<path d="M12 3 21 12l-9 9-9-9 9-9Z"/><path d="M9 12h6"/><path d="M12 9v6"/>',
    loop:      '<path d="M20 13a7 7 0 1 1-2.1-5"/><path d="M20 4v5h-5"/>',
    shield:    '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
    "shield-alert": '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    skip:      '<polygon points="5,4 15,12 5,20"/><line x1="19" y1="5" x2="19" y2="19"/>'
  };

  function icon(name, size) {
    const s = size || 16;
    const d = PATHS[name] || PATHS.dot;
    const attrs = Object.entries(P).map(([k, v]) => `${k}="${v}"`).join(" ");
    return `<svg class="icon" width="${s}" height="${s}" viewBox="0 0 24 24" ${attrs} aria-hidden="true">${d}</svg>`;
  }

  window.JIGSAW = window.JIGSAW || {};
  JIGSAW.Icons = { icon, has: n => !!PATHS[n] };
})();
