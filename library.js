"use strict";
// Cadet Prep library: import PDFs, read them offline, and sync them through the private cards repo.
// PDF files live in IndexedDB on each device. Their details (name, size, reading position) live in S.pdfs.
// In the repo each PDF is stored as library/<id>.json (details) plus library/<id>/NNN.part (10 MB pieces),
// which keeps every file well under GitHub's 100 MB limit.

const PART = 10 * 1024 * 1024;

// ---------- IndexedDB ----------
let idbP = null;
function idb() {
  return idbP = idbP || new Promise((ok, no) => {
    const r = indexedDB.open("cadet-library", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("files");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((ok, no) => {
    const tx = db.transaction("files", mode), req = fn(tx.objectStore("files"));
    tx.oncomplete = () => ok(req && req.result);
    tx.onerror = tx.onabort = () => no(tx.error || new Error("Storage error"));
  });
}
const fileGet = id => idbDo("readonly", s => s.get(id));
const filePut = (id, blob) => idbDo("readwrite", s => s.put(blob, id));
const fileDel = id => idbDo("readwrite", s => s.delete(id));
const fileKeys = () => idbDo("readonly", s => s.getAllKeys());
const fileClear = () => idbDo("readwrite", s => s.clear());

let localIds = new Set();
async function refreshLocal() { try { localIds = new Set(await fileKeys()); } catch (e) { localIds = new Set(); } }

// ---------- Helpers ----------
const mb = n => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
async function fileId(buf) {
  try {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    return [...h.slice(0, 8)].map(b => b.toString(16).padStart(2, "0")).join("");
  } catch (e) { return Date.now().toString(16) + Math.random().toString(16).slice(2, 8); }
}
const blobB64 = blob => new Promise((ok, no) => {
  const r = new FileReader();
  r.onload = () => ok(r.result.slice(r.result.indexOf(",") + 1));
  r.onerror = () => no(r.error);
  r.readAsDataURL(blob);
});
const docs = () => Object.values(S.pdfs).sort((a, b) => a.name.localeCompare(b.name));

let pdfjsP = null;
function pdfjs() {
  return pdfjsP = pdfjsP || import("./vendor/pdfjs/pdf.min.mjs").then(m => {
    m.GlobalWorkerOptions.workerSrc = new URL("vendor/pdfjs/pdf.worker.min.mjs", location.href).href;
    return m;
  }).catch(e => { pdfjsP = null; throw e; });
}

// ---------- Import ----------
async function importPdf(file) {
  const buf = await file.arrayBuffer();
  if (new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength))).indexOf("%PDF") < 0) throw new Error("not a PDF");
  const id = await fileId(buf);
  if (S.pdfs[id]) return `${file.name}: already in your library`;
  let pages = null;
  try { const lib = await pdfjs(); const d = await lib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise; pages = d.numPages; d.destroy(); } catch (e) {}
  await filePut(id, new Blob([buf], { type: "application/pdf" }));
  localIds.add(id);
  S.pdfs[id] = { id, name: file.name.replace(/\.pdf$/i, ""), size: buf.byteLength, pages, page: 1, added: new Date().toISOString(), remote: false };
  S.pdfGone = S.pdfGone.filter(x => x !== id);
  save();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  return `${file.name}: added`;
}

async function removePdf(id) {
  const d = S.pdfs[id];
  if (!d) return;
  if (d.remote) S.pdfGone.push(id);
  delete S.pdfs[id];
  save();
  await fileDel(id).catch(() => {});
  localIds.delete(id);
}

// ---------- GitHub (git data API, so each PDF lands in one commit) ----------
async function ghApi(path, opts = {}) {
  const r = await fetch(`https://api.github.com/repos/${S.settings.ghRepo}${path}`, Object.assign({}, opts, {
    headers: Object.assign({ Authorization: `Bearer ${S.settings.ghToken}`, Accept: "application/vnd.github+json" }, opts.headers || {}),
    cache: "no-store",
  }));
  if (r.status === 404) return null;
  if (!r.ok) { const e = new Error(`GitHub said ${r.status}`); e.status = r.status; throw e; }
  return r;
}
const ghJson = async (path, opts) => { const r = await ghApi(path, opts); return r ? r.json() : null; };
const ghPost = (path, body, method = "POST") => ghJson(path, { method, body: JSON.stringify(body) });

