import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskRuntime } from '../../../../src/core/task-runtime.ts';
import { openaiServer } from '../../../../tests/fixtures/openai-server.ts';
import { createModelScheduler } from '../../../../src/runtime/model-scheduler.ts';
const baseScheduler=createModelScheduler();let acquisitions=0;
const modelScheduler={...baseScheduler,acquire:async(...args)=>{acquisitions++;if(acquisitions===2)await task.pause('pause-after-tool-effect');return baseScheduler.acquire(...args)}};
const deadline=setTimeout(()=>{console.error('probe deadline');process.exit(124)},20_000);
const root=await mkdtemp(join(tmpdir(),'graph-fe8e2c4-partial-'));
let runtime;let task;let checks=0;
const provider=await openaiServer([
 {tools:[{id:'write-1',name:'write_file',arguments:JSON.stringify({path:'partial.txt',content:'partial output'})}]},
 {text:'Work complete after resume'},
]);
try {
 runtime=await openTaskRuntime({stateDir:join(root,'state'),projects:[{id:'p',root}],models:{entries:[{id:'local',provider:'graph-openai',grade:'high',api:'openai-completions',baseUrl:provider.model.baseUrl,contextWindow:32000,maxTokens:256}],apiKey:'scripted-local-key',modelRuntime:provider.runtime,modelScheduler,credentialFor:()=>({credentialId:'local-key',apiKey:'scripted-local-key',limit:1})},actions:{check:{kind:'program',prepare:async()=>async()=>{checks++;return {outcome:'completed',output:null,evidence:[{acceptanceId:'ok',summary:'synthetic',artifact:{path:join(root,'ok'),digest:'a'.repeat(64)}}]}}}}});
 runtime.catalog.publishDefinition('coder',{recommendedGrade:'high'},'coder');
 const {taskId}=await runtime.user.begin({projectId:'p',request:'partial pause test',requestId:'begin'});task=runtime.user.task(taskId);
 await runtime.supervisor(taskId).propose({requirementVersion:1,summary:'partial pause',acceptance:[{id:'ok',description:'ok',checkNode:'check'}],nodes:[{id:'work',kind:'agent',action:'work',definitionVersion:'coder@1',model:'local'},{id:'check',kind:'program',action:'check',dependsOn:['work']}]},'propose');
 await task.accept({proposalVersion:1,targetBranch:'main',requestId:'accept'});
 await runtime.host.drive();
 // drive returns early on pause; await final operation settlement without mutating runtime.
 for(let i=0;i<100;i++){const view=await task.view();if(view.operations[0]?.state==='interrupted'||view.operations[0]?.state==='succeeded')break;await new Promise(r=>setTimeout(r,20))}
 const paused=await task.view();const statBefore=(await import('node:fs/promises')).stat;const beforeEffect=await statBefore(join(root,'partial.txt'));if(paused.nodes.find(n=>n.id==='work').used!==50)throw new Error('partial usage not 50');
 await task.resume('resume');
 const resumedDrive=await runtime.host.drive();const after=await task.view();
 if(after.nodes.find(n=>n.id==='work').used!==100)throw new Error('final usage not 100');if(after.nodes.find(n=>n.id==='work').instanceId!==paused.nodes.find(n=>n.id==='work').instanceId)throw new Error('instance changed');if((await statBefore(join(root,'partial.txt'))).mtimeMs!==beforeEffect.mtimeMs)throw new Error('effect repeated');await runtime.host.drive();if((await task.view()).nodes.find(n=>n.id==='work').used!==100)throw new Error('double counted');let reconciliation;
 try{await runtime.host.reconcile(paused.operations[0].id);reconciliation='accepted'}catch(e){reconciliation={code:e.code,message:e.message}}
 const partialOutput=await readFile(join(root,'partial.txt'),'utf8').catch(()=>null);
 console.log(JSON.stringify({partialOutput,providerRequests:provider.requests.length,checks,paused:{status:paused.status,nodes:paused.nodes.map(n=>({id:n.id,status:n.status,used:n.used})),operations:paused.operations.map(o=>({state:o.state,workerActive:o.workerActive,result:o.result,reserved:o.reserved})),invocations:paused.invocations.map(i=>({usage:i.usage})),questions:paused.questions.map(q=>({kind:q.kind,status:q.status}))},afterResume:{drive:resumedDrive,status:after.status,nodes:after.nodes.map(n=>({id:n.id,status:n.status,used:n.used})),questions:after.questions.map(q=>({kind:q.kind,status:q.status}))},reconciliation}));
} finally {if(runtime)await runtime.close();await provider.close();await rm(root,{recursive:true,force:true});clearTimeout(deadline)}
