# PDF Toolkit (Desktop)

A cross-platform desktop PDF toolkit built with Electron. Everything runs
**locally on your machine** — no files are ever uploaded anywhere.

## Tools included (29)

**Page operations:** Merge, Split (per page), Rotate, Remove pages, Extract
pages, Reorder pages, Crop, Change page size, Pages per sheet (n-up)

**Conversion:** Images to PDF, PDF to Images, Convert image format
(JPG/PNG/WEBP), Text to PDF, Webpage to PDF, Office to PDF (via LibreOffice,
see below)

**Editing:** Add watermark, Add page numbers, Redact (visual box-over),
Edit metadata, Add bookmarks (experimental), Fill out PDF forms, Create
fillable form, Flatten form

**Utilities:** Compare PDFs (text diff), Repair PDF (best-effort), Generate
QR code, Generate password, View PDF (built-in viewer), OCR PDF (extract
text)

## Office documents (via LibreOffice) — tested, with an important correction

**Office → PDF works and was verified end-to-end**: Writer documents
(txt→odt→docx) and Calc spreadsheets (csv→xlsx) were both actually converted
to PDF using a real, installed LibreOffice during development — not just
assumed to work from documentation.

**PDF → Office is *not* offered, and this was also verified, not assumed.**
The original plan was to support both directions, but testing showed
LibreOffice's headless `--convert-to` imports a PDF as a **Draw document**
(i.e., a page image), not as editable text — so `--convert-to docx` from a
PDF produces no output at all ("no export filter found"), even though
`--convert-to png` from the same PDF works fine. This is a real limitation
of LibreOffice's headless pipeline, not a bug in this app's code. So the
tool only offers Office → PDF. If you need to get text out of a PDF, use
the **OCR PDF** tool instead (extracts text, not full layout/formatting).

**LibreOffice detection/fetch flow:**
- On launch of the tool, it checks common install locations
  (`soffice`/`libreoffice` on PATH, plus the usual per-OS install paths).
- If missing, on **Windows/Mac** it can attempt a real, automatic download
  with a progress readout: it looks up the current stable version from
  LibreOffice's official listing (rather than a hardcoded version number
  that would go stale), builds the direct installer URL, downloads it to
  your Downloads folder, and opens it for you to run — you still complete
  the actual install yourself (entering an admin password if your OS asks
  for one), since silently auto-executing an installer with elevated
  privileges isn't something this app does. If the automatic download fails
  for any reason (network hiccup, a version mismatch on the mirror, etc.)
  it automatically falls back to opening LibreOffice's official download
  page in your browser instead, so you're never stuck.
- On **Linux**, it points you to your package manager (`apt`/`dnf`/`pacman`)
  instead of a raw binary — that's the standard, more reliable way to get
  LibreOffice on Linux and it correctly matches your distro's dependencies,
  which one hardcoded `.tar.gz` URL can't guarantee.
- Caveat: the direct-download URL construction (version discovery +
  building the Windows/Mac installer URL) could only be logic-tested in
  this environment — the URL pattern was confirmed against multiple
  real-world examples (Debian wiki, install guides) but the live HTTP
  download itself wasn't exercised end-to-end here, since this sandbox's
  network doesn't reach documentfoundation.org. The automatic
  fallback-to-browser path means a broken URL degrades to "open the
  official page" rather than a dead end, but this is worth an eye on first
  real use.

## OCR — tested logic, not tested end-to-end

The OCR tool renders each PDF page to a canvas (same approach as "PDF to
Images") and feeds it to Tesseract via `tesseract.js` (pure WASM, no native
binary). The rendering and PDF-handling code reuses paths already verified
elsewhere in this app. What wasn't verified here: an actual OCR run, since
`tesseract.js` downloads its WASM core and language data from a CDN on
first use, and that CDN isn't reachable from this sandbox's restricted
network. It should work — this is tesseract.js's standard, well-documented
flow — but it's the one feature in this app that's shipped on the strength
of "this is how the library is designed to be used" rather than "I ran it
and watched it work."

## What else is *not* included, and why

PDF24's site has ~70 tools; some of the remaining ones need either a large
native binary bundled per-OS or a fundamentally different architecture, so
they're deliberately left out of this build rather than half-implemented:

- **PDF → Word / PowerPoint / Excel / ODT / RTF / EPUB** — see above: tested
  and confirmed this doesn't work via LibreOffice's headless pipeline (PDF
  imports as a Draw/image document, not editable text). A real "reconstruct
  editable Office content from a PDF" feature needs a fundamentally
  different, much more sophisticated tool than a CLI convert call.
- **True password-protect/encrypt PDF** — `pdf-lib` doesn't implement PDF
  encryption. Real support needs `qpdf` or similar, which means a native
  binary per platform.
- **Real compression** — needs re-encoding embedded images down in quality/
  resolution (e.g. via `sharp`, another native, per-platform dependency).
- **True "web-optimize"/linearize** — real linearization is a specific
  byte-layout format; what's here just recompresses objects, which isn't
  the same thing.
- **HEIC / TIFF image support** — Chromium (which Electron uses for
  rendering) doesn't decode these natively and reliably across all three
  OSes, so they're left out rather than shipping something flaky.

## What was actually tested vs. what wasn't

