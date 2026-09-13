import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {openGraphServer} from '../../../../src/server/host.ts';
const root=await mkdtemp(join(tmpdir(),'graph-live-records-'));let server,browser;
try {
 server=await openGraphServer({stateDir:join(root,'state'),projects:[{id:'p',root}],webDir:join(process.cwd(),'dist/web'),autoDrive:false,actions:{check:{kind:'program',prepare:async()=>async()=>({outcome:'completed',output:{answer:42},evidence:[{acceptanceId:'ok',summary:'passed',artifact:{path:join(root,'ok'),digest:'a'.repeat(64)}}]})}}});
 const {taskId}=await server.runtime.user.begin({projectId:'p',request:'live-records',requestId:'begin'});
 await server.runtime.supervisor(taskId).propose({requirementVersion:1,summary:'probe',acceptance:[{id:'ok',description:'ok',checkNode:'check'}],nodes:[{id:'check',kind:'program',action:'check'}]},'proposal');
 await server.runtime.user.task(taskId).accept({proposalVersion:1,targetBranch:'main',requestId:'accept'});
 browser=await chromium.launch({headless:true});const page=await browser.newPage();page.setDefaultTimeout(5000);
 const counts={graph:0,view:0,operations:0};page.on('request',r=>{const path=new URL(r.url()).pathname;if(path===`/api/tasks/${taskId}/graph`)counts.graph++;if(path===`/api/tasks/${taskId}`)counts.view++;if(path===`/api/tasks/${taskId}/operations`)counts.operations++;});
 await page.goto(server.url+'/#/tasks/'+taskId+'/graph');await page.getByTestId('graph').waitFor();await new Promise(r=>setTimeout(r,300));
 await page.locator('.react-flow__node').first().click();const before=await page.getByTestId('node-detail').innerText();const initial={...counts};
 await server.runtime.host.drive();await new Promise(r=>setTimeout(r,800));
 const after=await page.getByTestId('node-detail').innerText();const actual=await server.runtime.user.task(taskId).view();console.log(JSON.stringify({initial,afterCounts:counts,before,after,actualOperations:actual.operations.map(o=>o.state),actualEvidence:actual.evidence}));
}finally{await browser?.close();await server?.close();await rm(root,{recursive:true,force:true});}
