"use strict";
// Cadet Prep: offline spaced-repetition flashcards. All data lives in this browser (localStorage).

const KEY = "cadet.v1";
const DAY = 86400000;
const today = () => Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / DAY);

let S = load();
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.cards) { const b = blank(); return Object.assign(b, s, { settings: Object.assign(b.settings, s.settings) }); }
  } catch (e) {}
  return blank();
}
function blank() {
  return { cards: {}, answers: [], days: {}, ratings: {}, device: Math.random().toString(36).slice(2, 8), settings: { newPerDay: 20, typeAnswers: true, ghRepo: "NoUserFound000/cadet-cards", ghToken: "" } };
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { alertBox("Could not save: storage is full or blocked."); }
}
function dayRec(d = today()) { return (S.days[d] = S.days[d] || { reviewed: 0, newDone: 0 }); }

// ---------- HTML safety ----------
const ALLOWED = new Set(["B", "I", "U", "EM", "STRONG", "BR", "SMALL", "SUB", "SUP", "UL", "OL", "LI", "P", "DIV", "SPAN", "CODE"]);
function clean(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const walk = el => {
    for (const n of [...el.childNodes]) {
      if (n.nodeType === 1) {
        if (!ALLOWED.has(n.tagName)) { n.replaceWith(document.createTextNode(n.textContent)); continue; }
        for (const a of [...n.attributes]) n.removeAttribute(a.name);
        walk(n);
      } else if (n.nodeType !== 3) n.remove();
    }
  };
  const root = doc.body.firstChild;
  walk(root);
  return root.innerHTML;
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- Import ----------
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function importAnkiText(text, fallbackDeck) {
  let deck = fallbackDeck, tagCol = -1, sep = "\t", added = 0, updated = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith("#")) {
      const [k, v] = line.slice(1).split(":");
      if (k === "deck") deck = line.slice(6).trim();
      if (k === "tags column") tagCol = parseInt(v, 10) - 1;
      if (k === "separator") sep = v.trim() === "tab" ? "\t" : v.trim() === "comma" ? "," : v.trim();
      continue;
    }
    const f = line.split(sep);
    if (f.length < 2) continue;
    const id = hash(deck + "|" + f[0]);
    const tags = tagCol >= 0 && f[tagCol] ? f[tagCol].trim().split(/\s+/) : [];
    const old = S.cards[id];
    if (old) { Object.assign(old, { front: f[0], back: f[1], tags, deck }); updated++; }
    else { S.cards[id] = { id, deck, front: f[0], back: f[1], tags, isNew: true, due: 0, ivl: 0, ease: 2.5, reps: 0, lapses: 0 }; added++; }
  }
  save();
  return { added, updated };
}
function importBackup(text) {
  const s = JSON.parse(text);
  if (!s.cards) throw new Error("Not a Cadet Prep backup");
  S = Object.assign(blank(), s);
  save();
}

// ---------- Scheduling (SM-2 style) ----------
function dueCards(deck) {
  const t = today();
  return Object.values(S.cards).filter(c => !c.isNew && c.due <= t && (!deck || c.deck === deck));
}
function newCards(deck) {
  return Object.values(S.cards).filter(c => c.isNew && (!deck || c.deck === deck));
}
function newLeft() { return Math.max(0, S.settings.newPerDay - dayRec().newDone); }

