// Acceptance diagnostics for d0193bb. Run from the Graph repository root.
// Prints observed behavior; exit code 0 is not a product acceptance verdict.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openTaskRuntime } from '../../../src/core/task-runtime.ts';
import { git } from '../../../src/git/git.ts';
const root = await mkdtemp(join(tmpdir(), 'graph-standards-unknown-'));
const runGit = (args: string[]) => { const result = git(root,args); if(result.code) throw new Error(result.stderr); return result.stdout; };
runGit(['init','-b','main']);
await writeFile(join(root,'README.md'),'project\n'); runGit(['add','README.md']); runGit(['commit','-m','init']);
let releaseLate!: () => void;
const gate = new Promise<void>(resolve => {releaseLate=resolve;});
let reviews=0;
const usage={input:10,output:10,cacheRead:0,cacheWrite:0};
const runtime = await openTaskRuntime({stateDir:join(root,'state'), projects:[{id:'project',root}], actions:{
 work:{kind:'agent',reserveTokens:100,prepare:async op=>async()=>{await writeFile(join(op.workspace!,'feature.txt'),'done');return {outcome:'completed',output:null,usage};}},
 late:{kind:'agent',reserveTokens:100,prepare:async op=>async()=>{await gate;await writeFile(join(op.workspace!,'late.txt'),'late');return {outcome:'completed',output:null,usage};}},
 check:{kind:'program',prepare:async op=>async()=>({outcome:'completed',output:null,evidence:[{acceptanceId:'works',summary:'ok',artifact:{path:join(op.workspace!,'feature.txt'),digest:createHash('sha256').update('done').digest('hex')}}]})},
 review:{kind:'agent',reserveTokens:100,prepare:async op=>async()=>{reviews++;return {outcome:'completed',output:{reviews},usage:reviews===1?null:usage};}}
}});
try {
 const {taskId}=await runtime.user.begin({projectId:'project',request:'Test recheck with unknown review usage',requestId:'begin'});
 const p=await runtime.supervisor(taskId).propose({requirementVersion:1,summary:'Test',acceptance:[{id:'works',description:'Works',checkNode:'check'}],nodes:[
 {id:'work',kind:'agent',action:'work',definitionVersion:'coder@1',model:'scripted'},
 {id:'late',kind:'agent',action:'late',definitionVersion:'coder@1',model:'scripted'},
 {id:'check',kind:'program',action:'check',dependsOn:['work']},
 {id:'review',kind:'agent',action:'review',definitionVersion:'reviewer@1',model:'scripted',dependsOn:['check']}
 ]},'propose');
 const task=runtime.user.task(taskId);await task.accept({proposalVersion:p.proposalVersion,targetBranch:'main',requestId:'accept'});
 const running=runtime.host.drive();
 let before;
 for(let i=0;i<300;i++){before=await task.view();if(before.questions.some(q=>q.kind==='unknown_usage'&&q.status==='open'))break;await new Promise(r=>setTimeout(r,10));}
 console.log(JSON.stringify({phase:'beforeLate',reviews,review:before?.nodes.find(n=>n.id==='review')?.status,questions:before?.questions.map(q=>({kind:q.kind,status:q.status}))}));
 releaseLate();await running;
 const after=await task.view();
 console.log(JSON.stringify({phase:'afterLate',reviews,review:after.nodes.find(n=>n.id==='review')?.status,questions:after.questions.map(q=>({kind:q.kind,status:q.status})),reviewOperations:after.operations.filter(o=>o.nodeId==='review').map(o=>({state:o.state,attempt:o.attempt}))}));
} finally {releaseLate();await runtime.close();await rm(root,{recursive:true,force:true});}
