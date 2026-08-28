const { ipcRenderer } = require('electron');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const JSZip = require('jszip');

// ---- pdfjs-dist setup (used for "PDF to Images", "Compare PDFs", "View PDF") ----
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js');
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('file://' + workerPath).href;

const panelsEl = document.getElementById('panels');
const statusEl = document.getElementById('status');
const toolListEl = document.getElementById('toolList');

function setStatus(msg, kind) {
  statusEl.textContent = msg || '';
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

// In-memory store of loaded files per panel: [{name, bytes: Uint8Array}]
let loadedFiles = [];

function bytesToArray(bytes) {
  return Array.from(bytes);
}

async function saveOutput(defaultName, bytes) {
  setStatus('Saving...');
  const res = await ipcRenderer.invoke('save-file', {
    defaultName,
    data: bytesToArray(bytes)
  });
  if (res.ok) setStatus('Saved to ' + res.filePath, 'success');
  else setStatus('Save cancelled.');
}

function readFileAsUint8(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

async function extractAllText(bytes) {
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(' ') + '\n';
  }
  return text;
}

// ---------------- Background worker (keeps the UI responsive) ----------------
// Heavy, file-processing tools (merge, split, rotate, page-size, n-up, etc.)
// run inside worker.js — a separate thread — instead of on the main thread
// that draws the window. That means the UI never freezes on a big job, and
// we can show live progress messages as they come in. Everything still runs
// locally on this machine; a "worker thread" here has nothing to do with the
// internet, it's just a background thread inside this desktop app.

let pdfWorker = null;
let workerMsgId = 0;
const pendingWorkerJobs = new Map();

function getWorker() {
  if (!pdfWorker) {
    pdfWorker = new Worker(new URL('worker.js', document.baseURI).href);
    pdfWorker.onmessage = (e) => {
      const { id, type, message, filename, bytes } = e.data;
      const job = pendingWorkerJobs.get(id);
      if (!job) return;
      if (type === 'progress') {
        setStatus(message);
      } else if (type === 'result') {
        pendingWorkerJobs.delete(id);
        job.resolve({ filename, bytes: new Uint8Array(bytes) });
      } else if (type === 'error') {
        pendingWorkerJobs.delete(id);
        job.reject(new Error(message));
      }
    };
    pdfWorker.onerror = (err) => {
      setStatus('Worker error: ' + err.message, 'error');
    };
  }
  return pdfWorker;
}

function runInWorker(tool, values, files) {
  return new Promise((resolve, reject) => {
    const id = ++workerMsgId;
    pendingWorkerJobs.set(id, { resolve, reject });
    // Clone each file's bytes before transferring, so loadedFiles stays
    // usable if the user runs the same tool again without re-adding files.
    const transferFiles = files.map((f) => ({ name: f.name, bytes: f.bytes.slice().buffer }));
    getWorker().postMessage(
      { id, tool, values, files: transferFiles },
      transferFiles.map((f) => f.bytes)
    );
  });
}

// ---------------- Tool definitions ----------------
// Tools with `worker: true` run in the background thread (see pdf-ops.js /
// worker.js) — used for anything that processes whole PDF files. Tools with
// a plain `action` run on the main thread — used for lightweight ops or ones
// that need to stay synced with visible UI state (e.g. QR preview).

const TOOLS = {
  merge: {
    title: 'Merge PDF',
    desc: 'Combine multiple PDF files into a single PDF, in the order listed below.',
    accept: '.pdf',
    multi: true,
    worker: true
  },

  split: {
    title: 'Split PDF (per page)',
    desc: 'Splits a PDF into one file per page, packaged as a ZIP.',
    accept: '.pdf',
    multi: false,
    worker: true
  },

  rotate: {
    title: 'Rotate Pages',
    desc: 'Rotate every page in the PDF by a fixed angle.',
    accept: '.pdf',
    multi: false,
    worker: true,
    extraFields: [
      { id: 'angle', label: 'Rotation angle', type: 'select', options: ['90', '180', '270'] }
    ]
  },

  remove: {
    title: 'Remove Pages',
    desc: 'Remove specific pages from a PDF. Use 1-based page numbers, e.g. "1,3,5-7".',
    accept: '.pdf',
    multi: false,
    worker: true,
    extraFields: [{ id: 'pages', label: 'Pages to remove', type: 'text', placeholder: 'e.g. 2,4-6' }]
  },

  extract: {
    title: 'Extract Pages',
    desc: 'Extract specific pages into a new PDF. Use 1-based page numbers, e.g. "1,3,5-7".',
    accept: '.pdf',
    multi: false,
    worker: true,
    extraFields: [{ id: 'pages', label: 'Pages to extract', type: 'text', placeholder: 'e.g. 1,3,5-7' }]
  },

  reorder: {
    title: 'Reorder Pages',
    desc: 'Give the new page order as a comma-separated list of 1-based page numbers, e.g. "3,1,2" for a 3-page PDF.',
    accept: '.pdf',
    multi: false,
    worker: true,
    extraFields: [{ id: 'order', label: 'New page order', type: 'text', placeholder: 'e.g. 3,1,2' }]
  },

  crop: {
    title: 'Crop PDF',
    desc: 'Crop a uniform margin (in points — 72pt = 1 inch) from every page.',
    accept: '.pdf',
    multi: false,
    worker: true,
    extraFields: [{ id: 'margin', label: 'Margin to crop (points)', type: 'text', placeholder: 'e.g. 36' }]
  },

  'page-size': {
    title: 'Change Page Size',
    desc: 'Rescale every page to a standard paper size, centered.',
    accept: '.pdf',
    multi: false,
    worker: true,
    extraFields: [{ id: 'size', label: 'Target size', type: 'select', options: ['A4', 'Letter', 'Legal'] }]
  },

  'n-up': {
    title: 'Pages per Sheet',
    desc: 'Combine multiple PDF pages onto a single sheet (2-up or 4-up).',
    accept: '.pdf',
    multi: false,
    worker: true,
    extraFields: [{ id: 'n', label: 'Pages per sheet', type: 'select', options: ['2', '4'] }]
  },

  'images-to-pdf': {
    title: 'Images to PDF',
    desc: 'Combine JPG/PNG images into a single PDF, one image per page, in the order listed.',
    accept: '.jpg,.jpeg,.png',
    multi: true,
    worker: true
  },

  'pdf-to-images': {
    title: 'PDF to Images',
    desc: 'Render every page of a PDF as a PNG image, packaged as a ZIP.',
    accept: '.pdf',
    multi: false,
    action: async () => {
      if (loadedFiles.length !== 1) return setStatus('Add exactly 1 PDF file.', 'error');
      setStatus('Rendering pages...');
      const loadingTask = pdfjsLib.getDocument({ data: loadedFiles[0].bytes });
      const pdf = await loadingTask.promise;
      const zip = new JSZip();
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        const dataUrl = canvas.toDataURL('image/png');
        const base64 = dataUrl.split(',')[1];
        zip.file(`page-${i}.png`, base64, { base64: true });
        setStatus(`Rendered page ${i} of ${pdf.numPages}...`);
      }
      const zipBytes = await zip.generateAsync({ type: 'uint8array' });
      await saveOutput('pdf-images.zip', zipBytes);
    }
  },

  watermark: {
    title: 'Add Watermark',
    desc: 'Stamp a diagonal text watermark on every page.',
    accept: '.pdf',
    multi: false,
    worker: true,
    extraFields: [
      { id: 'text', label: 'Watermark text', type: 'text', placeholder: 'e.g. CONFIDENTIAL' },
      { id: 'opacity', label: 'Opacity (0-1)', type: 'text', placeholder: '0.3' }
    ]
  },

  'page-numbers': {
    title: 'Add Page Numbers',
    desc: 'Print "N / total" at the bottom center of every page.',
    accept: '.pdf',
    multi: false,
    worker: true
  },

  metadata: {
    title: 'Edit Metadata',
    desc: 'Change PDF document properties like title, author, subject, and keywords. Leave a field blank to keep it unchanged.',
    accept: '.pdf',
    multi: false,
    worker: true,
    extraFields: [
      { id: 'title', label: 'Title', type: 'text' },
      { id: 'author', label: 'Author', type: 'text' },
      { id: 'subject', label: 'Subject', type: 'text' },
      { id: 'keywords', label: 'Keywords (comma separated)', type: 'text' }
    ]
  },

  flatten: {
    title: 'Flatten Form',
    desc: 'Flatten all fillable form fields into static, non-editable page content.',
    accept: '.pdf',
    multi: false,
    worker: true
  },

  'create-form': {
    title: 'Create Fillable Form',
    desc: 'Add a single fillable text field to a PDF at a chosen position. Run again to add more fields.',
    accept: '.pdf',
    multi: false,
    worker: true,
    extraFields: [
      { id: 'name', label: 'Field name', type: 'text', placeholder: 'e.g. FullName' },
      { id: 'page', label: 'Page number', type: 'text', placeholder: '1' },
      { id: 'x', label: 'X position (pts from left)', type: 'text', placeholder: '50' },
      { id: 'y', label: 'Y position (pts from bottom)', type: 'text', placeholder: '50' },
      { id: 'width', label: 'Width (pts)', type: 'text', placeholder: '200' },
      { id: 'height', label: 'Height (pts)', type: 'text', placeholder: '20' }
    ]
  },

  bookmarks: {
    title: 'Add Bookmarks',
    desc: 'Add a flat list of bookmarks (experimental — uses low-level PDF APIs, verify in your PDF viewer). One per line, "Title:PageNumber".',
    accept: '.pdf',
    multi: false,
    worker: true,
    extraFields: [{ id: 'list', label: 'Bookmarks', type: 'textarea', placeholder: 'Chapter 1:1\nChapter 2:5' }]
  },

  redact: {
    title: 'Redact PDF (visual)',
    desc: 'Draws an opaque black box over a region on a page. Note: this covers content visually but does not strip the underlying text — for real redaction, also run "PDF to Images" then "Images to PDF" afterward to flatten to a raster image.',
    accept: '.pdf',
    multi: false,
    worker: true,
    extraFields: [
      { id: 'page', label: 'Page number', type: 'text', placeholder: '1' },
      { id: 'x', label: 'X (pts from left)', type: 'text', placeholder: '50' },
      { id: 'y', label: 'Y (pts from bottom)', type: 'text', placeholder: '700' },
      { id: 'width', label: 'Width (pts)', type: 'text', placeholder: '200' },
      { id: 'height', label: 'Height (pts)', type: 'text', placeholder: '20' }
    ]
  },

  repair: {
    title: 'Repair PDF',
    desc: 'Best-effort recovery: re-parses and re-saves a possibly-corrupted PDF. Not guaranteed for severely damaged files.',
    accept: '.pdf',
    multi: false,
    worker: true
  }
};
// ---------------- Custom (non-generic-form) tools ----------------
// These tools need bespoke UI (multi-file-slot comparisons, live text areas,
// dynamic field detection, etc.) so they bypass the generic dropzone panel
// and render themselves via `render(container)`.

