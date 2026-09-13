/**
 * Regenerates build/icon.png (app icon, 1024x1024) and the macOS tray template
 * images. Chromium is already a dev dependency, so the icons stay reproducible
 * without committing a font or an image toolchain.
 * Run: export PATH="$PWD/node_modules/.bin:$PATH"; node scripts/make-icons.mjs
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'build');

const appIcon = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="224" fill="#0f172a"/>
  <g stroke="#64748b" stroke-width="26" stroke-linecap="round">
    <line x1="330" y1="352" x2="700" y2="318"/>
    <line x1="330" y1="352" x2="512" y2="700"/>
    <line x1="700" y1="318" x2="512" y2="700"/>
  </g>
  <circle cx="330" cy="352" r="118" fill="#2563eb" stroke="#e2e8f0" stroke-width="18"/>
  <circle cx="700" cy="318" r="118" fill="#16a34a" stroke="#e2e8f0" stroke-width="18"/>
  <circle cx="512" cy="700" r="118" fill="#d97706" stroke="#e2e8f0" stroke-width="18"/>
</svg>`;

const tray = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 22 22">
  <g stroke="#000" stroke-width="1.6" stroke-linecap="round" fill="none">
    <line x1="6.5" y1="7.5" x2="15.5" y2="6.5"/>
    <line x1="6.5" y1="7.5" x2="11" y2="15"/>
    <line x1="15.5" y1="6.5" x2="11" y2="15"/>
  </g>
  <circle cx="6.5" cy="7.5" r="2.6" fill="#000"/>
  <circle cx="15.5" cy="6.5" r="2.6" fill="#000"/>
  <circle cx="11" cy="15" r="2.6" fill="#000"/>
</svg>`;

await mkdir(build, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const icon = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await icon.setContent(`<body style="margin:0;background:transparent">${appIcon}</body>`);
  await icon.screenshot({ path: join(build, 'icon.png'), omitBackground: true });

  const trayPage = await browser.newPage({ viewport: { width: 22, height: 22 } });
  await trayPage.setContent(`<body style="margin:0;background:transparent">${tray(22)}</body>`);
  await trayPage.screenshot({ path: join(build, 'trayTemplate.png'), omitBackground: true });

  const tray2x = await browser.newPage({ viewport: { width: 44, height: 44 } });
  await tray2x.setContent(`<body style="margin:0;background:transparent">${tray(44)}</body>`);
  await tray2x.screenshot({ path: join(build, 'trayTemplate@2x.png'), omitBackground: true });
  console.log('icons written to build/icon.png, build/trayTemplate.png, build/trayTemplate@2x.png');
} finally {
  await browser.close();
}
