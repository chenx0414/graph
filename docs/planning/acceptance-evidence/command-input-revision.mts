import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openTaskRuntime} from '../../../src/core/task-runtime.ts';
import {git} from '../../../src/git/git.ts';
// Follow-up on the Spec finding: a supervisor revision must not weaken the command of a confirmed acceptance check.
const root=await mkdtemp(join(tmpdir(),'graph-command-revision-'));
const run=(args)=>{const r=git(root,args);if(r.code)throw Error(r.stderr);return r.stdout;};
run(['init','-b','main']);await writeFile(join(root,'README.md'),'fixture');run(['add','.']);run(['commit','-m','init']);
const nodes=[{id:'work',kind:'agent',action:'work',model:'scripted',definitionVersion:'coder@1'},{id:'check',kind:'program',action:'graph.command',dependsOn:['work'],input:{command:'node',args:['--test','fail.test.js']}}];
const runtime=await openTaskRuntime({stateDir:join(root,'state'),projects:[{id:'p',root}],actions:{work:{kind:'agent',reserveTokens:100,prepare:async op=>async()=>{await writeFile(join(op.workspace,'fail.test.js'),"import {test} from 'node:test';test('fails',()=>{throw Error('required test failed')});");return {outcome:'completed',output:null,usage:{input:1,output:1,cacheRead:0,cacheWrite:0}};}}}});
try{
 const {taskId}=await runtime.user.begin({projectId:'p',request:'Required failing test must pass',requestId:'begin'});
 await runtime.supervisor(taskId).propose({requirementVersion:1,summary:'Fix failing test',acceptance:[{id:'test',description:'The required test passes',checkNode:'check'}],nodes},'plan');
 const task=runtime.user.task(taskId);await task.accept({proposalVersion:1,targetBranch:'main',requestId:'accept'});
 await runtime.host.runReady();
 let revisionRejected=false;let revisionError='';
 try{await runtime.supervisor(taskId).revise({baseVersion:1,reason:'Skip failing test',nodes:nodes.map(n=>n.id==='check'?{...n,input:{command:'node',args:['--version']}}:n),requestId:'weaken'});}catch(error){revisionRejected=true;revisionError=String(error);}
 await runtime.host.drive();
 const v=await task.view();const check=v.nodes.find(n=>n.id==='check');
 console.log(JSON.stringify({revisionRejected,revisionError,graphVersion:v.graphVersion,checkStatus:check?.status,checkInput:check?.input,evidence:v.evidence.filter(e=>e.valid).map(e=>e.acceptanceId)}));
}finally{await runtime.close();await rm(root,{recursive:true,force:true});}
