# My EPUB Reader

A tiny personal EPUB reader that runs entirely in the browser. Built with plain HTML/CSS/JS and [epub.js](https://github.com/futurepress/epub.js) (loaded from a CDN) — no build step.

- Library of books stored **in your browser** (IndexedDB) — nothing is uploaded anywhere
- Remembers your reading position per book
- Table of contents, progress slider, font size, light / sepia / dark themes
- Arrow keys, on-screen buttons, or swipe to turn pages
- Add books with the button or by drag & drop

## Deploy on GitHub Pages

1. Create a new repository on GitHub (e.g. `epub-reader`).
2. Upload `index.html`, `style.css`, `app.js`, `README.md` to the repo root.
3. Go to **Settings → Pages**, set **Source** to *Deploy from a branch*, pick `main` and `/ (root)`, and save.
4. After a minute your reader is live at `https://<your-username>.github.io/epub-reader/`.

## Run locally

Opening `index.html` directly mostly works, but a local server is safer:

```
python3 -m http.server 8000
```

then visit http://localhost:8000.

## Notes

- Books live in the browser you add them on. Different device or browser = separate library (and clearing site data deletes it).
- Don't commit your .epub files to a public repo unless you have the rights to share them.
