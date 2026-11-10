/**
 * Regenerates build/icon.png (app icon, 1024x1024) and the macOS tray template
 * images. Chromium is already a dev dependency, so the icons stay reproducible
 * without committing a font or an image toolchain.
 * Run: export PATH="$PWD/node_modules/.bin:$PATH"; node scripts/make-icons.mjs
 */
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'build');

// macOS icon grid: 824px of artwork inside the 1024px canvas, 185px corner
// radius, transparent margin. The source asset already rounds its own corners at
// the same ratio, so the clip below reproduces exactly what ships.
const appIcon = `<div style="width:824px;height:824px;margin:100px;border-radius:185px;overflow:hidden"><img style="width:824px;height:824px;display:block" src="data:image/png;base64,${(await readFile(join(build, 'graph-icon.png'))).toString('base64')}" /></div>`;

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
// The icons are committed artefacts and drawing them needs a browser. A machine
// where Chromium cannot start must still package the app with the icons it has;
// GRAPH_ICONS=force redraws them.
if (process.env.GRAPH_ICONS !== 'force') {
  const outputs = ['icon.png', 'trayTemplate.png', 'trayTemplate@2x.png'].map(name => join(build, name));
  const present = await Promise.all(outputs.map(path => stat(path).then(() => true, () => false)));
  if (present.every(Boolean)) { console.log(`icons kept: ${outputs.length}`); process.exit(0); }
}
const browser = await chromium.launch({ headless: true });
try {
  const icon = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await icon.setContent(`<body style="margin:0;background:transparent">${appIcon}</body>`);
  await icon.locator('img').evaluate(image => image.decode());
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
