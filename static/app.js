"use strict";

/* ----------------------------- Element types ----------------------------- */
const TYPE_META = {
  title:          { label: "Title",          color: "#7C3AED" },
  section_header: { label: "Section header", color: "#DC2626" },
  page_header:    { label: "Page header",    color: "#EA580C" },
  text:           { label: "Text",           color: "#0D9488" },
  table:          { label: "Table",          color: "#2563EB" },
  page_number:    { label: "Page number",    color: "#CA8A04" },
  figure:         { label: "Figure",         color: "#DB2777" },
  caption:        { label: "Caption",        color: "#0891B2" },
  list:           { label: "List",           color: "#16A34A" },
};
const DEFAULT_META = { label: "Element", color: "#64748B" };
const meta = (t) => TYPE_META[t] || { ...DEFAULT_META, label: t || "Element" };

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/* ------------------------------- App state ------------------------------- */
const state = {
  documents: [],
  docId: null,
  doc: null,
  pageIdx: 0,
  view: "formatted",
  zoom: 1,
  fitWidth: 820,
  selectedId: null,
};

const $ = (id) => document.getElementById(id);
const el = {
  docCount: $("doc-count"), docList: $("doc-list"), sidebar: $("sidebar"),
  fileChip: $("file-chip"), currentFile: $("current-file"), sourceTable: $("source-table"),
  img: $("page-img"), boxes: $("boxes"), imageWrap: $("image-wrap"), imagePane: $("image-pane"),
  formatted: $("formatted"), jsonView: $("json-view"), textPane: $("text-pane"),
  legend: $("legend"), legendBtn: $("legend-btn"),
  search: $("search"), searchCount: $("search-count"),
  prevPage: $("prev-page"), nextPage: $("next-page"),
  pageCur: $("page-cur"), pageTotal: $("page-total"), pageLabelNum: $("page-label-num"),
  viewToggle: $("view-toggle"),
  tooltip: $("tooltip"), overlay: $("overlay-msg"),
  zoomIn: $("zoom-in"), zoomOut: $("zoom-out"), zoomFit: $("zoom-fit"),
};

/* ------------------------------- Overlay -------------------------------- */
function showLoading(text) {
  el.overlay.className = "overlay-msg";
  el.overlay.innerHTML = `<div class="spinner"></div><div class="msg-text">${escapeHtml(text)}</div>`;
  el.overlay.hidden = false;
}
function showError(text) {
  el.overlay.className = "overlay-msg error";
  el.overlay.innerHTML = `<div class="msg-text">${escapeHtml(text)}</div>`;
  el.overlay.hidden = false;
}
function hideOverlay() { el.overlay.hidden = true; }

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* -------------------------------- Init ---------------------------------- */
async function init() {
  try {
    const cfg = await fetchJson("/api/config");
    el.sourceTable.textContent = cfg.source_table || "";
  } catch (_) { /* non-fatal */ }

  await loadDocuments();
  wireEvents();
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) {
    let detail = `${r.status} ${r.statusText}`;
    try { const j = await r.json(); if (j.detail) detail = j.detail; } catch (_) {}
    throw new Error(detail);
  }
  return r.json();
}

async function loadDocuments() {
  showLoading("Loading documents…");
  try {
    state.documents = await fetchJson("/api/documents");
  } catch (e) {
    showError("Could not load documents.\n\n" + e.message);
    return;
  }
  renderDocList();
  el.docCount.textContent =
    `${state.documents.length} document${state.documents.length === 1 ? "" : "s"}`;
  if (state.documents.length) {
    await selectDocument(state.documents[0].id);
  } else {
    showError("No documents found in the source table.");
  }
}

function renderDocList() {
  el.docList.innerHTML = "";
  for (const d of state.documents) {
    const li = document.createElement("li");
    li.className = "doc-item" + (d.id === state.docId ? " active" : "");
    li.dataset.id = d.id;
    li.innerHTML = `
      <span class="doc-thumb"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg></span>
      <span class="doc-meta">
        <span class="doc-name">${escapeHtml(d.name)}</span>
        <span class="doc-sub">${d.element_count} elements${d.page_count > 1 ? " · " + d.page_count + " pages" : ""}</span>
      </span>`;
    li.addEventListener("click", () => selectDocument(d.id));
    el.docList.appendChild(li);
  }
}