Most of this app's logic was genuinely run and checked, not just written and
assumed correct:
- All pdf-lib operations (merge, split, rotate, n-up, page-size, bookmarks,
  etc.) ran successfully against real PDFs in Node, including the bookmarks
  feature round-tripping through an independent parser (`pdfjs-dist`).
- The LibreOffice integration was tested against a **real, installed
  LibreOffice** — this is how the PDF→Office limitation (see above) was
  actually discovered, not guessed at.
- Dependencies install cleanly and every file passes a syntax check.

What wasn't (and couldn't be, from this environment):
- **The Electron GUI itself** — no display in this environment, so no
  button was ever actually clicked. `npm start` on your machine is the
  first real test of the UI layer.
- **OCR execution** — the code path is right (same rendering approach as
  "PDF to Images", standard `tesseract.js` usage), but the library
  downloads its WASM/language assets from a CDN this sandbox can't reach.
- **The live LibreOffice auto-download** — URL construction was verified
  against real-world examples, but the actual HTTPS download was never
  exercised end-to-end here (documentfoundation.org isn't reachable from
  this sandbox); it has an automatic fallback to opening the official page
  if the direct download fails for any reason.

## Architecture: background worker thread

File-processing tools (Merge, Split, Rotate, Crop, Change page size, Pages
per sheet, Images to PDF, Watermark, Page numbers, Metadata, Flatten, Create
form, Bookmarks, Redact, Repair) run inside `worker.js` — a separate thread
from the one drawing the window (`main.js`'s `nodeIntegrationInWorker: true`
lets it `require()` the same libraries). This means:

- The window stays responsive during a big job — no freeze, buttons still
  work, other panels still respond.
- You get live progress text for multi-step jobs (e.g. "Splitting page 12 of
  340...").
- All the actual PDF logic lives in `pdf-ops.js`, a small DOM-free module
  shared only with the worker, so it's easy to test in plain Node (see the
  test commands used during development — every operation there was run
  and verified against real PDFs before shipping).

A "worker thread" here is just a second thread inside this same desktop
app — it has nothing to do with the internet or a server; everything still
runs 100% locally.

Tools that need live UI state or aren't heavy (PDF to Images, Convert Image
Format, Compare PDFs, Fill Out PDF, Text to PDF, Webpage to PDF, QR Code,
Generate Password, View PDF) still run on the main thread, since they're
either already incremental/fast or need to interact with visible DOM state
between steps.

## Run it locally (any OS, for development/testing)

```bash
npm install
npm start
```

## Build native installers

### Build for your current OS only
```bash
npm run dist:mac      # on a Mac -> .dmg
npm run dist:linux    # on Linux -> .AppImage + .deb
npm run dist:win      # on Windows -> .exe (nsis installer)
```
Electron can only reliably build a **macOS** installer when run **on** macOS
(Apple's tooling isn't available on Linux/Windows), which is exactly why the
GitHub Actions workflow below is the recommended path — it builds each
platform's installer on that platform's *real* runner in the cloud.

### Build all three via GitHub Actions (recommended)

1. Push this project to a new GitHub repo.
2. The workflow at `.github/workflows/build.yml` runs automatically:
   - on every push of a version tag (e.g. `v1.0.0`)
   - or manually from the **Actions** tab ("Run workflow" button)
3. It builds on `macos-latest`, `ubuntu-latest`, and `windows-latest` in
   parallel and uploads the results as workflow **artifacts**.
4. If you push a tag like `v1.0.0`, it also creates a **GitHub Release** with
   the `.dmg`, `.AppImage`, `.deb`, and `.exe` attached automatically.

To trigger a tagged release build:
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
git tag v1.0.0
git push origin v1.0.0
```

## Notes & limitations

- **Not code-signed.** macOS will show an "unidentified developer" warning
  (right-click the app → Open, once) and Windows SmartScreen may warn too.
  Signing requires paid Apple/Microsoft developer certificates — the
  workflow can be extended to sign builds once you have those.
- **Redact** is visual-only — it draws a black box over the region but does
  not remove the underlying text/objects. For real redaction, run "PDF to
  Images" then "Images to PDF" afterward to flatten to a raster image.
- **Bookmarks** uses pdf-lib's low-level object APIs since pdf-lib has no
  official high-level outline/bookmark API — it's tested and round-trips
  correctly through an independent parser, but is still marked experimental
  in the UI since it bypasses the library's normal high-level interface.
- **PDF to Images** and **View PDF** render pages using `pdf.js` in the
  window itself, so very large PDFs may take a little while.
- The Electron window runs with `nodeIntegration: true` so the renderer can
  `require()` `pdf-lib`/`pdfjs-dist`/`jszip`/`qrcode`/`diff` directly. That's
  fine here since the app never loads remote/untrusted web content in the
  main window — only its own local `index.html`. Note the "Webpage to PDF"
  tool does load a remote URL, but in a separate, isolated, throwaway
  `BrowserWindow` used only for `printToPDF`, not the main app window.

## Adding more tools

Most tools are a single entry in the `TOOLS` object in `renderer.js` — add a
new key with a `title`, `desc`, `accept` (file types), optional
`extraFields` (form inputs), and an `action(values)` function that does the
PDF work and calls `saveOutput(name, bytes)`. Tools that need bespoke UI
(multiple file slots, dynamic field detection, live previews) instead set
`custom: true` and a `render(container)` function — see `compare`,
`fill-form`, or `view-pdf` for examples. Then add a matching
`<li data-tool="...">` entry in `index.html`.

