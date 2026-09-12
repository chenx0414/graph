// Acceptance diagnostics: B站 Web login gate, live progress, and note browsing.
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
// Replace only the external collect CLI with a slow, local, deterministic progress stream.
await writeFile(join(root,'src','cli.js'),[
  "setTimeout(()=>console.log('1 / 3'),300);",
  "setTimeout(()=>console.log('2 / 3'),700);",
  "setTimeout(()=>{console.log('3 / 3');process.exit(0);},1100);",
].join('\n'));
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
 // 1. Collect without login must be refused with a visible reason.
 await page.locator('#collect-btn').click();
 await page.waitForFunction(()=>document.getElementById('collect-error').textContent.trim().length>0);
 const refused=await(await fetch(base+'/api/job')).json();
 console.log(JSON.stringify({case:'collect_requires_login',loggedIn:login.loggedIn,backendStatus:refused.status,visibleError:await page.locator('#collect-error').innerText()}));
 // 2. After the CLI login state exists, collect runs asynchronously with live progress.
 await writeFile(join(root,'output','login-state.json'),JSON.stringify({bilibili:{hasKeyCookie:true,cookieCount:2}}));
 await page.locator('#collect-btn').click();
 const seen=[];
 for(let i=0;i<40;i++){
   const job=await(await fetch(base+'/api/job')).json();
   if(job.status==='running'&&job.progress.current>0)seen.push(job.progress.current);
   if(job.status==='done'){seen.push(job.progress.current);break;}
   await page.waitForTimeout(120);
 }
 const pageShowsProgress=await page.locator('#job').innerText();
 console.log(JSON.stringify({case:'live_progress_and_done',backendProgress:seen,pageShowsRunning:pageShowsProgress.includes('done')||pageShowsProgress.includes('running')}));
 // 3. Existing notes must be listed and readable from the page.
 const listed=await(await fetch(base+'/api/notes')).json();
 const href=listed.notes.find(item=>item.name==='fixture.md')?.href;
 const contentStatus=href?(await fetch(base+href)).status:0;
 const content=href?(await(await fetch(base+href)).json()).content:'';
 await page.locator('#notes a[data-note="fixture.md"]').click();
 await page.waitForFunction(()=>document.getElementById('note-body').textContent.includes('Review this note content'));
 console.log(JSON.stringify({case:'notes_browsable',listed:listed.notes.map(item=>item.name),contentStatus,contentHasBody:content.includes('Review this note content'),readerText:(await page.locator('#note-body').innerText()).trim()}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));process.chdir(prior);await rm(root,{recursive:true,force:true});}