async function commitTree(entries, message) {
  const repo = await ghJson("");
  const branch = repo.default_branch;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await ghJson(`/git/ref/heads/${branch}`);
    const head = await ghJson(`/git/commits/${ref.object.sha}`);
    const tree = await ghPost("/git/trees", { base_tree: head.tree.sha, tree: entries });
    const commit = await ghPost("/git/commits", { message, tree: tree.sha, parents: [ref.object.sha] });
    try { await ghPost(`/git/refs/heads/${branch}`, { sha: commit.sha }, "PATCH"); return; }
    catch (e) { if (e.status !== 422) throw e; } // Someone else committed first; rebuild on the new head.
  }
  throw new Error("GitHub kept changing during upload, try again");
}

function manifest(d, parts) {
  return JSON.stringify({ id: d.id, name: d.name, size: d.size, pages: d.pages, added: d.added, parts }, null, 1);
}

async function uploadPdf(d, progress) {
  const blob = await fileGet(d.id);
  if (!blob) return false;
  const n = Math.max(1, Math.ceil(blob.size / PART)), entries = [], parts = [];
  for (let i = 0; i < n; i++) {
    progress(`Uploading ${d.name} (${i + 1} of ${n})`);
    const b = await ghPost("/git/blobs", { content: await blobB64(blob.slice(i * PART, (i + 1) * PART)), encoding: "base64" });
    const path = `library/${d.id}/${String(i).padStart(3, "0")}.part`;
    entries.push({ path, mode: "100644", type: "blob", sha: b.sha });
    parts.push(path);
  }
  entries.push({ path: `library/${d.id}.json`, mode: "100644", type: "blob", content: manifest(d, parts) });
  await commitTree(entries, `Add ${d.name} to the library`);
  d.parts = parts; d.remote = true; d.renamed = false;
  save();
  return true;
}

