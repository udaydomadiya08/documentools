// Pure PDF processing logic — no DOM, no Electron renderer globals.
// This runs inside the Web Worker (worker.js) so heavy jobs don't freeze
// the main window. Every export takes (files, values, onProgress) and
// returns { bytes, filename }.

const {
  PDFDocument,
  degrees,
  rgb,
  StandardFonts,
  PDFName,
  PDFString,
  PDFNumber,
  PDFDict
} = require('pdf-lib');
const JSZip = require('jszip');

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

// Experimental: builds a flat outline/bookmark tree using pdf-lib's
// low-level object APIs (verified to round-trip correctly via pdfjs-dist).
function addOutline(doc, items) {
  const context = doc.context;
  const pages = doc.getPages();
  const outlineRef = context.nextRef();
  const itemRefs = items.map(() => context.nextRef());

  items.forEach((item, i) => {
    const map = new Map();
    map.set(PDFName.of('Title'), PDFString.of(item.title));
    map.set(PDFName.of('Parent'), outlineRef);
    map.set(PDFName.of('Dest'), context.obj([pages[item.pageIndex].ref, PDFName.of('Fit')]));
    if (i > 0) map.set(PDFName.of('Prev'), itemRefs[i - 1]);
    if (i < items.length - 1) map.set(PDFName.of('Next'), itemRefs[i + 1]);
    context.assign(itemRefs[i], PDFDict.fromMapWithContext(map, context));
  });

  const outlineMap = new Map();
  outlineMap.set(PDFName.of('Type'), PDFName.of('Outlines'));
  outlineMap.set(PDFName.of('First'), itemRefs[0]);
  outlineMap.set(PDFName.of('Last'), itemRefs[itemRefs.length - 1]);
  outlineMap.set(PDFName.of('Count'), PDFNumber.of(items.length));
  context.assign(outlineRef, PDFDict.fromMapWithContext(outlineMap, context));

  doc.catalog.set(PDFName.of('Outlines'), outlineRef);
}

