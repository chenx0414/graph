// Acceptance diagnostics for d0193bb. Run from the Graph repository root.
// Prints observed behavior; exit code 0 is not a product acceptance verdict.
import {mkdtemp,mkdir,copyFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from '../../../node_modules/playwright/index.mjs';
const root=await mkdtemp(join(tmpdir(),'graph-accept-media-'));
const prior=process.cwd();
await mkdir(join(root,'src','web'),{recursive:true});
await mkdir(join(root,'output','bilibili-notes'),{recursive:true});
await writeFile(join(root,'package.json'),'{"type":"module"}');
await copyFile(new URL('../../../../12-MediaBookmarks/src/config.js',import.meta.url),join(root,'src','config.js'));
await copyFile(new URL('../../../tests/fixtures/m7/web-server.js',import.meta.url),join(root,'src','web-server.js'));
await copyFile(new URL('../../../tests/fixtures/m7/index.html',import.meta.url),join(root,'src','web','index.html'));
// Replace only the external collect CLI with a slow, local, deterministic response.
await writeFile(join(root,'src','cli.js'),'setTimeout(()=>process.exit(0),1200);');
await writeFile(join(root,'output','bilibili-notes','fixture.md'),'# Existing note\nReview this note content.');
process.chdir(root);
const {createWebServer}=await import(pathToFileURL(join(root,'src','web-server.js')).href);
const server=createWebServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();
 await page.goto(base);
 await page.waitForFunction(()=>document.getElementById('job').textContent.includes('idle'));
 const login=await(await fetch(base+'/api/login-status')).json();
 const collectResponse=page.waitForResponse(r=>r.url().endsWith('/api/collect'));
 await page.locator('#collect-btn').click();
 await page.waitForTimeout(250);
 const backendJob=await(await fetch(base+'/api/job')).json();
 const pageJob=await page.locator('#job').innerText();
 console.log(JSON.stringify({case:'collect_without_login_and_no_live_progress',loggedIn:login.loggedIn,backendStatus:backendJob.status,pageJob}));
 await collectResponse;
 console.log(JSON.stringify({case:'notes_not_browsable',listed:await page.locator('#notes').innerText(),links:await page.locator('#notes a').count(),notePathStatus:(await fetch(base+'/output/bilibili-notes/fixture.md')).status}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));process.chdir(prior);await rm(root,{recursive:true,force:true});}
