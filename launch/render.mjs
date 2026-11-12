// Render launch/video.html frame by frame and encode an MP4.
//   node launch/render.mjs [--fps 30] [--out launch/skillyard-launch.mp4]
// Needs playwright-core (resolved from PLAYWRIGHT_CORE or ~/Desktop/money-making/node_modules), a Playwright
// chromium-headless-shell in ~/Library/Caches/ms-playwright, and ffmpeg on PATH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const fps = Number(arg('--fps', 30));
const out = path.resolve(arg('--out', path.join(here, 'skillyard-launch.mp4')));

const req = createRequire(import.meta.url);
const pwPath = process.env.PLAYWRIGHT_CORE || path.join(os.homedir(), 'Desktop/money-making/node_modules/playwright-core');
const { chromium } = req(pwPath);
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const shellDir = fs.readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().pop();
const exe = spawnSync('find', [path.join(cache, shellDir), '-name', 'chrome-headless-shell', '-type', 'f']).stdout.toString().trim().split('\n')[0];

const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'sy-frames-'));
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(pathToFileURL(path.join(here, 'video.html')).href, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
const duration = await page.evaluate(() => window.DURATION);
const total = Math.round(duration * fps);
for (let i = 0; i < total; i++) {
  await page.evaluate((t) => window.render(t), i / fps);
  await page.screenshot({ path: path.join(frames, `f${String(i).padStart(5, '0')}.png`) });
  if (i % 150 === 0) console.log(`frame ${i}/${total}`);
}
await browser.close();
const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(frames, 'f%05d.png'),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', out], { stdio: 'inherit' });
fs.rmSync(frames, { recursive: true, force: true });
if (ff.status !== 0) process.exit(ff.status || 1);
console.log(`wrote ${out} (${duration}s, ${fps} fps)`);