async function downloadPdf(id, progress = () => {}) {
  const d = S.pdfs[id];
  if (!S.settings.ghToken) throw new Error("link GitHub in Settings to download");
  if (!navigator.onLine) throw new Error("you're offline");
  let parts = d.parts;
  if (!parts) { const m = await ghApi(`/contents/library/${id}.json`, { headers: { Accept: "application/vnd.github.raw+json" } }); parts = JSON.parse(await m.text()).parts; }
  const bufs = [];
  for (let i = 0; i < parts.length; i++) {
    progress(`Downloading ${d.name} (${i + 1} of ${parts.length})`);
    const r = await ghApi(`/contents/${parts[i].split("/").map(encodeURIComponent).join("/")}`, { headers: { Accept: "application/vnd.github.raw+json" } });
    if (!r) throw new Error("file is missing from GitHub");
    bufs.push(await r.arrayBuffer());
  }
  await filePut(id, new Blob(bufs, { type: "application/pdf" }));
  localIds.add(id);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

// Two-way sync of the library list. PDFs themselves download when opened, or with "Download all".
async function syncLibrary(progress = () => {}) {
  await refreshLocal();
  const listing = await ghJson("/contents/library");
  const remote = {};
  for (const f of listing || []) if (f.type === "file" && f.name.endsWith(".json")) remote[f.name.slice(0, -5)] = f;
  let up = 0, added = 0, gone = 0;
  // Deleted on this device: remove from GitHub.
  for (const id of S.pdfGone.slice()) {
    if (remote[id]) {
      const m = await ghApi(`/contents/library/${id}.json`, { headers: { Accept: "application/vnd.github.raw+json" } });
      const parts = m ? JSON.parse(await m.text()).parts || [] : [];
      await commitTree([`library/${id}.json`, ...parts].map(path => ({ path, mode: "100644", type: "blob", sha: null })), `Remove ${id} from the library`);
      delete remote[id];
    }
    S.pdfGone = S.pdfGone.filter(x => x !== id);
    save();
  }
  // New on other devices: list them here. Deleted on other devices: remove here.
  for (const [id, f] of Object.entries(remote)) {
    const d = S.pdfs[id];
    if (d && d.msha === f.sha) continue;
    if (d && d.renamed) continue;
    const m = await ghApi(`/contents/${f.path}`, { headers: { Accept: "application/vnd.github.raw+json" } });
    if (!m) continue;
    const info = JSON.parse(await m.text());
    if (!d) added++;
    S.pdfs[id] = Object.assign({ page: 1 }, d, { id, name: info.name, size: info.size, pages: info.pages, added: info.added, parts: info.parts, remote: true, msha: f.sha });
  }
  for (const d of Object.values(S.pdfs)) {
    if (d.remote && !remote[d.id]) { delete S.pdfs[d.id]; await fileDel(d.id).catch(() => {}); localIds.delete(d.id); gone++; }
  }
  save();
  // Imported on this device: upload. Renamed here: update the details file.
  for (const d of Object.values(S.pdfs)) {
    if (!d.remote) { if (await uploadPdf(d, progress)) up++; else delete S.pdfs[d.id]; }
    else if (d.renamed) {
      await commitTree([{ path: `library/${d.id}.json`, mode: "100644", type: "blob", content: manifest(d, d.parts) }], `Rename ${d.name} in the library`);
      d.renamed = false; delete d.msha;
    }
  }
  save();
  return [up && `${up} PDF(s) uploaded`, added && `${added} new PDF(s) listed`, gone && `${gone} removed`].filter(Boolean).join(", ");
}

// ---------- Library view ----------
let libBusy = false;
async function libraryView(note) {
  await refreshLocal();
  const all = docs(), linked = !!S.settings.ghToken;
  const offline = all.filter(d => localIds.has(d.id)).length;
  let est = "";
  try { const e = await navigator.storage.estimate(); est = ` · ${mb(e.usage || 0)} used on this device`; } catch (e) {}
  V.innerHTML = `
    <div class="eyebrow">Books and question banks</div>
    <h1>Library</h1>
    <div class="card">
      <input type="file" id="pdfs" multiple accept="application/pdf,.pdf" class="hide">
      <button class="primary" id="add">Import PDFs</button>
      <p class="small" id="lmsg">${esc(note || (linked ? "Imported PDFs upload to your private repo when you sync, so every device can open them." : "Link GitHub in Settings to share your library across devices."))}</p>
    </div>
    <div class="card">${all.map(d => `
      <div class="deck doc">
        <div style="min-width:0;flex:1">
          <b class="open" data-id="${d.id}" style="cursor:pointer;color:var(--accent)">${esc(d.name)}</b>
          <div class="small">${d.pages ? d.pages + " pages · " : ""}${mb(d.size)} · ${localIds.has(d.id) ? "on this device" : "in the cloud"}${d.remote ? "" : " · not uploaded yet"}${d.page > 1 ? ` · at p. ${d.page}` : ""}</div>
          <div class="small hide" data-more="${d.id}"><button data-ren="${d.id}">Rename</button> <button data-del="${d.id}">Delete</button></div>
        </div>
        <div class="row" style="flex:none"><button data-tog="${d.id}" aria-label="More">⋯</button><button class="open" data-id="${d.id}">${localIds.has(d.id) ? "Read" : "Get"}</button></div>
      </div>`).join("") || `<p class="small">No PDFs yet. Import a book or question bank to start.</p>`}</div>
    ${all.length ? `<p class="small">${all.length} PDF(s), ${offline} on this device${est}.</p>` : ""}
    ${linked && offline < all.length ? `<button id="getall">Download all for offline</button>` : ""}
    ${linked ? ` <button id="lsync">Sync library</button>` : ""}`;
  const msg = t => { const m = document.getElementById("lmsg"); if (m) m.textContent = t; };
  const inp = document.getElementById("pdfs");
  document.getElementById("add").onclick = () => inp.click();
  inp.onchange = async () => {
    const out = [];
    for (const f of inp.files) { msg(`Adding ${f.name}…`); try { out.push(await importPdf(f)); } catch (e) { out.push(`${f.name}: ${e.message}`); } }
    if (linked && navigator.onLine && out.some(x => x.endsWith("added"))) {
      libraryView(out.join(" · ") + " · uploading…");
      const r = await runLibSync(t => msg(t));
      libraryView(out.join(" · ") + (r ? " · " + r : ""));
    } else libraryView(out.join(" · "));
  };
  V.querySelectorAll(".open").forEach(b => b.onclick = () => openDoc(b.dataset.id, msg));
  V.querySelectorAll("[data-tog]").forEach(b => b.onclick = () => V.querySelector(`[data-more="${b.dataset.tog}"]`).classList.toggle("hide"));
  V.querySelectorAll("[data-ren]").forEach(b => b.onclick = () => {
    const d = S.pdfs[b.dataset.ren], box = b.parentNode;
    box.innerHTML = `<input type="text" value="${esc(d.name)}"><button>Save</button>`;
    box.querySelector("button").onclick = () => {
      const v = box.querySelector("input").value.trim();
      if (v && v !== d.name) { d.name = v; if (d.remote) d.renamed = true; save(); }
      libraryView();
    };
  });
  V.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    if (b.dataset.armed) { await removePdf(b.dataset.del); libraryView(linked ? "Deleted. It leaves your other devices on their next sync." : "Deleted."); if (linked) runLibSync(); return; }
    b.dataset.armed = 1; b.textContent = "Tap again to delete everywhere";
  });
  const ga = document.getElementById("getall");
  if (ga) ga.onclick = async () => {
    ga.disabled = true;
    try { for (const d of docs()) if (!localIds.has(d.id)) await downloadPdf(d.id, msg); libraryView("Everything is saved on this device for offline reading."); }
    catch (e) { libraryView("Download stopped: " + e.message); }
  };
  const ls = document.getElementById("lsync");
  if (ls) ls.onclick = async () => { ls.disabled = true; const r = await runLibSync(msg); libraryView(r || "Library is up to date."); };
}
async function runLibSync(progress) {
  if (libBusy || !S.settings.ghToken || !navigator.onLine) return "";
  libBusy = true;
  try { return await syncLibrary(progress); } catch (e) { return "Library sync failed: " + e.message; } finally { libBusy = false; }
}

