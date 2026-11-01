/* Luisterboeken — PWA.
   Boeken worden op dit toestel opgeslagen (IndexedDB) en werken daarna offline. */

/* ---------- hulp ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`; };
const fmtLong = s => { s = Math.max(0, s || 0); const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return h ? `${h} u ${m} min` : `${m} min`; };
const hue = str => { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const isAudio = n => /\.(mp3|m4b|m4a|aac|ogg|opus|flac|wav)$/i.test(n);
const isImage = n => /\.(jpe?g|png|webp)$/i.test(n);
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

let toastT;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ---------- opslag: IndexedDB voor audio en boeken ---------- */
const DB = (() => {
  let dbp;
  const open = () => dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open("luisterboeken", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("boeken", { keyPath: "id" });
      r.result.createObjectStore("bestanden");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  async function tx(store, mode, fn) {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error("Opslaan mislukt (geheugen vol?)"));
    });
  }
  return {
    put: (store, val, key) => tx(store, "readwrite", s => key === undefined ? s.put(val) : s.put(val, key)),
    get: (store, key) => tx(store, "readonly", s => s.get(key)),
    getAll: store => tx(store, "readonly", s => s.getAll()),
    del: (store, key) => tx(store, "readwrite", s => s.delete(key)),
  };
})();

/* voortgang en bladwijzers blijven klein genoeg voor localStorage */
let progress = JSON.parse(localStorage.getItem("voortgang") || "{}");
let marks = JSON.parse(localStorage.getItem("bladwijzers") || "{}");
const saveProgressStore = () => localStorage.setItem("voortgang", JSON.stringify(progress));
const saveMarksStore = () => localStorage.setItem("bladwijzers", JSON.stringify(marks));

/* ---------- status ---------- */
const audio = $("#audio");
let books = [], cur = null, fileIdx = 0, pendingSeek = 0, pendingPlay = false;
let seeking = false, pausedAt = 0, lastCh = -1, picked = [], objUrl = null, loadTok = 0;
let speed = parseFloat(localStorage.getItem("snelheid")) || 1;
let sleep = { mode: null };

const gpos = () => (cur?.files[fileIdx]?.offset || 0) + (audio.currentTime || 0);
const total = () => cur?.duration || 0;
const isDone = () => !!progress[cur?.id]?.finished;

function recalc(b) {
  let off = 0;
  b.files.forEach(f => { f.offset = off; off += f.duration || 0; });
  b.duration = off;
  b.chapters.forEach(c => { c.pos = (b.files[c.file]?.offset || 0) + c.start; });
}

function posOf(b) {
  const p = progress[b.id];
  return p && p.file < b.files.length ? b.files[p.file].offset + p.time : 0;
}

/* ---------- bibliotheek ---------- */
const coverUrls = {};
async function loadLibrary() {
  books = await DB.getAll("boeken");
  books.sort((a, b) => a.title.localeCompare(b.title, "nl"));
  for (const b of books) {
    recalc(b);
    if (b.hasCover && !coverUrls[b.id]) {
      const blob = await DB.get("bestanden", `${b.id}/cover`);
      if (blob) coverUrls[b.id] = URL.createObjectURL(blob);
    }
    b.coverUrl = coverUrls[b.id] || "";
  }
  renderLibrary();
}

function coverStyle(b) {
  if (b.coverUrl) return `background-image:url('${b.coverUrl}')`;
  const h = hue(b.title);
  return `background:linear-gradient(135deg,hsl(${h} 45% 42%),hsl(${(h + 50) % 360} 40% 24%))`;
}

function cardHtml(b) {
  const pos = posOf(b);
  const pct = b.duration ? Math.min(100, pos / b.duration * 100) : 0;
  const status = progress[b.id]?.finished ? "Afgelopen" : pos > 0 ? `nog ${fmtLong(b.duration - pos)}` : fmtLong(b.duration);
  return `<div class="card" data-open="${esc(b.id)}">
    <div class="cover" style="${coverStyle(b)}">
      ${b.coverUrl ? "" : esc(b.title.charAt(0).toUpperCase())}
      ${progress[b.id]?.finished ? '<span class="done">✓ Gelezen</span>' : ""}
    </div>
    <div class="info">
      <div class="t">${esc(b.title)}</div>
      <div class="a">${esc(b.author)}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="a">${status}</div>
    </div></div>`;
}

