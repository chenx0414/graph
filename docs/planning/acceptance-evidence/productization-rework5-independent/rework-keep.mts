import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskRuntime } from '../../../../src/core/task-runtime.ts';
import { openaiServer } from '../../../../tests/fixtures/openai-server.ts';
const deadline=setTimeout(()=>{console.error('deadline');process.exit(124)},20000);
const root=await mkdtemp(join(tmpdir(),'graph-b15e31d-rework-'));
const provider=await openaiServer([{text:'first incomplete implementation'},{usage:null,tools:[{id:'w',name:'write_file',arguments:JSON.stringify({path:'fix.txt',content:'fix'})}]},{text:'real second round completion'}]);
let runtime;let checks=0;let finalDependencies;
try{
 runtime=await openTaskRuntime({stateDir:join(root,'state'),projects:[{id:'p',root}],models:{entries:[{id:'local',provider:'graph-openai',grade:'high',api:'openai-completions',baseUrl:provider.model.baseUrl,contextWindow:32000,maxTokens:256}],apiKey:'scripted-local-key',modelRuntime:provider.runtime},actions:{check:{kind:'program',prepare:async operation=>async()=>{checks++;if(checks===1)return {outcome:'completed',output:{kind:'verification',outcome:'rework',subjects:[],reports:[],blockers:[{id:'needs-fix',reason:'synthetic rework required',evidence:[]}]}};finalDependencies=operation.dependencies;return {outcome:'completed',output:{passed:true},evidence:[{acceptanceId:'ok',summary:'synthetic observing check',artifact:{path:join(root,'ok'),digest:'a'.repeat(64)}}]}}}}});
 runtime.catalog.publishDefinition('coder',{recommendedGrade:'high'},'coder');
 const {taskId}=await runtime.user.begin({projectId:'p',request:'rework interrupted result',requestId:'begin'});const task=runtime.user.task(taskId);
 await runtime.supervisor(taskId).propose({requirementVersion:1,summary:'work',acceptance:[{id:'ok',description:'ok',checkNode:'check'}],loops:[{from:'check',to:'work'}],nodes:[{id:'work',kind:'agent',action:'work',definitionVersion:'coder@1',model:'local'},{id:'check',kind:'program',action:'check',dependsOn:['work']}]},'propose');
 await task.accept({proposalVersion:1,targetBranch:'main',requestId:'accept'});await runtime.host.drive();
 const before=await task.view();const question=before.questions.find(q=>q.kind==='unknown_usage'&&q.status==='open');
 await task.answer(question.id,{type:'reconcile_usage',proof:'The provider confirms no usage is available for this call'},'reconcile');
 const answered=await task.view();await runtime.host.drive();const after=await task.view();
 console.log(JSON.stringify({providerRequests:provider.requests.length,checks,before:{work:before.nodes.find(n=>n.id==='work'),workOperations:before.operations.filter(o=>o.nodeId==='work').map(o=>({state:o.state,activationId:o.activationId,result:o.result}))},answered:{work:answered.nodes.find(n=>n.id==='work'),questions:answered.questions.map(q=>({kind:q.kind,status:q.status}))},after:{phase:after.phase,nodes:after.nodes.map(n=>({id:n.id,status:n.status})),finalDependencies}}));
}finally{if(runtime)await runtime.close();await provider.close();await rm(root,{recursive:true,force:true});clearTimeout(deadline)}