function grade(c, g) { // g: 1 again, 2 hard, 3 good, 4 easy. Returns true if the card should come back this session.
  const t = today(), d = dayRec();
  d.reviewed++;
  if (c.isNew) {
    if (g <= 2) return true;
    c.isNew = false; d.newDone++;
    c.ivl = g === 4 ? 4 : 1;
  } else if (c.relearn) {
    if (g <= 2) return true;
    c.relearn = false;
    c.ivl = Math.max(1, c.ivl);
  } else {
    if (g === 1) { c.lapses++; c.ease = Math.max(1.3, c.ease - 0.2); c.ivl = 1; c.relearn = true; c.due = t; return true; }
    if (g === 2) { c.ease = Math.max(1.3, c.ease - 0.15); c.ivl = Math.max(c.ivl + 1, Math.round(c.ivl * 1.2)); }
    if (g === 3) c.ivl = Math.max(c.ivl + 1, Math.round(c.ivl * c.ease));
    if (g === 4) { c.ivl = Math.max(c.ivl + 1, Math.round(c.ivl * c.ease * 1.3)); c.ease += 0.15; }
  }
  c.reps++;
  c.due = t + c.ivl;
  return false;
}
function preview(c, g) {
  if (c.isNew || c.relearn) return g <= 2 ? "again soon" : g === 4 && c.isNew ? "4d" : "1d";
  if (g === 1) return "again soon";
  const e = c.ease, i = c.ivl;
  const n = g === 2 ? Math.max(i + 1, Math.round(i * 1.2)) : g === 3 ? Math.max(i + 1, Math.round(i * e)) : Math.max(i + 1, Math.round(i * e * 1.3));
  return n < 30 ? n + "d" : (n / 30).toFixed(1) + "mo";
}
function streak() {
  let t = today(), n = 0;
  if (!(S.days[t] && S.days[t].reviewed)) t--;
  while (S.days[t] && S.days[t].reviewed) { n++; t--; }
  return n;
}
function decks() { return [...new Set(Object.values(S.cards).map(c => c.deck))].sort(); }

// ---------- Views ----------
const V = document.getElementById("view");
let session = null;

function go(name, arg) {
  document.querySelectorAll("nav button").forEach(b => b.classList.toggle("on", b.dataset.go === name));
  ({ home, decks: deckView, answers, settings, review }[name])(arg);
  window.scrollTo(0, 0);
}
document.querySelectorAll("nav button").forEach(b => b.onclick = () => go(b.dataset.go));

function home() {
  const due = dueCards().length, nw = Math.min(newLeft(), newCards().length), d = dayRec();
  const total = Object.keys(S.cards).length;
  V.innerHTML = `
    <div class="eyebrow">Cathay cadet prep</div>
    <h1>Today</h1>
    <div class="card gold row">
      <div><div class="stat">${due}</div><div class="small">due reviews</div></div>
      <div><div class="stat">${nw}</div><div class="small">new cards</div></div>
      <div><div class="stat">${streak()}</div><div class="small">day streak</div></div>
    </div>
    <button class="primary" id="start" ${due + nw ? "" : "disabled"}>${due + nw ? "Start review" : total ? "All done for today" : "Import a deck to start"}</button>
    <p class="small">Reviewed today: ${d.reviewed}. ${total} cards in ${decks().length} decks.</p>
    ${total ? "" : `<div class="card">Go to <b>Decks</b> and import your card files (the .txt files from the project).</div>`}`;
  const s = document.getElementById("start");
  if (s) s.onclick = () => go("review");
}