function rowHtml(b) {
  const pos = posOf(b);
  return `<div class="row" data-open="${esc(b.id)}">
    <div class="thumb" style="${coverStyle(b)}">${b.coverUrl ? "" : esc(b.title.charAt(0).toUpperCase())}</div>
    <div class="grow"><div class="t" style="-webkit-line-clamp:1">${esc(b.title)}</div>
    <small>nog ${fmtLong(b.duration - pos)}</small></div></div>`;
}

function renderLibrary() {
  const q = $("#search").value.trim().toLowerCase();
  const list = books.filter(b => !q || `${b.title} ${b.author}`.toLowerCase().includes(q));
  const cont = books.filter(b => posOf(b) > 0 && !progress[b.id]?.finished)
    .sort((a, b) => (progress[b.id]?.updated || 0) - (progress[a.id]?.updated || 0)).slice(0, 6);
  $("#continueWrap").classList.toggle("hidden", !cont.length || q.length > 0);
  $("#continueList").innerHTML = cont.map(rowHtml).join("");
  $("#grid").innerHTML = list.map(cardHtml).join("");
  $("#empty").classList.toggle("hidden", books.length > 0);
  $$("[data-open]").forEach(el => el.onclick = () => openBook(el.dataset.open));
}

/* ---------- downloaden (importeren) ---------- */
function probeDuration(file) {
  return new Promise(res => {
    const u = URL.createObjectURL(file);
    const a = new Audio();
    a.preload = "metadata";
    a.onloadedmetadata = () => { URL.revokeObjectURL(u); res(isFinite(a.duration) ? a.duration : 0); };
    a.onerror = () => { URL.revokeObjectURL(u); res(0); };
    a.src = u;
  });
}

// chapters.json (gemaakt met maak_hoofdstukken.py) of, zonder dat bestand, één hoofdstuk per audiobestand
function buildChapters(book, spec) {
  let ch = [];
  if (Array.isArray(spec)) {
    ch = spec
      .map(c => ({ title: String(c.title), file: book.files.findIndex(f => f.name === c.file), start: +c.start || 0 }))
      .filter(c => c.file >= 0);
  }
  if (!ch.length) ch = book.files.map((f, i) => ({ title: f.name.replace(/\.[^.]+$/, ""), file: i, start: 0 }));
  return ch;
}

async function addBook(title, author, files, cover, chapSpec, progressCb) {
  if (!files.length) throw new Error("Geen audiobestanden");
  const id = "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const book = {
    id, title, author: author || "", hasCover: !!cover, added: Date.now(),
    files: files.map(f => ({ name: f.name, duration: 0, offset: 0 })),
    chapters: [],
  };
  for (let i = 0; i < files.length; i++) {
    progressCb(`${i + 1}/${files.length} · ${files[i].name}`);
    await DB.put("bestanden", files[i], `${id}/${i}`);
    book.files[i].duration = await probeDuration(files[i]);
  }
  if (cover) await DB.put("bestanden", cover, `${id}/cover`);
  book.chapters = buildChapters(book, chapSpec);
  recalc(book);
  await DB.put("boeken", book);
}