module.exports = {
  merge: async (files) => {
    if (files.length < 2) throw new Error('Add at least 2 PDF files.');
    const out = await PDFDocument.create();
    for (const f of files) {
      const src = await PDFDocument.load(f.bytes);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    }
    return { bytes: await out.save(), filename: 'merged.pdf' };
  },

  split: async (files, values, onProgress) => {
    if (files.length !== 1) throw new Error('Add exactly 1 PDF file.');
    const src = await PDFDocument.load(files[0].bytes);
    const zip = new JSZip();
    const count = src.getPageCount();
    for (let i = 0; i < count; i++) {
      const out = await PDFDocument.create();
      const [page] = await out.copyPages(src, [i]);
      out.addPage(page);
      zip.file(`page-${i + 1}.pdf`, await out.save());
      if (onProgress) onProgress(`Splitting page ${i + 1} of ${count}...`);
    }
    return { bytes: await zip.generateAsync({ type: 'uint8array' }), filename: 'split-pages.zip' };
  },

  rotate: async (files, values) => {
    if (files.length !== 1) throw new Error('Add exactly 1 PDF file.');
    const angle = parseInt(values.angle, 10) || 90;
    const doc = await PDFDocument.load(files[0].bytes);
    doc.getPages().forEach((page) => page.setRotation(degrees(page.getRotation().angle + angle)));
    return { bytes: await doc.save(), filename: 'rotated.pdf' };
  },

  remove: async (files, values) => {
    if (files.length !== 1) throw new Error('Add exactly 1 PDF file.');
    const doc = await PDFDocument.load(files[0].bytes);
    const toRemove = parsePageRanges(values.pages, doc.getPageCount());
    if (!toRemove.length) throw new Error('Enter valid page numbers.');
    toRemove.sort((a, b) => b - a).forEach((idx) => doc.removePage(idx));
    return { bytes: await doc.save(), filename: 'removed-pages.pdf' };
  },

  extract: async (files, values) => {
    if (files.length !== 1) throw new Error('Add exactly 1 PDF file.');
    const src = await PDFDocument.load(files[0].bytes);
    const indices = parsePageRanges(values.pages, src.getPageCount()).sort((a, b) => a - b);
    if (!indices.length) throw new Error('Enter valid page numbers.');
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, indices);
    pages.forEach((p) => out.addPage(p));
    return { bytes: await out.save(), filename: 'extracted-pages.pdf' };
  },

  reorder: async (files, values) => {
    if (files.length !== 1) throw new Error('Add exactly 1 PDF file.');
    const src = await PDFDocument.load(files[0].bytes);
    const count = src.getPageCount();
    const order = (values.order || '')
      .split(',')
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((n) => n >= 0 && n < count);
    if (order.length !== count) throw new Error(`Order must list all ${count} pages exactly once.`);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, order);
    pages.forEach((p) => out.addPage(p));
    return { bytes: await out.save(), filename: 'reordered.pdf' };
  },

  'page-size': async (files, values) => {
    if (files.length !== 1) throw new Error('Add exactly 1 PDF file.');
    const sizes = { A4: [595.28, 841.89], Letter: [612, 792], Legal: [612, 1008] };
    const [targetW, targetH] = sizes[values.size] || sizes.A4;
    const src = await PDFDocument.load(files[0].bytes);
    const out = await PDFDocument.create();
    const embedded = await out.embedPdf(src, src.getPageIndices());
    embedded.forEach((ep) => {
      const page = out.addPage([targetW, targetH]);
      const scale = Math.min(targetW / ep.width, targetH / ep.height);
      const w = ep.width * scale;
      const h = ep.height * scale;
      page.drawPage(ep, { x: (targetW - w) / 2, y: (targetH - h) / 2, width: w, height: h });
    });
    return { bytes: await out.save(), filename: 'resized.pdf' };
  },

  'n-up': async (files, values, onProgress) => {
    if (files.length !== 1) throw new Error('Add exactly 1 PDF file.');
    const n = parseInt(values.n, 10) || 2;
    const src = await PDFDocument.load(files[0].bytes);
    const out = await PDFDocument.create();
    const embedded = await out.embedPdf(src, src.getPageIndices());
    // Detect source page orientation to choose best sheet layout
    const firstPage = embedded[0];
    const srcW = firstPage.width;
    const srcH = firstPage.height;
    const srcPortrait = srcH >= srcW;
    // For portrait sources: use landscape sheet so pages fit side-by-side
    // For landscape sources: use portrait sheet so pages stack naturally
    let sheetW, sheetH;
    if (srcPortrait) {
      sheetW = 841.89; // A4 landscape width
      sheetH = 595.28; // A4 landscape height
    } else {
      sheetW = 595.28; // A4 portrait width
      sheetH = 841.89; // A4 portrait height
    }
    const cols = 2;
    const rows = n === 4 ? 2 : 1;
    const cellW = sheetW / cols;
    const cellH = sheetH / rows;
    for (let i = 0; i < embedded.length; i += n) {
      const page = out.addPage([sheetW, sheetH]);
      for (let j = 0; j < n && i + j < embedded.length; j++) {
        const ep = embedded[i + j];
        const col = j % cols;
        const row = Math.floor(j / cols);
        const scale = Math.min(cellW / ep.width, cellH / ep.height) * 0.95;
        const w = ep.width * scale;
        const h = ep.height * scale;
        const x = col * cellW + (cellW - w) / 2;
        const y = sheetH - (row + 1) * cellH + (cellH - h) / 2;
        page.drawPage(ep, { x, y, width: w, height: h });
      }
      if (onProgress) onProgress(`Laying out sheet ${Math.floor(i / n) + 1}...`);
    }
    return { bytes: await out.save(), filename: 'n-up.pdf' };
  },

  'images-to-pdf': async (files) => {
    if (!files.length) throw new Error('Add at least 1 image.');
    const doc = await PDFDocument.create();
    for (const f of files) {
      const isPng = f.name.toLowerCase().endsWith('.png');
      const img = isPng ? await doc.embedPng(f.bytes) : await doc.embedJpg(f.bytes);
      const page = doc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }
    return { bytes: await doc.save(), filename: 'images.pdf' };
  },

  watermark: async (files, values) => {
    if (files.length !== 1) throw new Error('Add exactly 1 PDF file.');
    const text = (values.text || 'WATERMARK').trim();
    const opacity = Math.min(1, Math.max(0, parseFloat(values.opacity) || 0.3));
    const doc = await PDFDocument.load(files[0].bytes);
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    doc.getPages().forEach((page) => {
      const { width, height } = page.getSize();
      const size = Math.min(width, height) / 10;
      page.drawText(text, {
        x: width / 2 - (text.length * size) / 4,
        y: height / 2,
        size,
        font,
        color: rgb(0.5, 0.5, 0.5),
        opacity,
        rotate: degrees(45)
      });
    });
    return { bytes: await doc.save(), filename: 'watermarked.pdf' };
  },

  'page-numbers': async (files) => {
    if (files.length !== 1) throw new Error('Add exactly 1 PDF file.');
    const doc = await PDFDocument.load(files[0].bytes);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    pages.forEach((page, i) => {
      const { width } = page.getSize();
      const label = `${i + 1} / ${pages.length}`;
      page.drawText(label, { x: width / 2 - label.length * 3, y: 20, size: 10, font, color: rgb(0, 0, 0) });
    });
    return { bytes: await doc.save(), filename: 'numbered.pdf' };
  },

  metadata: async (files, values) => {
    if (files.length !== 1) throw new Error('Add exactly 1 PDF file.');
    const doc = await PDFDocument.load(files[0].bytes);
    if (values.title) doc.setTitle(values.title);
    if (values.author) doc.setAuthor(values.author);
    if (values.subject) doc.setSubject(values.subject);
    if (values.keywords) doc.setKeywords(values.keywords.split(',').map((s) => s.trim()));
    return { bytes: await doc.save(), filename: 'metadata-updated.pdf' };
  },

  crop: async (files, values) => {
    if (files.length !== 1) throw new Error('Add exactly 1 PDF file.');
    const margin = parseFloat(values.margin) || 0;
    const doc = await PDFDocument.load(files[0].bytes);
    doc.getPages().forEach((page) => {
      const { width, height } = page.getSize();
      page.setCropBox(margin, margin, width - margin * 2, height - margin * 2);
    });
    return { bytes: await doc.save(), filename: 'cropped.pdf' };
  },

  flatten: async (files) => {
    if (files.length !== 1) throw new Error('Add exactly 1 PDF file.');
    const doc = await PDFDocument.load(files[0].bytes);
    doc.getForm().flatten();
    return { bytes: await doc.save(), filename: 'flattened.pdf' };
  },

  'create-form': async (files, values) => {
    if (files.length !== 1) throw new Error('Add exactly 1 PDF file.');
    const doc = await PDFDocument.load(files[0].bytes);
    const form = doc.getForm();
    const pageIdx = (parseInt(values.page, 10) || 1) - 1;
    const page = doc.getPages()[pageIdx];
    if (!page) throw new Error('Invalid page number.');
    const field = form.createTextField(values.name || 'Field1');
    field.addToPage(page, {
      x: parseFloat(values.x) || 50,
      y: parseFloat(values.y) || 50,
      width: parseFloat(values.width) || 200,
      height: parseFloat(values.height) || 20
    });
    return { bytes: await doc.save(), filename: 'form-with-field.pdf' };
  },

  redact: async (files, values) => {
    if (files.length !== 1) throw new Error('Add exactly 1 PDF file.');
    const doc = await PDFDocument.load(files[0].bytes);
    const pageIdx = (parseInt(values.page, 10) || 1) - 1;
    const page = doc.getPages()[pageIdx];
    if (!page) throw new Error('Invalid page number.');
    page.drawRectangle({
      x: parseFloat(values.x) || 0,
      y: parseFloat(values.y) || 0,
      width: parseFloat(values.width) || 100,
      height: parseFloat(values.height) || 20,
      color: rgb(0, 0, 0)
    });
    return { bytes: await doc.save(), filename: 'redacted.pdf' };
  },

  repair: async (files) => {
    if (files.length !== 1) throw new Error('Add exactly 1 PDF file.');
    const doc = await PDFDocument.load(files[0].bytes, {
      ignoreEncryption: true,
      updateMetadata: false
    });
    return { bytes: await doc.save({ useObjectStreams: false }), filename: 'repaired.pdf' };
  },

  bookmarks: async (files, values) => {
    if (files.length !== 1) throw new Error('Add exactly 1 PDF file.');
    const doc = await PDFDocument.load(files[0].bytes);
    const count = doc.getPageCount();
    const items = (values.list || '')
      .split('\n')
      .map((line) => {
        const idx = line.lastIndexOf(':');
        if (idx === -1) return null;
        const title = line.slice(0, idx).trim();
        const page = parseInt(line.slice(idx + 1).trim(), 10);
        if (!title || !page || page < 1 || page > count) return null;
        return { title, pageIndex: page - 1 };
      })
      .filter(Boolean);
    if (!items.length) throw new Error('Enter at least one valid "Title:Page" line.');
    addOutline(doc, items);
    return { bytes: await doc.save(), filename: 'bookmarked.pdf' };
  }
};
