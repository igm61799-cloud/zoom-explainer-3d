// Deterministic offline renderer: serves this folder, opens index.html in headless Chrome
// with the GPU enabled, asks the page for one frame at a time and pipes JPEGs into ffmpeg.
//
//   node render.mjs --stills 0.5,10,20          -> out/still_*.jpg   (look at these first)
//   node render.mjs --full                      -> out/video.mp4
//   node render.mjs --full --o name.mp4 --audio voiceover.wav --crf 19 --ss 1.5
//   node render.mjs --from 12 --to 16 --o part.mp4   (a section, no audio)
//
// Chrome is found in this order: $CHROME_PATH, puppeteer's cache, a system install.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : (args[i + 1] ?? true); };
const ss = arg('ss', '1.5');
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cache = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  if (fs.existsSync(cache)) {
    for (const ver of fs.readdirSync(cache).sort().reverse()) {
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-linux64/chrome', 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']) {
        const p = path.join(cache, ver, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  for (const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chrome not found. Run `npx puppeteer browsers install chrome` or set CHROME_PATH.');
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.normalize(path.join(ROOT, decodeURIComponent(req.url.split('?')[0])));
  if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(p === ROOT ? path.join(p, 'index.html') : p, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const gpuArgs = process.platform === 'win32' ? ['--use-angle=d3d11'] : process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=gl'];
const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: 'new',
  args: [...gpuArgs, '--enable-gpu', '--ignore-gpu-blocklist', '--force_high_performance_gpu', '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=1280,720'],
  protocolTimeout: 600000,
});
const page = await browser.newPage();
// Shader compile errors only show up here. Never filter this output away.
page.on('console', m => { const t = m.text(); if (!t.includes('favicon') && !t.includes('404')) console.log('[page]', t); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${port}/index.html?ss=${ss}`);
await page.waitForFunction('window.READY === true', { timeout: 120000 });
const info = await page.evaluate('window.INFO');
console.log('info', JSON.stringify(info));
if (/swiftshader|llvmpipe|software/i.test(info.gpu || '')) console.log('WARNING: software rendering, this will be very slow. Check GPU flags.');

const grab = async (t, q) => Buffer.from((await page.evaluate((t, q) => window.frame(t, q), t, q)).split(',')[1], 'base64');

if (arg('stills')) {
  for (const s of String(arg('stills')).split(',')) {
    const t = parseFloat(s);
    const name = path.join(OUT, `still_${t.toFixed(2).padStart(5, '0')}.jpg`);
    fs.writeFileSync(name, await grab(t, 0.92));
    console.log('wrote', name);
  }
} else {
  const outFile = path.join(OUT, String(arg('o', 'video.mp4')));
  const from = parseFloat(arg('from', '0')), to = parseFloat(arg('to', String(info.duration)));
  const audio = arg('audio', null);
  const ffArgs = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(info.fps), '-c:v', 'mjpeg', '-i', '-'];
  if (audio) ffArgs.push('-i', String(audio));
  ffArgs.push('-c:v', 'libx264', '-preset', 'slow', '-crf', String(arg('crf', '19')), '-pix_fmt', 'yuv420p');
  if (audio) ffArgs.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
  ffArgs.push('-movflags', '+faststart', outFile);
  const ff = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
  const f0 = Math.round(from * info.fps), f1 = Math.round(to * info.fps);
  const start = Date.now();
  for (let f = f0; f < f1; f++) {
    const buf = await grab(f / info.fps, 0.97);
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if ((f - f0) % 90 === 0) console.log(`frame ${f - f0}/${f1 - f0}  ${((Date.now() - start) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  console.log('wrote', outFile);
}
await browser.close();
server.close();