Object.assign(TOOLS, {
  'fill-form': {
    title: 'Fill Out PDF',
    custom: true,
    render(container) {
      container.innerHTML = `
        <div class="panel">
          <h2>Fill Out PDF</h2>
          <p class="desc">Load a PDF, fill in its form fields, and save.</p>
          <div class="dropzone" id="ffDrop">Click to open a PDF with form fields</div>
          <div id="ffFields"></div>
          <button class="primary" id="ffSave" style="display:none;">Fill &amp; Save</button>
        </div>
      `;
      let doc = null;
      let fields = [];

      document.getElementById('ffDrop').addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.pdf';
        input.onchange = async () => {
          const file = input.files[0];
          const bytes = await readFileAsUint8(file);
          doc = await PDFDocument.load(bytes);
          const form = doc.getForm();
          fields = form.getFields();
          const fieldsDiv = document.getElementById('ffFields');
          if (!fields.length) {
            fieldsDiv.innerHTML = '<p>No fillable fields found in this PDF.</p>';
            document.getElementById('ffSave').style.display = 'none';
            return;
          }
          fieldsDiv.innerHTML = fields
            .map((f, i) => `<label>${f.getName()} (${f.constructor.name})</label><input type="text" id="ff-${i}">`)
            .join('');
          document.getElementById('ffSave').style.display = 'inline-block';
        };
        input.click();
      });

      document.getElementById('ffSave').addEventListener('click', async () => {
        try {
          fields.forEach((f, i) => {
            const val = document.getElementById(`ff-${i}`).value;
            if (!val) return;
            if (typeof f.setText === 'function') f.setText(val);
            else if (typeof f.select === 'function') {
              try { f.select(val); } catch (e) { /* option didn't match, skip */ }
            } else if (typeof f.check === 'function') {
              if (val.toLowerCase() === 'true' || val === '1') f.check();
            }
          });
          const bytes = await doc.save();
          await saveOutput('filled-form.pdf', bytes);
        } catch (err) {
          setStatus('Error: ' + err.message, 'error');
        }
      });
    }
  },

  compare: {
    title: 'Compare PDFs',
    custom: true,
    render(container) {
      container.innerHTML = `
        <div class="panel">
          <h2>Compare PDFs</h2>
          <p class="desc">Extract text from two PDFs and show a line-by-line diff.</p>
          <div class="dropzone" id="cmpDropA">Click to open PDF A</div>
          <div id="cmpNameA" style="margin-bottom:10px;font-size:13px;color:#555;"></div>
          <div class="dropzone" id="cmpDropB">Click to open PDF B</div>
          <div id="cmpNameB" style="margin-bottom:10px;font-size:13px;color:#555;"></div>
          <button class="primary" id="cmpRun">Compare</button>
          <pre id="cmpResult" style="white-space:pre-wrap;background:#fff;border:1px solid #e1e3e8;padding:12px;margin-top:16px;max-height:400px;overflow:auto;font-size:12px;"></pre>
        </div>
      `;
      let bytesA = null;
      let bytesB = null;

      function pick(dropId, nameId, cb) {
        document.getElementById(dropId).addEventListener('click', () => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.pdf';
          input.onchange = async () => {
            const file = input.files[0];
            document.getElementById(nameId).textContent = file.name;
            cb(await readFileAsUint8(file));
          };
          input.click();
        });
      }
      pick('cmpDropA', 'cmpNameA', (b) => (bytesA = b));
      pick('cmpDropB', 'cmpNameB', (b) => (bytesB = b));

      document.getElementById('cmpRun').addEventListener('click', async () => {
        if (!bytesA || !bytesB) return setStatus('Load both PDF A and PDF B.', 'error');
        setStatus('Extracting text...');
        try {
          const textA = await extractAllText(bytesA);
          const textB = await extractAllText(bytesB);
          const { diffLines } = require('diff');
          const parts = diffLines(textA, textB);
          const resultEl = document.getElementById('cmpResult');
          resultEl.innerHTML = '';
          parts.forEach((part) => {
            const span = document.createElement('span');
            span.textContent = part.value;
            span.style.color = part.added ? '#1e8e3e' : part.removed ? '#c0392b' : '#333';
            span.style.background = part.added ? '#eafaf0' : part.removed ? '#fdecea' : 'transparent';
            resultEl.appendChild(span);
          });
          setStatus('Comparison complete.', 'success');
        } catch (err) {
          setStatus('Error: ' + err.message, 'error');
        }
      });
    }
  },

  'text-to-pdf': {
    title: 'Text to PDF',
    custom: true,
    render(container) {
      container.innerHTML = `
        <div class="panel">
          <h2>Text to PDF</h2>
          <p class="desc">Paste or type text below, then generate a PDF.</p>
          <textarea id="txtInput" rows="14" style="width:100%;max-width:700px;font-family:monospace;padding:10px;"></textarea>
          <br><button class="primary" id="txtRun">Generate PDF</button>
        </div>
      `;
      document.getElementById('txtRun').addEventListener('click', async () => {
        const text = document.getElementById('txtInput').value;
        if (!text.trim()) return setStatus('Enter some text.', 'error');
        setStatus('Generating...');
        try {
          const doc = await PDFDocument.create();
          const font = await doc.embedFont(StandardFonts.Helvetica);
          const fontSize = 11;
          const margin = 50;
          const pageW = 612;
          const pageH = 792;
          const maxWidth = pageW - margin * 2;
          let page = doc.addPage([pageW, pageH]);
          let y = pageH - margin;
          const paragraphs = text.split('\n');
          for (const para of paragraphs) {
            const words = para.split(' ');
            let line = '';
            for (const word of words) {
              const test = line ? line + ' ' + word : word;
              if (font.widthOfTextAtSize(test, fontSize) > maxWidth && line) {
                page.drawText(line, { x: margin, y, size: fontSize, font });
                y -= fontSize * 1.4;
                if (y < margin) {
                  page = doc.addPage([pageW, pageH]);
                  y = pageH - margin;
                }
                line = word;
              } else {
                line = test;
              }
              if (font.widthOfTextAtSize(line, fontSize) > maxWidth && !line.includes(' ')) {
                page.drawText(line, { x: margin, y, size: fontSize, font });
                y -= fontSize * 1.4;
                if (y < margin) {
                  page = doc.addPage([pageW, pageH]);
                  y = pageH - margin;
                }
                line = '';
              }
            }
            page.drawText(line, { x: margin, y, size: fontSize, font });
            y -= fontSize * 1.4;
            if (y < margin) {
              page = doc.addPage([pageW, pageH]);
              y = pageH - margin;
            }
          }
          const bytes = await doc.save();
          await saveOutput('text.pdf', bytes);
        } catch (err) {
          setStatus('Error: ' + err.message, 'error');
        }
      });
    }
  },

  'webpage-to-pdf': {
    title: 'Webpage to PDF',
    custom: true,
    render(container) {
      container.innerHTML = `
        <div class="panel">
          <h2>Webpage to PDF</h2>
          <p class="desc">Enter a full URL (including https://) to render and save as a PDF.</p>
          <input type="text" id="urlInput" placeholder="https://example.com" style="max-width:500px;">
          <br><button class="primary" id="urlRun">Convert</button>
        </div>
      `;
      document.getElementById('urlRun').addEventListener('click', async () => {
        const url = document.getElementById('urlInput').value.trim();
        if (!url) return setStatus('Enter a URL.', 'error');
        setStatus('Loading page and rendering PDF...');
        try {
          const res = await ipcRenderer.invoke('webpage-to-pdf', { url });
          if (!res.ok) return setStatus('Error: ' + res.error, 'error');
          await saveOutput('webpage.pdf', new Uint8Array(res.data));
        } catch (err) {
          setStatus('Error: ' + err.message, 'error');
        }
      });
    }
  },

  'qr-code': {
    title: 'Generate QR Code',
    custom: true,
    render(container) {
      container.innerHTML = `
        <div class="panel">
          <h2>Generate QR Code</h2>
          <p class="desc">Generate a QR code image from text or a URL.</p>
          <input type="text" id="qrInput" placeholder="Text or URL" style="max-width:500px;">
          <br><button class="primary" id="qrRun">Generate &amp; Save PNG</button>
          <div id="qrPreview" style="margin-top:16px;"></div>
        </div>
      `;
      document.getElementById('qrRun').addEventListener('click', async () => {
        const text = document.getElementById('qrInput').value.trim();
        if (!text) return setStatus('Enter text or a URL.', 'error');
        try {
          const QRCode = require('qrcode');
          const dataUrl = await QRCode.toDataURL(text, { width: 400 });
          document.getElementById('qrPreview').innerHTML = `<img src="${dataUrl}" width="200">`;
          const base64 = dataUrl.split(',')[1];
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          await saveOutput('qrcode.png', bytes);
        } catch (err) {
          setStatus('Error: ' + err.message, 'error');
        }
      });
    }
  },

  'generate-password': {
    title: 'Generate Password',
    custom: true,
    render(container) {
      container.innerHTML = `
        <div class="panel">
          <h2>Generate Password</h2>
          <p class="desc">Create a secure random password locally (nothing is sent anywhere).</p>
          <label>Length</label>
          <input type="text" id="pwLength" value="16" style="max-width:100px;">
          <label style="font-weight:normal;margin-top:12px;">
            <input type="checkbox" id="pwSymbols" checked> Include symbols
          </label>
          <br><button class="primary" id="pwGen">Generate</button>
          <div id="pwResult" style="margin-top:16px;font-family:monospace;font-size:20px;background:#fff;border:1px solid #e1e3e8;padding:12px;border-radius:6px;display:inline-block;"></div>
        </div>
      `;
      document.getElementById('pwGen').addEventListener('click', () => {
        const len = Math.min(128, Math.max(4, parseInt(document.getElementById('pwLength').value, 10) || 16));
        const useSymbols = document.getElementById('pwSymbols').checked;
        const chars =
          'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789' + (useSymbols ? '!@#$%^&*()-_=+' : '');
        const arr = new Uint32Array(len);
        crypto.getRandomValues(arr);
        let pw = '';
        for (let i = 0; i < len; i++) pw += chars[arr[i] % chars.length];
        document.getElementById('pwResult').textContent = pw;
      });
    }
  },

  'view-pdf': {
    title: 'View PDF',
    custom: true,
    render(container) {
      container.innerHTML = `
        <div class="panel">
          <h2>View PDF</h2>
          <p class="desc">Simple built-in PDF viewer.</p>
          <div class="dropzone" id="vpDrop">Click to open a PDF</div>
          <div id="vpControls" style="display:none;margin:10px 0;">
            <button id="vpPrev">&laquo; Prev</button>
            <span id="vpPageInfo" style="margin:0 10px;"></span>
            <button id="vpNext">Next &raquo;</button>
          </div>
          <canvas id="vpCanvas" style="border:1px solid #ccc;max-width:100%;"></canvas>
        </div>
      `;
      let pdf = null;
      let pageNum = 1;

      async function renderPage() {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.2 });
        const canvas = document.getElementById('vpCanvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        document.getElementById('vpPageInfo').textContent = `Page ${pageNum} / ${pdf.numPages}`;
      }

      document.getElementById('vpDrop').addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.pdf';
        input.onchange = async () => {
          const file = input.files[0];
          const bytes = await readFileAsUint8(file);
          pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
          pageNum = 1;
          document.getElementById('vpControls').style.display = 'block';
          renderPage();
        };
        input.click();
      });
      document.getElementById('vpPrev').addEventListener('click', () => {
        if (pdf && pageNum > 1) { pageNum--; renderPage(); }
      });
      document.getElementById('vpNext').addEventListener('click', () => {
        if (pdf && pageNum < pdf.numPages) { pageNum++; renderPage(); }
      });
    }
  },

  'convert-image': {
    title: 'Convert Image Format',
    custom: true,
    render(container) {
      container.innerHTML = `
        <div class="panel">
          <h2>Convert Image Format</h2>
          <p class="desc">Convert JPG/PNG/WEBP images to another format (runs locally via canvas).</p>
          <div class="dropzone" id="imgDrop">Click to select image(s)</div>
          <ul class="file-list" id="imgFileList"></ul>
          <label>Target format</label>
          <select id="imgFormat">
            <option value="png">PNG</option>
            <option value="jpeg">JPG</option>
            <option value="webp">WEBP</option>
          </select>
          <br><button class="primary" id="imgRun">Convert</button>
        </div>
      `;
      let files = [];
      function refresh() {
        document.getElementById('imgFileList').innerHTML = files.map((f) => `<li>${f.name}</li>`).join('');
      }
      document.getElementById('imgDrop').addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.jpg,.jpeg,.png,.webp';
        input.multiple = true;
        input.onchange = () => { files = Array.from(input.files); refresh(); };
        input.click();
      });
      document.getElementById('imgRun').addEventListener('click', async () => {
        if (!files.length) return setStatus('Select at least one image.', 'error');
        setStatus('Converting...');
        try {
          const format = document.getElementById('imgFormat').value;
          const zip = new JSZip();
          for (const file of files) {
            const bytes = await readFileAsUint8(file);
            const blob = new Blob([bytes]);
            const bitmap = await createImageBitmap(blob);
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0);
            const mime = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
            const dataUrl = canvas.toDataURL(mime, 0.92);
            const base64 = dataUrl.split(',')[1];
            const base = file.name.replace(/\.[^.]+$/, '');
            zip.file(`${base}.${format === 'jpeg' ? 'jpg' : format}`, base64, { base64: true });
          }
          const zipBytes = await zip.generateAsync({ type: 'uint8array' });
          await saveOutput('converted-images.zip', zipBytes);
        } catch (err) {
          setStatus('Error: ' + err.message, 'error');
        }
      });
    }
  },

  'office-convert': {
    title: 'Office \u2192 PDF (LibreOffice)',
    custom: true,
    render(container) {
      container.innerHTML = `
        <div class="panel">
          <h2>Office &rarr; PDF</h2>
          <p class="desc">Converts Word/PowerPoint/Excel/ODT/RTF files to PDF, using LibreOffice on this computer. This app doesn't bundle LibreOffice itself (that alone would add 300-500MB per platform to the installer) — it detects an existing install, or can fetch one.</p>
          <div id="loStatus" style="margin-bottom:14px;padding:10px 12px;background:#fff;border:1px solid #e1e3e8;border-radius:6px;font-size:13px;"></div>
          <div id="loMissing" style="display:none;margin-bottom:16px;">
            <div id="loLinuxHint" style="display:none;font-size:13px;color:#555;margin-bottom:10px;">
              On Linux, the recommended way is your package manager, e.g.
              <code>sudo apt install libreoffice</code> (Debian/Ubuntu),
              <code>sudo dnf install libreoffice</code> (Fedora), or
              <code>sudo pacman -S libreoffice-fresh</code> (Arch).
            </div>
            <button class="primary" id="loDownloadBtn">Get LibreOffice</button>
            <div id="loProgress" style="display:none;margin-top:10px;font-size:13px;"></div>
            <button id="loRecheckBtn" style="margin-left:8px;">I installed it \u2014 Recheck</button>
          </div>
          <div id="loReady" style="display:none;">
            <div class="dropzone" id="ofDrop">Click to open a file to convert</div>
            <div id="ofFileName" style="margin-bottom:10px;font-size:13px;color:#555;"></div>
            <div id="ofPdfNote" style="display:none;font-size:13px;color:#c0392b;margin-bottom:10px;max-width:500px;">
              PDF &rarr; Office isn't offered here: LibreOffice imports a PDF as a page image (a Draw document), not
              as editable text, so a direct "convert to docx" produces no usable result — this was tested and
              confirmed while building this tool, not assumed. For a PDF you need to edit, "OCR PDF" (in the
              sidebar) will get you the text content, though not full layout/formatting.
            </div>
            <label>Convert to</label>
            <select id="ofTarget"></select>
            <br><button class="primary" id="ofRun">Convert</button>
          </div>
        </div>
      `;

      let sofficePath = null;
      let selectedFile = null;

      async function checkLO() {
        document.getElementById('loStatus').textContent = 'Checking for LibreOffice on this computer...';
        const res = await ipcRenderer.invoke('check-libreoffice');
        if (res.found) {
          sofficePath = res.path;
          document.getElementById('loStatus').textContent = `Found LibreOffice (${res.version || res.path}). Ready to convert.`;
          document.getElementById('loMissing').style.display = 'none';
          document.getElementById('loReady').style.display = 'block';
        } else {
          document.getElementById('loStatus').textContent =
            'LibreOffice was not found on this computer \u2014 this tool needs it installed to convert Office documents.';
          document.getElementById('loMissing').style.display = 'block';
          document.getElementById('loReady').style.display = 'none';
          document.getElementById('loLinuxHint').style.display = res.platform === 'linux' ? 'block' : 'none';
        }
      }
      checkLO();

      document.getElementById('loRecheckBtn').addEventListener('click', checkLO);

      document.getElementById('loDownloadBtn').addEventListener('click', async () => {
        const btn = document.getElementById('loDownloadBtn');
        const progressEl = document.getElementById('loProgress');
        btn.disabled = true;
        progressEl.style.display = 'block';
        progressEl.textContent = 'Looking up the current LibreOffice version...';

        const onProgress = (event, fraction) => {
          progressEl.textContent = `Downloading LibreOffice: ${Math.round(fraction * 100)}%`;
        };
        ipcRenderer.on('libreoffice-download-progress', onProgress);

        try {
          const res = await ipcRenderer.invoke('download-libreoffice');
          if (res.mode === 'downloaded') {
            progressEl.textContent = `Downloaded to ${res.path}. Opening the installer \u2014 finish the install, then click "I installed it".`;
            await ipcRenderer.invoke('open-path', res.path);
          } else {
            // Automatic download failed (network hiccup, version-resolve
            // failure, etc.) — we already opened the official download page
            // as a fallback, which auto-detects the right build for you.
            progressEl.textContent =
              'Could not download automatically, so I opened the official LibreOffice download page in your browser instead \u2014 grab it there, then click "I installed it".';
          }
        } catch (err) {
          progressEl.textContent = 'Error: ' + err.message;
        } finally {
          ipcRenderer.removeListener('libreoffice-download-progress', onProgress);
          btn.disabled = false;
        }
      });

      const targetSelect = document.getElementById('ofTarget');
      function updateTargetOptions(fileName) {
        const ext = (fileName.split('.').pop() || '').toLowerCase();
        if (ext === 'pdf') {
          targetSelect.innerHTML = '<option value="" disabled selected>Not supported (see note below)</option>';
          document.getElementById('ofPdfNote').style.display = 'block';
        } else {
          targetSelect.innerHTML = '<option value="pdf">PDF</option>';
          document.getElementById('ofPdfNote').style.display = 'none';
        }
      }

      document.getElementById('ofDrop').addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.ods,.odp,.rtf';
        input.onchange = async () => {
          const file = input.files[0];
          const bytes = await readFileAsUint8(file);
          selectedFile = { name: file.name, bytes };
          document.getElementById('ofFileName').textContent = file.name;
          updateTargetOptions(file.name);
        };
        input.click();
      });

      document.getElementById('ofRun').addEventListener('click', async () => {
        if (!selectedFile) return setStatus('Choose a file first.', 'error');
        if (!sofficePath) return setStatus('LibreOffice not detected.', 'error');
        const target = targetSelect.value;
        if (!target) return setStatus('This file type isn\'t supported by this tool (see the note above).', 'error');
        setStatus('Converting via LibreOffice (the first run can take a little longer while it starts up)...');
        try {
          const res = await ipcRenderer.invoke('convert-with-libreoffice', {
            sofficePath,
            fileName: selectedFile.name,
            fileBytes: Array.from(selectedFile.bytes),
            targetFormat: target
          });
          if (!res.ok) return setStatus('Conversion failed: ' + res.error, 'error');
          await saveOutput(res.filename, new Uint8Array(res.bytes));
        } catch (err) {
          setStatus('Error: ' + err.message, 'error');
        }
      });
    }
  },

  ocr: {
    title: 'OCR PDF (extract text)',
    custom: true,
    render(container) {
      container.innerHTML = `
        <div class="panel">
          <h2>OCR PDF (extract text)</h2>
          <p class="desc">Runs optical character recognition on a scanned/image PDF and extracts the text, using Tesseract OCR running locally (WASM) \u2014 nothing is uploaded anywhere. The first run needs an internet connection to fetch the English language data (a few MB); after that it's cached and works offline.</p>
          <div class="dropzone" id="ocrDrop">Click to open a PDF</div>
          <div id="ocrFileName" style="margin-bottom:10px;font-size:13px;color:#555;"></div>
          <button class="primary" id="ocrRun">Run OCR &amp; Save Text</button>
          <pre id="ocrResult" style="white-space:pre-wrap;background:#fff;border:1px solid #e1e3e8;padding:12px;margin-top:16px;max-height:300px;overflow:auto;font-size:12px;"></pre>
        </div>
      `;
      let bytes = null;

      document.getElementById('ocrDrop').addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.pdf';
        input.onchange = async () => {
          const file = input.files[0];
          document.getElementById('ocrFileName').textContent = file.name;
          bytes = await readFileAsUint8(file);
        };
        input.click();
      });

      document.getElementById('ocrRun').addEventListener('click', async () => {
        if (!bytes) return setStatus('Choose a PDF first.', 'error');
        setStatus('Starting OCR engine (may download language data on first use)...');
        let worker = null;
        try {
          const { createWorker } = require('tesseract.js');
          worker = await createWorker('eng');
          const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
          let fullText = '';
          for (let i = 1; i <= pdf.numPages; i++) {
            setStatus(`OCR: page ${i} of ${pdf.numPages}...`);
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 2 });
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext('2d');
            await page.render({ canvasContext: ctx, viewport }).promise;
            const { data } = await worker.recognize(canvas.toDataURL('image/png'));
            fullText += `--- Page ${i} ---\n${data.text}\n\n`;
          }
          document.getElementById('ocrResult').textContent = fullText;
          await saveOutput('ocr-text.txt', new TextEncoder().encode(fullText));
          setStatus('OCR complete.', 'success');
        } catch (err) {
          setStatus('OCR error: ' + err.message, 'error');
        } finally {
          if (worker) await worker.terminate();
        }
      });
    }
  }
});

