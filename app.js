(() => {
  const $ = (id) => document.getElementById(id);

  /* ---------- IndexedDB: 'meta' (small) + 'files' (the epub bytes) ---------- */
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("epub-reader", 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("meta", { keyPath: "id" });
        req.result.createObjectStore("files", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbRun(stores, mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let result;
      Promise.resolve(fn(...stores.map((s) => t.objectStore(s)))).then((r) => (result = r));
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
    });
  }
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  const getAllMeta = () => dbRun(["meta"], "readonly", (m) => req(m.getAll()));
  const getFile = (id) => dbRun(["files"], "readonly", (f) => req(f.get(id)));
  const saveBook = (meta, data) =>
    dbRun(["meta", "files"], "readwrite", (m, f) => { m.put(meta); f.put({ id: meta.id, data }); });
  const deleteBook = (id) =>
    dbRun(["meta", "files"], "readwrite", (m, f) => { m.delete(id); f.delete(id); });

  /* ---------- Settings & positions ---------- */
  const store = {
    get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  let theme = store.get("theme", "light");
  let fontSize = store.get("fontSize", 100);

  const THEMES = {
    light: { body: { background: "#ffffff", color: "#222222" } },
    sepia: { body: { background: "#f4ecd8", color: "#5b4636" } },
    dark:  { body: { background: "#16171a", color: "#d8d8dc" } },
  };

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 3000);
  }

  function applyTheme() {
    document.body.dataset.theme = theme;
    $("theme").value = theme;
    if (rendition) rendition.themes.select(theme);
  }

  /* ---------- Library ---------- */
  function blobToDataURL(blob) {
    return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
  }

  async function addFile(file) {
    if (!/\.epub$/i.test(file.name)) { toast(`${file.name} is not an .epub`); return; }
    const id = `${file.name}-${file.size}`;
    const data = await file.arrayBuffer();
    let title = file.name.replace(/\.epub$/i, ""), author = "", cover = "";
    try {
      const b = ePub(data.slice(0));
      const md = await b.loaded.metadata;
      title = md.title || title;
      author = md.creator || "";
      const url = await b.coverUrl();
      if (url) cover = await blobToDataURL(await (await fetch(url)).blob());
      b.destroy();
    } catch (e) { console.warn("metadata failed", e); }
    await saveBook({ id, title, author, cover, added: Date.now() }, data);
  }

  async function addFiles(files) {
    for (const f of files) await addFile(f);
    renderLibrary();
  }

  async function renderLibrary() {
    const books = (await getAllMeta()).sort((a, b) => b.added - a.added);
    const grid = $("grid");
    grid.innerHTML = "";
    $("drop-hint").hidden = books.length > 0 ? true : false;
    for (const b of books) {
      const card = document.createElement("div");
      card.className = "card";
      const pos = store.get("pos:" + b.id, null);
      card.innerHTML = `
        <div class="cover"></div>
        <div class="name"></div>
        <div class="author"></div>
        <div class="pct"></div>
        <button class="del" title="Remove">×</button>`;
      const cover = card.querySelector(".cover");
      if (b.cover) cover.style.backgroundImage = `url("${b.cover}")`; else cover.textContent = b.title;
      card.querySelector(".name").textContent = b.title;
      card.querySelector(".author").textContent = b.author;
      if (pos && pos.pct != null) card.querySelector(".pct").textContent = `${pos.pct}% read`;
      card.addEventListener("click", () => openBook(b));
      card.querySelector(".del").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (confirm(`Remove “${b.title}” from your library?`)) {
          await deleteBook(b.id);
          localStorage.removeItem("pos:" + b.id);
          renderLibrary();
        }
      });
      grid.appendChild(card);
    }
    if (!books.length) $("drop-hint").hidden = false;
  }

  /* ---------- Reader ---------- */
  let book = null, rendition = null, current = null, saveTimer = null;

  async function openBook(meta) {
    const rec = await getFile(meta.id);
    if (!rec) { toast("Book data missing"); return; }
    closeBook();
    current = meta;
    $("library").hidden = true;
    $("reader").hidden = false;
    $("book-title").textContent = meta.title;

    book = ePub(rec.data);
    rendition = book.renderTo("viewer", {
      width: "100%", height: "100%", flow: "paginated", spread: "auto", allowScriptedContent: false,
    });
    for (const [name, rules] of Object.entries(THEMES)) rendition.themes.register(name, rules);
    rendition.themes.fontSize(fontSize + "%");
    applyTheme();

    const saved = store.get("pos:" + meta.id, null);
    rendition.display(saved && saved.cfi ? saved.cfi : undefined);

    book.loaded.navigation.then((nav) => buildTOC(nav.toc));

    book.ready.then(() => book.locations.generate(1200)).then(() => {
      const loc = rendition.currentLocation();
      if (loc && loc.start) updateProgress(loc);
    });

    rendition.on("relocated", (loc) => {
      updateProgress(loc);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const pct = book.locations.length() ? Math.round(book.locations.percentageFromCfi(loc.start.cfi) * 100) : (saved?.pct ?? 0);
        store.set("pos:" + meta.id, { cfi: loc.start.cfi, pct });
      }, 300);
    });

    // keys + swipe inside the book iframe
    let sx = null;
    rendition.on("keyup", handleKey);
    rendition.on("touchstart", (e) => { sx = e.changedTouches[0].screenX; });
    rendition.on("touchend", (e) => {
      if (sx === null) return;
      const dx = e.changedTouches[0].screenX - sx;
      if (Math.abs(dx) > 50) (dx < 0 ? rendition.next() : rendition.prev());
      sx = null;
    });
  }

  function updateProgress(loc) {
    if (!book || !book.locations.length()) return;
    const p = Math.round(book.locations.percentageFromCfi(loc.start.cfi) * 100);
    $("progress").value = p;
    $("progress-text").textContent = p + "%";
  }

  function buildTOC(items) {
    const toc = $("toc");
    toc.innerHTML = "";
    const add = (list, depth) => {
      for (const it of list) {
        const a = document.createElement("a");
        a.href = "#";
        a.textContent = it.label.trim();
        a.style.paddingLeft = 16 + depth * 14 + "px";
        a.addEventListener("click", (e) => {
          e.preventDefault();
          rendition.display(it.href);
          toc.hidden = true;
        });
        toc.appendChild(a);
        if (it.subitems && it.subitems.length) add(it.subitems, depth + 1);
      }
    };
    add(items, 0);
  }

  function closeBook() {
    clearTimeout(saveTimer);
    try { if (rendition) rendition.destroy(); if (book) book.destroy(); } catch {}
    rendition = null; book = null; current = null;
    $("viewer").innerHTML = "";
    $("toc").hidden = true;
    $("progress").value = 0; $("progress-text").textContent = "0%";
  }

  function handleKey(e) {
    if (!rendition || $("reader").hidden) return;
    if (e.key === "ArrowRight" || e.key === "PageDown") rendition.next();
    else if (e.key === "ArrowLeft" || e.key === "PageUp") rendition.prev();
  }

  function setFont(delta) {
    fontSize = Math.min(220, Math.max(70, fontSize + delta));
    store.set("fontSize", fontSize);
    if (rendition) rendition.themes.fontSize(fontSize + "%");
  }

  /* ---------- Wire up UI ---------- */
  $("file-input").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
  $("back").addEventListener("click", () => {
    closeBook();
    $("reader").hidden = true; $("library").hidden = false;
    renderLibrary();
  });
  $("prev").addEventListener("click", () => rendition && rendition.prev());
  $("next").addEventListener("click", () => rendition && rendition.next());
  $("toc-btn").addEventListener("click", () => ($("toc").hidden = !$("toc").hidden));
  $("font-up").addEventListener("click", () => setFont(10));
  $("font-down").addEventListener("click", () => setFont(-10));
  $("theme").addEventListener("change", (e) => { theme = e.target.value; store.set("theme", theme); applyTheme(); });
  $("progress").addEventListener("change", (e) => {
    if (book && book.locations.length()) {
      const cfi = book.locations.cfiFromPercentage(e.target.value / 100);
      rendition.display(cfi);
    }
  });
  document.addEventListener("keyup", handleKey);

  // drag & drop
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; document.body.classList.add("dragging"); });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove("dragging");
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  applyTheme();
  renderLibrary();
})();