async function openDoc(id, msg) {
  if (!localIds.has(id)) {
    try { await downloadPdf(id, msg); } catch (e) { msg("Couldn't download: " + e.message); return; }
  }
  go("reader", id);
}

// ---------- Reader ----------
let rd = null; // { id, doc, zoom, base, observer, rendered, saveT }
function closeReader() {
  if (!rd) return;
  const r = rd; rd = null;
  if (r.observer) r.observer.disconnect();
  window.removeEventListener("scroll", r.onScroll);
  window.removeEventListener("resize", r.onResize);
  document.body.classList.remove("reading");
  if (r.url) URL.revokeObjectURL(r.url);
  if (r.doc) r.doc.destroy();
  save();
}

async function reader(id) {
  const d = S.pdfs[id];
  if (!d) return go("library");
  document.body.classList.add("reading");
  V.innerHTML = `
    <div class="rbar">
      <button id="rback" aria-label="Back to library">←</button>
      <div class="rtitle">${esc(d.name)}</div>
      <span class="small"><input type="text" inputmode="numeric" id="rpg" value="${d.page || 1}"> / <span id="rnum">${d.pages || "…"}</span></span>
      <button id="rout" aria-label="Zoom out">−</button><button id="rin" aria-label="Zoom in">+</button>
    </div>
    <div id="pages"><p class="small">Opening…</p></div>`;
  document.getElementById("rback").onclick = () => go("library");
  const blob = await fileGet(id);
  if (!blob) { V.querySelector("#pages").innerHTML = `<p class="small">This PDF isn't on this device yet. Go back and tap Get.</p>`; return; }
  const me = rd = { id, zoom: 1, rendered: new Map() };
  let lib;
  try { lib = await pdfjs(); }
  catch (e) {
    // No module support (for example, opened straight from a file on a computer): use the browser's own viewer.
    me.url = URL.createObjectURL(blob);
    V.querySelector("#pages").innerHTML = `<iframe src="${me.url}#page=${d.page || 1}" style="width:100%;height:calc(100dvh - 140px);border:0;background:#fff"></iframe>`;
    return;
  }
  const base = new URL("vendor/pdfjs/", location.href).href;
  const doc = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), cMapUrl: base + "cmaps/", cMapPacked: true, standardFontDataUrl: base + "standard_fonts/" }).promise;
  if (rd !== me) { doc.destroy(); return; }
  me.doc = doc;
  if (d.pages !== doc.numPages) { d.pages = doc.numPages; save(); }
  const first = await doc.getPage(1), vp1 = first.getViewport({ scale: 1 });
  me.ratio = vp1.height / vp1.width;
  const box = document.getElementById("pages");
  box.innerHTML = Array.from({ length: doc.numPages }, (_, i) => `<div class="pg" data-n="${i + 1}"><canvas></canvas><span>${i + 1}</span></div>`).join("");
  const layout = () => {
    const w = Math.min(box.clientWidth, 1000) * me.zoom;
    box.querySelectorAll(".pg").forEach(p => { p.style.width = w + "px"; p.style.height = (p.dataset.ratio || me.ratio) * w + "px"; });
    me.width = w;
  };
  layout();
  me.observer = new IntersectionObserver(es => es.forEach(e => {
    const n = +e.target.dataset.n;
    if (e.isIntersecting) renderPage(me, n); else unrenderPage(me, n);
  }), { rootMargin: "150% 0px" });
  box.querySelectorAll(".pg").forEach(p => me.observer.observe(p));
  const jump = n => { const p = box.querySelector(`.pg[data-n="${Math.max(1, Math.min(doc.numPages, n))}"]`); if (p) window.scrollTo(0, p.offsetTop - 64); };
  jump(d.page || 1);
  me.onScroll = () => {
    const y = window.scrollY + window.innerHeight / 3;
    let n = 1;
    for (const p of box.children) { if (p.offsetTop > y) break; n = +p.dataset.n; }
    if (n !== d.page) {
      d.page = n;
      const pg = document.getElementById("rpg"); if (pg !== document.activeElement) pg.value = n;
      clearTimeout(me.saveT); me.saveT = setTimeout(save, 800);
    }
  };
  window.addEventListener("scroll", me.onScroll, { passive: true });
  const rezoom = z => {
    const keep = d.page;
    me.zoom = Math.max(0.5, Math.min(4, z));
    layout();
    for (const n of [...me.rendered.keys()]) { unrenderPage(me, n); renderPage(me, n); }
    jump(keep);
  };
  me.onResize = () => { clearTimeout(me.rT); me.rT = setTimeout(() => rezoom(me.zoom), 200); };
  window.addEventListener("resize", me.onResize);
  document.getElementById("rin").onclick = () => rezoom(me.zoom * 1.25);
  document.getElementById("rout").onclick = () => rezoom(me.zoom / 1.25);
  document.getElementById("rpg").onchange = e => jump(parseInt(e.target.value, 10) || 1);
  document.getElementById("rnum").textContent = doc.numPages;
}

