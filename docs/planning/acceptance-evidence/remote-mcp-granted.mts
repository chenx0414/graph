// Local-only MCP pause probe with a matching operation grant. The original
// remote-mcp-boundary.mts is refused at the authorization check before the
// handshake, so this variant grants mcp:remote:delete_records to reach the
// per-request pause boundary.
// All service effects are synthetic counters; no real provider or external service is used.
// Exit 0 means observations completed, not that the product passed acceptance.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { openTaskRuntime } from '../../../src/core/task-runtime.ts';
import { openaiServer } from '../../../tests/fixtures/openai-server.ts';
async function run(pauseDuringHandshake) {
 const root=await mkdtemp(join(tmpdir(),'graph-spec-repro-')); const workspace=join(root,'project'); const cap=join(root,'cap'); await mkdir(workspace); await mkdir(cap);
 let task; let paused=false; let initializations=0; let effects=0; const received=[];
 const server=createServer(async(req,res)=>{ const chunks=[]; for await(const c of req) chunks.push(c); const m=JSON.parse(Buffer.concat(chunks).toString()); received.push({method:m.method,paused}); if(m.method==='initialize'){initializations++; if(pauseDuringHandshake&&initializations===2){await task.pause('pause-in-handshake'); paused=true;}}
  if(m.method==='notifications/initialized'){res.writeHead(202);res.end();return;}
  let result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fake-external',version:'1'}};
  if(m.method==='tools/list') result={tools:[{name:'delete_records',description:'Delete external service records',annotations:{readOnlyHint:false,destructiveHint:true},inputSchema:{type:'object',properties:{}}}]};
  if(m.method==='tools/call'){effects++;result={content:[{type:'text',text:'external records deleted'}],isError:false};}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
 }); await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const provider=await openaiServer([{tools:[{id:'x',name:'mcp_remote_delete_records',arguments:'{}'}]},{text:'Done.'}]);
 await writeFile(join(cap,'capability.json'),JSON.stringify({kind:'mcp',transport:'http',url:`http://127.0.0.1:${server.address().port}/mcp`}));
 const runtime=await openTaskRuntime({stateDir:join(root,'state'),projects:[{id:'p',root:workspace,grants:['mcp:remote:delete_records']}],network:{mcpDomains:['127.0.0.1']},models:{entries:[{id:'local',provider:'graph-openai',grade:'high',api:'openai-completions',baseUrl:provider.model.baseUrl,contextWindow:32000,maxTokens:256}],apiKey:'scripted-local-key',modelRuntime:provider.runtime},actions:{check:{kind:'program',prepare:async()=>async()=>({outcome:'completed',output:null,evidence:[{acceptanceId:'ok',summary:'ok',artifact:{path:join(workspace,'ok'),digest:'a'.repeat(64)}}]})}}});
 try {
 runtime.catalog.publishDefinition('coder',{recommendedGrade:'high',capabilities:[{id:'remote',version:'1'}]},'coder'); await runtime.catalog.install({id:'remote',kind:'mcp',source:cap,version:'1',requestId:'install'});
 const {taskId}=await runtime.user.begin({projectId:'p',request:'Read only remote data',requestId:'begin'}); task=runtime.user.task(taskId);
 await runtime.supervisor(taskId).propose({requirementVersion:1,summary:'Read only remote data',acceptance:[{id:'ok',description:'Works',checkNode:'check'}],nodes:[{id:'work',kind:'agent',action:'work',definitionVersion:'coder@1',model:'local'},{id:'check',kind:'program',action:'check',dependsOn:['work']}]},'proposal');
 await task.accept({proposalVersion:1,targetBranch:'main',requestId:'accept'}); await runtime.host.drive(); const view=await task.view();
 const db=new DatabaseSync(join(root,'state','tasks.sqlite'),{readOnly:true}); const grants=db.prepare('SELECT * FROM task_grants').all(); const projectGrants=db.prepare('SELECT grants FROM projects').all();db.close();
 console.log(JSON.stringify({scenario:pauseDuringHandshake?'pause-during-call-handshake':'no-service-grant',effects,grants,projectGrants,received,questions:view.questions,phase:view.phase,invocations:view.invocations.map(i=>({state:i.state,usage:i.usage}))},null,2));
 } finally {await runtime.close();await provider.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
}
await run(false); await run(true);
