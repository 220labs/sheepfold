#!/usr/bin/env node
// Renders media/icon.svg to build/icon.png (128 px, transparent corners): the Marketplace and
// Open VSX want a PNG, and the repo keeps no binaries, so the PNG is built at check time and
// never committed. Headless Chrome is the renderer because both the Mac and CI's ubuntu runner
// have it (macOS's qlmanage is Mac-only). Standard library only.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SIZE = 128;
const OUT = path.join(ROOT, 'build', 'icon.png');

function chrome() {
  const candidates = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error('no Chrome found; set CHROME to its path');
  return found;
}

/**
 * The last lines Chrome wrote to stderr, for an error message: on success it is noise (GPU and
 * sandbox chatter), but when no PNG comes back it is the only account of why.
 */
function tail(text, lines = 15) {
  const kept = text.trimEnd().split('\n').slice(-lines).join('\n');
  return kept ? `Chrome's stderr, last lines:\n${kept}` : 'Chrome wrote nothing to stderr';
}

/** Width and height from a PNG's IHDR chunk, or null when the file is not a PNG. */
function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.readUInt32BE(12) !== 0x49484452) return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sheepfold-icon-'));
  const svg = fs.readFileSync(path.join(ROOT, 'media', 'icon.svg'), 'utf8');
  const page = path.join(tmp, 'icon.html');
  // The page draws the SVG on a SIZE-pixel canvas and writes the PNG's data URL into the DOM;
  // --dump-dom prints it. No screenshot: headless Chrome's window is at least 500 px wide and
  // 87 px shorter than asked, so a 128 px shot cannot be had (measured 2026-10-10).
  fs.writeFileSync(
    page,
    `<!doctype html><html><body><pre id="out"></pre><script>
const img = new Image();
img.onload = () => {
  const c = document.createElement('canvas');
  c.width = c.height = ${SIZE};
  c.getContext('2d').drawImage(img, 0, 0, ${SIZE}, ${SIZE});
  document.getElementById('out').textContent = c.toDataURL('image/png');
};
img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
</script></body></html>`,
  );
  let stderr = '';
  const dom = await new Promise((resolve, reject) => {
    const proc = spawn(
      chrome(),
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--virtual-time-budget=5000',
        `--user-data-dir=${path.join(tmp, 'profile')}`,
        '--dump-dom',
        `file://${page}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    // Read as it comes (an unread pipe can fill and stall Chrome); only the last 64 KB is kept.
    proc.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-64 * 1024);
    });
    proc.stdout.on('data', (d) => {
      out += d;
      // In a sandboxed session Chrome prints the DOM and never exits: stop it once it has.
      if (out.includes('</html>')) proc.kill();
    });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Chrome printed no DOM in 30 s\n${tail(stderr)}`));
    }, 30_000);
    // 'close', not 'exit': only then have stdout and stderr been read to the end.
    proc.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
    proc.on('error', reject);
  });
  const m = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(dom);
  if (!m) throw new Error(`the page produced no PNG\n${tail(stderr)}`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(m[1], 'base64'));
  const size = pngSize(OUT);
  if (!size || size[0] !== SIZE || size[1] !== SIZE) throw new Error(`rendered ${size}, wanted ${SIZE}x${SIZE}`);
  // Chrome may still be closing its profile; a leftover temp folder is harmless.
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // leave it to the OS's temp cleanup
  }
  console.log(`wrote ${path.relative(ROOT, OUT)} (${SIZE}x${SIZE})`);
}

main().catch((e) => {
  console.error(`render_icon: ${e.message}`);
  process.exit(1);
});
