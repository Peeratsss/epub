(() => {
  const $ = (id) => document.getElementById(id);

  /* ---------- IndexedDB: 'meta' (small) + 'files' (the book bytes) ---------- */
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

  /* ---------- Settings & per-book data ---------- */
  const store = {
    get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  const FONTS = [
    { name: "Book default", css: "" },
    { name: "Georgia", css: "Georgia, serif" },
    { name: "Palatino", css: "'Palatino Linotype', Palatino, 'Book Antiqua', serif" },
    { name: "System sans", css: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
    { name: "Monospace", css: "'Courier New', monospace" },
    { name: "Merriweather", css: "'Merriweather', serif", gf: "Merriweather" },
    { name: "Lora", css: "'Lora', serif", gf: "Lora" },
    { name: "Open Sans", css: "'Open Sans', sans-serif", gf: "Open+Sans" },
    { name: "Atkinson Hyperlegible", css: "'Atkinson Hyperlegible', sans-serif", gf: "Atkinson+Hyperlegible" },
    { name: "Noto Serif TC (中文)", css: "'Noto Serif TC', serif", gf: "Noto+Serif+TC" },
    { name: "Noto Sans TC (中文)", css: "'Noto Sans TC', sans-serif", gf: "Noto+Sans+TC" },
  ];

  let theme = store.get("theme", "light");
  let backgroundTheme = store.get("backgroundTheme", "light");
  let fontSize = store.get("fontSize", 100);
  let fontIdx = store.get("fontIdx", 0);
  let lineH = store.get("lineH", 0); // 0 = book default, otherwise e.g. 1.6
  let pdfZoom = store.get("pdfZoom", 1);
  let helperEnabled = store.get("helperEnabled", false);
  let helperMode = store.get("helperMode", "underline");
  let helperUnderlineColor = store.get("helperUnderlineColor", "#cd6ceb");
  let helperBgColor = store.get("helperBgColor", "#fff09a");
  let helperTextColor = store.get("helperTextColor", "#292238");
  let geminiApiKey = store.get("geminiApiKey", "");
  const helperHighlightName = "reader-word-helper";


  const THEMES = {
    light: { body: { background: "#fcf9ff", color: "#2b2139" } },
    slate: { body: { background: "#17243a", color: "#e8eef8" } },
    dark:  { body: { background: "#14111b", color: "#eee8f6" } },
  };
  if (!THEMES[theme]) theme = "light"; // e.g. the old "sepia" theme
  if (!["light", "slate", "dark"].includes(backgroundTheme)) backgroundTheme = "light";

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 3000);
  }

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error((label || "operation") + " timed out")), ms)),
    ]);
  }

  /* ---------- Loading / error overlay ---------- */
  let loadTimer = null;
  function showLoading(msg) { const l = $("loading"); l.textContent = msg || "Opening book…"; l.hidden = false; }
  function hideLoading() { clearTimeout(loadTimer); $("loading").hidden = true; }
  function openFailed(err) {
    console.error("Open failed:", err);
    clearTimeout(loadTimer);
    const l = $("loading");
    l.hidden = false;
    l.textContent = "Couldn’t open this book" + (err && err.message ? ": " + err.message : ".") +
      "  (Press F12 → Console for details, or go back and try another file.)";
  }

  /* ---------- Reader state ---------- */
  let mode = null; // "epub" | "pdf"
  let book = null, rendition = null, current = null, saveTimer = null;
  let pdf = null, pdfPage = 1, pdfNum = 0, pdfToken = 0, pdfRender = null;
  let pdfObserver = null, pdfPageNodes = new Map(), pdfRendered = new Set(), pdfPageScale = 1, pdfScrollTimer = null;
  let tocFlat = [];
  let bookmarks = [], anns = [];
  let pendingSel = null, editingId = null, notesTab = "bm";

  const saveBookmarks = () => store.set("bm:" + current.id, bookmarks);
  const saveAnns = () => store.set("an:" + current.id, anns);
  const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  /* ---------- Theme / typography ---------- */
  function applyTheme() {
    document.body.dataset.theme = backgroundTheme;
    $("background-theme").value = backgroundTheme;
    $("theme").value = theme;
    $("reader").dataset.bookTheme = theme;
    if (rendition) rendition.themes.select(theme);
  }

  function typographyCSS() {
    const f = FONTS[fontIdx] || FONTS[0];
    let css = `
      html, body { box-sizing: border-box !important; width: 100% !important; min-height: 100% !important; }
      body { margin: 0 !important; padding: 0.5in !important; }
      img, svg, video, table { max-width: 100% !important; }
    `;
    if (f.gf) css += `@import url('https://fonts.googleapis.com/css2?family=${f.gf}&display=swap');\n`;
    if (f.css) css += `body, body *:not(code):not(pre):not(kbd) { font-family: ${f.css} !important; }\n`;
    if (lineH) css += `body, body p, body div, body li, body span { line-height: ${lineH} !important; }\n`;
    return css;
  }
  function styleDoc(doc) {
    let s = doc.getElementById("reader-typo");
    if (!s) { s = doc.createElement("style"); s.id = "reader-typo"; doc.head.appendChild(s); }
    s.textContent = typographyCSS();
  }
  function applyTypography() {
    if (!rendition) return;
    rendition.themes.fontSize(fontSize + "%");
    rendition.getContents().forEach((c) => styleDoc(c.document));
    // re-flow to the current position once the new font has had a moment to load
    setTimeout(() => {
      try {
        const loc = rendition.currentLocation();
        if (loc && loc.start) rendition.display(loc.start.cfi);
      } catch {}
    }, 250);
  }

  function initSettingsUI() {
    const sel = $("font-select");
    FONTS.forEach((f, i) => { const o = document.createElement("option"); o.value = i; o.textContent = f.name; sel.appendChild(o); });
    sel.value = fontIdx;
    $("size-range").value = fontSize; $("size-label").textContent = fontSize + "%";
    $("lh-range").value = lineH ? Math.round(lineH * 10) : 11;
    $("lh-label").textContent = lineH ? lineH.toFixed(1) : "Default";
    $("zoom-range").value = Math.round(pdfZoom * 100); $("zoom-label").textContent = Math.round(pdfZoom * 100) + "%";
    $("helper-mode").value = helperMode;
    $("helper-underline-color").value = helperUnderlineColor;
    $("helper-bg-color").value = helperBgColor;
    $("helper-text-color").value = helperTextColor;
    $("gemini-key").placeholder = geminiApiKey ? "API key saved in this browser" : "Paste your Gemini API key";
    $("gemini-key-status").textContent = geminiApiKey
      ? "Gemini key saved in this browser. It is not written to GitHub."
      : "Add a Google AI Studio API key to enable AI etymology. The key stays in this browser.";
    $("gemini-key-save").addEventListener("click", () => {
      const value = $("gemini-key").value.trim();
      if (!value) { $("gemini-key-status").textContent = "Paste your API key first."; return; }
      geminiApiKey = value;
      store.set("geminiApiKey", geminiApiKey);
      $("gemini-key").value = "";
      $("gemini-key").placeholder = "API key saved in this browser";
      $("gemini-key-status").textContent = "Key saved locally in this browser.";
      toast("Gemini key saved");
    });
    $("gemini-key-clear").addEventListener("click", () => {
      geminiApiKey = "";
      localStorage.removeItem("geminiApiKey");
      $("gemini-key").value = "";
      $("gemini-key").placeholder = "Paste your Gemini API key";
      $("gemini-key-status").textContent = "Gemini key forgotten on this browser.";
      toast("Gemini key cleared");
    });
    updateHelperControls();
    updateHelperButton();
    $("helper-mode").addEventListener("change", (e) => {
      helperMode = e.target.value; store.set("helperMode", helperMode);
      updateHelperControls(); refreshHelperStyles();
    });
    $("helper-underline-color").addEventListener("input", (e) => {
      helperUnderlineColor = e.target.value; store.set("helperUnderlineColor", helperUnderlineColor); refreshHelperStyles();
    });
    $("helper-bg-color").addEventListener("input", (e) => {
      helperBgColor = e.target.value; store.set("helperBgColor", helperBgColor); refreshHelperStyles();
    });
    $("helper-text-color").addEventListener("input", (e) => {
      helperTextColor = e.target.value; store.set("helperTextColor", helperTextColor); refreshHelperStyles();
    });


    sel.addEventListener("change", () => { fontIdx = +sel.value; store.set("fontIdx", fontIdx); applyTypography(); });
    $("size-range").addEventListener("input", (e) => {
      fontSize = +e.target.value; $("size-label").textContent = fontSize + "%";
      store.set("fontSize", fontSize);
      if (rendition) rendition.themes.fontSize(fontSize + "%");
    });
    $("lh-range").addEventListener("input", (e) => {
      const v = +e.target.value;
      lineH = v <= 11 ? 0 : v / 10;
      $("lh-label").textContent = lineH ? lineH.toFixed(1) : "Default";
      store.set("lineH", lineH);
      applyTypography();
    });
    $("zoom-range").addEventListener("input", (e) => { $("zoom-label").textContent = e.target.value + "%"; });
    $("zoom-range").addEventListener("change", async (e) => {
      pdfZoom = +e.target.value / 100;
      store.set("pdfZoom", pdfZoom);
      if (mode !== "pdf" || !pdf) return;
      const doc = pdf;
      const page = pdfPage;
      try {
        await setupContinuousPdf();
        if (doc !== pdf) return;
        await renderPdfPage(page);
        if (doc === pdf) pdfGo(page);
      } catch (err) {
        if (doc === pdf) openFailed(err);
      }
    });
    $("theme").addEventListener("change", (e) => {
      theme = e.target.value;
      store.set("theme", theme);
      $("reader").dataset.bookTheme = theme;
      if (rendition) rendition.themes.select(theme);
    });
    $("background-theme").addEventListener("change", (e) => {
      backgroundTheme = e.target.value;
      store.set("backgroundTheme", backgroundTheme);
      document.body.dataset.theme = backgroundTheme;
    });
  }

  // show only the controls that make sense for the open file type
  function setModeUI() {
    const isPdf = mode === "pdf";
    ["font-field", "size-field", "lh-field"].forEach((id) => ($(id).hidden = isPdf));
    $("zoom-field").hidden = !isPdf;
    $("book-theme-field").hidden = isPdf;
    $("epub-sheet").hidden = isPdf;
    $("pdfview").hidden = !isPdf;
    $("settings-title").textContent = isPdf ? "PDF settings" : "Text settings";
  }

  /* ---------- Library ---------- */
  function blobToDataURL(blob) {
    return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
  }

  async function pdfMeta(data) {
    const doc = await withTimeout(pdfjsLib.getDocument({ data: new Uint8Array(data.slice(0)) }).promise, 60000, "reading PDF");
    let title = "", author = "", cover = "";
    try {
      const m = await doc.getMetadata();
      title = (m.info && m.info.Title) || ""; author = (m.info && m.info.Author) || "";
    } catch {}
    try {
      const page = await doc.getPage(1);
      const vp0 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 300 / vp0.width });
      const c = document.createElement("canvas");
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      await withTimeout(page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise, 20000, "rendering cover");
      cover = c.toDataURL("image/jpeg", 0.7);
    } catch (e) { console.warn("pdf cover failed", e); }
    try { doc.destroy(); } catch {}
    return { title, author, cover };
  }

  async function addFile(file) {
    const isPdf = /\.pdf$/i.test(file.name);
    const isEpub = /\.epub$/i.test(file.name);
    if (!isPdf && !isEpub) { toast(`${file.name} is not an .epub or .pdf`); return; }
    if (isPdf && typeof pdfjsLib === "undefined") { toast("PDF engine didn’t load. Check your internet connection and refresh."); return; }
    const id = `${file.name}-${file.size}`;
    const data = await file.arrayBuffer();
    let title = file.name.replace(/\.(epub|pdf)$/i, ""), author = "", cover = "";
    try {
      if (isPdf) {
        const m = await pdfMeta(data);
        if (m.title && m.title.trim()) title = m.title.trim();
        author = m.author; cover = m.cover;
      } else {
        const b = ePub(data.slice(0));
        const md = await withTimeout(b.loaded.metadata, 15000, "reading metadata");
        title = md.title || title;
        author = md.creator || "";
        try {
          const url = await withTimeout(b.coverUrl(), 8000, "loading cover");
          if (url) cover = await blobToDataURL(await (await fetch(url)).blob());
        } catch (e) { console.warn("cover failed", e); }
        b.destroy();
      }
    } catch (e) { console.warn("metadata failed", e); }
    await saveBook({ id, type: isPdf ? "pdf" : "epub", title, author, cover, added: Date.now() }, data);
  }

  async function addFiles(files) {
    toast("Adding book…");
    for (const f of files) {
      try { await addFile(f); } catch (e) { console.error(e); toast(`Couldn’t add ${f.name}: ${e.message || e}`); }
    }
    renderLibrary();
  }

  async function renderLibrary() {
    const books = (await getAllMeta()).sort((a, b) => b.added - a.added);
    const grid = $("grid");
    grid.innerHTML = "";
    $("drop-hint").hidden = books.length > 0;
    for (const b of books) {
      const card = document.createElement("div");
      card.className = "card";
      const pos = store.get("pos:" + b.id, null);
      card.innerHTML = `
        <div class="cover"></div>
        <div class="name"></div>
        <div class="author"></div>
        <div class="prog"><i></i></div>
        <div class="pct"></div>
        <button class="del" title="Remove">×</button>`;
      const cover = card.querySelector(".cover");
      if (b.cover) cover.style.backgroundImage = `url("${b.cover}")`; else cover.textContent = b.title;
      card.querySelector(".name").textContent = b.title;
      card.querySelector(".author").textContent = (b.type === "pdf" ? "PDF" : "EPUB") + (b.author ? " · " + b.author : "");
      if (pos && pos.pct != null) {
        card.querySelector(".pct").textContent = `${pos.pct}% read`;
        card.style.setProperty("--p", Math.min(100, Math.max(0, pos.pct)) + "%");
      }
      card.addEventListener("click", () => openBook(b));
      card.querySelector(".del").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (confirm(`Remove “${b.title}” from your library? Its bookmarks and notes will be deleted too.`)) {
          await deleteBook(b.id);
          ["pos:", "bm:", "an:", "loc:"].forEach((p) => localStorage.removeItem(p + b.id));
          renderLibrary();
        }
      });
      grid.appendChild(card);
    }
  }

  /* ---------- Open / close ---------- */
  async function openBook(meta) {
    const rec = await getFile(meta.id);
    if (!rec) { toast("Book data missing"); return; }
    closeBook();
    current = meta;
    bookmarks = store.get("bm:" + meta.id, []);
    anns = store.get("an:" + meta.id, []);
    $("library").hidden = true;
    $("reader").hidden = false;
    $("book-title").textContent = meta.title;
    if (meta.type === "pdf") return openPdf(meta, rec);
    return openEpub(meta, rec);
  }

  function openEpub(meta, rec) {
    mode = "epub"; setModeUI();
    if (typeof ePub === "undefined") { openFailed(new Error("EPUB engine didn’t load. Check your internet connection and refresh.")); return; }
    showLoading();
    loadTimer = setTimeout(() => showLoading("Still opening… large books can take a while. If nothing happens, press F12 and check the Console for errors."), 15000);

    book = ePub(rec.data);
    book.opened.catch(openFailed);
    rendition = book.renderTo("viewer", {
      width: "100%", height: "100%", flow: "paginated", spread: "none", allowScriptedContent: false,
    });
    for (const [name, rules] of Object.entries(THEMES)) rendition.themes.register(name, rules);
    rendition.themes.fontSize(fontSize + "%");
    rendition.hooks.content.register((contents) => {
      styleDoc(contents.document);
      attachReadingHelper(contents.document);
    });
    applyTheme();

    anns.forEach(drawAnn);

    const saved = store.get("pos:" + meta.id, null);
    rendition.on("rendered", hideLoading);
    rendition.display(saved && saved.cfi ? saved.cfi : undefined).catch((err) => {
      // a saved position can become invalid; fall back to the start of the book
      console.warn("display failed, retrying from start", err);
      rendition.display().catch(openFailed);
    });

    book.loaded.navigation.then((nav) => {
      buildTOC(nav.toc);
      tocFlat = [];
      (function walk(list) { list.forEach((i) => { tocFlat.push(i); if (i.subitems) walk(i.subitems); }); })(nav.toc);
      renderNotes();
    });

    // page-count/progress data: reuse a saved copy, otherwise build it after the first page is showing
    const bk = book;
    book.ready.then(() => {
      const cached = store.get("loc:" + meta.id, null);
      if (cached) { bk.locations.load(cached); return; }
      return new Promise((r) => setTimeout(r, 1500))
        .then(() => (book === bk ? bk.locations.generate(2000) : null))
        .then(() => { if (book === bk) store.set("loc:" + meta.id, bk.locations.save()); });
    }).then(() => {
      if (book !== bk) return;
      const loc = rendition.currentLocation();
      if (loc && loc.start) updateProgress(loc);
      renderNotes();
    }).catch((e) => console.warn("progress data failed", e));

    rendition.on("relocated", (loc) => {
      updateProgress(loc);
      updateBmStar();
      hideSelbar();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const pct = pctAt(loc.start.cfi) ?? (saved?.pct ?? 0);
        store.set("pos:" + meta.id, { cfi: loc.start.cfi, pct });
      }, 300);
    });

    rendition.on("selected", (cfiRange, contents) => {
      pendingSel = { cfiRange, contents };
      $("selbar").hidden = false;
    });

    // keys + swipe inside the book iframe
    let sx = null;
    rendition.on("keyup", handleKey);
    rendition.on("touchstart", (e) => { sx = e.changedTouches[0].screenX; });
    rendition.on("touchend", (e) => {
      if (sx === null) return;
      const dx = e.changedTouches[0].screenX - sx;
      const sel = e.view && e.view.getSelection ? e.view.getSelection().toString() : "";
      if (Math.abs(dx) > 50 && !sel) (dx < 0 ? rendition.next() : rendition.prev());
      sx = null;
    });
  }

  function closeBook() {
    clearTimeout(saveTimer);
    hideLoading();
    pdfToken++;
    try { if (pdfRender) pdfRender.cancel(); } catch {}
    try { if (pdf) pdf.destroy(); } catch {}
    try { if (rendition) rendition.destroy(); if (book) book.destroy(); } catch {}
    rendition = null; book = null; pdf = null; pdfRender = null; pdfNum = 0; pdfPage = 1;
    if (pdfObserver) pdfObserver.disconnect(); pdfObserver = null;
    pdfPageNodes.clear(); pdfRendered.clear(); clearTimeout(pdfScrollTimer);
    current = null; mode = null; tocFlat = []; bookmarks = []; anns = [];
    if (typeof helperDocs !== "undefined") { helperDocs.forEach(clearHelperDoc); helperDocs.clear(); }
    pendingSel = null;
    closeDictionary();
    $("viewer").innerHTML = "";
    $("pdfpage").innerHTML = "";
    $("toc").innerHTML = "";
    setModeUI(); $("pdfview").hidden = true; $("viewer").hidden = false;
    hidePanels(); hideSelbar();
    setSlider(0, 100, 0); $("progress-text").textContent = "0%";
    $("bm-btn").textContent = "☆"; $("bm-btn").classList.remove("on");
  }

  function setSlider(min, max, val) {
    const s = $("progress");
    s.min = min; s.max = max; s.value = val;
  }

  /* ---------- EPUB helpers ---------- */
  function pctAt(cfi) {
    try {
      if (book && book.locations.length()) return Math.round(book.locations.percentageFromCfi(cfi) * 100);
    } catch {}
    return null;
  }

  function updateProgress(loc) {
    const p = pctAt(loc.start.cfi);
    if (p == null) return;
    $("progress").value = p;
    $("progress-text").textContent = p + "%";
  }

  function chapterOf(href) {
    if (!href) return "";
    const h = href.split("#")[0];
    const hit = tocFlat.find((i) => {
      const t = (i.href || "").split("#")[0];
      return t === h || t.endsWith(h) || h.endsWith(t);
    });
    return hit ? hit.label.trim() : "";
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

  /* ---------- PDF ---------- */
  async function openPdf(meta, rec) {
    mode = "pdf"; setModeUI(); applyTheme();
    if (typeof pdfjsLib === "undefined") { openFailed(new Error("PDF engine didn’t load. Check your internet connection and refresh.")); return; }
    showLoading("Opening PDF…");
    loadTimer = setTimeout(() => showLoading("Still opening… large PDFs can take a while. If nothing happens, press F12 and check the Console for errors."), 20000);
    try {
      pdf = await pdfjsLib.getDocument({ data: new Uint8Array(rec.data) }).promise;
    } catch (e) { if (current === meta) openFailed(e); return; }
    if (current !== meta) { try { pdf.destroy(); } catch {} return; }
    pdfNum = pdf.numPages;
    const saved = store.get("pos:" + meta.id, null);
    pdfPage = Math.min(Math.max((saved && saved.page) || 1, 1), pdfNum);
    const doc = pdf;
    pdf.getOutline().then((o) => buildPdfTOC(doc, o)).catch(() => buildPdfTOC(doc, null));
    try {
      await setupContinuousPdf();
      await renderPdfPage(pdfPage);
      pdfGo(pdfPage);
      hideLoading();
    } catch (e) {
      if (current === meta) openFailed(e);
    }
  }

  async function setupContinuousPdf() {
    const view = $("pdfview"), root = $("pdfpage");
    if (pdfObserver) pdfObserver.disconnect();
    pdfPageNodes.clear(); pdfRendered.clear();
    root.innerHTML = "";
    const first = await pdf.getPage(1);
    const base = Math.min(Math.max(view.clientWidth - 44, 280), 900) / first.getViewport({ scale: 1 }).width;
    pdfPageScale = Math.max(base, 0.1) * pdfZoom;
    for (let n = 1; n <= pdfNum; n++) {
      const page = n === 1 ? first : await pdf.getPage(n);
      const vp = page.getViewport({ scale: pdfPageScale });
      const wrap = document.createElement("div");
      wrap.className = "pdf-page";
      wrap.dataset.page = n;
      wrap.style.width = vp.width + "px";
      wrap.style.height = vp.height + "px";
      wrap.style.setProperty("--page-width", vp.width + "px");
      wrap.setAttribute("aria-label", "PDF page " + n);
      root.appendChild(wrap);
      pdfPageNodes.set(n, wrap);
    }
    pdfObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const n = +entry.target.dataset.page;
          renderPdfPage(n).catch((e) => console.warn("PDF page render failed", n, e));
        }
      });
    }, { root: view, rootMargin: "1200px 0px" });
    pdfPageNodes.forEach((node) => pdfObserver.observe(node));
    updatePdfUI();
  }

  async function renderPdfPage(n) {
    if (!pdf || pdfRendered.has(n)) return;
    const doc = pdf, wrap = pdfPageNodes.get(n);
    if (!wrap) return;
    pdfRendered.add(n);
    try {
      const page = await doc.getPage(n);
      if (doc !== pdf) return;
      const vp = page.getViewport({ scale: pdfPageScale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = vp.width + "px"; canvas.style.height = vp.height + "px";
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
      if (doc !== pdf) return;
      wrap.innerHTML = "";
      wrap.appendChild(canvas);
      const hl = document.createElement("div"); hl.className = "hlLayer"; wrap.appendChild(hl);
      const tl = document.createElement("div"); tl.className = "textLayer";
      tl.style.setProperty("--scale-factor", vp.scale); wrap.appendChild(tl);
      const tc = await page.getTextContent();
      if (doc !== pdf) return;
      await pdfjsLib.renderTextLayer({ textContentSource: tc, container: tl, viewport: vp, textDivs: [] }).promise;
      drawPdfHighlights(n, wrap);
      const annotations = await page.getAnnotations();
      annotations.filter((x) => x.subtype === "Link" && x.rect).forEach((ann) => {
        const rect = vp.convertToViewportRectangle(ann.rect);
        const left = Math.min(rect[0], rect[2]), top = Math.min(rect[1], rect[3]);
        const link = document.createElement("a");
        link.className = "pdf-link";
        link.style.left = left + "px"; link.style.top = top + "px";
        link.style.width = Math.abs(rect[2] - rect[0]) + "px";
        link.style.height = Math.abs(rect[3] - rect[1]) + "px";
        link.title = ann.url ? "Open link" : "Go to linked page";
        if (ann.url) { link.href = ann.url; link.target = "_blank"; link.rel = "noopener noreferrer"; }
        else if (ann.dest) { link.href = "#"; link.addEventListener("click", async (e) => {
          e.preventDefault(); const target = await resolvePdfDest(doc, ann.dest); if (target) pdfGo(target);
        }); }
        else return;
        wrap.appendChild(link);
      });
    } catch (e) {
      pdfRendered.delete(n);
      throw e;
    }
  }

  async function pdfGo(n) {
    if (!pdf) return;
    n = Math.min(Math.max(Math.round(n), 1), pdfNum);
    pdfPage = n;
    updatePdfUI();
    hideSelbar();
    const node = pdfPageNodes.get(n);
    if (node) {
      node.scrollIntoView({ behavior: "auto", block: "start" });
      renderPdfPage(n).catch(openFailed);
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (current) store.set("pos:" + current.id, { page: pdfPage, pct: Math.round((pdfPage / pdfNum) * 100) });
    }, 500);
  }

  function updatePdfUI() {
    setSlider(1, pdfNum, pdfPage);
    $("progress-text").textContent = `${pdfPage} / ${pdfNum}`;
    updateBmStar();
  }

  async function resolvePdfDest(doc, dest) {
    let d = dest;
    if (typeof d === "string") d = await doc.getDestination(d);
    if (!Array.isArray(d)) return null;
    const ref = d[0];
    if (ref && typeof ref === "object") return (await doc.getPageIndex(ref)) + 1;
    if (Number.isInteger(ref)) return ref + 1;
    return null;
  }

  async function buildPdfTOC(doc, items) {
    const toc = $("toc");
    if (pdf !== doc) return;
    if (!items || !items.length) { toc.innerHTML = '<div class="empty">This PDF has no table of contents.</div>'; return; }
    toc.innerHTML = "";
    const flat = [];
    (function walk(list, d) { list.forEach((it) => { flat.push({ it, d }); if (it.items && it.items.length) walk(it.items, d + 1); }); })(items, 0);
    flat.forEach(({ it, d }) => {
      const a = document.createElement("a");
      a.href = "#";
      a.textContent = (it.title || "").trim() || "(untitled)";
      a.style.paddingLeft = 16 + d * 14 + "px";
      a.addEventListener("click", async (e) => {
        e.preventDefault();
        try {
          const p = it._page ?? (await resolvePdfDest(doc, it.dest));
          if (p) { pdfGo(p); toc.hidden = true; }
        } catch (err) { console.warn(err); }
      });
      toc.appendChild(a);
    });
    // resolve target pages in the background so bookmarks/notes can show chapter names
    const list = [];
    for (const { it } of flat) {
      if (pdf !== doc) return;
      try { it._page = await resolvePdfDest(doc, it.dest); } catch {}
      if (it._page) list.push({ label: (it.title || "").trim(), page: it._page });
    }
    if (pdf !== doc) return;
    list.sort((a, b) => a.page - b.page);
    tocFlat = list;
    renderNotes();
  }

  function pdfChapterOf(page) {
    let label = "";
    for (const t of tocFlat) { if (t.page <= page) label = t.label; else break; }
    return label;
  }

  function drawPdfHighlights(pageNo = pdfPage, pageWrap = $("pdfpage").querySelector('[data-page="' + pdfPage + '"]')) {
    const layer = pageWrap && pageWrap.querySelector(".hlLayer");
    if (!layer) return;
    layer.innerHTML = "";
    anns.filter((a) => a.page === pageNo && a.rects).forEach((a) => a.rects.forEach((r) => {
      const d = document.createElement("div");
      d.className = "hl-rect";
      d.style.cssText = `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%;background:${a.color}`;
      layer.appendChild(d);
    }));
  }

  // text selection on a PDF page -> show the highlight bar
  let selTimer = null;
  document.addEventListener("selectionchange", () => {
    if (mode !== "pdf") return;
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const sel = window.getSelection();
      const pageEl = sel && sel.anchorNode && sel.anchorNode.parentElement ? sel.anchorNode.parentElement.closest(".pdf-page") : null;
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !pageEl) {
        if (pendingSel && pendingSel.pdf) hideSelbar();
        return;
      }
      const text = sel.toString().trim().replace(/\s+/g, " ");
      if (!text) return;
      const wr = pageEl.getBoundingClientRect();
      const rects = [...sel.getRangeAt(0).getClientRects()]
        .map((r) => ({ x: (r.left - wr.left) / wr.width, y: (r.top - wr.top) / wr.height, w: r.width / wr.width, h: r.height / wr.height }))
        .filter((r) => r.w > 0.002 && r.h > 0.002 && r.h < 0.06 && r.w < 0.98);
      if (!rects.length) return;
      pendingSel = { pdf: true, page: +pageEl.dataset.page, rects, text };
      $("selbar").hidden = false;
    }, 250);
  });

  // click a PDF highlight to open its note
  $("pdfpage").addEventListener("click", (e) => {
    if (window.getSelection().toString() || e.target.closest(".pdf-link")) return;
    const pageEl = e.target.closest(".pdf-page");
    if (!pageEl) return;
    const pageNo = +pageEl.dataset.page;
    const wr = pageEl.getBoundingClientRect();
    const x = (e.clientX - wr.left) / wr.width, y = (e.clientY - wr.top) / wr.height;
    const hit = anns.find((a) => a.page === pageNo && a.rects && a.rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h));
    if (hit) openNote(hit.id);
  });

  // swipe to turn pages on touch screens (only when the page isn't zoomed wider than the screen)
  let psx = null, psy = null;
  $("pdfview").addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) { psx = e.touches[0].clientX; psy = e.touches[0].clientY; } else psx = null;
  }, { passive: true });
  $("pdfview").addEventListener("touchend", (e) => {
    if (psx === null || mode !== "pdf") return;
    const dx = e.changedTouches[0].clientX - psx, dy = e.changedTouches[0].clientY - psy;
    psx = null;
    const v = $("pdfview");
    if (window.getSelection().toString() || v.scrollWidth > v.clientWidth + 4) return;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) pdfGo(pdfPage + (dx < 0 ? 1 : -1));
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (mode !== "pdf" || !pdf) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (mode === "pdf" && pdf) setupContinuousPdf().then(() => pdfGo(pdfPage)).catch(() => {});
    }, 350);
  });


  /* ---------- Reading Helper ---------- */
  const helperDocs = new Set();
  function updateHelperButton() {
    const button = $("helper-toggle");
    button.setAttribute("aria-pressed", helperEnabled ? "true" : "false");
    button.textContent = helperEnabled ? "◎ Helper: On" : "◎ Helper";
    button.title = helperEnabled ? "Turn Reading Helper off" : "Turn Reading Helper on";
  }
  function updateHelperControls() {
    const isHighlight = helperMode === "highlight";
    $("helper-underline-field").hidden = isHighlight;
    $("helper-highlight-fields").hidden = !isHighlight;
  }
  function helperStyleText() {
    // CSS Custom Highlights paint over the existing text range. Do not set font,
    // weight, size, spacing, or line-height here: those remain inherited from the
    // book's original text, so hovering never substitutes or reflows a word.
    if (helperMode === "highlight") {
      return `::highlight(${helperHighlightName}){background-color:${helperBgColor};color:${helperTextColor}}`;
    }
    // Add only an underline; leave the word's original font and other styling intact.
    return `::highlight(${helperHighlightName}){background-color:transparent;color:inherit;text-decoration-line:underline;text-decoration-color:${helperUnderlineColor};text-decoration-thickness:1px;text-underline-offset:2px}`;
  }
  function applyHelperStyle(doc) {
    if (!doc || !doc.head) return;
    let style = doc.getElementById("reader-helper-style");
    if (!style) { style = doc.createElement("style"); style.id = "reader-helper-style"; doc.head.appendChild(style); }
    style.textContent = helperStyleText();
  }
  function clearHelperDoc(doc) {
    try { doc.defaultView.CSS.highlights.delete(helperHighlightName); } catch {}
  }

  // A token is separated only by whitespace, comma, or period. Build one
  // Range across adjacent inline text nodes so bold/italic/span boundaries do
  // not split words such as (Tish′ūz).
  function getHelperWordRange(doc, caret) {
    if (!caret || caret.startContainer.nodeType !== doc.defaultView.Node.TEXT_NODE) return null;
    const caretNode = caret.startContainer;
    let root = caretNode.parentElement;
    const blockTags = new Set(["P","LI","TD","TH","BLOCKQUOTE","PRE","H1","H2","H3","H4","H5","H6"]);
    while (root && root !== doc.body && !blockTags.has(root.tagName) && !root.classList.contains("textLayer")) {
      root = root.parentElement;
    }
    if (!root || root === doc.body) root = caretNode.parentElement || doc.body;

    const walker = doc.createTreeWalker(root, doc.defaultView.NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || p.closest("script,style,noscript,svg")) return doc.defaultView.NodeFilter.FILTER_REJECT;
        if (p.closest("[hidden],.hidden")) return doc.defaultView.NodeFilter.FILTER_REJECT;
        return doc.defaultView.NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    let total = 0, caretOffset = -1, current;
    while ((current = walker.nextNode())) {
      const value = current.nodeValue || "";
      if (current === caretNode) caretOffset = total + Math.min(caret.startOffset, value.length);
      nodes.push({ node: current, start: total, end: total + value.length, value });
      total += value.length;
    }
    if (caretOffset < 0 || !nodes.length) return null;

    const fullText = nodes.map(x => x.value).join("");
    const isSeparator = (ch) => !ch || /[\\s,.]/u.test(ch);
    let pos = caretOffset;
    if (isSeparator(fullText.charAt(pos))) {
      if (!isSeparator(fullText.charAt(pos - 1))) pos--;
      else if (!isSeparator(fullText.charAt(pos + 1))) pos++;
      else return null;
    }
    if (pos < 0 || pos >= fullText.length || isSeparator(fullText.charAt(pos))) return null;

    let start = pos, end = pos + 1;
    while (start > 0 && !isSeparator(fullText.charAt(start - 1))) start--;
    while (end < fullText.length && !isSeparator(fullText.charAt(end))) end++;

    const pointAt = (offset, preferNext) => {
      for (let i = 0; i < nodes.length; i++) {
        const item = nodes[i];
        if (offset < item.end || (!preferNext && offset === item.end)) {
          return { node: item.node, offset: Math.max(0, Math.min(item.value.length, offset - item.start)) };
        }
      }
      const last = nodes[nodes.length - 1];
      return { node: last.node, offset: last.value.length };
    };
    const a = pointAt(start, true), b = pointAt(end, false);
    const range = doc.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    if (!range.toString().trim() || !range.getBoundingClientRect().width) return null;

    const parent = caretNode.parentElement;
    const weight = parent ? doc.defaultView.getComputedStyle(parent).fontWeight : "400";
    const isBold = weight === "bold" || Number.parseInt(weight, 10) >= 600;
    const context = fullText.slice(Math.max(0, start - 100), Math.min(fullText.length, end + 180)).replace(/\\s+/g, " ").trim();
    return { range, isBold, context };
  }
  function getCaretAtPoint(doc, x, y) {
    try {
      if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
      if (doc.caretPositionFromPoint) {
        const p = doc.caretPositionFromPoint(x, y);
        if (p) { const r = doc.createRange(); r.setStart(p.offsetNode, p.offset); r.collapse(true); return r; }
      }
    } catch {}
    return null;
  }
  function attachReadingHelper(doc) {
    if (!doc || helperDocs.has(doc)) return;
    helperDocs.add(doc);
    applyHelperStyle(doc);
    let lastMove = 0;
    doc.addEventListener("mousemove", (e) => {
      if (!helperEnabled || !current) { clearHelperDoc(doc); return; }
      const now = performance.now();
      if (now - lastMove < 12) return;
      lastMove = now;
      const caret = getCaretAtPoint(doc, e.clientX, e.clientY);
      if (!caret || caret.startContainer.nodeType !== Node.TEXT_NODE) { clearHelperDoc(doc); return; }
      const word = getHelperWordRange(doc, caret);
      if (!word) { clearHelperDoc(doc); return; }
      try {
        const range = word.range;
        if (!range.toString().trim() || !range.getBoundingClientRect().width) { clearHelperDoc(doc); return; }
        const HighlightClass = doc.defaultView.Highlight;
        const highlights = doc.defaultView.CSS && doc.defaultView.CSS.highlights;
        if (!HighlightClass || !highlights) { clearHelperDoc(doc); return; }
        applyHelperStyle(doc);
        highlights.set(helperHighlightName, new HighlightClass(range));
      } catch { clearHelperDoc(doc); }
    }, { passive: true });
    doc.addEventListener("click", (e) => {
      if (!helperEnabled || !current || e.target.closest("a")) return;
      const caret = getCaretAtPoint(doc, e.clientX, e.clientY);
      const word = caret && getHelperWordRange(doc, caret);
      if (word) lookupDictionary(word.range.toString(), word.context);
    });
    doc.addEventListener("mouseleave", () => clearHelperDoc(doc));
  }
  function appendDictionarySource(container, label, url) {
    if (!url) return;
    const link = document.createElement("a");
    link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer";
    link.textContent = label;
    container.appendChild(link);
  }
  function setDictionaryCopy(id, value) {
    $(id).textContent = value || "No information was returned for this section.";
  }
  function extractInteractionText(data) {
    if (data.output_text) return data.output_text;
    const outputs = Array.isArray(data.outputs) ? data.outputs : [];
    const outputText = outputs.filter(x => x.type === "text" && x.text).map(x => x.text).join("\\n");
    if (outputText) return outputText;
    const steps = Array.isArray(data.steps) ? data.steps : [];
    return steps.filter(x => x.type === "model_output").flatMap(x => x.content || [])
      .filter(x => x.type === "text" && x.text).map(x => x.text).join("\\n");
  }
  function extractInteractionCitations(data) {
    const found = [];
    const add = (annotations) => (annotations || []).forEach(a => {
      const url = a.url || a.source;
      if (url && /^https?:\\/\\//i.test(url) && !found.some(x => x.url === url)) {
        found.push({ title: a.title || new URL(url).hostname, url });
      }
    });
    (data.outputs || []).forEach(x => add(x.annotations));
    (data.steps || []).forEach(step => (step.content || []).forEach(x => add(x.annotations)));
    return found;
  }
  async function getReferenceDescription(word) {
    const [dictResult, wikiResult] = await Promise.allSettled([
      fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(word)).then(r => {
        if (!r.ok) throw new Error("Dictionary entry not found");
        return r.json();
      }),
      fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(word.replace(/ /g, "_"))).then(r => {
        if (!r.ok) throw new Error("No Wikipedia summary");
        return r.json();
      })
    ]);
    const parts = [];
    const sources = [];
    if (dictResult.status === "fulfilled" && Array.isArray(dictResult.value)) {
      const entry = dictResult.value[0];
      if (entry.phonetic) parts.push("Pronunciation: " + entry.phonetic);
      (entry.meanings || []).slice(0, 4).forEach(m => {
        const defs = (m.definitions || []).slice(0, 2).map(d => d.definition).filter(Boolean);
        if (defs.length) parts.push(m.partOfSpeech + ": " + defs.join(" / "));
      });
      if (entry.origin) parts.push("Recorded origin: " + entry.origin);
      sources.push({ title: "Dictionary API", url: "https://dictionaryapi.dev/" });
    }
    let wikiTitle = "";
    if (wikiResult.status === "fulfilled" && wikiResult.value && wikiResult.value.extract) {
      const w = wikiResult.value;
      wikiTitle = w.title || word;
      parts.push("Reference overview: " + w.extract);
      sources.push({ title: "Wikipedia — " + wikiTitle, url: w.content_urls?.desktop?.page || "https://en.wikipedia.org/wiki/" + encodeURIComponent(wikiTitle.replace(/ /g, "_")) });
    }
    sources.push({ title: "Wiktionary", url: "https://en.wiktionary.org/wiki/" + encodeURIComponent(word.replace(/ /g, "_")) });
    sources.push({ title: "MedlinePlus search", url: "https://medlineplus.gov/search/?q=" + encodeURIComponent(word) });
    sources.push({ title: "PubMed search", url: "https://pubmed.ncbi.nlm.nih.gov/?term=" + encodeURIComponent(word) });
    return { description: parts.join("\\n\\n") || "No automatic dictionary entry was found. Use the reference links below.", sources };
  }
  async function getGeminiEtymology(word, context) {
    if (!geminiApiKey) throw new Error("Add your Gemini API key in Text settings → Gemini etymology.");
    const prompt = `Analyze the term "${word}" in the context: "${context || word}".

Use Google Search to verify etymological and medical claims. Focus on etymology as the AI-generated part, and distinguish historically attested origins from modern textbook word-part analysis. Never invent roots or claim certainty where the origin is disputed. If no reliable etymology can be verified, say so clearly.

If this is a medical, anatomical, biological, pharmacological, or medico-legal term, use exactly these six sections:
1. ROOTS — exact prefixes, roots, suffixes; source language (Greek, Latin, Old English, etc.); original meanings. Distinguish true historical etymology from educational word-part segmentation.
2. LITERAL MEANING — direct word-for-word meaning of the components, noting when a literal translation is approximate.
3. ROOT USES — high-yield clinical cognates using the same roots or affixes, with brief meanings.
4. FULL WORD — accurate clinical definition, anatomy/pathophysiology or medico-legal significance at PNLE/NCLEX level.
5. DIFFERENTIAL COMPARISON — compare with closely related concepts; use a compact table when useful.
6. DISTINGUISHED FROM — commonly confused look-alike or sound-alike terms and their differences.

If this is not a medical term, use a concise equivalent: ROOTS & ORIGIN, ORIGINAL/LITERAL MEANING, HISTORICAL DEVELOPMENT, MODERN MEANING, and RELATED WORDS. Do not force medical sections onto ordinary words.

Be rigorous and concise. Do not blindly agree with a presumed root breakdown. Include source URLs or source names at the end when available. This is educational information, not a diagnosis or substitute for clinical references.`;
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": geminiApiKey },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        input: prompt,
        tools: [{ type: "google_search" }],
        store: false
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || ("Gemini request failed (" + response.status + ")"));
    const text = extractInteractionText(data);
    if (!text) throw new Error("Gemini returned no text. Try again.");
    return { text, citations: extractInteractionCitations(data) };
  }
  async function lookupDictionary(rawWord, context) {
    const word = String(rawWord || "").trim().replace(/^\\(+|\\)+$/g, "");
    if (!word || word.length > 100) return;
    $("dictionary-dialog").hidden = false;
    $("dictionary-title").textContent = word;
    $("dictionary-status").textContent = "Loading dictionary references and Gemini etymology…";
    setDictionaryCopy("dictionary-definition", "Searching dictionary and reference sources…");
    setDictionaryCopy("dictionary-etymology", "Waiting for Gemini…");
    $("dictionary-sources").innerHTML = "";
    const cacheKey = "wordLookup:" + word.toLocaleLowerCase();
    const cached = store.get(cacheKey, null);
    if (cached && Date.now() - cached.savedAt < 30 * 24 * 60 * 60 * 1000) {
      setDictionaryCopy("dictionary-definition", cached.description);
      setDictionaryCopy("dictionary-etymology", cached.etymology || "No cached Gemini explanation.");
      cached.sources.forEach(s => appendDictionarySource($("dictionary-sources"), s.title, s.url));
      $("dictionary-status").textContent = "Loaded from this browser’s 30-day cache.";
      if (!cached.etymology && geminiApiKey) {
        try {
          const ai = await getGeminiEtymology(word, context);
          setDictionaryCopy("dictionary-etymology", ai.text);
          ai.citations.forEach(s => appendDictionarySource($("dictionary-sources"), s.title, s.url));
          store.set(cacheKey, { ...cached, etymology: ai.text, sources: [...cached.sources, ...ai.citations], savedAt: Date.now() });
        } catch (e) { setDictionaryCopy("dictionary-etymology", e.message); }
      }
      return;
    }
    const referencePromise = getReferenceDescription(word);
    const aiPromise = getGeminiEtymology(word, context);
    const [referenceResult, aiResult] = await Promise.allSettled([referencePromise, aiPromise]);
    const reference = referenceResult.status === "fulfilled"
      ? referenceResult.value
      : { description: "Reference websites could not be reached. Check your internet connection.", sources: [] };
    const ai = aiResult.status === "fulfilled"
      ? aiResult.value
      : { text: aiResult.reason?.message || "Gemini lookup failed.", citations: [] };
    setDictionaryCopy("dictionary-definition", reference.description);
    setDictionaryCopy("dictionary-etymology", ai.text);
    const sources = [...reference.sources, ...ai.citations];
    const uniqueSources = sources.filter((s, i) => s.url && sources.findIndex(x => x.url === s.url) === i);
    uniqueSources.forEach(s => appendDictionarySource($("dictionary-sources"), s.title, s.url));
    $("dictionary-status").textContent = referenceResult.status === "fulfilled" && aiResult.status === "fulfilled"
      ? "Reference lookup complete · Gemini AI etymology"
      : "Some sources were unavailable. Other sections may still be useful.";
    store.set(cacheKey, { description: reference.description, etymology: aiResult.status === "fulfilled" ? ai.text : "", sources: uniqueSources, savedAt: Date.now() });
  }
  function closeDictionary() { $("dictionary-dialog").hidden = true; }
  $("dictionary-close").addEventListener("click", closeDictionary);
  $("dictionary-dialog").addEventListener("click", e => { if (e.target === $("dictionary-dialog")) closeDictionary(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("dictionary-dialog").hidden) closeDictionary(); });

  function refreshHelperStyles() {
    helperDocs.forEach((doc) => {
      applyHelperStyle(doc);
      clearHelperDoc(doc);
    });
  }
  function setHelperEnabled(on) {
    helperEnabled = !!on;
    store.set("helperEnabled", helperEnabled);
    updateHelperButton();
    if (!helperEnabled) helperDocs.forEach(clearHelperDoc);
    else {
      if (mode === "pdf") { helperDocs.add(document); applyHelperStyle(document); }
      else if (rendition) rendition.getContents().forEach((c) => attachReadingHelper(c.document));
    }
  }
  $("helper-toggle").addEventListener("click", () => setHelperEnabled(!helperEnabled));
  $("pdfview").addEventListener("mousemove", (e) => {
    if (!helperEnabled || mode !== "pdf") return;
    const target = e.target;
    if (!target.closest || !target.closest(".textLayer")) {
      clearHelperDoc(document);
      return;
    }
    helperDocs.add(document);
    applyHelperStyle(document);
    // PDF text layers live in the main document; use the same word-range logic.
    const caret = getCaretAtPoint(document, e.clientX, e.clientY);
    if (!caret || caret.startContainer.nodeType !== Node.TEXT_NODE) { clearHelperDoc(document); return; }
    const word = getHelperWordRange(document, caret);
    if (!word) { clearHelperDoc(document); return; }
    try {
      const range = word.range;
      const HighlightClass = window.Highlight;
      if (!HighlightClass || !CSS.highlights) { clearHelperDoc(document); return; }
      applyHelperStyle(document);
      CSS.highlights.set(helperHighlightName, new HighlightClass(range));
    } catch { clearHelperDoc(document); }
  }, { passive: true });
  $("pdfview").addEventListener("click", (e) => {
    if (!helperEnabled || mode !== "pdf" || !e.target.closest(".textLayer")) return;
    const caret = getCaretAtPoint(document, e.clientX, e.clientY);
    const word = caret && getHelperWordRange(document, caret);
    if (word) lookupDictionary(word.range.toString(), word.context);
  });

  /* ---------- Panels ---------- */
  function hidePanels() { ["toc", "settings", "notes"].forEach((p) => ($(p).hidden = true)); }
  function togglePanel(id) {
    const show = $(id).hidden;
    hidePanels();
    $(id).hidden = !show;
    if (id === "notes" && show) renderNotes();
  }

  /* ---------- Bookmarks ---------- */
  function bookmarkOnPage() {
    if (mode === "pdf") return bookmarks.filter((b) => b.page === pdfPage);
    const loc = rendition && rendition.currentLocation();
    if (!loc || !loc.start) return [];
    const c = new ePub.CFI();
    return bookmarks.filter((b) => {
      try { return c.compare(b.cfi, loc.start.cfi) >= 0 && c.compare(b.cfi, loc.end.cfi) <= 0; }
      catch { return b.cfi === loc.start.cfi; }
    });
  }
  function updateBmStar() {
    const on = bookmarkOnPage().length > 0;
    $("bm-btn").textContent = on ? "★" : "☆";
    $("bm-btn").classList.toggle("on", on);
  }
  function toggleBookmark() {
    if (!mode) return;
    const here = bookmarkOnPage();
    if (here.length) {
      bookmarks = bookmarks.filter((b) => !here.includes(b));
      toast("Bookmark removed");
    } else if (mode === "pdf") {
      bookmarks.push({
        id: newId("b"), page: pdfPage,
        label: pdfChapterOf(pdfPage) || `Page ${pdfPage}`,
        pct: Math.round((pdfPage / pdfNum) * 100), added: Date.now(),
      });
      toast("Bookmarked");
    } else {
      const loc = rendition.currentLocation();
      if (!loc || !loc.start) return;
      bookmarks.push({
        id: newId("b"), cfi: loc.start.cfi,
        label: chapterOf(loc.start.href) || "Bookmark",
        pct: pctAt(loc.start.cfi), added: Date.now(),
      });
      toast("Bookmarked");
    }
    saveBookmarks(); updateBmStar(); renderNotes();
  }

  /* ---------- Highlights & notes ---------- */
  function drawAnn(a) {
    rendition.annotations.highlight(
      a.cfiRange, { id: a.id }, () => openNote(a.id), "hl",
      { fill: a.color, "fill-opacity": "0.35", "mix-blend-mode": "multiply" }
    );
  }
  function hideSelbar() { $("selbar").hidden = true; pendingSel = null; }

  function createAnn(color, thenNote) {
    if (!pendingSel) return;
    let a;
    if (pendingSel.pdf) {
      const { page, rects, text } = pendingSel;
      a = {
        id: newId("a"), page, rects, text, color, note: "",
        chapter: pdfChapterOf(page), pct: Math.round((page / pdfNum) * 100), added: Date.now(),
      };
      anns.push(a); saveAnns(); drawPdfHighlights();
      try { window.getSelection().removeAllRanges(); } catch {}
    } else {
      if (!rendition) return;
      const { cfiRange, contents } = pendingSel;
      let text = "";
      try { text = rendition.getRange(cfiRange).toString().trim().replace(/\s+/g, " "); } catch {}
      const loc = rendition.currentLocation();
      a = {
        id: newId("a"), cfiRange, text, color, note: "",
        chapter: chapterOf(loc && loc.start && loc.start.href),
        pct: loc && loc.start ? pctAt(loc.start.cfi) : null,
        added: Date.now(),
      };
      anns.push(a); saveAnns(); drawAnn(a);
      try { contents.window.getSelection().removeAllRanges(); } catch {}
    }
    hideSelbar(); renderNotes();
    if (thenNote) openNote(a.id);
  }

  function openNote(id) {
    const a = anns.find((x) => x.id === id);
    if (!a) return;
    editingId = id;
    $("modal-quote").textContent = a.text;
    $("modal-text").value = a.note || "";
    $("modal").hidden = false;
    $("modal-text").focus();
  }
  function closeNote() { $("modal").hidden = true; editingId = null; }
  function removeAnn(id) {
    const a = anns.find((x) => x.id === id);
    if (!a) return;
    if (a.cfiRange) { try { rendition.annotations.remove(a.cfiRange, "highlight"); } catch {} }
    anns = anns.filter((x) => x.id !== id);
    saveAnns(); renderNotes();
    if (mode === "pdf") drawPdfHighlights();
  }

  /* ---------- Bookmarks / highlights panel ---------- */
  const sortKey = (x) => x.page ?? x.pct ?? 0;
  const posText = (x) => (x.page ? `p. ${x.page}` : x.pct != null ? x.pct + "%" : "");

  function renderNotes() {
    const list = $("notes-list");
    if (!list) return;
    list.innerHTML = "";
    $("tab-bm").classList.toggle("active", notesTab === "bm");
    $("tab-hl").classList.toggle("active", notesTab === "hl");

    const go = (item) => {
      if (mode === "pdf") pdfGo(item.page);
      else if (rendition) rendition.display(item.cfi || item.cfiRange);
      $("notes").hidden = true;
    };
    const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const when = (t) => new Date(t).toLocaleDateString();

    if (notesTab === "bm") {
      if (!bookmarks.length) list.appendChild(mk("div", "empty", "No bookmarks yet. Tap ☆ in the top bar to add one."));
      [...bookmarks].sort((a, b) => sortKey(a) - sortKey(b)).forEach((b) => {
        const row = mk("div", "item");
        const body = mk("div", "body");
        body.appendChild(mk("div", "quote", b.label));
        body.appendChild(mk("div", "meta", `${posText(b) ? posText(b) + " · " : ""}${when(b.added)}`));
        const x = mk("button", "x", "×"); x.title = "Delete";
        x.addEventListener("click", (e) => { e.stopPropagation(); bookmarks = bookmarks.filter((y) => y.id !== b.id); saveBookmarks(); updateBmStar(); renderNotes(); });
        row.append(body, x);
        row.addEventListener("click", () => go(b));
        list.appendChild(row);
      });
    } else {
      if (!anns.length) list.appendChild(mk("div", "empty", "No highlights yet. Select text to highlight it or add a note."));
      [...anns].sort((a, b) => sortKey(a) - sortKey(b)).forEach((a) => {
        const row = mk("div", "item");
        const dot = mk("span", "dot"); dot.style.background = a.color;
        const body = mk("div", "body");
        body.appendChild(mk("div", "meta", [a.chapter, posText(a)].filter(Boolean).join(" · ")));
        body.appendChild(mk("div", "quote", a.text.length > 180 ? a.text.slice(0, 180) + "…" : a.text));
        if (a.note) body.appendChild(mk("div", "note", a.note));
        const edit = mk("button", "x", "✎"); edit.title = "Edit note";
        edit.addEventListener("click", (e) => { e.stopPropagation(); openNote(a.id); });
        const x = mk("button", "x", "×"); x.title = "Delete";
        x.addEventListener("click", (e) => { e.stopPropagation(); removeAnn(a.id); });
        row.append(dot, body, edit, x);
        row.addEventListener("click", () => go(a));
        list.appendChild(row);
      });
    }
  }

  function exportNotes() {
    if (!current) return;
    const lines = [`# ${current.title}`, current.author ? `*${current.author}*` : "", ""];
    if (bookmarks.length) {
      lines.push("## Bookmarks", "");
      [...bookmarks].sort((a, b) => sortKey(a) - sortKey(b))
        .forEach((b) => lines.push(`- ${b.label}${posText(b) ? ` (${posText(b)})` : ""}`));
      lines.push("");
    }
    if (anns.length) {
      lines.push("## Highlights & notes", "");
      [...anns].sort((a, b) => sortKey(a) - sortKey(b)).forEach((a) => {
        lines.push(`> ${a.text}`);
        lines.push([a.chapter, posText(a) ? `(${posText(a)})` : ""].filter(Boolean).join(" "));
        if (a.note) lines.push("", `**Note:** ${a.note}`);
        lines.push("");
      });
    }
    if (!bookmarks.length && !anns.length) { toast("Nothing to export yet"); return; }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = current.title.replace(/[\\/:*?"<>|]+/g, "_") + "-notes.md";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------- Find in book (Ctrl+F) ---------- */
  let searchResults = [];
  function openSearch() {
    if (!mode || $("reader").hidden) return;
    $("search-dialog").hidden = false;
    $("search-status").textContent = "Search the text of this book.";
    $("search-input").value = "";
    $("search-results").innerHTML = "";
    setTimeout(() => $("search-input").focus(), 0);
  }
  function closeSearch() {
    $("search-dialog").hidden = true;
    $("search-input").blur();
  }
  async function runSearch() {
    const query = $("search-input").value.trim();
    const status = $("search-status"), list = $("search-results");
    list.innerHTML = "";
    searchResults = [];
    if (!query) { status.textContent = "Type a word or phrase to search."; return; }
    status.textContent = "Searching…";
    try {
      if (mode === "epub" && book) {
        const found = await book.find(query);
        searchResults = (found || []).map((r) => ({
          label: r.excerpt || query, detail: r.cfi ? "Match in book" : "Match",
          go: () => rendition.display(r.cfi)
        })).filter((r) => r.go);
      } else if (mode === "pdf" && pdf) {
        const doc = pdf;
        for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
          if (doc !== pdf) return;
          const page = await doc.getPage(pageNo);
          const text = await page.getTextContent();
          const words = text.items.map((x) => x.str || "").join(" ");
          const lower = words.toLocaleLowerCase();
          let at = 0;
          while ((at = lower.indexOf(query.toLocaleLowerCase(), at)) !== -1) {
            const start = Math.max(0, at - 65), end = Math.min(words.length, at + query.length + 85);
            const excerpt = (start ? "…" : "") + words.slice(start, end).replace(/\s+/g, " ") + (end < words.length ? "…" : "");
            searchResults.push({ label: excerpt, detail: "Page " + pageNo, go: () => pdfGo(pageNo) });
            at += Math.max(1, query.length);
          }
        }
      }
      status.textContent = searchResults.length
        ? searchResults.length + " result" + (searchResults.length === 1 ? "" : "s") + " found."
        : "No matches found.";
      searchResults.slice(0, 200).forEach((result, i) => {
        const button = document.createElement("button");
        button.className = "search-result";
        const small = document.createElement("small"); small.textContent = result.detail;
        const span = document.createElement("span"); span.textContent = result.label;
        button.append(small, span);
        button.addEventListener("click", async () => {
          try { await result.go(); closeSearch(); } catch (e) { console.warn("Search navigation failed", e); }
        });
        list.appendChild(button);
      });
      if (searchResults.length > 200) status.textContent += " Showing the first 200.";
    } catch (error) {
      console.error("Book search failed", error);
      status.textContent = "Search couldn't complete. Try another word or phrase.";
    }
  }
  $("search-close").addEventListener("click", closeSearch);
  $("search-submit").addEventListener("click", runSearch);
  $("search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runSearch(); }
    if (e.key === "Escape") closeSearch();
  });
  $("search-dialog").addEventListener("click", (e) => {
    if (e.target === $("search-dialog")) closeSearch();
  });

  /* ---------- Navigation & keys ---------- */
  function goNext() { if (mode === "pdf") pdfGo(pdfPage + 1); else if (rendition) rendition.next(); }
  function goPrev() { if (mode === "pdf") pdfGo(pdfPage - 1); else if (rendition) rendition.prev(); }

  function handleKey(e) {
    if (e.key === "Escape" && !$("search-dialog").hidden) { closeSearch(); return; }
    if (!mode || $("reader").hidden || !$("modal").hidden || !$("search-dialog").hidden) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === "ArrowRight" || e.key === "PageDown") goNext();
    else if (e.key === "ArrowLeft" || e.key === "PageUp") goPrev();
  }

  /* ---------- Wire up UI ---------- */
  $("file-input").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
  $("back").addEventListener("click", () => {
    closeBook();
    $("reader").hidden = true; $("library").hidden = false;
    renderLibrary();
  });
  $("prev").addEventListener("click", goPrev);
  $("next").addEventListener("click", goNext);
  $("toc-btn").addEventListener("click", () => togglePanel("toc"));
  $("settings-btn").addEventListener("click", () => togglePanel("settings"));
  $("notes-btn").addEventListener("click", () => togglePanel("notes"));
  $("bm-btn").addEventListener("click", toggleBookmark);
  $("tab-bm").addEventListener("click", () => { notesTab = "bm"; renderNotes(); });
  $("tab-hl").addEventListener("click", () => { notesTab = "hl"; renderNotes(); });
  $("export-btn").addEventListener("click", exportNotes);

  // keep the text selection alive while pressing the highlight bar's buttons
  $("selbar").addEventListener("mousedown", (e) => e.preventDefault());
  document.querySelectorAll("#selbar .swatch").forEach((s) =>
    s.addEventListener("click", () => createAnn(s.dataset.color, false)));
  $("sel-note").addEventListener("click", () => createAnn("#cd6ceb", true));
  $("sel-cancel").addEventListener("click", () => {
    try {
      if (pendingSel && pendingSel.pdf) window.getSelection().removeAllRanges();
      else if (pendingSel) pendingSel.contents.window.getSelection().removeAllRanges();
    } catch {}
    hideSelbar();
  });

  $("modal-save").addEventListener("click", () => {
    const a = anns.find((x) => x.id === editingId);
    if (a) { a.note = $("modal-text").value.trim(); saveAnns(); renderNotes(); }
    closeNote();
  });
  $("modal-cancel").addEventListener("click", closeNote);
  $("modal-delete").addEventListener("click", () => { if (editingId) removeAnn(editingId); closeNote(); });
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeNote(); });

  $("pdfview").addEventListener("scroll", () => {
    if (mode !== "pdf" || !pdf) return;
    clearTimeout(pdfScrollTimer);
    pdfScrollTimer = setTimeout(() => {
      const viewRect = $("pdfview").getBoundingClientRect();
      const center = viewRect.top + viewRect.height * 0.35;
      let best = pdfPage, distance = Infinity;
      pdfPageNodes.forEach((node, n) => {
        const r = node.getBoundingClientRect();
        const d = center < r.top ? r.top - center : center > r.bottom ? center - r.bottom : 0;
        if (d < distance) { distance = d; best = n; }
      });
      if (best !== pdfPage) { pdfPage = best; updatePdfUI(); clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { if (current) store.set("pos:" + current.id, { page: pdfPage, pct: Math.round(pdfPage / pdfNum * 100) }); }, 400); }
    }, 80);
  }, { passive: true });

  $("progress").addEventListener("input", (e) => {
    if (mode === "pdf") $("progress-text").textContent = `${e.target.value} / ${pdfNum}`;
  });
  $("progress").addEventListener("change", (e) => {
    if (mode === "pdf") pdfGo(+e.target.value);
    else if (book && book.locations.length()) rendition.display(book.locations.cfiFromPercentage(e.target.value / 100));
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && mode && !$("reader").hidden) {
      e.preventDefault();
      e.stopPropagation();
      openSearch();
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

  if (typeof pdfjsLib !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc = window.__pdfWorkerSrc || "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  initSettingsUI();
  applyTheme();
  renderLibrary();
})();