function parsePageRanges(input, pageCount) {
  if (!input) return [];
  const result = new Set();
  input.split(',').forEach((part) => {
    part = part.trim();
    if (!part) return;
    if (part.includes('-')) {
      const [a, b] = part.split('-').map((n) => parseInt(n.trim(), 10));
      if (Number.isInteger(a) && Number.isInteger(b)) {
        for (let i = a; i <= b; i++) if (i >= 1 && i <= pageCount) result.add(i - 1);
      }
    } else {
      const n = parseInt(part, 10);
      if (Number.isInteger(n) && n >= 1 && n <= pageCount) result.add(n - 1);
    }
  });
  return Array.from(result);
}

// ---------------- Panel rendering ----------------

function renderPanel(toolKey) {
  loadedFiles = [];
  const tool = TOOLS[toolKey];
  setStatus('');

  if (tool.custom) {
    panelsEl.innerHTML = '';
    tool.render(panelsEl);
    return;
  }

  panelsEl.innerHTML = `
    <div class="panel">
      <h2>${tool.title}</h2>
      <p class="desc">${tool.desc}</p>
      <div class="dropzone" id="dropzone">
        Drag &amp; drop file(s) here, or click to browse
      </div>
      <ul class="file-list" id="fileList"></ul>
      ${(tool.extraFields || [])
        .map((f) => `
          <label for="field-${f.id}">${f.label}</label>
          ${
            f.type === 'select'
              ? `<select id="field-${f.id}">${f.options.map((o) => `<option value="${o}">${o}°</option>`).join('')}</select>`
              : f.type === 'textarea'
              ? `<textarea id="field-${f.id}" placeholder="${f.placeholder || ''}" rows="4" style="width:100%;max-width:400px;"></textarea>`
              : `<input type="text" id="field-${f.id}" placeholder="${f.placeholder || ''}">`
          }
        `)
        .join('')}
      <br>
      <button class="primary" id="runBtn">${tool.title}</button>
    </div>
  `;

  const dropzone = document.getElementById('dropzone');
  const fileListEl = document.getElementById('fileList');
  const runBtn = document.getElementById('runBtn');

  function refreshFileList() {
    fileListEl.innerHTML = loadedFiles
      .map(
        (f, i) => `<li>${f.name} <button data-i="${i}">Remove</button></li>`
      )
      .join('');
    fileListEl.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        loadedFiles.splice(parseInt(btn.dataset.i, 10), 1);
        refreshFileList();
      });
    });
  }

  async function addFiles(fileObjs) {
    for (const file of fileObjs) {
      if (!tool.multi && loadedFiles.length >= 1) loadedFiles = [];
      const bytes = await readFileAsUint8(file);
      loadedFiles.push({ name: file.name, bytes });
    }
    refreshFileList();
  }

  dropzone.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = tool.accept;
    input.multiple = !!tool.multi;
    input.onchange = () => addFiles(Array.from(input.files));
    input.click();
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    addFiles(Array.from(e.dataTransfer.files));
  });

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    setStatus('Processing...');
    try {
      const values = {};
      (tool.extraFields || []).forEach((f) => {
        values[f.id] = document.getElementById(`field-${f.id}`).value;
      });
      if (tool.worker) {
        const { filename, bytes } = await runInWorker(toolKey, values, loadedFiles);
        await saveOutput(filename, bytes);
      } else {
        await tool.action(values);
      }
    } catch (err) {
      console.error(err);
      setStatus('Error: ' + err.message, 'error');
    } finally {
      runBtn.disabled = false;
    }
  });
}

toolListEl.querySelectorAll('li').forEach((li) => {
  li.addEventListener('click', () => {
    toolListEl.querySelectorAll('li').forEach((x) => x.classList.remove('active'));
    li.classList.add('active');
    renderPanel(li.dataset.tool);
  });
});

// initial panel
renderPanel('merge');