async function renderPage(me, n) {
  if (rd !== me || me.rendered.has(n)) return;
  const el = V.querySelector(`.pg[data-n="${n}"]`);
  if (!el) return;
  const job = { cancelled: false };
  me.rendered.set(n, job);
  try {
    const page = await me.doc.getPage(n);
    if (job.cancelled) return;
    const vp0 = page.getViewport({ scale: 1 }), ratio = vp0.height / vp0.width;
    if (Math.abs(ratio - me.ratio) > 0.01) { el.dataset.ratio = ratio; el.style.height = ratio * me.width + "px"; }
    // Cap pixel size so long books don't run phones out of memory.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = Math.min(me.width * dpr / vp0.width, 4096 / Math.max(vp0.width, vp0.height));
    const vp = page.getViewport({ scale });
    const c = el.querySelector("canvas");
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    job.task = page.render({ canvasContext: c.getContext("2d"), viewport: vp });
    await job.task.promise;
  } catch (e) { if (!job.cancelled) me.rendered.delete(n); }
}
function unrenderPage(me, n) {
  const job = me.rendered.get(n);
  if (!job) return;
  job.cancelled = true;
  if (job.task) job.task.cancel();
  me.rendered.delete(n);
  const c = V.querySelector(`.pg[data-n="${n}"] canvas`);
  if (c) { c.width = 0; c.height = 0; }
}

refreshLocal();