function buildQueue(deck) {
  const rev = shuffle(dueCards(deck));
  // New cards rotate across decks, keeping each deck's own order.
  const byDeck = {};
  for (const c of newCards(deck)) (byDeck[c.deck] = byDeck[c.deck] || []).push(c);
  const lanes = Object.values(byDeck), nw = [];
  for (let i = 0; nw.length < newLeft() && lanes.some(l => l.length); i++) { const l = lanes[i % lanes.length]; if (l.length) nw.push(l.shift()); }
  const q = [];
  // Spread new cards among reviews.
  const step = nw.length ? Math.max(1, Math.floor(rev.length / nw.length)) : 0;
  let r = 0;
  for (const n of nw) { q.push(...rev.slice(r, r + step)); r += step; q.push(n); }
  q.push(...rev.slice(r));
  return q;
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function review(deck) {
  if (!session || session.deck !== deck) session = { deck, queue: buildQueue(deck), done: 0 };
  const c = session.queue[0];
  if (!c) { session = null; if (S.settings.ghToken) sync(); V.innerHTML = `<h1>Session complete</h1><div class="card">Nice work. Streak: <b>${streak()}</b> day(s).</div><button class="primary" id="back">Back to Today</button>`; document.getElementById("back").onclick = () => go("home"); return; }
  const typing = S.settings.typeAnswers;
  V.innerHTML = `
    <div class="row eyebrow" style="margin-top:4px"><span>${esc(c.deck.split("::").pop())}</span><span>${session.queue.length} left</span></div>
    <div class="card">
      <div class="q">${clean(c.front)}</div>
      ${typing ? `<textarea id="typed" placeholder="Say it out loud or type your answer (optional)"></textarea>` : ""}
      <div id="ans" class="a hide">${clean(c.back)}</div>
    </div>
    <button class="primary" id="show">Show answer</button>
    <div class="grades hide" id="grades">
      ${[["Again", 1], ["Hard", 2], ["Good", 3], ["Easy", 4]].map(([l, g]) => `<button class="g${g}" data-g="${g}">${l}<small>${preview(c, g)}</small></button>`).join("")}
    </div>
    <p class="tag">${c.tags.map(esc).join(" · ")}</p>`;
  const show = document.getElementById("show");
  show.onclick = () => {
    document.getElementById("ans").classList.remove("hide");
    document.getElementById("grades").classList.remove("hide");
    show.classList.add("hide");
  };
  document.querySelectorAll("#grades button").forEach(b => b.onclick = () => {
    const g = +b.dataset.g;
    const t = document.getElementById("typed");
    if (t && t.value.trim()) S.answers.push({ id: c.id, deck: c.deck, q: c.front, model: c.back, typed: t.value.trim(), grade: g, at: new Date().toISOString(), sent: false });
    session.queue.shift();
    if (grade(c, g)) session.queue.splice(Math.min(session.queue.length, 3 + Math.floor(Math.random() * 3)), 0, c);
    save();
    review(deck);
  });
}

function deckView() {
  const t = today();
  V.innerHTML = `
    <div class="eyebrow">Library</div>
    <h1>Decks</h1>
    <div class="card">${decks().map(d => {
      const all = Object.values(S.cards).filter(c => c.deck === d);
      const due = all.filter(c => !c.isNew && c.due <= t).length, nw = all.filter(c => c.isNew).length;
      return `<div class="deck"><div><b>${esc(d)}</b><div class="small">${all.length} cards · ${nw} new</div></div>
        <div class="row"><span class="pill ${due ? "due" : ""}">${due}</span><button data-d="${esc(d)}" class="study">Study</button></div></div>`;
    }).join("") || `<p class="small">No decks yet.</p>`}</div>
    <h2>Import</h2>
    <div class="card">
      <p class="small">Pick one or more card files (.txt in Anki text format), or a backup (.json). Re-importing a file updates cards and keeps your progress.</p>
      <input type="file" id="file" multiple accept=".txt,.tsv,.json,text/plain,application/json">
      <p id="msg" class="small"></p>
    </div>`;
  document.querySelectorAll(".study").forEach(b => b.onclick = () => { session = null; go("review", b.dataset.d); });
  document.getElementById("file").onchange = async e => {
    const out = [];
    for (const f of e.target.files) {
      const text = await f.text();
      try {
        if (f.name.endsWith(".json")) { importBackup(text); out.push(`${f.name}: backup restored`); }
        else { const r = importAnkiText(text, f.name.replace(/\.\w+$/, "")); out.push(`${f.name}: ${r.added} new, ${r.updated} updated`); }
      } catch (err) { out.push(`${f.name}: ${err.message}`); }
    }
    deckView();
    document.getElementById("msg").textContent = out.join(" · ");
  };
}

function answers() {
  const list = S.answers.slice().reverse();
  const unsent = S.answers.filter(a => !a.sent);
  const rated = Object.values(S.ratings).flat().sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  const linked = !!S.settings.ghToken;
  V.innerHTML = `
    <div class="eyebrow">For rating</div>
    <h1>Your answers</h1>
    <p class="small">${linked ? "Answers you type during review are sent to Claude when you sync. Ratings come back here." : "Answers you type during review are kept here. Link GitHub in Settings to send them to Claude automatically, or copy them."}</p>
    ${linked ? `<button class="primary" id="sync">Sync now (${unsent.length} to send)</button>` : `<button class="primary" id="copy" ${unsent.length ? "" : "disabled"}>Copy ${unsent.length} new answer(s) for Claude</button>`}
    <p id="msg" class="small"></p>
    ${rated.length ? `<h2>Claude's ratings</h2>` + rated.slice(0, 30).map(r => `<div class="card gold"><div class="row"><b>${esc(r.q || "")}</b><span class="stat" style="font-size:22px">${esc(r.score ?? "")}/5</span></div>
      <div class="small">You: ${esc(r.typed || "")}</div><div class="a">${esc(r.feedback || "")}${r.better ? `<br><small>Stronger answer: ${esc(r.better)}</small>` : ""}</div></div>`).join("") : ""}
    <h2>Recent answers</h2>
    ${list.slice(0, 50).map(a => `<div class="card"><div class="small">${esc(a.deck.split("::").pop())} · ${new Date(a.at).toLocaleString()} ${a.sent ? "· sent" : ""}</div>
      <div><b>${clean(a.q)}</b></div><div>You: ${esc(a.typed)}</div></div>`).join("") || `<p class="small">No typed answers yet.</p>`}`;
  const msg = t => document.getElementById("msg").textContent = t;
  const sy = document.getElementById("sync");
  if (sy) sy.onclick = async () => { sy.disabled = true; msg("Syncing…"); const r = await sync(); answers(); msg(r); };
  const cp = document.getElementById("copy");
  if (cp) cp.onclick = async () => {
    const text = "Please rate my answers:\n\n" + unsent.map((a, i) => `${i + 1}. [${a.deck}] Q: ${strip(a.q)}\n   My answer: ${a.typed}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      unsent.forEach(a => a.sent = true); save();
      answers();
      msg("Copied. Paste it into your Claude thread.");
    } catch (e) { msg("Copy was blocked by the browser."); }
  };
}

// ---------- GitHub sync (private cards repo) ----------
async function gh(path, opts = {}) {
  const r = await fetch(`https://api.github.com/repos/${S.settings.ghRepo}/contents/${path}`, Object.assign({}, opts, {
    headers: Object.assign({ Authorization: `Bearer ${S.settings.ghToken}`, Accept: "application/vnd.github+json" }, opts.headers || {}),
    cache: "no-store",
  }));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub said ${r.status}${r.status === 401 ? " (check the access key)" : ""}`);
  return r;
}
const b64 = str => btoa(String.fromCharCode(...new TextEncoder().encode(str)));
async function sync() {
  if (!S.settings.ghToken) return "Link GitHub in Settings first.";
  if (!navigator.onLine) return "You're offline. Your answers will send next time you sync.";
  try {
    let decksN = 0, sent = 0, newRatings = 0;
    const dl = await gh("decks");
    for (const f of dl ? await dl.json() : []) {
      if (!/\.txt$/.test(f.name)) continue;
      const r = await gh(f.path, { headers: { Accept: "application/vnd.github.raw+json" } });
      if (r) { importAnkiText(await r.text(), f.name.replace(/\.\w+$/, "")); decksN++; }
    }
    const unsent = S.answers.filter(a => !a.sent);
    if (unsent.length) {
      const name = `answers/${new Date().toISOString().replace(/[:.]/g, "-")}-${S.device}.json`;
      const payload = unsent.map(a => ({ deck: a.deck, q: strip(a.q), model: strip(a.model), typed: a.typed, grade: a.grade, at: a.at }));
      await gh(name, { method: "PUT", body: JSON.stringify({ message: `Answers from ${S.device}`, content: b64(JSON.stringify(payload, null, 1)) }) });
      unsent.forEach(a => a.sent = true); sent = unsent.length;
    }
    const rl = await gh("ratings");
    for (const f of rl ? await rl.json() : []) {
      if (!/\.json$/.test(f.name) || S.ratings[f.sha]) continue;
      const r = await gh(f.path, { headers: { Accept: "application/vnd.github.raw+json" } });
      if (r) { try { S.ratings[f.sha] = JSON.parse(await r.text()); newRatings++; } catch (e) {} }
    }
    S.lastSync = new Date().toISOString();
    save();
    return `Synced: ${decksN} decks updated, ${sent} answers sent, ${newRatings} new rating sets.`;
  } catch (e) { return "Sync failed: " + e.message; }
}
const strip = h => { const d = document.createElement("div"); d.innerHTML = clean(h); return d.textContent; };

function settings() {
  V.innerHTML = `
    <div class="eyebrow">This device</div>
    <h1>Settings</h1>
    <div class="card">
      <label class="small">New cards per day</label>
      <input type="text" inputmode="numeric" id="npd" value="${S.settings.newPerDay}">
      <label class="chk"><input type="checkbox" id="ta" ${S.settings.typeAnswers ? "checked" : ""}> Show an answer box during review</label>
    </div>
    <h2>GitHub sync</h2>
    <div class="card">
      <p class="small">Pulls your decks from your private repo and sends typed answers to Claude for rating. Paste your access key once on each device. It stays on this device only.</p>
      <label class="small">Cards repo</label>
      <input type="text" id="ghr" value="${esc(S.settings.ghRepo)}" autocapitalize="off" autocorrect="off">
      <label class="small">Access key</label>
      <input type="text" id="ght" value="${S.settings.ghToken ? "••••••••" + S.settings.ghToken.slice(-4) : ""}" placeholder="github_pat_…" autocapitalize="off" autocorrect="off">
      <div style="height:8px"></div>
      <button id="ghs">Save and sync</button>
      <p id="gmsg" class="small">${S.lastSync ? "Last synced " + new Date(S.lastSync).toLocaleString() : ""}</p>
    </div>
    <h2>Backup</h2>
    <div class="card">
      <p class="small">Your progress is stored on this device only. Export a backup to move it to another device (import it under Decks).</p>
      <button id="exp">Export backup</button>
    </div>
    <h2>Danger zone</h2>
    <div class="card"><button id="wipe">Erase all data on this device</button><p id="wmsg" class="small"></p></div>`;
  document.getElementById("npd").onchange = e => { S.settings.newPerDay = Math.max(0, parseInt(e.target.value, 10) || 0); save(); };
  document.getElementById("ta").onchange = e => { S.settings.typeAnswers = e.target.checked; save(); };
  document.getElementById("exp").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(S)], { type: "application/json" }));
    a.download = `cadet-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  document.getElementById("ghs").onclick = async () => {
    S.settings.ghRepo = document.getElementById("ghr").value.trim();
    const t = document.getElementById("ght").value.trim();
    if (t && !t.startsWith("••")) S.settings.ghToken = t;
    save();
    document.getElementById("gmsg").textContent = "Syncing…";
    document.getElementById("gmsg").textContent = await sync();
  };
  let armed = false;
  document.getElementById("wipe").onclick = e => {
    if (!armed) { armed = true; e.target.textContent = "Tap again to erase everything"; return; }
    S = blank(); save(); go("home");
if (S.settings.ghToken) sync().then(() => { if (!session && document.querySelector("nav .on").dataset.go === "home") home(); });
  };
}
function alertBox(msg) { const p = document.createElement("div"); p.className = "card"; p.textContent = msg; V.prepend(p); }

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
go("home");
if (S.settings.ghToken) sync().then(() => { if (!session && document.querySelector("nav .on").dataset.go === "home") home(); });