async function startImport() {
  if (!picked.length) return toast("Kies eerst bestanden");
  const titleIn = $("#upTitle").value.trim(), authorIn = $("#upAuthor").value.trim();
  const btn = $("#startUp"), log = $("#upLog");
  btn.disabled = true; log.innerHTML = "";

  const audioFiles = picked.filter(f => isAudio(f.name)).sort((a, b) => natural(a.name, b.name));
  const cover = picked.find(f => isImage(f.name));
  const chapFile = picked.find(f => f.name.toLowerCase() === "chapters.json");
  let chapSpec = null;
  if (chapFile) {
    try { chapSpec = JSON.parse(await chapFile.text()); }
    catch { toast("chapters.json kon niet gelezen worden"); }
  }

  // met titel: één boek met alle delen; zonder titel: elk bestand een eigen boek
  const groups = titleIn
    ? [{ title: titleIn, files: audioFiles }]
    : audioFiles.map(f => ({ title: f.name.replace(/\.[^.]+$/, ""), files: [f] }));

  let ok = 0;
  for (const g of groups) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<div class="grow">${esc(g.title)}</div><small>bezig…</small>`;
    log.appendChild(row);
    const s = row.querySelector("small");
    try {
      await addBook(g.title, authorIn, g.files, titleIn ? cover : null, chapSpec, t => s.textContent = t);
      s.textContent = "✓ gedownload"; ok++;
    } catch (e) { s.textContent = e.message || "mislukt"; }
  }
  picked = []; renderPicked(); btn.disabled = false;
  await loadLibrary();
  toast(`${ok} boek(en) gedownload`);
}

function openUpload(initial = []) {
  picked = [...initial];
  openSheet(`
    <h2>Boek downloaden</h2>
    <label class="field">Titel
      <input type="text" id="upTitle" placeholder="Bijv. De Hobbit"></label>
    <label class="field">Auteur
      <input type="text" id="upAuthor" placeholder="Optioneel"></label>
    <div class="drop" id="drop">
      <div>Kies je audiobestanden</div>
      <button class="btn ghost" id="pickBtn" style="margin-top:10px">Kies bestanden</button>
      <p class="muted" style="font-size:.8rem;margin:14px 0 0;text-align:left">
        Boek in meerdere delen? Kies alle delen tegelijk met dezelfde titel.
        Ze worden op naam gesorteerd, dus gebruik “deel 01”, “deel 02”, …<br>
        Hoofdstukken: voeg het bestand <b>chapters.json</b> toe (zie uitleg).<br>
        Omslag: voeg een jpg of png toe.
      </p>
    </div>
    <div id="pickedList" style="margin-top:12px"></div>
    <button class="btn" id="startUp" style="width:100%;margin-top:14px">Downloaden</button>
    <div id="upLog" style="margin-top:8px"></div>`);
  $("#pickBtn").onclick = () => $("#fileInput").click();
  const drop = $("#drop");
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); addPicked([...e.dataTransfer.files]); };
  $("#startUp").onclick = startImport;
  renderPicked();
}

function addPicked(files) { picked.push(...files); renderPicked(); }
function renderPicked() {
  const el = $("#pickedList");
  if (!el) return;
  el.innerHTML = picked.length
    ? picked.map(f => `<div class="row"><div class="grow">${esc(f.name)}</div><small>${(f.size / 1048576).toFixed(1)} MB</small></div>`).join("")
    : `<small class="muted">Nog geen bestanden gekozen</small>`;
}

/* ---------- openen en afspelen ---------- */
async function openBook(id) {
  const b = books.find(x => x.id === id);
  if (!b) return;
  cur = b;
  const p = progress[b.id];
  $("#player").classList.remove("hidden");
  $("#pTitle").textContent = b.title;
  $("#pAuthor").textContent = b.author || "";
  $("#pTitleSmall").textContent = b.title;
  const c = $("#pCover");
  c.setAttribute("style", coverStyle(b));
  c.textContent = b.coverUrl ? "" : b.title.charAt(0).toUpperCase();
  $("#chapBtn").classList.toggle("hidden", b.chapters.length < 2);
  pausedAt = 0; lastCh = -1;
  localStorage.setItem("laatsteBoek", id);
  loadFile(p ? p.file : 0, p ? p.time : 0, true);
  renderTime();
  updateMini();
}

async function loadFile(i, t = 0, play = false) {
  const tok = ++loadTok;
  fileIdx = i; pendingSeek = t; pendingPlay = play;
  const blob = await DB.get("bestanden", `${cur.id}/${i}`);
  if (tok !== loadTok) return;                 // er is intussen een ander bestand gekozen
  if (!blob) return toast("Dit bestand staat niet (meer) op dit toestel");
  if (objUrl) URL.revokeObjectURL(objUrl);
  objUrl = URL.createObjectURL(blob);
  audio.src = objUrl;
}

audio.addEventListener("loadedmetadata", () => {
  const f = cur.files[fileIdx];
  if (f && !f.duration && isFinite(audio.duration)) {   // duur alsnog bepalen
    f.duration = audio.duration; recalc(cur); DB.put("boeken", cur);
  }
  audio.playbackRate = speed;
  if (pendingSeek > 0) audio.currentTime = Math.min(pendingSeek, Math.max(0, audio.duration - 1));
  pendingSeek = 0;
  if (pendingPlay) audio.play().catch(() => toast("Tik op ▶ om te starten"));
  renderTime();
});

audio.addEventListener("play", () => {
  $("#playBtn").textContent = "❚❚";
  if (pausedAt && Date.now() - pausedAt > 120000) {   // na lange pauze 10 sec terug
    audio.currentTime = Math.max(0, audio.currentTime - 10);
    toast("10 sec terug na je pauze");
  }
  pausedAt = 0;
  updateMini();
});

audio.addEventListener("pause", () => {
  $("#playBtn").textContent = "▶";
  pausedAt = Date.now();
  saveProgress();
  updateMini();
});

audio.addEventListener("timeupdate", () => {
  renderTime();
  if (sleep.mode === "chapter") checkChapterSleep();
});

audio.addEventListener("ended", () => {
  if (!cur) return;
  if (fileIdx < cur.files.length - 1) return loadFile(fileIdx + 1, 0, true);
  saveProgress(true);
  toast("Boek uit ✓");
});

audio.addEventListener("error", () => {
  if (cur && audio.getAttribute("src")) toast("Kon dit bestand niet afspelen");
});

function togglePlay() {
  if (!cur) return;
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

function seekGlobal(g) {
  if (!cur) return;
  g = Math.min(Math.max(0, g), total());
  let i = cur.files.length - 1;
  for (let k = 0; k < cur.files.length; k++) {
    const f = cur.files[k];
    if (g < f.offset + f.duration) { i = k; break; }
  }
  const t = g - cur.files[i].offset;
  if (i === fileIdx && audio.readyState > 0) audio.currentTime = t;
  else loadFile(i, t, !audio.paused);
}

/* ---------- voortgang ---------- */
function saveProgress(finished) {
  if (!cur || pendingSeek || audio.readyState === 0) return;
  const prev = progress[cur.id] || {};
  progress[cur.id] = {
    file: fileIdx,
    time: Math.round((audio.currentTime || 0) * 100) / 100,
    finished: finished ?? !!prev.finished,
    updated: Date.now() / 1000,
  };
  saveProgressStore();
}
setInterval(() => { if (cur && !audio.paused) saveProgress(); }, 5000);
document.addEventListener("visibilitychange", () => { if (document.hidden) saveProgress(); });
window.addEventListener("beforeunload", () => saveProgress());

/* ---------- scherm ---------- */
function renderTime() {
  if (!cur) return;
  const g = gpos(), T = total();
  if (!seeking) { $("#seek").max = Math.max(1, Math.floor(T)); $("#seek").value = Math.floor(g); }
  $("#tNow").textContent = fmt(g);
  $("#tLeft").textContent = "-" + fmt(T - g);
  const ch = curChapterIdx();
  $("#pChapter").textContent = cur.chapters[ch]?.title || "";
  if (cur.chapters.length > 1) $("#chapBtn").textContent = `☰ Hoofdstuk ${ch + 1}/${cur.chapters.length}`;
  if (ch !== lastCh) { lastCh = ch; updateMedia(); }
  if (!isDone() && T && g >= T - 5 && fileIdx === cur.files.length - 1 && !audio.paused) saveProgress(true);
  if (T && "mediaSession" in navigator && navigator.mediaSession.setPositionState) {
    try { navigator.mediaSession.setPositionState({ duration: T, position: Math.min(g, T), playbackRate: audio.playbackRate || 1 }); } catch {}
  }
  updateMini();
}

function updateMini() {
  const show = !!cur && $("#player").classList.contains("hidden");
  $("#mini").classList.toggle("hidden", !show);
  if (show) {
    $("#miniInfo").textContent = `${cur.title} · ${chapterTitle()}`;
    $("#miniPlay").textContent = audio.paused ? "▶" : "❚❚";
  }
}
function openPlayer() { $("#player").classList.remove("hidden"); updateMini(); }
function closePlayer() { $("#player").classList.add("hidden"); renderLibrary(); updateMini(); }

/* ---------- hoofdstukken ---------- */
function curChapterIdx() {
  if (!cur) return 0;
  const g = gpos();
  let idx = 0;
  cur.chapters.forEach((c, i) => { if (c.pos <= g + 0.5) idx = i; });
  return idx;
}
function chapterTitle() { return cur?.chapters[curChapterIdx()]?.title || ""; }

function prevChapter() {
  if (!cur) return;
  const i = curChapterIdx(), c = cur.chapters[i];
  if (gpos() - c.pos > 3) return seekGlobal(c.pos);
  seekGlobal(cur.chapters[Math.max(0, i - 1)].pos);
}
function nextChapter() {
  if (!cur) return;
  const n = cur.chapters[curChapterIdx() + 1];
  if (n) seekGlobal(n.pos); else toast("Dit is het laatste hoofdstuk");
}

function openChapters() {
  const i = curChapterIdx();
  openSheet(`<h2>Hoofdstukken</h2>` + cur.chapters.map((c, k) => `
    <div class="row ${k === i ? "on" : ""}" data-ch="${k}">
      <div class="grow">${esc(c.title)}</div><small>${fmt(c.pos)}</small>
    </div>`).join(""));
  $$("[data-ch]").forEach(el => el.onclick = () => { closeSheet(); seekGlobal(cur.chapters[+el.dataset.ch].pos); });
  document.querySelector(".row.on")?.scrollIntoView({ block: "center" });
}

/* ---------- slaaptimer ---------- */
function setSleep(mode, minutes) {
  clearSleep(false);
  sleep = mode === "chapter" ? { mode } : { mode, end: Date.now() + minutes * 60000 };
  sleep.tick = setInterval(tickSleep, 1000);
  tickSleep();
}
function clearSleep(render = true) {
  if (sleep.tick) clearInterval(sleep.tick);
  sleep = { mode: null };
  audio.volume = 1;
  if (render) updateSleepUI();
}
function tickSleep() {
  if (sleep.mode === "timer") {
    const left = (sleep.end - Date.now()) / 1000;
    if (left <= 0) {
      audio.pause(); clearSleep();
      return toast("Slaaptimer voorbij. Welterusten 🌙");
    }
    audio.volume = left < 20 ? Math.max(0.05, left / 20) : 1;   // laatste 20 sec zachter
  }
  updateSleepUI();
}
function checkChapterSleep() {
  const i = curChapterIdx();
  const nextPos = cur.chapters[i + 1] ? cur.chapters[i + 1].pos : total();
  if (gpos() >= nextPos - 0.5 && !audio.paused) {
    audio.pause(); clearSleep();
    toast("Gestopt aan het einde van het hoofdstuk");
  }
}
function updateSleepUI() {
  const btn = $("#sleepBtn");
  if (sleep.mode === "timer") {
    btn.textContent = `🌙 ${fmt((sleep.end - Date.now()) / 1000)}`;
    btn.classList.add("active");
  } else if (sleep.mode === "chapter") {
    btn.textContent = "🌙 Einde hoofdstuk";
    btn.classList.add("active");
  } else {
    btn.textContent = "🌙 Slaaptimer";
    btn.classList.remove("active");
  }
}
function openSleep() {
  const active = sleep.mode === "timer";
  openSheet(`<h2>Slaaptimer</h2>
    <div class="opt-grid">
      ${[15, 30, 45, 60].map(m => `<button class="tool" data-sleep="${m}">${m} min</button>`).join("")}
      <button class="tool" data-sleep="chapter">Einde hoofdstuk</button>
      <button class="tool" data-sleep="off">Uitzetten</button>
    </div>
    ${active ? `<button class="tool" data-sleep="plus10">+10 min verlengen</button>` : ""}
    <p class="muted" style="font-size:.85rem">De laatste 20 seconden wordt het geluid zachter, daarna stopt het.</p>`);
  $$("[data-sleep]").forEach(b => b.onclick = () => {
    const v = b.dataset.sleep;
    closeSheet();
    if (v === "off") { clearSleep(); return toast("Slaaptimer uit"); }
    if (v === "chapter") { setSleep("chapter"); return toast("Stopt aan het einde van dit hoofdstuk"); }
    if (v === "plus10") { sleep.end += 10 * 60000; updateSleepUI(); return toast("+10 minuten"); }
    setSleep("timer", +v);
    toast(`Slaaptimer: ${v} minuten`);
  });
}

/* ---------- bladwijzers ---------- */
function addBookmark() {
  if (!cur) return;
  marks[cur.id] = marks[cur.id] || [];
  marks[cur.id].push({ file: fileIdx, time: Math.round(audio.currentTime * 100) / 100, label: `${chapterTitle()} · ${fmt(gpos())}` });
  saveMarksStore();
  toast("Bladwijzer toegevoegd 🔖");
}

function openBookmarks() {
  const list = (marks[cur.id] || [])
    .map((b, k) => ({ ...b, k, pos: (cur.files[b.file]?.offset || 0) + b.time }))
    .sort((a, b) => a.pos - b.pos);
  openSheet(`<h2>Bladwijzers</h2>` + (list.length ? list.map(b => `
    <div class="row">
      <div class="grow" data-go="${b.pos}"><b>${esc(b.label)}</b><br><small>${fmt(b.pos)}</small></div>
      <button class="tool" style="width:auto;padding:8px 12px" data-del="${b.k}">✕</button>
    </div>`).join("") : `<p class="muted">Nog geen bladwijzers. Tik op “Bladwijzer zetten” terwijl je luistert.</p>`));
  $$("[data-go]").forEach(el => el.onclick = () => { closeSheet(); seekGlobal(+el.dataset.go); });
  $$("[data-del]").forEach(el => el.onclick = () => {
    marks[cur.id].splice(+el.dataset.del, 1);
    saveMarksStore();
    openBookmarks();
  });
}

/* ---------- meer-menu ---------- */
function openMore() {
  openSheet(`<h2>${esc(cur.title)}</h2>
    <div class="row" data-m="edit"><div class="grow">✏️ Titel & auteur wijzigen</div></div>
    <div class="row" data-m="fin"><div class="grow">${isDone() ? "↺ Markeer als niet afgespeeld" : "✓ Markeer als afgespeeld"}</div></div>
    <div class="row" data-m="del"><div class="grow danger">🗑 Van dit toestel verwijderen</div></div>`);
  $$("[data-m]").forEach(el => el.onclick = async () => {
    const m = el.dataset.m;
    if (m === "edit") {
      const t = prompt("Titel", cur.title); if (t === null) return;
      const a = prompt("Auteur", cur.author || ""); if (a === null) return;
      cur.title = t.trim() || cur.title; cur.author = a.trim();
      await DB.put("boeken", cur);
      $("#pTitle").textContent = cur.title; $("#pAuthor").textContent = cur.author;
      $("#pTitleSmall").textContent = cur.title;
      closeSheet(); await loadLibrary();
    }
    if (m === "fin") {
      saveProgress(!isDone()); closeSheet();
      toast(isDone() ? "Gemarkeerd als afgespeeld" : "Opnieuw op ‘niet afgespeeld’");
    }
    if (m === "del") {
      if (!confirm(`“${cur.title}” verwijderen van dit toestel? Je kunt het later opnieuw downloaden.`)) return;
      await deleteBook(cur);
      audio.pause(); audio.removeAttribute("src"); audio.load();
      cur = null; clearSleep(false); closeSheet();
      $("#player").classList.add("hidden");
      await loadLibrary(); toast("Boek verwijderd");
    }
  });
}

async function deleteBook(b) {
  await DB.del("boeken", b.id);
  for (let i = 0; i < b.files.length; i++) await DB.del("bestanden", `${b.id}/${i}`);
  if (b.hasCover) await DB.del("bestanden", `${b.id}/cover`);
  delete progress[b.id]; delete marks[b.id];
  saveProgressStore(); saveMarksStore();
}

/* ---------- sheets ---------- */
function openSheet(html) {
  $("#sheet").innerHTML = html;
  $("#sheetBg").classList.remove("hidden");
}
function closeSheet() { $("#sheetBg").classList.add("hidden"); }

/* ---------- knoppen, toetsenbord, vergrendelscherm ---------- */
$("#speed").innerHTML = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]
  .map(v => `<option value="${v}">${String(v).replace(".", ",")}×</option>`).join("");
$("#speed").value = String(speed);
$("#speed").onchange = () => {
  speed = +$("#speed").value; localStorage.setItem("snelheid", speed);
  audio.playbackRate = speed;
};

$("#playBtn").onclick = togglePlay;
$("#miniPlay").onclick = e => { e.stopPropagation(); togglePlay(); };
$("#mini").onclick = openPlayer;
$("#back30").onclick = () => seekGlobal(gpos() - 30);
$("#fwd30").onclick = () => seekGlobal(gpos() + 30);
$("#prevCh").onclick = prevChapter;
$("#nextCh").onclick = nextChapter;
$("#chapBtn").onclick = openChapters;
$("#sleepBtn").onclick = openSleep;
$("#markBtn").onclick = addBookmark;
$("#bmListBtn").onclick = openBookmarks;
$("#moreBtn").onclick = openMore;
$("#closePlayer").onclick = closePlayer;
$("#pChapter").onclick = openChapters;
$("#uploadBtn").onclick = () => openUpload([]);
$("#search").oninput = renderLibrary;
$("#sheetBg").onclick = e => { if (e.target.id === "sheetBg") closeSheet(); };
$("#fileInput").onchange = e => { addPicked([...e.target.files]); e.target.value = ""; };

const seek = $("#seek");
seek.oninput = () => { seeking = true; $("#tNow").textContent = fmt(+seek.value); };
seek.onchange = () => { seeking = false; seekGlobal(+seek.value); };

document.addEventListener("keydown", e => {
  if (!cur || $("#player").classList.contains("hidden") || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  else if (e.key === "ArrowRight") seekGlobal(gpos() + 10);
  else if (e.key === "ArrowLeft") seekGlobal(gpos() - 10);
  else if (e.key === "Escape") closePlayer();
});

if ("mediaSession" in navigator) {
  const handlers = {
    play: () => audio.play().catch(() => {}),
    pause: () => audio.pause(),
    seekbackward: () => seekGlobal(gpos() - 15),
    seekforward: () => seekGlobal(gpos() + 30),
    previoustrack: prevChapter,
    nexttrack: nextChapter,
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch {}
  }
}
function updateMedia() {
  if (!cur || !("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: chapterTitle() || cur.title,
      artist: cur.author || "",
      album: cur.title,
      artwork: cur.coverUrl ? [{ src: cur.coverUrl, sizes: "512x512" }] : [],
    });
  } catch {}
}

// op de PC: sleep bestanden in het venster om te downloaden
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("drop", e => {
  e.preventDefault();
  if (!e.dataTransfer.files.length) return;
  const upOpen = !$("#sheetBg").classList.contains("hidden") && $("#pickedList");
  upOpen ? addPicked([...e.dataTransfer.files]) : openUpload([...e.dataTransfer.files]);
});

// offline werken: de app zelf wordt door de service worker bewaard
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

loadLibrary().catch(e => toast(e.message));
