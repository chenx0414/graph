import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskRuntime } from '../../../../src/core/task-runtime.ts';
import { openaiServer } from '../../../../tests/fixtures/openai-server.ts';
import { createModelScheduler } from '../../../../src/runtime/model-scheduler.ts';
const baseScheduler=createModelScheduler();let acquisitions=0;
const modelScheduler={...baseScheduler,acquire:async(...args)=>{acquisitions++;if(acquisitions===3)await task.pause('pause-after-tool-effect');return baseScheduler.acquire(...args)}};
const deadline=setTimeout(()=>{console.error('probe deadline');process.exit(124)},20_000);
const root=await mkdtemp(join(tmpdir(),'graph-fe8e2c4-partial-'));
let runtime;let task;let checks=0;
const provider=await openaiServer([
 {tools:[{id:'known-write',name:'write_file',arguments:JSON.stringify({path:'known.txt',content:'known effect'})}]},
 {usage:null,tools:[{id:'write-1',name:'write_file',arguments:JSON.stringify({path:'partial.txt',content:'partial output'})}]},
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
 const paused=await task.view();const stat=(await import('node:fs/promises')).stat;const effectBefore=await stat(join(root,'known.txt'));
 const question=paused.questions.find(q=>q.kind==='unknown_usage'&&q.status==='open');
 const mode=process.argv.includes('--keep')?'reconcile_usage':'usage';
 const answer=mode==='usage'?{type:'usage',usage:{input:40,output:10,cacheRead:0,cacheWrite:0},proof:'synthetic bill'}:{type:'reconcile_usage',proof:'unavailable'};
 await task.answer(question.id,answer,'answer-first');
 const answered=await task.view();let duplicate;
 try{await task.answer(question.id,answer,'answer-duplicate');duplicate='accepted'}catch(e){duplicate=e.code}
 if(duplicate!=='invalid_question')throw new Error('duplicate accepted');
 const answers=[{mode,duplicate,used:answered.nodes.find(n=>n.id==='work').used,invocations:answered.invocations}];
 await task.resume('resume');await runtime.host.drive();const after=await task.view();
 if(after.nodes.find(n=>n.id==='work').used!==(mode==='usage'?150:100))throw new Error('wrong final used');if((await stat(join(root,'known.txt'))).mtimeMs!==effectBefore.mtimeMs)throw new Error('effect repeated');if(checks!==1)throw new Error('wrong successor');if(after.nodes.find(n=>n.id==='work').instanceId!==paused.nodes.find(n=>n.id==='work').instanceId)throw new Error('changed instance');console.log(JSON.stringify({providerRequests:provider.requests.length,operation:paused.operations.map(o=>({state:o.state,workerActive:o.workerActive,result:o.result})),questions:paused.questions.map(q=>({kind:q.kind,status:q.status})),answers,after:after.nodes.map(n=>({id:n.id,status:n.status,used:n.used})),checks}));

} finally {if(runtime)await runtime.close();await provider.close();await rm(root,{recursive:true,force:true});clearTimeout(deadline)}
