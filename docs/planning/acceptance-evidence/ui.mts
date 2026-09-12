// Acceptance diagnostics for d0193bb. Run from the Graph repository root.
// Prints observed behavior; exit code 0 is not a product acceptance verdict.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../../../node_modules/playwright/index.mjs';
import { openGraphServer } from '../../../src/server/host.ts';
const root=await mkdtemp(join(tmpdir(),'graph-accept-ui-'));
const usage={input:10,output:10,cacheRead:0,cacheWrite:0};
const server=await openGraphServer({stateDir:join(root,'state'),projects:[{id:'p',root}],webDir:join(process.cwd(),'dist/web'),actions:{
 work:{kind:'agent',reserveTokens:100,prepare:async()=>async()=>({outcome:'completed',output:null,usage})},
 expensive:{kind:'agent',reserveTokens:20_000_001,prepare:async()=>async()=>({outcome:'completed',output:null,usage})},
 check:{kind:'program',prepare:async()=>async()=>({outcome:'completed',output:null,evidence:[{acceptanceId:'ok',summary:'ok',artifact:{path:join(root,'ok'),digest:'a'.repeat(64)}}]})}
}});
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage();
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 const {taskId}=await server.runtime.user.begin({projectId:'p',request:'UI live state',requestId:'one'});
 await server.runtime.supervisor(taskId).propose({requirementVersion:1,summary:'Live',acceptance:[{id:'ok',description:'Works',checkNode:'check'}],nodes:[{id:'work',kind:'agent',action:'work',definitionVersion:'coder@1',model:'scripted'},{id:'check',kind:'program',action:'check',dependsOn:['work']}]},'plan-one');
 await server.runtime.user.task(taskId).accept({proposalVersion:1,targetBranch:'main',requestId:'accept-one'});
 await page.goto(`${server.url}/#/tasks/${taskId}/graph`);
 await page.locator('.react-flow__node').filter({hasText:'work'}).waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('.react-flow__node')].some(node=>node.textContent?.includes('work pending')));
 const before=await page.locator('.react-flow__node').filter({hasText:'work'}).textContent();
 await server.runtime.host.drive();
 await page.waitForTimeout(300);
 const after=await page.locator('.react-flow__node').filter({hasText:'work'}).textContent();
 console.log(JSON.stringify({case:'graph_stale_after_completion',before,after,runtimePhase:(await server.runtime.user.task(taskId).view()).phase}));
 const next=await server.runtime.user.begin({projectId:'p',request:'Budget question',requestId:'two'});
 await server.runtime.supervisor(next.taskId).propose({requirementVersion:1,summary:'Budget',acceptance:[{id:'ok',description:'Works',checkNode:'check'}],nodes:[{id:'expensive',kind:'agent',action:'expensive',definitionVersion:'coder@1',model:'scripted'},{id:'check',kind:'program',action:'check',dependsOn:['expensive']}]},'plan-two');
 await server.runtime.user.task(next.taskId).accept({proposalVersion:1,targetBranch:'main',requestId:'accept-two'});
 await server.runtime.host.drive();
 await page.goto(`${server.url}/#/tasks/${next.taskId}`);
 await page.getByTestId('questions').getByRole('button',{name:'答复'}).waitFor();
 const response=page.waitForResponse(r=>r.url().endsWith('/answer'));
 await page.getByTestId('questions').getByRole('button',{name:'答复'}).click();
 const res=await response;
 console.log(JSON.stringify({case:'budget_reply',httpStatus:res.status(),body:await res.json(),openQuestions:(await server.runtime.user.task(next.taskId).view()).questions.filter(q=>q.status==='open').map(q=>q.kind)}));
} finally { await browser.close(); await server.close(); await rm(root,{recursive:true,force:true}); }
