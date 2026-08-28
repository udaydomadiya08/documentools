const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { execFile, spawn } = require('child_process');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    title: 'PDF Toolkit',
    webPreferences: {
      // Simple single-purpose desktop tool: nodeIntegration is enabled so the
      // renderer can use pdf-lib / pdfjs-dist / jszip directly via require().
      // nodeIntegrationInWorker lets worker.js do the same inside a Web
      // Worker, so heavy PDF jobs run off the main UI thread without
      // freezing the window.
      // Only load trusted local files in this window (no remote content).
      nodeIntegration: true,
      nodeIntegrationInWorker: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Save a Buffer/Uint8Array to disk via native "Save As" dialog.
ipcMain.handle('save-file', async (event, { defaultName, data }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, Buffer.from(data));
  return { ok: true, filePath };
});

// Render a live webpage and return it as PDF bytes.
ipcMain.handle('webpage-to-pdf', async (event, { url }) => {
  const win = new BrowserWindow({ show: false });
  const loadTimeout = setTimeout(() => {
    try { win.destroy(); } catch (e) {}
  }, 30000);
  try {
    await win.loadURL(url);
    const data = await win.webContents.printToPDF({});
    return { ok: true, data: Array.from(data) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(loadTimeout);
    try { win.destroy(); } catch (e) {}
  }
});

// Open one or more files and return their paths + raw bytes.
ipcMain.handle('open-files', async (event, { filters, multi }) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: filters || [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (canceled) return { ok: false, files: [] };
  const files = filePaths.map((p) => ({
    name: path.basename(p),
    data: Array.from(fs.readFileSync(p))
  }));
  return { ok: true, files };
});

// ---------------- LibreOffice integration (Office <-> PDF) ----------------
// We don't bundle LibreOffice (it would add 300-500MB per platform to the
// installer). Instead: detect it if already installed, and if not, offer to
// grab it — a real download with progress for Windows/Mac, since their
// installer files are well-defined; a package-manager pointer for Linux,
// since that's the normal/expected way to install software there and covers
// far more distros correctly than one hardcoded binary URL could.

function candidateSofficePaths() {
  if (process.platform === 'win32') {
    return [
      'soffice.exe',
      'soffice',
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
    ];
  }
  if (process.platform === 'darwin') {
    return ['/Applications/LibreOffice.app/Contents/MacOS/soffice', 'soffice'];
  }
  return ['soffice', 'libreoffice', '/usr/bin/soffice', '/usr/bin/libreoffice'];
}

function trySoffice(cmd) {
  return new Promise((resolve) => {
    execFile(cmd, ['--version'], { timeout: 6000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve({ path: cmd, version: (stdout || '').trim() });
    });
  });
}

ipcMain.handle('check-libreoffice', async () => {
  for (const cmd of candidateSofficePaths()) {
    const result = await trySoffice(cmd);
    if (result) return { found: true, ...result };
  }
  return { found: false, platform: process.platform };
});

function httpsGetText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          return resolve(httpsGetText(res.headers.location, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function httpsDownloadFile(url, destPath, onProgress, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          return resolve(httpsDownloadFile(res.headers.location, destPath, onProgress, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const fileStream = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress && total) onProgress(received / total);
        });
        res.pipe(fileStream);
        fileStream.on('finish', () => fileStream.close(() => resolve(destPath)));
        fileStream.on('error', reject);
      })
      .on('error', reject);
    req.setTimeout(300000, () => { req.destroy(); reject(new Error('Download timed out')); });
  });
}

// Finds the latest stable version folder by listing the official index,
// rather than hardcoding a version number that would go stale.
async function resolveLatestLibreOfficeVersion() {
  const html = await httpsGetText('https://download.documentfoundation.org/libreoffice/stable/');
  const versions = Array.from(html.matchAll(/href="(\d+\.\d+\.\d+)\/"/g)).map((m) => m[1]);
  if (!versions.length) throw new Error('Could not read the version listing.');
  versions.sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
    return 0;
  });
  return versions[0];
}

function buildLibreOfficeUrl(version) {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const archLabel = arch === 'aarch64' ? 'aarch64' : 'x86-64';
  if (process.platform === 'win32') {
    const fileName = `LibreOffice_${version}_Win_${archLabel}.msi`;
    return { url: `https://download.documentfoundation.org/libreoffice/stable/${version}/win/${arch}/${fileName}`, fileName };
  }
  if (process.platform === 'darwin') {
    const fileName = `LibreOffice_${version}_MacOS_${archLabel}.dmg`;
    return { url: `https://download.documentfoundation.org/libreoffice/stable/${version}/mac/${arch}/${fileName}`, fileName };
  }
  // Linux: handled separately (package manager guidance), not reached.
  const fileName = `LibreOffice_${version}_Linux_${archLabel}_deb.tar.gz`;
  return { url: `https://download.documentfoundation.org/libreoffice/stable/${version}/deb/${arch}/${fileName}`, fileName };
}

// Attempts a real, automatic download (Windows/Mac). Always falls back to
// opening the official download page if anything about the resolve/download
// step fails, so the user is never left stuck on a broken URL.
ipcMain.handle('download-libreoffice', async () => {
  try {
    const version = await resolveLatestLibreOfficeVersion();
    const { url, fileName } = buildLibreOfficeUrl(version);
    const destPath = path.join(app.getPath('downloads'), fileName);
    await httpsDownloadFile(url, destPath, (fraction) => {
      if (mainWindow) mainWindow.webContents.send('libreoffice-download-progress', fraction);
    });
    return { ok: true, mode: 'downloaded', path: destPath, version };
  } catch (err) {
    // Fallback: open the official page, which auto-detects the right build.
    await shell.openExternal('https://www.libreoffice.org/download/download-libreoffice/');
    return { ok: true, mode: 'opened-browser', error: err.message };
  }
});

ipcMain.handle('open-libreoffice-download-page', async () => {
  await shell.openExternal('https://www.libreoffice.org/download/download-libreoffice/');
  return { ok: true };
});

ipcMain.handle('open-path', async (event, targetPath) => {
  const err = await shell.openPath(targetPath);
  return { ok: !err, error: err || null };
});

// Convert a document via a locally-installed LibreOffice (headless).
ipcMain.handle('convert-with-libreoffice', async (event, { sofficePath, fileName, fileBytes, targetFormat }) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdftoolkit-'));
  try {
    const inputPath = path.join(tmpDir, fileName);
    fs.writeFileSync(inputPath, Buffer.from(fileBytes));

    await new Promise((resolve, reject) => {
      const proc = spawn(sofficePath, ['--headless', '--convert-to', targetFormat, '--outdir', tmpDir, inputPath]);
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error('LibreOffice conversion timed out after 120 seconds'));
      }, 120000);
      proc.stderr.on('data', (d) => (stderr += d));
      proc.on('error', (err) => { clearTimeout(timer); reject(err); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error('LibreOffice exited with code ' + code + (stderr ? ': ' + stderr.slice(0, 300) : '')));
      });
    });

    const baseName = fileName.replace(/\.[^.]+$/, '');
    const outputPath = path.join(tmpDir, `${baseName}.${targetFormat}`);
    if (!fs.existsSync(outputPath)) throw new Error('Conversion did not produce an output file.');
    const outBytes = fs.readFileSync(outputPath);
    return { ok: true, bytes: Array.from(outBytes), filename: `${baseName}.${targetFormat}` };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
