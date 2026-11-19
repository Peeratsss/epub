(() => {
  const $ = (id) => document.getElementById(id);

  /* ---------- IndexedDB: 'meta' (small) + 'files' (the book bytes) ---------- */
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("epub-reader", 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" });
        if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "id" });
        if (!db.objectStoreNames.contains("pdfocr")) db.createObjectStore("pdfocr", { keyPath: "id" });
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
  const putMeta = (meta) => dbRun(["meta"], "readwrite", (m) => { m.put(meta); });
  const getFile = (id) => dbRun(["files"], "readonly", (f) => req(f.get(id)));
  const saveBook = (meta, data) =>
    dbRun(["meta", "files"], "readwrite", (m, f) => { m.put(meta); f.put({ id: meta.id, data }); });
  const getPdfOcr = (bookId, pageNo) =>
    dbRun(["pdfocr"], "readonly", (s) => req(s.get(bookId + ":v2:" + pageNo)));
  const putPdfOcr = (bookId, pageNo, value) =>
    dbRun(["pdfocr"], "readwrite", (s) => { s.put({ ...value, id: bookId + ":v2:" + pageNo }); });
  const deleteBook = (id) =>
    dbRun(["meta", "files", "pdfocr"], "readwrite", (m, f, o) => {
      m.delete(id); f.delete(id);
      const all = o.getAll();
      all.onsuccess = () => all.result.filter((entry) => entry.id.startsWith(id + ":")).forEach((entry) => o.delete(entry.id));
    });

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
  let dictionaryEnabled = store.get("dictionaryEnabled", true);
  let helperMode = store.get("helperMode", "underline");
  let helperLeftWords = Number(store.get("helperLeftWords", 0));
  let helperRightWords = Number(store.get("helperRightWords", 0));
  if (!Number.isInteger(helperLeftWords) || helperLeftWords < 0 || helperLeftWords > 3) helperLeftWords = 0;
  if (!Number.isInteger(helperRightWords) || helperRightWords < 0 || helperRightWords > 3) helperRightWords = 0;
  let helperUnderlineColor = store.get("helperUnderlineColor", "#cd6ceb");
  let helperBgColor = store.get("helperBgColor", "#fff09a");
  let helperTextColor = store.get("helperTextColor", "#292238");
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
  let pdfOcrNoticeShown = false;
  let tocFlat = [];
  let bookmarks = [], anns = [];
  let pendingSel = null, editingId = null, notesTab = "bm";

  const saveBookmarks = () => store.set("bm:" + current.id, bookmarks);
  const saveAnns = () => store.set("an:" + current.id, anns);

  const READING_STATS_KEY = "readingStats";
  let readingStats = store.get(READING_STATS_KEY, { version: 1, books: {} });
  if (!readingStats || typeof readingStats !== "object" || !readingStats.books || typeof readingStats.books !== "object") {
    readingStats = { version: 1, books: {} };
  }
  let statsSession = null, statsTimer = null;
  let pdfReferenceMap = new Map(), pdfAuthorYearMap = new Map();

  const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);


  /* ---------- Portable annotation backup ---------- */
  async function exportAnnotationBackup() {
    const libraryBooks = await getAllMeta();
    const books = libraryBooks.map((meta) => ({
      id: meta.id,
      title: meta.title || "",
      author: meta.author || "",
      type: meta.type || "",
      bookmarks: store.get("bm:" + meta.id, []),
      annotations: store.get("an:" + meta.id, []),
    })).filter((item) => item.bookmarks.length || item.annotations.length);
    if (!books.length) { toast("There are no bookmarks or highlights to back up yet."); return; }
    const payload = {
      format: "papertrail-annotations",
      version: 1,
      exportedAt: new Date().toISOString(),
      books,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "reader-annotations-backup-" + statsDateKey() + ".json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Annotation backup exported for " + books.length + " book(s).");
  }

  function mergeBackupItems(existing, incoming) {
    const merged = new Map();
    (Array.isArray(existing) ? existing : []).forEach((item, index) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        merged.set(item.id != null ? String(item.id) : "existing-" + index, item);
      }
    });
    (Array.isArray(incoming) ? incoming : []).forEach((item, index) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        merged.set(item.id != null ? String(item.id) : "backup-" + index, item);
      }
    });
    return Array.from(merged.values());
  }

  async function importAnnotationBackup(file) {
    try {
      if (!file || file.size > 25 * 1024 * 1024) throw new Error("The backup file is missing or larger than 25 MB.");
      const payload = JSON.parse(await file.text());
      if (!payload || payload.format !== "papertrail-annotations" || payload.version !== 1 || !Array.isArray(payload.books)) {
        throw new Error("This is not a supported reader annotation backup.");
      }
      const libraryBooks = await getAllMeta();
      let restored = 0, unmatched = 0;
      const normalizeTitle = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
      for (const item of payload.books) {
        if (!item || typeof item.id !== "string" || !item.id || item.id.length > 500) { unmatched++; continue; }
        const exact = libraryBooks.find((b) => b.id === item.id);
        const titleMatches = exact ? [] : libraryBooks.filter((b) =>
          b.type === item.type && normalizeTitle(b.title) === normalizeTitle(item.title)
        );
        const targetId = exact ? exact.id : (titleMatches.length === 1 ? titleMatches[0].id : item.id);
        const oldBookmarks = store.get("bm:" + targetId, []);
        const oldAnnotations = store.get("an:" + targetId, []);
        const nextBookmarks = mergeBackupItems(oldBookmarks, item.bookmarks);
        const nextAnnotations = mergeBackupItems(oldAnnotations, item.annotations);
        store.set("bm:" + targetId, nextBookmarks);
        store.set("an:" + targetId, nextAnnotations);
        if (nextBookmarks.length || nextAnnotations.length) restored++;
        else unmatched++;
      }
      toast("Restored annotations for " + restored + " book(s). Existing items were merged, not erased.");
      renderLibrary();
    } catch (error) {
      console.error("Annotation backup import failed:", error);
      toast(error.message || "Could not restore this backup.");
    }
  }

  /* ---------- Reading statistics ---------- */
  function statsDateKey(timestamp) {
    const d = new Date(timestamp == null ? Date.now() : timestamp);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function statsBook(meta) {
    if (!meta || !meta.id) return null;
    if (!readingStats.books[meta.id]) {
      readingStats.books[meta.id] = { title: meta.title || "Untitled", type: meta.type || "", totalSeconds: 0, seenPages: [], daily: {}, lastRead: 0 };
    }
    const entry = readingStats.books[meta.id];
    if (!Array.isArray(entry.seenPages)) entry.seenPages = [];
    if (!entry.daily || typeof entry.daily !== "object") entry.daily = {};
    entry.title = meta.title || entry.title || "Untitled";
    entry.type = meta.type || entry.type || "";
    return entry;
  }

  function statsDaily(entry, date) {
    const key = date || statsDateKey();
    if (!entry.daily[key]) entry.daily[key] = { seconds: 0, pages: [] };
    if (!Array.isArray(entry.daily[key].pages)) entry.daily[key].pages = [];
    return entry.daily[key];
  }

  function saveReadingStats() {
    store.set(READING_STATS_KEY, readingStats);
  }

  function statsPageKey() {
    if (mode === "pdf") return "pdf:" + pdfPage;
    if (mode === "epub" && rendition) {
      const loc = rendition.currentLocation();
      if (loc && loc.start) return "epub:" + (loc.start.cfi || "");
    }
    return "";
  }

  function recordStatsPage(key) {
    if (!statsSession || !current || statsSession.bookId !== current.id || !key) return;
    const entry = statsBook(current);
    const daily = statsDaily(entry);
    if (!entry.seenPages.includes(key)) entry.seenPages.push(key);
    if (!daily.pages.includes(key)) daily.pages.push(key);
    entry.lastRead = Date.now();
    saveReadingStats();
  }

  const STATS_IDLE_TIMEOUT = 2 * 60 * 1000;

  function markStatsActivity() {
    if (!statsSession || !current || statsSession.bookId !== current.id || document.hidden) return;
    const now = Date.now();
    // First account for the time before this interaction, using the previous
    // activity timestamp. Then restart the active window at this interaction.
    flushStatsTime(false);
    statsSession.lastActivity = now;
    statsSession.lastTick = now;
    statsSession.active = true;
  }

  function attachStatsActivity(target) {
    if (!target || target.__readerStatsActivityAttached) return;
    try { target.__readerStatsActivityAttached = true; } catch {}
    const onActivity = () => markStatsActivity();
    ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"].forEach((eventName) => {
      target.addEventListener(eventName, onActivity, { passive: true, capture: true });
    });
  }

  function flushStatsTime(force) {
    if (!statsSession || !statsSession.active || !current || statsSession.bookId !== current.id) return;
    const now = Date.now();
    const idleDeadline = statsSession.lastActivity + STATS_IDLE_TIMEOUT;
    const countUntil = Math.min(now, idleDeadline);
    const elapsed = Math.max(0, (countUntil - statsSession.lastTick) / 1000);
    if (elapsed >= 1) {
      const entry = statsBook(current);
      entry.totalSeconds = (Number(entry.totalSeconds) || 0) + elapsed;
      const daily = statsDaily(entry);
      daily.seconds = (Number(daily.seconds) || 0) + elapsed;
      entry.lastRead = countUntil;
      saveReadingStats();
    }
    statsSession.lastTick = now;
    if (now >= idleDeadline) statsSession.active = false;
  }

  function startStatsSession() {
    stopStatsSession();
    if (!current || !mode) return;
    const now = Date.now();
    statsSession = { bookId: current.id, lastTick: now, lastActivity: now, active: !document.hidden };
    const entry = statsBook(current);
    entry.lastRead = now;
    saveReadingStats();
    recordStatsPage(statsPageKey());
    statsTimer = setInterval(() => flushStatsTime(false), 5000);
  }

  function stopStatsSession() {
    flushStatsTime(true);
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
    statsSession = null;
  }

  document.addEventListener("visibilitychange", () => {
    if (!statsSession) return;
    if (document.hidden) {
      flushStatsTime(true);
      statsSession.active = false;
    } else {
      const now = Date.now();
      statsSession.active = true;
      statsSession.lastTick = now;
      statsSession.lastActivity = now;
    }
  });
  window.addEventListener("pagehide", () => {
    flushStatsTime(true);
    if (statsSession) statsSession.active = false;
  });

  // Activity from the main page (PDF pages, controls, scrolling) resets AFK time.
  attachStatsActivity(document);

  function formatReadingDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (hours) return hours + "h " + minutes + "m";
    if (minutes) return minutes + "m";
    return total ? total + "s" : "0m";
  }


  function renderLibraryStats() {
    const entries = Object.values(readingStats.books || {});
    const today = statsDateKey();
    const totalSeconds = entries.reduce((sum, item) => sum + (Number(item.totalSeconds) || 0), 0);
    const totalPages = entries.reduce((sum, item) => sum + (Array.isArray(item.seenPages) ? item.seenPages.length : 0), 0);
    const todaySeconds = entries.reduce((sum, item) => sum + (Number(item.daily && item.daily[today] && item.daily[today].seconds) || 0), 0);
    const todayPages = entries.reduce((sum, item) => sum + (item.daily && item.daily[today] && Array.isArray(item.daily[today].pages) ? item.daily[today].pages.length : 0), 0);

    $("library-stats-total-time").textContent = formatReadingDuration(totalSeconds);
    $("library-stats-total-pages").textContent = String(totalPages);
    $("library-stats-today-time").textContent = formatReadingDuration(todaySeconds);
    $("library-stats-today-pages").textContent = String(todayPages);

    const daily = [];
    for (let offset = 6; offset >= 0; offset--) {
      const date = new Date();
      date.setDate(date.getDate() - offset);
      const key = statsDateKey(date.getTime());
      const seconds = entries.reduce((sum, item) => sum + (Number(item.daily && item.daily[key] && item.daily[key].seconds) || 0), 0);
      const pages = entries.reduce((sum, item) => sum + (item.daily && item.daily[key] && Array.isArray(item.daily[key].pages) ? item.daily[key].pages.length : 0), 0);
      daily.push({ date, seconds, pages });
    }
    const maxSeconds = Math.max(1, ...daily.map((day) => day.seconds));
    const dailyList = $("library-stats-daily");
    dailyList.innerHTML = "";
    daily.forEach((day, index) => {
      const item = document.createElement("div");
      item.className = "library-stats-day";
      const barWrap = document.createElement("div");
      barWrap.className = "library-stats-bar-wrap";
      const bar = document.createElement("i");
      bar.style.height = Math.max(day.seconds ? 8 : 3, Math.round(day.seconds / maxSeconds * 100)) + "%";
      barWrap.appendChild(bar);
      const value = document.createElement("strong");
      value.textContent = day.seconds ? formatReadingDuration(day.seconds) : "—";
      const label = document.createElement("span");
      label.textContent = index === 6 ? "Today" : day.date.toLocaleDateString(undefined, { weekday: "short" });
      item.title = day.date.toLocaleDateString() + ": " + formatReadingDuration(day.seconds) + ", " + day.pages + " page(s)";
      item.append(barWrap, value, label);
      dailyList.appendChild(item);
    });
  }

  function renderReadingStats() {
    const entries = Object.values(readingStats.books || {});
    const today = statsDateKey();
    const totalSeconds = entries.reduce((sum, item) => sum + (Number(item.totalSeconds) || 0), 0);
    const totalPages = entries.reduce((sum, item) => sum + (Array.isArray(item.seenPages) ? item.seenPages.length : 0), 0);
    const todaySeconds = entries.reduce((sum, item) => sum + (Number(item.daily && item.daily[today] && item.daily[today].seconds) || 0), 0);
    const todayPages = entries.reduce((sum, item) => sum + (item.daily && item.daily[today] && Array.isArray(item.daily[today].pages) ? item.daily[today].pages.length : 0), 0);
    $("stats-total-time").textContent = formatReadingDuration(totalSeconds);
    $("stats-total-pages").textContent = String(totalPages);
    $("stats-today-time").textContent = formatReadingDuration(todaySeconds);
    $("stats-today-pages").textContent = String(todayPages);

    const dailyList = $("stats-daily");
    dailyList.innerHTML = "";
    const make = (tag, cls, value) => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (value != null) node.textContent = value;
      return node;
    };
    for (let offset = 6; offset >= 0; offset--) {
      const d = new Date();
      d.setDate(d.getDate() - offset);
      const key = statsDateKey(d.getTime());
      const daySeconds = entries.reduce((sum, item) => sum + (Number(item.daily && item.daily[key] && item.daily[key].seconds) || 0), 0);
      const dayPages = entries.reduce((sum, item) => sum + (item.daily && item.daily[key] && Array.isArray(item.daily[key].pages) ? item.daily[key].pages.length : 0), 0);
      const row = make("div", "stats-row");
      row.append(make("span", "stats-date", d.toLocaleDateString(undefined, { month: "short", day: "numeric" })));
      row.append(make("strong", "stats-value", formatReadingDuration(daySeconds) + " · " + dayPages + " page(s)"));
      dailyList.appendChild(row);
    }

    const bookList = $("stats-books");
    bookList.innerHTML = "";
    entries.sort((a, b) => (Number(b.lastRead) || 0) - (Number(a.lastRead) || 0));
    if (!entries.length) bookList.appendChild(make("div", "empty", "Your reading activity will appear here as you use the reader."));
    entries.forEach((item) => {
      const row = make("div", "stats-book-row");
      const info = make("div", "stats-book-info");
      info.append(make("strong", "", item.title || "Untitled"));
      info.append(make("span", "", (item.type === "pdf" ? "PDF" : "EPUB") + " · " + (Array.isArray(item.seenPages) ? item.seenPages.length : 0) + " pages read"));
      row.append(info, make("strong", "stats-book-time", formatReadingDuration(item.totalSeconds)));
      bookList.appendChild(row);
    });
  }

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
    $("helper-left-words").value = helperLeftWords;
    $("helper-right-words").value = helperRightWords;
    updateHelperRangeLabels();
    $("helper-underline-color").value = helperUnderlineColor;
    $("helper-bg-color").value = helperBgColor;
    $("helper-text-color").value = helperTextColor;
    updateHelperControls();
    updateHelperButton();
    $("helper-left-words").addEventListener("input", (e) => {
      helperLeftWords = Number(e.target.value);
      store.set("helperLeftWords", helperLeftWords);
      updateHelperRangeLabels();
      helperDocs.forEach(clearHelperDoc);
    });
    $("helper-right-words").addEventListener("input", (e) => {
      helperRightWords = Number(e.target.value);
      store.set("helperRightWords", helperRightWords);
      updateHelperRangeLabels();
      helperDocs.forEach(clearHelperDoc);
    });
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
    const isPdf = mode === "pdf", isArticle = mode === "article";
    ["font-field", "size-field", "lh-field"].forEach((id) => ($(id).hidden = isPdf));
    $("zoom-field").hidden = !isPdf;
    $("book-theme-field").hidden = isPdf || isArticle;
    $("epub-sheet").hidden = isPdf || isArticle;
    $("pdfview").hidden = !isPdf;
    $("article-view").hidden = !isArticle;
    $("prev").hidden = isArticle; $("next").hidden = isArticle;
    $("article-export").hidden = !isArticle;
    ["bm-btn","notes-btn","toc-btn","settings-btn","helper-toggle","dictionary-toggle"].forEach(id => { $(id).hidden = isArticle; });
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

  /* ---------- URL article import ---------- */
  function cleanArticleHtml(rawHtml, pageUrl, assetMap, htmlPath) {
    const parsed = new DOMParser().parseFromString(rawHtml, "text/html");
    const junkSelectors = ["script","style","noscript","iframe","svg","form","button","input","select","textarea","nav","header","footer","aside","[role=navigation]","[role=banner]","[role=contentinfo]","[aria-label*=advert i]","[class*=advert i]","[id*=advert i]","[class*=promo i]","[class*=banner i]","[class*=social i]","[class*=share i]","[class*=newsletter i]","[class*=subscribe i]","[class*=related i]","[class*=recommend i]","[class*=recent i]","[class*=cookie i]","[class*=popup i]","[class*=modal i]","[class*=breadcrumb i]"];
    junkSelectors.forEach(sel => { try { parsed.querySelectorAll(sel).forEach(n => n.remove()); } catch {} });
    let main=null, score=0;
    ["article","main","[role=main]","[itemprop=articleBody]"].forEach(sel => parsed.querySelectorAll(sel).forEach(node => {
      const len=(node.innerText||"").trim().length; if(len>score && len>600){score=len;main=node;}
    }));
    if(!main) main=parsed.body;
    const article=main.cloneNode(true);
    article.querySelectorAll("a").forEach(a=>{try{const href=a.getAttribute("href")||"";const u=pageUrl?new URL(href,pageUrl):new URL(href);if(!/^https?:$/.test(u.protocol)){a.removeAttribute("href");return;}a.href=u.href;a.target="_blank";a.rel="noopener noreferrer";}catch{a.removeAttribute("href");}});
    article.querySelectorAll("img").forEach(img=>{
      const src=img.getAttribute("src")||img.getAttribute("data-src")||img.getAttribute("data-original")||img.getAttribute("data-lazy-src");
      let resolved=false;
      if(src && assetMap && htmlPath && !/^(https?:|data:|blob:)/i.test(src)){
        try{
          const dir=htmlPath.split("/").slice(0,-1).join("/");
          const path=decodeURIComponent(new URL(src,"https://local.invalid/"+dir+"/").pathname).replace(/^\//,"");
          const embedded=assetMap.get(path);
          if(embedded){img.setAttribute("src",embedded);resolved=true;}
        }catch{}
      }
      if(src && !resolved)try{const u=pageUrl?new URL(src,pageUrl):new URL(src);if(/^https?:$/.test(u.protocol)){img.src=u.href;resolved=true;}}catch{}
      if(!resolved)img.removeAttribute("src");
      img.removeAttribute("srcset");img.removeAttribute("data-src");img.removeAttribute("data-original");img.removeAttribute("data-lazy-src");img.removeAttribute("loading");
    });
    article.querySelectorAll("video,audio,source,canvas,object,embed").forEach(n=>n.remove());
    article.querySelectorAll("*").forEach(el=>{[...el.attributes].forEach(attr=>{if(/^on/i.test(attr.name)||["style","class","id"].includes(attr.name))el.removeAttribute(attr.name);});});
    const title=(parsed.querySelector('meta[property="og:title"]')?.content||parsed.querySelector("h1")?.innerText||parsed.title||"Web article").trim().replace(/[<>&]/g,"");
    const author=parsed.querySelector('meta[name="author"]')?.content||parsed.querySelector('[rel=author]')?.innerText||"";
    const date=parsed.querySelector('meta[property="article:published_time"]')?.content||parsed.querySelector("time")?.dateTime||"";
    return {title,author:author.trim(),date,content:article.innerHTML,source:pageUrl};
  }
  async function saveImportedArticle(article, fallbackAuthor) {
    if((article.content||"").replace(/<[^>]+>/g," ").trim().length<150) throw Error("Not enough article content was found.");
    const id="article-"+Date.now().toString(36);
    const host=article.source?new URL(article.source).hostname:"Imported HTML";
    await saveBook({id,type:"article",title:article.title,author:article.author||fallbackAuthor||host,source:article.source||"",date:article.date,added:Date.now()},article.content);
    await renderLibrary();
    toast("Cleaned article saved to your Bookshelf.");
  }
  async function importArticleUrl() {
    const raw=prompt("Paste article URL:"); if(!raw)return;
    let url;try{url=new URL(raw.trim());if(!/^https?:$/.test(url.protocol))throw 0;}catch{toast("Please enter a valid http or https URL.");return;}
    toast("Fetching and cleaning article…");
    try{
      const response=await fetch(url.href,{credentials:"omit",redirect:"follow"});
      if(!response.ok)throw Error("HTTP "+response.status);
      const article=cleanArticleHtml(await response.text(),url.href);
      await saveImportedArticle(article,new URL(article.source).hostname);
    }catch(err){console.warn("Article import failed",err);toast("This site blocks URL import (CORS). Try Add HTML and choose a saved webpage file.");}
  }
  async function importArticleHtml(file, selectedFiles) {
    if(!file)return;
    toast("Reading webpage and images…");
    try{
      const allFiles=Array.from(selectedFiles||[file]);
      const relativePath=f=>(f.webkitRelativePath||f.name).split("/").slice(f.webkitRelativePath?1:0).join("/");
      const imageFiles=allFiles.filter(f=>/^image\//i.test(f.type)||/\.(jpe?g|png|gif|webp|svg|avif|bmp)$/i.test(f.name));
      const assetMap=new Map();let embeddedBytes=0;
      for(const imageFile of imageFiles){
        if(imageFile.size>5*1024*1024||embeddedBytes+imageFile.size>20*1024*1024)continue;
        const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(imageFile);});
        assetMap.set(relativePath(imageFile),dataUrl);embeddedBytes+=imageFile.size;
      }
      const raw=await file.text();
      const sourceDoc=new DOMParser().parseFromString(raw,"text/html");
      const candidate=sourceDoc.querySelector("base[href]")?.getAttribute("href")
        ||sourceDoc.querySelector('link[rel="canonical"]')?.getAttribute("href")
        ||sourceDoc.querySelector('meta[property="og:url"]')?.content||"";
      let source="";try{const u=new URL(candidate);if(/^https?:$/.test(u.protocol))source=u.href;}catch{}
      const article=cleanArticleHtml(raw,source,assetMap,relativePath(file));
      article.source=source;
      await saveImportedArticle(article,file.name.replace(/\.html?$/i,"")||"Imported HTML");
    }catch(err){console.warn("HTML article import failed",err);toast("Could not import this webpage. Choose the HTML file inside its Complete folder.");}
  }
  function openArticle(meta,rec){
    mode="article";setModeUI();const host=$("article-view");host.hidden=false;host.innerHTML="";
    const frame=document.createElement("iframe");frame.className="article-frame";frame.setAttribute("sandbox","allow-same-origin allow-popups allow-modals");frame.title=meta.title;
    const title=(meta.title||"Article").replace(/[<>&]/g,"");
    const cssText="body{font-family:Georgia,serif;font-size:"+fontSize+"%;line-height:1.7;max-width:780px;margin:40px auto;padding:24px;color:#24212a;background:#fff}h1,h2,h3,h4{line-height:1.25}img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse;display:block;overflow:auto}td,th{border:1px solid #ccc;padding:6px}a{color:#6b45b1}blockquote{border-left:3px solid #ccc;padding-left:1em;color:#555}.article-source{font:14px system-ui;color:#666;border-bottom:1px solid #ddd;padding-bottom:12px;margin-bottom:24px;overflow-wrap:anywhere}";
    const sourceLine=meta.source?'<br><a href="'+meta.source+'">'+meta.source+'</a>':"";
    frame.srcdoc='<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>'+cssText+'</style></head><body><h1>'+title+'</h1><div class="article-source">'+(meta.author||"")+(meta.date?" · "+meta.date:"")+sourceLine+'</div>'+rec.data+'</body></html>';
    host.appendChild(frame);
  }
  function exportArticlePdf(){if(!current||current.type!=="article")return;const frame=$("article-view").querySelector("iframe");if(!frame||!frame.contentDocument){toast("Article is still loading.");return;}try{frame.contentWindow.focus();frame.contentWindow.print();}catch{toast("Could not open print dialog.");}}
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
        <div class="reading-stats"></div>
        <div class="prog"><i></i></div>
        <div class="pct"></div>
        <button class="rename" title="Edit title" aria-label="Edit title">✎</button>
        <button class="del" title="Remove">×</button>`;
      const cover = card.querySelector(".cover");
      if (b.cover) cover.style.backgroundImage = `url("${b.cover}")`; else cover.textContent = b.title;
      card.querySelector(".name").textContent = b.title;
      card.querySelector(".author").textContent = (b.type === "pdf" ? "PDF" : b.type === "article" ? "ARTICLE" : "EPUB") + (b.author ? " · " + b.author : "");
      const bookStats = readingStats.books[b.id];
      if (bookStats && ((Number(bookStats.totalSeconds) || 0) > 0 || (Array.isArray(bookStats.seenPages) && bookStats.seenPages.length))) {
        card.querySelector(".reading-stats").textContent =
          "Reading · " + formatReadingDuration(bookStats.totalSeconds) + " · " +
          (Array.isArray(bookStats.seenPages) ? bookStats.seenPages.length : 0) + " pages";
      }
      if (pos && pos.pct != null) {
        card.querySelector(".pct").textContent = `${pos.pct}% read`;
        card.style.setProperty("--p", Math.min(100, Math.max(0, pos.pct)) + "%");
      }
      card.addEventListener("click", () => openBook(b));
      card.querySelector(".rename").addEventListener("click", async (e) => {
        e.stopPropagation();
        const nextTitle=prompt("Edit book title:",b.title||"");
        if(nextTitle===null)return;
        const title=nextTitle.trim();
        if(!title){toast("Title cannot be empty.");return;}
        if(title===b.title)return;
        b.title=title;
        await putMeta(b);
        if(readingStats.books[b.id]){readingStats.books[b.id].title=title;store.set(READING_STATS_KEY,readingStats);}
        renderLibrary();
        toast("Title updated.");
      });
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
    renderLibraryStats();
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
    if (meta.type === "article") return openArticle(meta, rec);
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
      attachStatsActivity(contents.document);
    });
    applyTheme();

    anns.forEach(drawAnn);

    const saved = store.get("pos:" + meta.id, null);
    rendition.on("rendered", hideLoading);
    rendition.display(saved && saved.cfi ? saved.cfi : undefined).then(() => {
      if (current === meta) startStatsSession();
    }).catch((err) => {
      // a saved position can become invalid; fall back to the start of the book
      console.warn("display failed, retrying from start", err);
      rendition.display().then(() => { if (current === meta) startStatsSession(); }).catch(openFailed);
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
      recordStatsPage("epub:" + (loc.start.cfi || ""));
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
    stopStatsSession();
    clearTimeout(saveTimer);
    hideLoading();
    pdfToken++;
    try { if (pdfRender) pdfRender.cancel(); } catch {}
    try { if (pdf) pdf.destroy(); } catch {}
    try { if (rendition) rendition.destroy(); if (book) book.destroy(); } catch {}
    rendition = null; book = null; pdf = null; pdfRender = null; pdfNum = 0; pdfPage = 1;
    if (pdfObserver) pdfObserver.disconnect(); pdfObserver = null;
    pdfPageNodes.clear(); pdfRendered.clear(); clearTimeout(pdfScrollTimer);
    pdfReferenceMap = new Map();
    pdfAuthorYearMap = new Map();
    current = null; mode = null; tocFlat = []; bookmarks = []; anns = [];
    if (typeof helperDocs !== "undefined") { helperDocs.forEach(clearHelperDoc); helperDocs.clear(); }
    pendingSel = null;
    $("viewer").innerHTML = "";
    $("pdfpage").innerHTML = "";
    $("article-view").innerHTML = ""; $("article-view").hidden=true;
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

  function renderTOCPanel(items, config) {
    const toc = $("toc");
    toc.innerHTML = "";

    const searchWrap = document.createElement("div");
    searchWrap.className = "toc-search-wrap";
    const search = document.createElement("input");
    search.id = "toc-search-input";
    search.type = "search";
    search.placeholder = "Search chapters…";
    search.autocomplete = "off";
    search.setAttribute("aria-label", "Search table of contents");
    searchWrap.appendChild(search);

    const list = document.createElement("div");
    list.id = "toc-list";
    list.className = "toc-list";

    const empty = document.createElement("div");
    empty.className = "toc-search-empty";
    empty.setAttribute("role", "status");
    empty.setAttribute("aria-live", "polite");

    const hasItems = Array.isArray(items) && items.length > 0;
    if (!hasItems) {
      search.disabled = true;
      empty.textContent = config.emptyLabel || "This book has no table of contents.";
    } else {
      const add = (nodes, depth, parent) => {
        (nodes || []).forEach((item) => {
          const label = String(config.label(item) || "").trim() || "(untitled)";
          const entry = document.createElement("div");
          entry.className = "toc-entry";
          entry.dataset.searchText = label.toLocaleLowerCase();

          const link = document.createElement("a");
          link.href = "#";
          const title = document.createElement("span");
          title.className = "toc-entry-title";
          title.textContent = label;
          link.appendChild(title);
          if (config.pageLabel) {
            const pageLabel = config.pageLabel(item);
            if (pageLabel) {
              const page = document.createElement("span");
              page.className = "toc-page-number";
              page.textContent = pageLabel;
              link.appendChild(page);
            }
          }
          link.style.paddingLeft = 16 + depth * 14 + "px";
          link.addEventListener("click", (event) => {
            event.preventDefault();
            config.onSelect(item);
          });
          entry.appendChild(link);

          const descendants = config.children(item) || [];
          if (descendants.length) {
            const childGroup = document.createElement("div");
            childGroup.className = "toc-children";
            add(descendants, depth + 1, childGroup);
            entry.appendChild(childGroup);
          }
          parent.appendChild(entry);
        });
      };
      add(items, 0, list);
      search.addEventListener("input", () => {
        const query = search.value.trim().toLocaleLowerCase();
        const filterEntries = (container) => {
          let anyVisible = false;
          Array.from(container.children).forEach((entry) => {
            const childGroup = entry.querySelector(":scope > .toc-children");
            const childVisible = childGroup ? filterEntries(childGroup) : false;
            const ownMatch = !query || entry.dataset.searchText.includes(query);
            entry.hidden = !(ownMatch || childVisible);
            if (!entry.hidden) anyVisible = true;
          });
          return anyVisible;
        };
        const found = filterEntries(list);
        empty.textContent = query && !found ? "No chapters match your search." : "";
        empty.hidden = !query || found;
      });
    }

    empty.hidden = hasItems;
    toc.append(searchWrap, list, empty);
  }

  function buildTOC(items) {
    renderTOCPanel(items, {
      label: (item) => item.label,
      children: (item) => item.subitems,
      pageLabel: (item) => {
        try {
          const spineItem = book && book.spine.get(item.href);
          if (!spineItem || !spineItem.cfiBase || !book.locations.length()) return "";
          const location = book.locations.locationFromCfi(spineItem.cfiBase);
          return Number.isFinite(location) && location >= 0 ? "p. " + (location + 1) : "";
        } catch { return ""; }
      },
      emptyLabel: "This book has no table of contents.",
      onSelect: (item) => {
        if (rendition) rendition.display(item.href);
        $("toc").hidden = true;
      },
    });
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
    pdfOcrNoticeShown = false;
    const saved = store.get("pos:" + meta.id, null);
    pdfPage = Math.min(Math.max((saved && saved.page) || 1, 1), pdfNum);
    const doc = pdf;
    pdfReferenceMap = new Map();
    pdfAuthorYearMap = new Map();
    buildPdfReferenceIndex(doc).then((indexes) => {
      if (doc !== pdf) return;
      pdfReferenceMap = indexes.numbers;
      pdfAuthorYearMap = indexes.authorYears;
      pdfPageNodes.forEach((wrap, pageNo) => {
        const textLayer = wrap.querySelector(".textLayer");
        if (textLayer) addPdfReferenceLinks(doc, wrap, textLayer, pageNo);
      });
    }).catch((error) => console.warn("PDF reference index failed:", error));
    pdf.getOutline().then((o) => buildPdfTOC(doc, o)).catch(() => buildPdfTOC(doc, null));
    try {
      await setupContinuousPdf();
      await renderPdfPage(pdfPage);
      pdfGo(pdfPage);
      startStatsSession();
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

  /* ---------- OCR fallback for scanned PDF pages ---------- */
  let pdfOcrWorkerPromise = null;
  async function getPdfOcrWorker() {
    if (pdfOcrWorkerPromise) return pdfOcrWorkerPromise;
    pdfOcrWorkerPromise = (async () => {
      if (!window.Tesseract) {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
          script.onload = resolve;
          script.onerror = () => reject(new Error("Could not load OCR. Check your internet connection and try again."));
          document.head.appendChild(script);
        });
      }
      return window.Tesseract.createWorker("eng", 1, {
        workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js",
        corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0",
        langPath: "https://tessdata.projectnaptha.com/4.0.0"
      });
    })().catch((error) => { pdfOcrWorkerPromise = null; throw error; });
    return pdfOcrWorkerPromise;
  }

  async function recognizeScannedPdfPage(doc, pageNo, canvas) {
    if (!current || doc !== pdf) return null;
    const cached = await getPdfOcr(current.id, pageNo);
    if (cached && Array.isArray(cached.words)) return cached;
    const worker = await getPdfOcrWorker();
    if (doc !== pdf || !current) return null;

    // These scans have a repeated "devilbat" watermark at the very bottom.
    // Crop that strip out, enlarge the page, and boost grayscale contrast before OCR.
    const scale = 2.5;
    const cropBottom = Math.max(0, Math.floor(canvas.height * 0.055));
    const sourceHeight = Math.max(1, canvas.height - cropBottom);
    const processed = document.createElement("canvas");
    processed.width = Math.max(1, Math.round(canvas.width * scale));
    processed.height = Math.max(1, Math.round(sourceHeight * scale));
    const ctx = processed.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, processed.width, processed.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, canvas.width, sourceHeight, 0, 0, processed.width, processed.height);
    const image = ctx.getImageData(0, 0, processed.width, processed.height);
    const pixels = image.data;
    for (let i = 0; i < pixels.length; i += 4) {
      const gray = Math.round(pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114);
      // Stretch the faded ink while keeping the paper background white.
      const enhanced = gray < 205 ? Math.max(0, Math.round((gray - 205) * 1.55 + 205)) : 255;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = enhanced;
      pixels[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);

    const result = await worker.recognize(processed);
    if (doc !== pdf || !current) return null;
    const words = (result.data.words || []).filter((word) =>
      word.text && word.bbox && (word.confidence == null || word.confidence >= 22)
    ).map((word) => ({
      text: String(word.text),
      confidence: Number(word.confidence || 0),
      // Convert processed-canvas coordinates back to the original page canvas.
      bbox: {
        x0: word.bbox.x0 / scale, y0: word.bbox.y0 / scale,
        x1: word.bbox.x1 / scale, y1: word.bbox.y1 / scale
      }
    })).filter((word) => word.bbox.y1 < sourceHeight);
    const payload = { width: canvas.width, height: canvas.height, words };
    await putPdfOcr(current.id, pageNo, payload);
    return payload;
  }

  function addOcrWordsToTextLayer(textLayer, words, scaleX, scaleY) {
    const fragment = document.createDocumentFragment();
    const measure = document.createElement("canvas").getContext("2d");
    words.forEach((word) => {
      const text = String(word.text || "").trim(), box = word.bbox;
      if (!text || !box) return;
      const left = box.x0 * scaleX, top = box.y0 * scaleY;
      const width = Math.max(1, (box.x1 - box.x0) * scaleX);
      const height = Math.max(5, (box.y1 - box.y0) * scaleY);
      const span = document.createElement("span");
      span.textContent = text + " ";
      span.dataset.ocr = "1";
      span.style.left = left + "px"; span.style.top = top + "px";
      span.style.height = height + "px";
      span.style.fontSize = height * 0.82 + "px";
      span.style.lineHeight = height + "px";
      span.style.width = width + "px";
      measure.font = (height * 0.82) + "px Arial";
      const naturalWidth = Math.max(1, measure.measureText(text + " ").width);
      span.style.transform = "scaleX(" + (width / naturalWidth) + ")";
      span.style.transformOrigin = "left top";
      fragment.appendChild(span);
    });
    textLayer.appendChild(fragment);
  }

  async function addScannedPdfTextLayer(doc, pageNo, canvas, textLayer, viewport, textContent) {
    const existingChars = (textContent.items || []).reduce((sum, item) =>
      sum + String(item.str || "").trim().length, 0);
    if (existingChars >= 20 || !current || doc !== pdf || !textLayer.isConnected) return;
    if (!pdfOcrNoticeShown) {
      pdfOcrNoticeShown = true;
      toast("Scanned page detected. Preparing selectable text…");
    }
    const ocr = await recognizeScannedPdfPage(doc, pageNo, canvas);
    if (!ocr || doc !== pdf || !textLayer.isConnected) return;
    addOcrWordsToTextLayer(textLayer, ocr.words, viewport.width / ocr.width, viewport.height / ocr.height);
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
      // Original scanned page stays visible; OCR supplies an invisible selectable text layer.
      try { await addScannedPdfTextLayer(doc, n, canvas, tl, vp, tc); }
      catch (ocrError) { console.warn("OCR failed on PDF page " + n + ":", ocrError); }
      addPdfReferenceLinks(doc, wrap, tl, n);
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
    recordStatsPage("pdf:" + n);
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


  async function buildPdfReferenceIndex(doc) {
    const numbers = new Map();
    const authorYears = new Map();
    const firstCandidate = Math.max(1, Math.floor(doc.numPages * 0.35));
    let referenceStart = 0;
    for (let pageNo = doc.numPages; pageNo >= firstCandidate; pageNo--) {
      if (doc !== pdf) return { numbers, authorYears };
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      const text = content.items.map((item) => item.str || "").join(" ").replace(/\s+/g, " ").trim();
      if (/\b(references?|bibliography|works cited|literature cited)\b/i.test(text)) {
        referenceStart = pageNo;
        break;
      }
      if (pageNo % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (!referenceStart) return { numbers, authorYears };
    for (let pageNo = referenceStart; pageNo <= doc.numPages; pageNo++) {
      if (doc !== pdf) return { numbers: new Map(), authorYears: new Map() };
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      const text = content.items.map((item) => item.str || "").join(" ");
      const numericPattern = /\[(\d{1,4})\]/g;
      let match;
      while ((match = numericPattern.exec(text))) {
        const number = Number(match[1]);
        if (number > 0 && !numbers.has(number)) numbers.set(number, pageNo);
      }

      // APA-style bibliography entries commonly begin with "Surname, Initials (Year)".
      // Reconstruct visual lines from PDF.js text-item baselines before matching them.
      let line = "", previousY = null;
      const lines = [];
      content.items.forEach((item) => {
        const y = item.transform && Number.isFinite(item.transform[5]) ? item.transform[5] : null;
        if (previousY !== null && y !== null && Math.abs(y - previousY) > 2.5) {
          if (line.trim()) lines.push(line.trim());
          line = "";
        }
        line += (line ? " " : "") + (item.str || "");
        if (y !== null) previousY = y;
      });
      if (line.trim()) lines.push(line.trim());
      lines.forEach((entry) => {
        const cleaned = entry.replace(/^\s*(?:\[\d{1,4}\]|\d{1,4}[.)])\s*/, "");
        const authorMatch = cleaned.match(/^([A-Z][A-Za-z'’-]{1,})\s*,[^0-9]{0,120}\b((?:19|20)\d{2}[a-z]?)\b/i);
        if (authorMatch) {
          const key = authorMatch[1].toLocaleLowerCase() + "|" + authorMatch[2].toLocaleLowerCase();
          if (!authorYears.has(key)) authorYears.set(key, pageNo);
        }
      });
      if (pageNo % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { numbers, authorYears };
  }

  function addPdfReferenceLinks(doc, pageWrap, textLayer, pageNo) {
    pageWrap.querySelectorAll(".pdf-ref-link").forEach((link) => link.remove());
    if (doc !== pdf || !textLayer) return;
    const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let fullText = "", node;
    while ((node = walker.nextNode())) {
      const value = node.nodeValue || "";
      if (!value) continue;
      nodes.push({ node, start: fullText.length, end: fullText.length + value.length });
      fullText += value;
    }
    if (!fullText) return;

    const matches = [];
    const pagePattern = /\b(?:pages?|pp?\.?)\s*(\d{1,4})(?:\s*[-–—]\s*\d{1,4})?\b/gi;
    let match;
    while ((match = pagePattern.exec(fullText))) {
      const target = Number(match[1]);
      if (target >= 1 && target <= pdfNum && target !== pageNo) {
        matches.push({ start: match.index, end: match.index + match[0].length, target, label: "page " + target });
      }
    }
    const citationPattern = /\[(\d{1,4})(?:\s*[,;]\s*\d{1,4})*(?:\s*[-–—]\s*\d{1,4})?\]/g;
    while ((match = citationPattern.exec(fullText))) {
      const target = pdfReferenceMap.get(Number(match[1]));
      if (target && target !== pageNo) {
        matches.push({ start: match.index, end: match.index + match[0].length, target, label: "reference " + match[1] });
      }
    }
    const authorPatterns = [
      /\(([A-Z][A-Za-z'’-]{1,})(?:\s+et\s+al\.?)?,?\s*((?:19|20)\d{2}[a-z]?)\)/g,
      /\b([A-Z][A-Za-z'’-]{1,})\s+et\s+al\.?\s*\(((?:19|20)\d{2}[a-z]?)\)/g,
      /\b([A-Z][A-Za-z'’-]{1,})\s*\(((?:19|20)\d{2}[a-z]?)\)/g,
    ];
    authorPatterns.forEach((pattern) => {
      let authorMatch;
      while ((authorMatch = pattern.exec(fullText))) {
        const surname = authorMatch[1], year = authorMatch[2];
        const target = pdfAuthorYearMap.get(surname.toLocaleLowerCase() + "|" + year.toLocaleLowerCase());
        if (target && target !== pageNo) {
          matches.push({
            start: authorMatch.index,
            end: authorMatch.index + authorMatch[0].length,
            target,
            label: "reference " + surname + " (" + year + ")",
          });
        }
      }
    });
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    const unique = [];
    matches.forEach((item) => {
      const previous = unique[unique.length - 1];
      if (!previous || item.start >= previous.end) unique.push(item);
    });

    const pointAt = (offset, preferNext) => {
      for (const item of nodes) {
        if (offset < item.end || (!preferNext && offset === item.end)) {
          return { node: item.node, offset: Math.max(0, Math.min(item.node.nodeValue.length, offset - item.start)) };
        }
      }
      const last = nodes[nodes.length - 1];
      return { node: last.node, offset: last.node.nodeValue.length };
    };
    const pageRect = pageWrap.getBoundingClientRect();
    unique.forEach((item) => {
      const start = pointAt(item.start, true), end = pointAt(item.end, false);
      const range = document.createRange();
      try {
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
      } catch { return; }
      Array.from(range.getClientRects()).forEach((rect) => {
        if (rect.width < 1 || rect.height < 1) return;
        const link = document.createElement("a");
        link.className = "pdf-ref-link";
        link.href = "#";
        link.title = "Jump to " + item.label;
        link.setAttribute("aria-label", "Jump to " + item.label);
        link.style.left = (rect.left - pageRect.left) + "px";
        link.style.top = (rect.top - pageRect.top) + "px";
        link.style.width = rect.width + "px";
        link.style.height = rect.height + "px";
        link.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          pdfGo(item.target);
        });
        pageWrap.appendChild(link);
      });
    });
  }

  async function buildPdfTOC(doc, items) {
    if (pdf !== doc) return;
    renderTOCPanel(items || [], {
      label: (item) => item.title,
      children: (item) => item.items,
      pageLabel: (item) => item._page ? "p. " + item._page : "",
      emptyLabel: "This PDF has no table of contents.",
      onSelect: async (item) => {
        try {
          const page = item._page ?? (await resolvePdfDest(doc, item.dest));
          if (page && pdf === doc) { pdfGo(page); $("toc").hidden = true; }
        } catch (error) { console.warn(error); }
      },
    });

    // Resolve target pages so bookmarks and notes can show their chapter names.
    const flat = [];
    (function walk(list) {
      (list || []).forEach((item) => {
        flat.push(item);
        if (item.items && item.items.length) walk(item.items);
      });
    })(items || []);
    const chapters = [];
    for (const item of flat) {
      if (pdf !== doc) return;
      try { item._page = await resolvePdfDest(doc, item.dest); } catch {}
      if (item._page) chapters.push({ label: (item.title || "").trim(), page: item._page });
    }
    if (pdf !== doc) return;
    chapters.sort((a, b) => a.page - b.page);
    tocFlat = chapters;
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
    if (window.getSelection().toString() || e.target.closest(".pdf-link, .pdf-ref-link")) return;
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
  function updateHelperRangeLabels() {
    const left = $("helper-left-words-label");
    const right = $("helper-right-words-label");
    if (left) left.textContent = helperLeftWords + " word" + (helperLeftWords === 1 ? "" : "s");
    if (right) right.textContent = helperRightWords + " word" + (helperRightWords === 1 ? "" : "s");
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
    const blockTags = new Set(["P","DIV","LI","TD","TH","BLOCKQUOTE","PRE","H1","H2","H3","H4","H5","H6","SECTION","ARTICLE"]);
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
    const isWhitespace = (ch) => !!ch && /\s/u.test(ch);

    // A hyphen at the end of a printed line joins the next line's letters
    // into the same word (for example, "meso-\nderm"). Ordinary line
    // breaks and spaces still separate words ("beginning\nof").
    function isHyphenatedLineBreakSpace(index) {
      if (!isWhitespace(fullText.charAt(index))) return false;
      let runStart = index, runEnd = index + 1;
      while (runStart > 0 && isWhitespace(fullText.charAt(runStart - 1))) runStart--;
      while (runEnd < fullText.length && isWhitespace(fullText.charAt(runEnd))) runEnd++;
      const lineBreak = /[\r\n\u2028\u2029]/u.test(fullText.slice(runStart, runEnd));
      const before = fullText.charAt(runStart - 1);
      const after = fullText.charAt(runEnd);
      return lineBreak &&
        /[-\u2010\u2011\u00ad]/u.test(before) &&
        !!after && !/[\s,.]/u.test(after);
    }

    const isSeparatorAt = (index) => {
      const ch = fullText.charAt(index);
      if (!ch) return true;
      if (ch === "," || ch === ".") return true;
      return isWhitespace(ch) && !isHyphenatedLineBreakSpace(index);
    };

    let pos = caretOffset;
    if (isSeparatorAt(pos)) {
      if (!isSeparatorAt(pos - 1)) pos--;
      else if (!isSeparatorAt(pos + 1)) pos++;
      else return null;
    }
    if (pos < 0 || pos >= fullText.length || isSeparatorAt(pos)) return null;

    // Build word boundaries using the same separator rules. The word under
    // the pointer is always included; the two independent controls expand the
    // highlighted range by up to three words to its left and right.
    const tokens = [];
    let scan = 0;
    while (scan < fullText.length) {
      while (scan < fullText.length && isSeparatorAt(scan)) scan++;
      if (scan >= fullText.length) break;
      const tokenStart = scan;
      while (scan < fullText.length && !isSeparatorAt(scan)) scan++;
      tokens.push({ start: tokenStart, end: scan });
    }
    const tokenIndex = tokens.findIndex((token) => pos >= token.start && pos < token.end);
    if (tokenIndex < 0) return null;
    const firstIndex = Math.max(0, tokenIndex - helperLeftWords);
    const lastIndex = Math.min(tokens.length - 1, tokenIndex + helperRightWords);
    const start = tokens[firstIndex].start;
    const end = tokens[lastIndex].end;

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
    const context = fullText.slice(Math.max(0, start - 100), Math.min(fullText.length, end + 180)).replace(/\s+/g, " ").trim();
    return { range, isBold, context, word: fullText.slice(tokens[tokenIndex].start, tokens[tokenIndex].end) };
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
  function classifyLookupTopic(rawWord, rawContext = "") {
    const word = String(rawWord || "").toLocaleLowerCase().trim().replace(/\s+/g, " ");
    const context = String(rawContext || "").toLocaleLowerCase();

    const medicalTerms = new Set([
      "ischemia","ischaemia","ischemic","ischaemic","infarction","infarct","necrosis",
      "thrombosis","embolism","embolus","atherosclerosis","hypertension","hypotension",
      "tachycardia","bradycardia","arrhythmia","dyspnea","dyspnoea","cyanosis",
      "edema","oedema","hemorrhage","haemorrhage","anemia","anaemia","leukemia",
      "leukaemia","sepsis","pathology","etiology","aetiology","prognosis","diagnosis",
      "prophylaxis","pharmacology","anatomy","physiology","histology","hemostasis",
      "haemostasis","homeostasis","myocardial","pulmonary","renal","hepatic","cerebral",
      "neurological","neurologic","immunology","endocrine","antigen","antibody",
      "pathogen","neoplasm","carcinoma","metastasis","asphyxia","hypoxia","ischemia"
    ]);
    const lifeScienceTerms = new Set([
      "organelle","organelles","cytoplasm","mitochondria","mitochondrion","ribosome","ribosomes",
      "nucleus","nucleolus","chromosome","chromosomes","dna","rna","gene","genes","genome",
      "genetics","meiosis","mitosis","osmosis","diffusion","photosynthesis","chloroplast",
      "chlorophyll","prokaryote","eukaryote"
    ]);
    const programmingLanguages = new Set([
      "c#","c++","javascript","typescript","python","java","rust","golang","go",
      "php","ruby","swift","kotlin","html","css","sql","bash","powershell","lua","dart"
    ]);
    const medicalContext = /\b(medical|medicine|clinical|patient|diagnosis|diagnostic|disease|disorder|symptom|syndrome|treatment|therapy|pathology|anatomy|physiology|nursing|pharmacology|drug|medication|hospital|healthcare|infection|inflammation|organ|artery|vein|blood|cardiac|pulmonary|renal|hepatic|neurologic|clinical signs)\b/u;
    const biologyContext = /\b(biology|biological|cellular|cell membrane|cell wall|cell division|basic unit of life|living organism|tissues?|organelle|cytoplasm|mitochondri|ribosom|chromosom|dna|rna|gene|genetic|organism|photosynthesis|ecosystem|microscope|histology|embryology)\b/u;
    const programmingContext = /\b(programming|programmer|software|source code|code|coding|compiler|interpreter|syntax|variable|function|method|class|object|algorithm|debugging|repository|framework|library|runtime|database|developer|IDE|API|script)\b/u;
    const computingContext = /\b(computer|computing|hardware|operating system|windows|linux|processor|CPU|GPU|RAM|memory address|network|networking|protocol|server|cloud|browser|web development|cybersecurity|encryption|command line|terminal|device driver|firmware)\b/u;

    // C# and C++ are distinctive enough to classify from the word alone.
    if (word === "c#" || word === "c++" ||
        /^(javascript|typescript|html|css)$/u.test(word)) {
      return { key: "programming", label: "Programming / software" };
    }
    // Medical terms and the surrounding book text distinguish clinical use from general language.
    if (medicalTerms.has(word) || medicalContext.test(context)) {
      return { key: "medical", label: "Medical / clinical" };
    }
    if (lifeScienceTerms.has(word) || biologyContext.test(context)) {
      return { key: "life-science", label: "Biology / life sciences" };
    }
    if ((programmingLanguages.has(word) && programmingContext.test(context)) ||
        programmingContext.test(context)) {
      return { key: "programming", label: "Programming / software" };
    }
    if (computingContext.test(context)) {
      return { key: "technology", label: "Computing / technology" };
    }
    return { key: "general", label: "General reference" };
  }

  function makeSiteSearchUrl(site, word) {
    return "https://www.google.com/search?q=" + encodeURIComponent("site:" + site + " " + word);
  }

  function getTopicReferenceSources(word, category) {
    const source = (title, site) => ({ title, url: makeSiteSearchUrl(site, word) });
    if (category.key === "medical") {
      return [
        source("MedlinePlus medical results", "medlineplus.gov"),
        source("MSD Manual medical results", "msdmanuals.com"),
        source("NCBI Bookshelf medical references", "ncbi.nlm.nih.gov/books")
      ];
    }
    if (category.key === "life-science") {
      return [
        source("NCBI Bookshelf biology references", "ncbi.nlm.nih.gov/books"),
        source("OpenStax biology references", "openstax.org")
      ];
    }
    if (category.key === "programming") {
      if (word.toLocaleLowerCase() === "c#") {
        return [
          source("Microsoft Learn — C# documentation", "learn.microsoft.com/en-us/dotnet/csharp"),
          source("Stack Overflow programming discussions", "stackoverflow.com/questions")
        ];
      }
      const languageSites = {
        javascript: "developer.mozilla.org",
        typescript: "www.typescriptlang.org/docs",
        python: "docs.python.org",
        java: "docs.oracle.com",
        rust: "doc.rust-lang.org",
        golang: "go.dev/doc",
        go: "go.dev/doc",
        php: "www.php.net/manual",
        ruby: "docs.ruby-lang.org",
        swift: "www.swift.org/documentation",
        kotlin: "kotlinlang.org/docs",
        html: "developer.mozilla.org",
        css: "developer.mozilla.org",
        sql: "www.postgresql.org/docs"
      };
      const site = languageSites[word.toLocaleLowerCase()];
      return [
        ...(site ? [source("Official " + word + " documentation", site)] : [
          source("Microsoft Learn developer documentation", "learn.microsoft.com"),
          source("MDN Web Docs", "developer.mozilla.org")
        ]),
        source("Stack Overflow programming discussions", "stackoverflow.com/questions")
      ];
    }
    if (category.key === "technology") {
      return [
        source("Microsoft technical documentation", "learn.microsoft.com"),
        source("MDN Web Docs", "developer.mozilla.org"),
        source("Cloudflare technical guides", "cloudflare.com/learning")
      ];
    }
    return [];
  }

  async function getReferenceDescription(word, category) {
    // Ordinary layman's terms use Wikipedia only. DictionaryAPI is reserved
    // for specialist medical / life-science terminology where a word definition helps.
    const shouldUseDictionary = category.key === "medical" || category.key === "life-science";
    const requests = [
      fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(word.replace(/ /g, "_"))).then(r => {
        if (!r.ok) throw new Error("No Wikipedia summary");
        return r.json();
      })
    ];
    if (shouldUseDictionary) {
      requests.unshift(fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(word)).then(r => {
        if (!r.ok) throw new Error("Dictionary entry not found");
        return r.json();
      }));
    }
    const results = await Promise.allSettled(requests);
    const dictResult = shouldUseDictionary ? results[0] : null;
    const wikiResult = shouldUseDictionary ? results[1] : results[0];
    const parts = [];
    const sources = [];

    if (dictResult && dictResult.status === "fulfilled" && Array.isArray(dictResult.value)) {
      const entry = dictResult.value[0];
      if (entry.phonetic) parts.push("Pronunciation: " + entry.phonetic);
      (entry.meanings || []).slice(0, 4).forEach(m => {
        const defs = (m.definitions || []).slice(0, 2).map(d => d.definition).filter(Boolean);
        if (defs.length) parts.push(m.partOfSpeech + ": " + defs.join(" / "));
      });
      sources.push({ title: "Dictionary API", url: "https://dictionaryapi.dev/" });
    }
    if (wikiResult.status === "fulfilled" && wikiResult.value && wikiResult.value.extract) {
      const w = wikiResult.value;
      parts.push("Reference overview: " + w.extract);
      sources.push({
        title: "Wikipedia — " + (w.title || word),
        url: w.content_urls?.desktop?.page || "https://en.wikipedia.org/wiki/" + encodeURIComponent((w.title || word).replace(/ /g, "_"))
      });
    }
    getTopicReferenceSources(word, category).forEach(s => sources.push(s));
    return {
      description: parts.join("\n\n") || (category.key === "general"
        ? "No Wikipedia overview was available for this term."
        : "No automatic definition was found. Use the topic-specific reference links below."),
      sources
    };
  }

  async function lookupDictionary(rawWord, rawContext = "") {
    const word = String(rawWord || "").trim().replace(/^[()[\]{}]+|[()[\]{}]+$/g, "");
    if (!word || word.length > 100) return;
    const category = classifyLookupTopic(word, rawContext);
    $("dictionary-dialog").hidden = false;
    $("dictionary-word-input").value = word;
    $("dictionary-status").textContent = "Category: " + category.label + " · searching relevant references…";
    setDictionaryCopy("dictionary-definition", "Searching the best-matched reference sources…");
    $("dictionary-sources").innerHTML = "";
    const cacheKey = "wordLookup:" + category.key + ":" + word.toLocaleLowerCase();
    const cached = store.get(cacheKey, null);
    if (cached && Date.now() - cached.savedAt < 30 * 24 * 60 * 60 * 1000) {
      setDictionaryCopy("dictionary-definition", cached.description);
      (cached.sources || []).forEach(s => appendDictionarySource($("dictionary-sources"), s.title, s.url));
      $("dictionary-status").textContent = "Category: " + category.label + " · loaded from this browser’s 30-day cache.";
      return;
    }
    try {
      const reference = await getReferenceDescription(word, category);
      setDictionaryCopy("dictionary-definition", reference.description);
      reference.sources.forEach(s => appendDictionarySource($("dictionary-sources"), s.title, s.url));
      $("dictionary-status").textContent = "Category: " + category.label + " · lookup complete.";
      store.set(cacheKey, { description: reference.description, sources: reference.sources, savedAt: Date.now() });
    } catch (error) {
      setDictionaryCopy("dictionary-definition", "Reference websites could not be reached. Check your internet connection.");
      $("dictionary-status").textContent = "Category: " + category.label + " · lookup unavailable.";
    }
  }
  $("dictionary-word-search").addEventListener("click", () => {
    const editedWord = $("dictionary-word-input").value.trim();
    if (!editedWord) {
      $("dictionary-word-input").focus();
      return;
    }
    lookupDictionary(editedWord, editedWord);
  });
  $("dictionary-word-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      $("dictionary-word-search").click();
    }
  });
  function closeDictionary() { $("dictionary-dialog").hidden = true; }
  $("dictionary-dialog").addEventListener("click", e => { if (e.target === $("dictionary-dialog")) closeDictionary(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("dictionary-dialog").hidden) closeDictionary(); });

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
      if (!dictionaryEnabled || !current || e.target.closest("a")) return;
      const caret = getCaretAtPoint(doc, e.clientX, e.clientY);
      const word = caret && getHelperWordRange(doc, caret);
      if (word) lookupDictionary(word.word, word.context);
    });
    doc.addEventListener("mouseleave", () => clearHelperDoc(doc));
  }

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

  function updateDictionaryButton() {
    const button = $("dictionary-toggle");
    button.setAttribute("aria-pressed", dictionaryEnabled ? "true" : "false");
    button.textContent = dictionaryEnabled ? "⌕ Lookup: On" : "⌕ Lookup: Off";
    button.title = dictionaryEnabled ? "Turn word lookup off" : "Turn word lookup on";
  }
  function setDictionaryEnabled(on) {
    dictionaryEnabled = !!on;
    store.set("dictionaryEnabled", dictionaryEnabled);
    updateDictionaryButton();
    if (!dictionaryEnabled) closeDictionary();
  }
  $("dictionary-toggle").addEventListener("click", () => setDictionaryEnabled(!dictionaryEnabled));
  updateDictionaryButton();
  $("pdfview").addEventListener("click", (e) => {
    if (!dictionaryEnabled || mode !== "pdf" || !e.target.closest(".textLayer")) return;
    const caret = getCaretAtPoint(document, e.clientX, e.clientY);
    const word = caret && getHelperWordRange(document, caret);
    if (word) lookupDictionary(word.word, word.context);
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
          let words = text.items.map((x) => x.str || "").join(" ");
          if (words.replace(/\\s/g, "").length < 20) {
            let ocr = await getPdfOcr(current.id, pageNo);
            if (!ocr) {
              const viewport = page.getViewport({ scale: 1.5 });
              const canvas = document.createElement("canvas");
              canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
              await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
              ocr = await recognizeScannedPdfPage(doc, pageNo, canvas);
            }
            if (ocr) words = ocr.words.map((word) => word.text).join(" ");
          }
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
  $("add-url").addEventListener("click", importArticleUrl);
  $("add-html").addEventListener("click", () => $("html-input").click());
  $("html-input").addEventListener("change", (e) => {
    const files=Array.from(e.target.files||[]);
    const file=files.find(f=>/\.html?$/i.test(f.name));
    if(file) importArticleHtml(file,files);
    else if(files.length)toast("Choose the .html file inside the saved webpage folder.");
    e.target.value="";
  });
  $("article-export").addEventListener("click", exportArticlePdf);
  $("backup-export").addEventListener("click", exportAnnotationBackup);
  $("backup-input").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importAnnotationBackup(file);
    e.target.value = "";
  });
  $("stats-open").addEventListener("click", () => { renderReadingStats(); $("stats-dialog").hidden = false; });
  $("stats-close").addEventListener("click", () => { $("stats-dialog").hidden = true; });
  $("stats-dialog").addEventListener("click", (e) => { if (e.target === $("stats-dialog")) $("stats-dialog").hidden = true; });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("stats-dialog").hidden) $("stats-dialog").hidden = true;
  });
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
      if (best !== pdfPage) { pdfPage = best; updatePdfUI(); recordStatsPage("pdf:" + best); clearTimeout(saveTimer);
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
    pdfjsLib.GlobalWorkerOptions.workerSrc = window.__pdfWorkerSrc || "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  }

  initSettingsUI();
  applyTheme();
  renderLibrary();
})();
