// Runs inside a dedicated Web Worker (see main.js: nodeIntegrationInWorker
// is enabled, so this file can require() node_modules just like the main
// renderer). Keeping this off the main thread means the UI stays responsive
// — buttons, drag&drop, and other panels keep working — while a big merge/
// split/rotate/etc. job runs in the background.

const ops = require('./pdf-ops.js');

self.onmessage = async (event) => {
  const { id, tool, values, files } = event.data;
  try {
    const fileObjs = files.map((f) => ({ name: f.name, bytes: new Uint8Array(f.bytes) }));
    const onProgress = (message) => self.postMessage({ id, type: 'progress', message });

    const op = ops[tool];
    if (!op) throw new Error('Unknown worker tool: ' + tool);

    const { bytes, filename } = await op(fileObjs, values || {}, onProgress);

    // Transfer the underlying ArrayBuffer back (zero-copy) rather than
    // cloning it a second time.
    self.postMessage({ id, type: 'result', filename, bytes: bytes.buffer }, [bytes.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err.message });
  }
};