/* --------------------------- Document loading --------------------------- */
async function selectDocument(docId) {
  if (state.docId === docId && state.doc) return;
  state.docId = docId;
  state.selectedId = null;
  for (const li of el.docList.children) li.classList.toggle("active", li.dataset.id === docId);

  const docMeta = state.documents.find((d) => d.id === docId);
  el.fileChip.hidden = false;
  el.currentFile.textContent = docMeta ? docMeta.name : docId;
  showLoading(`Rendering ${docMeta ? docMeta.name : docId}…`);

  try {
    state.doc = await fetchJson(`/api/documents/${encodeURIComponent(docId)}`);
  } catch (e) {
    showError(`Could not load ${docId}.\n\n` + e.message);
    return;
  }
  try {
    state.pageIdx = 0;
    state.zoom = 1;
    renderPage();
    renderText();
    buildLegend();
    el.search.value = "";
    applySearch("");
  } catch (e) {
    console.error(e);
    showError("Render error: " + e.message + "\n\n" + (e.stack || ""));
    return;
  }
  hideOverlay();
}

function currentPage() { return state.doc.pages[state.pageIdx]; }

function renderPage() {
  const page = currentPage();
  // image
  el.img.src = `/api/documents/${encodeURIComponent(state.docId)}/pages/${page.page_id}/image.png`;
  computeFit();
  applyZoom();
  // boxes
  el.boxes.innerHTML = "";
  for (const b of page.boxes) {
    const m = meta(b.type);
    const div = document.createElement("div");
    div.className = "bbox";
    div.dataset.elid = String(b.id);
    div.dataset.type = b.type;
    const [x1, y1, x2, y2] = b.coord;
    div.style.left = (x1 / page.width) * 100 + "%";
    div.style.top = (y1 / page.height) * 100 + "%";
    div.style.width = ((x2 - x1) / page.width) * 100 + "%";
    div.style.height = ((y2 - y1) / page.height) * 100 + "%";
    div.style.setProperty("--c", m.color);
    div.style.setProperty("--c-fill", hexToRgba(m.color, 0.10));
    div.style.setProperty("--c-fill-strong", hexToRgba(m.color, 0.24));
    div.addEventListener("mouseenter", (ev) => { setLinked(b.id, true); showTooltip(ev, b); });
    div.addEventListener("mousemove", (ev) => moveTooltip(ev));
    div.addEventListener("mouseleave", () => { setLinked(b.id, false); hideTooltip(); });
    div.addEventListener("click", () => selectElement(b.id, "box"));
    el.boxes.appendChild(div);
  }
  // page indicators
  el.pageCur.textContent = state.pageIdx + 1;
  el.pageTotal.textContent = state.doc.pages.length;
  el.pageLabelNum.textContent = page.page_id + 1;
  el.prevPage.disabled = state.pageIdx === 0;
  el.nextPage.disabled = state.pageIdx >= state.doc.pages.length - 1;
}

function renderText() {
  const page = currentPage();
  const elements = state.doc.elements.filter((e) => e.page === page.page_id);
  // ----- formatted -----
  el.formatted.innerHTML = "";
  for (const e of elements) {
    const m = meta(e.type);
    const wrap = document.createElement("div");
    wrap.className = `fmt-el fmt-${e.type}`;
    wrap.dataset.elid = String(e.id);
    wrap.dataset.type = e.type;
    wrap.style.setProperty("--cc", m.color);
    wrap.style.setProperty("--hl", hexToRgba(m.color, 0.08));

    const conf = document.createElement("span");
    conf.className = "conf";
    conf.style.setProperty("--cc", m.color);
    conf.textContent = e.confidence != null ? Math.round(e.confidence * 100) + "%" : "";
    if (e.confidence == null) conf.style.display = "none";

    const body = document.createElement("div");
    body.className = "fmt-body";
    if (e.type === "table") {
      body.innerHTML = e.content;            // trusted ai_parse HTML
    } else {
      body.innerHTML = escapeHtml(e.content); // preserve text; newlines via pre-wrap
    }
    wrap.dataset.text = (body.textContent || "").toLowerCase();
    wrap._origHtml = body.innerHTML;

    wrap.appendChild(conf);
    wrap.appendChild(body);
    wrap.addEventListener("mouseenter", () => setLinked(e.id, true));
    wrap.addEventListener("mouseleave", () => setLinked(e.id, false));
    wrap.addEventListener("click", () => selectElement(e.id, "text"));
    el.formatted.appendChild(wrap);
  }
  // ----- JSON -----
  const jsonData = elements.map((e) => ({
    id: e.id, type: e.type,
    confidence: e.confidence != null ? Number(e.confidence.toFixed(4)) : null,
    page: e.page, content: e.content,
  }));
  el.jsonView.innerHTML = syntaxHighlight(JSON.stringify(jsonData, null, 2));
  setView(state.view);
}

