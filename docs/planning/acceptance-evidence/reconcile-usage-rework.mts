// Synthetic reconciliation probes for Graph 6004a2a. No real provider calls.
// Exit 0 means observations completed; acceptance expectations are in the report.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskRuntime } from '../../../src/core/task-runtime.ts';
import { TaskStore } from '../../../src/core/store.ts';
import { taskGate } from '../../../src/runtime/task-gate.ts';

async function scenario(name, work) {
 const root = await mkdtemp(join(tmpdir(), `graph-6004-${name}-`));
 let checkDependencies;
 const runtime = await openTaskRuntime({stateDir:join(root,'state'),projects:[{id:'p',root}],actions:{
   work: {kind:'agent',reserveTokens:20_000_000,prepare:async operation=>async()=>work(operation,root)},
   check:{kind:'program',prepare:async operation=>async()=>{checkDependencies=operation.dependencies;return {outcome:'completed',output:null,evidence:[{acceptanceId:'ok',summary:'synthetic check',artifact:{path:join(root,'ok'),digest:'a'.repeat(64)}}]}}}
 }});
 const {taskId}=await runtime.user.begin({projectId:'p',request:'synthetic review',requestId:'begin'});
 const task=runtime.user.task(taskId);
 await runtime.supervisor(taskId).propose({requirementVersion:1,summary:'synthetic review',acceptance:[{id:'ok',description:'ok',checkNode:'check'}],nodes:[{id:'work',kind:'agent',action:'work',model:'fake',definitionVersion:'fake@1'},{id:'check',kind:'program',action:'check',dependsOn:['work']}]},'propose');
 await task.accept({proposalVersion:1,targetBranch:'main',requestId:'accept'});
 await runtime.host.runReady();
 const before=await task.view();
 await task.answer(before.questions.find(q=>q.status==='open'&&q.kind==='unknown_usage').id,{type:'reconcile_usage',proof:'Synthetic provider confirms usage for failed invocation is unavailable'},'reconcile');
 const after=await task.view();
 const resends=await runtime.host.runReady();
 const final=await task.view();
 console.log(JSON.stringify({name,root,before:{used:before.nodes[0].used,status:before.nodes[0].status,knownUsage:before.invocations.map(i=>i.usage)},after:{used:after.nodes[0].used,status:after.nodes[0].status,outputVersion:after.nodes[0].outputVersion,questions:after.questions.map(q=>({kind:q.kind,status:q.status}))},resends,checkDependencies,final:{used:final.nodes[0].used,status:final.nodes[0].status,operations:final.operations.map(o=>({result:o.result,dependencies:o.dependencies})),questions:final.questions.map(q=>({kind:q.kind,status:q.status}))}}));
 await runtime.close();
 await rm(root, { recursive: true, force: true });
}
await scenario('completed-output',async()=>({outcome:'completed',output:{answer:42},usage:null}));
await scenario('waiting-result',async()=>({outcome:'waiting',output:{draft:true},question:{prompt:'User must choose format'},usage:null}));
let attempts=0;
await scenario('known-usage',async(operation,root)=>{
 const store=new TaskStore(join(root,'state/tasks.sqlite'));
 try {
  const gate=taskGate(store,operation,{id:'fake',provider:'fake',grade:'high',api:'openai-completions',baseUrl:'http://invalid',contextWindow:1,maxTokens:1});
  attempts++;
  if(attempts===1){
   gate.dispatch('known',19_999_950,()=>{});
   gate.settle('known',{input:19_999_950,output:0,cacheRead:0,cacheWrite:0});
   gate.dispatch('unknown',0,()=>{});
   gate.settle('unknown',null);
   return {outcome:'continue',output:{stage:'unknown'},usage:gate.total()};
  }
  let result;
  try{gate.dispatch('beyond-known-budget',100,()=>{result='SENT'});gate.settle('beyond-known-budget',{input:100,output:0,cacheRead:0,cacheWrite:0});}
  catch(e){result=`BLOCKED:${e.code}`;}
  return {outcome:'completed',output:{nextSend:result},usage:gate.total()};
 } finally {store.close();}
});
