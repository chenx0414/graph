import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openaiServer } from '../fixtures/openai-server.ts';
const execute=promisify(execFile);

test('evaluation confirms a real draft without dispatching the worker', async () => {
 const root=await mkdtemp(join(tmpdir(),'graph-eval-workflow-'));
 const workerProvider=await openaiServer([{text:'[]'},{text:'Worker execution observed.'},{text:'[]'}]);
 const proposal={requirementVersion:1,summary:'Repair the parser',acceptance:[{id:'behavior',description:'Parser behavior',checkNode:'work'}],definition:{
  schemaVersion:2,name:'Parser repair',protocols:{data:{type:'object'}},
  nodes:{work:{recipe:'coder@2',model:'worker',task:'Repair config.js',workspace:{base:'worktree'},inputs:{job:{protocol:'data'}},outputs:{},submission:{}}},
  modules:{},edges:{},inputs:{},outputs:{},acceptance:[{id:'behavior',description:'Parser behavior',kind:'human'}],
 }};
 const provider=await openaiServer([
  {tools:[{id:'catalog',name:'list_agent_combinations',arguments:'{}'}]},
  {tools:[{id:'draft',name:'propose_graph',arguments:JSON.stringify({proposal,requestId:'publish-draft'})}]},
  {text:'The draft is ready.'},
  {text:'Confirmation received; work has not started.'},
 ]);
 let artifactRoot: string|undefined;
 try {
  const configPath=join(root,'config.json');
  await writeFile(configPath,JSON.stringify({version:1,projects:[],credentials:{local:{secretRef:'GRAPH_EVAL_LOCAL_KEY'}},models:{entries:['local','worker'].map(id=>({
   id,modelId:id,provider:id==='worker'?'graph-openai-worker':'graph-openai',grade:'high',api:'openai-completions',baseUrl:(id==='worker'?workerProvider:provider).model.baseUrl,
   contextWindow:32000,maxTokens:256,credentialId:'local',cost:{input:2,output:4,cacheRead:.5,cacheWrite:1},
  }))}}));
  const {stdout}=await execute(process.execPath,['scripts/harness-real-eval.mjs',configPath],{cwd:process.cwd(),timeout:45000,
   env:{...process.env,HOME:root,GRAPH_EVAL_LOCAL_KEY:'fixture-key',GRAPH_EVAL_CONFIRM_WORKFLOW:'1',GRAPH_EVAL_WORKER_MODEL:'worker',GRAPH_EVAL_TIMEOUT_MS:'10000'}});
  const report=JSON.parse(stdout);artifactRoot=report.root;
  expect(report.error,JSON.stringify(report)).toBeUndefined();
  expect(report.workflow).toMatchObject({coderAvailable:true,proposalSeen:true});
  expect(report.workflow.confirmedTaskId).toBeTruthy();
  expect(report.workflow.confirmedTaskId).not.toBe(report.taskId);
  expect(report).toMatchObject({completed:false,taskSuccess:false});
  expect(report.workflow.taskIds).toEqual(expect.arrayContaining([report.taskId,report.workflow.confirmedTaskId]));
  const ledger=JSON.parse(await readFile(join(report.root,'cost-report.json'),'utf8'));
  const mainCost=ledger.tasks.find((task:{id:string})=>task.id===report.taskId);
  expect(mainCost.requests).toBeGreaterThan(0);
  const workerCost=ledger.tasks.find((task:{id:string})=>task.id===report.workflow.confirmedTaskId);
  expect(workerCost?.requests ?? 0).toBe(0);
  const catalogReply=(provider.requests[1] as {messages:{role:string;content:unknown}[]}).messages.filter(message=>message.role==='tool');
  expect(JSON.stringify(catalogReply)).toContain('coder');
  const runPath=join(root,'run.json');await writeFile(runPath,stdout);
  const manifestPath=join(root,'comparison.json');
  const group={name:'workflow',scope:'workflow',runs:[runPath]};
  await writeFile(manifestPath,JSON.stringify({groups:[group]}));
  const comparison=await execute(process.execPath,['scripts/harness-eval-summary.mjs',manifestPath],{cwd:process.cwd()});
  expect(JSON.parse(comparison.stdout).groups[0]).toMatchObject({scope:'workflow',attempts:1,completed:0,requests:report.accounting.requests,costPerCompletedTask:null});
  await writeFile(manifestPath,JSON.stringify({groups:[group],weights:{currency:'USD',perMillion:{input:1,output:1,cacheRead:1,cacheWrite:1}}}));
  await expect(execute(process.execPath,['scripts/harness-eval-summary.mjs',manifestPath],{cwd:process.cwd()})).rejects.toThrow(/mixed-model workflow/);

 } finally {
  await provider.close();await workerProvider.close();await rm(root,{recursive:true,force:true});
  if(artifactRoot)await rm(artifactRoot,{recursive:true,force:true});
 }
},60000);
