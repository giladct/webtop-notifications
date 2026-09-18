// Minimal local server so the "צור סיכום להיום" dashboard button can trigger a
// fresh scrape + digest build on demand. Static files (index.html, digest.html,
// etc.) are served from this directory; only works when run locally via
// `node server.js` — the public GitHub Pages copy has no backend, so there the
// button just shows a fallback message.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = __dirname;
const PORT = process.env.PORT || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

let generating = false;

function runDigestGeneration() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(DIR, 'check-notifications.js')], { cwd: DIR });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => {
      if (code === 0 || code === 2) resolve(); // 2 = session expired but still wrote pages
      else reject(new Error(stderr || `exit code ${code}`));
    });
    child.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/generate-digest') {
    if (generating) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'already running' }));
      return;
    }
    generating = true;
    try {
      await runDigestGeneration();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    } finally {
      generating = false;
    }
    return;
  }

  let filePath = req.url.split('?')[0];
  if (filePath === '/') filePath = '/index.html';
  const full = path.normalize(path.join(DIR, decodeURIComponent(filePath)));
  if (!full.startsWith(DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(full);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Webtop reports running at http://localhost:${PORT}/`);
});
