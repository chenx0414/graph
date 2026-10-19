/** Checks a completed real-browser paired run; screenshots remain in the OS temp dir. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const report = JSON.parse(await readFile(process.argv[2] ?? 'perf/bench/paired.json', 'utf8'));
const limits = JSON.parse(await readFile(new URL('./limits.json', import.meta.url), 'utf8'));
assert.ok(report.runs >= 10);
const profile = report.profile.startsWith('Fast4G') ? 'fast4g' : 'local';
for (const metric of ['startup', 'conversation', 'graph']) {
  const actual = report.summary.B[metric].p75;
  assert.ok(actual <= limits[profile][metric], `${metric}: ${actual} exceeds ${limits[profile][metric]}ms`);
}
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const view of ['home', 'graph']) {
    for (const width of [768, 1440]) {
      const images = await Promise.all(['A', 'B'].map(async label => (await readFile(join(report.root, `${label}-${view}-${width}.png`))).toString('base64')));
      const difference = await page.evaluate(async images => {
        const pixels = await Promise.all(images.map(async bytes => {
          const image = new Image(); image.src = `data:image/png;base64,${bytes}`; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, image.width, image.height).data;
        }));
        if (pixels[0]!.length !== pixels[1]!.length) return 1;
        let changed = 0;
        for (let i = 0; i < pixels[0]!.length; i += 4) {
          if ([0, 1, 2].some(channel => Math.abs(pixels[0]![i + channel]! - pixels[1]![i + channel]!) > 16)) changed++;
        }
        return changed / (pixels[0]!.length / 4);
      }, images);
      console.log(`${view} ${width}: ${(difference * 100).toFixed(4)}% changed pixels`);
      assert.ok(difference <= 0.005, `${view} ${width}: visual parity exceeds 0.5%`);
    }
  }
} finally { await browser.close(); }
console.log('PASS: p75 budgets and paired visual parity');