/* --------------------------- Linking & select --------------------------- */
function elemsForId(id) {
  const sid = String(id);
  return {
    boxes: el.boxes.querySelectorAll(`.bbox[data-elid="${sid}"]`),
    fmts: el.formatted.querySelectorAll(`.fmt-el[data-elid="${sid}"]`),
  };
}
function setLinked(id, on) {
  const { boxes, fmts } = elemsForId(id);
  boxes.forEach((b) => b.classList.toggle("linked", on));
  fmts.forEach((f) => f.classList.toggle("linked", on));
  if (on && fmts[0] && state.view === "formatted") {
    fmts[0].scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}
function selectElement(id, origin) {
  const sid = String(id);
  if (state.selectedId === sid) { clearSelection(); return; }
  clearSelection();
  state.selectedId = sid;
  const { boxes, fmts } = elemsForId(id);
  boxes.forEach((b) => b.classList.add("selected"));
  fmts.forEach((f) => f.classList.add("selected"));
  if (origin === "box" && fmts[0] && state.view === "formatted") {
    fmts[0].scrollIntoView({ block: "center", behavior: "smooth" });
  } else if (origin === "text" && boxes[0]) {
    boxes[0].scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  }
}
function clearSelection() {
  if (!state.selectedId) return;
  el.boxes.querySelectorAll(".bbox.selected").forEach((b) => b.classList.remove("selected"));
  el.formatted.querySelectorAll(".fmt-el.selected").forEach((f) => f.classList.remove("selected"));
  state.selectedId = null;
}

/* -------------------------------- Tooltip ------------------------------- */
function showTooltip(ev, b) {
  const m = meta(b.type);
  const conf = b.confidence != null ? `<span class="tt-conf">${Math.round(b.confidence * 100)}%</span>` : "";
  el.tooltip.innerHTML =
    `<span class="tt-dot" style="background:${m.color}"></span><span class="tt-type">${escapeHtml(m.label)}</span>${conf}`;
  el.tooltip.hidden = false;
  moveTooltip(ev);
}
function moveTooltip(ev) {
  const pad = 14;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  const r = el.tooltip.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
  el.tooltip.style.left = x + "px";
  el.tooltip.style.top = y + "px";
}
function hideTooltip() { el.tooltip.hidden = true; }

/* -------------------------------- Legend -------------------------------- */
function buildLegend() {
  const counts = {};
  for (const p of state.doc.pages) for (const b of p.boxes) counts[b.type] = (counts[b.type] || 0) + 1;
  const types = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  let html = `<div class="legend-title">Element types</div>`;
  for (const t of types) {
    const m = meta(t);
    html += `<div class="legend-item">
      <span class="legend-swatch" style="border-color:${m.color};background:${hexToRgba(m.color, 0.14)}"></span>
      ${escapeHtml(m.label)}<span class="legend-count">${counts[t]}</span></div>`;
  }
  el.legend.innerHTML = html;
}

/* -------------------------------- Search -------------------------------- */
function applySearch(q) {
  q = (q || "").trim().toLowerCase();
  const fmts = el.formatted.querySelectorAll(".fmt-el");
  // Always reset to a clean slate first.
  fmts.forEach((f) => {
    f.classList.remove("dimmed", "search-hit");
    const body = f.querySelector(".fmt-body");
    if (body && f._origHtml != null) body.innerHTML = f._origHtml;
  });
  el.boxes.querySelectorAll(".bbox").forEach((b) => b.classList.remove("dimmed"));
  if (!q) { el.searchCount.hidden = true; return; }

  let n = 0, firstHit = null;
  const hitIds = new Set();
  fmts.forEach((f) => {
    const hit = (f.dataset.text || "").includes(q);
    f.classList.toggle("dimmed", !hit);
    if (hit) {
      f.classList.add("search-hit");
      highlightTextNodes(f.querySelector(".fmt-body"), q); // safe in tables too
      n++; hitIds.add(f.dataset.elid);
      if (!firstHit) firstHit = f;
    }
  });
  el.boxes.querySelectorAll(".bbox").forEach((b) => b.classList.toggle("dimmed", !hitIds.has(b.dataset.elid)));
  el.searchCount.hidden = false;
  el.searchCount.textContent = n ? `${n} match${n === 1 ? "" : "es"}` : "no matches";
  if (firstHit && state.view === "formatted") firstHit.scrollIntoView({ block: "center", behavior: "smooth" });
}
// Wrap query matches in <mark> by walking text nodes only — never breaks HTML.
function highlightTextNodes(root, q) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
  for (const node of nodes) {
    const text = node.nodeValue;
    const lc = text.toLowerCase();
    if (!lc.includes(q)) continue;
    const frag = document.createDocumentFragment();
    let last = 0, idx = lc.indexOf(q);
    while (idx !== -1) {
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(idx, idx + q.length);
      frag.appendChild(mark);
      last = idx + q.length;
      idx = lc.indexOf(q, last);
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

/* ------------------------------- JSON view ------------------------------ */
function syntaxHighlight(json) {
  // Escape <,>,& but keep quotes so the string-literal regex still matches.
  json = json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return json.replace(
    /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g,
    (m) => {
      let cls = "j-num";
      if (/^"/.test(m)) cls = /:$/.test(m) ? "j-key" : "j-str";
      else if (/true|false/.test(m)) cls = "j-bool";
      else if (/null/.test(m)) cls = "j-null";
      return `<span class="${cls}">${m}</span>`;
    }
  );
}

/* -------------------------------- Views --------------------------------- */
function setView(view) {
  state.view = view;
  el.formatted.hidden = view !== "formatted";
  el.jsonView.hidden = view !== "json";
  for (const b of el.viewToggle.children) b.classList.toggle("active", b.dataset.view === view);
}

/* --------------------------------- Zoom --------------------------------- */
function computeFit() {
  const avail = el.imagePane.clientWidth - 56; // 28px padding each side
  state.fitWidth = Math.max(280, Math.min(820, avail));
}
function applyZoom() {
  el.imageWrap.style.width = Math.round(state.fitWidth * state.zoom) + "px";
  el.imageWrap.style.maxWidth = "none";
  el.zoomFit.textContent = state.zoom === 1 ? "Fit" : Math.round(state.zoom * 100) + "%";
}
function setZoom(z) { state.zoom = Math.max(0.4, Math.min(3, z)); applyZoom(); }

/* ------------------------------- Events --------------------------------- */
function wireEvents() {
  $("toggle-sidebar").addEventListener("click", () => el.sidebar.classList.toggle("collapsed"));
  $("refresh-btn").addEventListener("click", async () => {
    state.doc = null; state.docId = null;
    showLoading("Reloading data…");
    try { state.documents = await fetchJson("/api/documents?refresh=true"); }
    catch (e) { showError("Reload failed.\n\n" + e.message); return; }
    renderDocList();
    if (state.documents.length) await selectDocument(state.documents[0].id);
    else hideOverlay();
  });

  el.legendBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = el.legend.hidden;
    el.legend.hidden = !open;
    el.legendBtn.classList.toggle("active", open);
  });
  document.addEventListener("click", (e) => {
    if (!el.legend.hidden && !el.legend.contains(e.target) && e.target !== el.legendBtn) {
      el.legend.hidden = true; el.legendBtn.classList.remove("active");
    }
  });

  el.search.addEventListener("input", (e) => applySearch(e.target.value));
  el.viewToggle.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]");
    if (btn) { setView(btn.dataset.view); if (el.search.value) applySearch(el.search.value); }
  });

  el.prevPage.addEventListener("click", () => { if (state.pageIdx > 0) { state.pageIdx--; renderPage(); renderText(); applySearch(el.search.value); } });
  el.nextPage.addEventListener("click", () => { if (state.pageIdx < state.doc.pages.length - 1) { state.pageIdx++; renderPage(); renderText(); applySearch(el.search.value); } });

  el.zoomIn.addEventListener("click", () => setZoom(state.zoom * 1.2));
  el.zoomOut.addEventListener("click", () => setZoom(state.zoom / 1.2));
  el.zoomFit.addEventListener("click", () => setZoom(1));

  el.imagePane.addEventListener("click", (e) => { if (e.target === el.imagePane || e.target.classList.contains("image-stage")) clearSelection(); });

  window.addEventListener("resize", () => { if (state.doc && state.zoom === 1) { computeFit(); applyZoom(); } });
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === "ArrowDown" || e.key === "j") moveDoc(1);
    else if (e.key === "ArrowUp" || e.key === "k") moveDoc(-1);
    else if (e.key === "/") { e.preventDefault(); el.search.focus(); }
    else if (e.key === "Escape") { clearSelection(); el.search.value = ""; applySearch(""); }
  });
}
function moveDoc(delta) {
  const idx = state.documents.findIndex((d) => d.id === state.docId);
  const next = idx + delta;
  if (next >= 0 && next < state.documents.length) selectDocument(state.documents[next].id);
}

window.addEventListener("error", (e) => {
  console.error("window error:", e.error || e.message);
  showError("Script error: " + (e.message || "") + "\n\n" + ((e.error && e.error.stack) || ""));
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("unhandled rejection:", e.reason);
  showError("Unhandled promise: " + ((e.reason && e.reason.message) || e.reason));
});

document.addEventListener("DOMContentLoaded", init);
