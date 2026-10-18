import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openaiServer } from '../fixtures/openai-server.ts';
const execute=promisify(execFile);

test.each([false,true])('evaluation confirms a real draft and accounts for native worker dispatch=%s without calling it completed', async dispatch => {
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
  ...(dispatch ? [{tools:[{id:'send-work',name:'graph_send',arguments:()=>{
    const last=JSON.stringify(provider.requests.at(-1));
    const graphId=/已确认 graph ([0-9a-f-]+)/.exec(last)?.[1];
    if(!graphId)throw new Error('Missing real confirmation graph ID');
    return JSON.stringify({graphId,nodeId:'work',input:'job',value:{request:'Repair config.js'}});
  }}]},{text:'Input accepted.'}] : [{text:'Confirmation received; work has not started.'}]),
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
  if(dispatch){expect(workerCost).toBeDefined();expect(workerCost.requests).toBeGreaterThan(0);expect(workerCost.executions).toBeGreaterThan(0);expect(workerProvider.requests.some(request=>(request as {model:string;max_completion_tokens:number}).model==='worker' && (request as {max_completion_tokens:number}).max_completion_tokens===256)).toBe(true);}
  else expect(workerCost?.requests ?? 0).toBe(0);
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

test.each(['bare','frozen-auto','frozen-explicit'])('evaluation completes only after worktree integration, host check, independent review and target delivery; context=%s', async context=>{
 const frozenContext=context!=='bare';
 const explicitRoles=context!=='frozen-auto';
 const example=JSON.parse(await readFile(new URL('../../examples/graphs/parser-delivery.json',import.meta.url),'utf8'));
 example.nodes.work.recipe='coder@2';
 if(explicitRoles)example.nodes.work.model='worker';else delete example.nodes.work.model;
 example.nodes.review.recipe='reviewer@2';
 const root=await mkdtemp(join(tmpdir(),'graph-eval-delivery-'));
 let artifactRoot:string|undefined;
 const repaired="export function parseConfig(text) { return Object.fromEntries(text.split('\\n').filter(line => line.trim()).map(line => { const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)]; })); }\n";
 const tool=(name:string,value:()=>unknown,thinking?:string)=>({...(thinking?{thinking}:{}),tools:[{id:name,name,arguments:()=>JSON.stringify(value())}]});
 const messages=(server:{requests:unknown[]})=>(server.requests.at(-1) as {messages:{role:string;content:unknown}[]}).messages;
 const skillPath=(server:{requests:unknown[]})=>[...JSON.stringify(messages(server)).matchAll(/\/[^\\\s"<>]+\/SKILL\.md/g)].map(match=>match[0]).find(path=>path.includes('delivery-context'))??join(root,'missing-skill.md');
 const graphId=()=>{
  const match=/已确认 graph ([0-9a-f-]+)/.exec(JSON.stringify(main.requests));
  if(!match)throw new Error('Missing confirmed graph');return match[1]!;
 };
 const commit=()=>{
  for(const message of [...messages(main)].reverse())if(message.role==='tool' && typeof message.content==='string'){
   const value=JSON.parse(message.content) as {commit?:string};if(value.commit)return value.commit;
  }
  throw new Error('Missing real integration commit');
 };
 const worker=await openaiServer([
  ...(frozenContext?[tool('read',()=>({path:skillPath(worker)}))]:[]),
  tool('write_file',()=>({path:'config.js',content:repaired}),'private-worker-reasoning-marker'),
  tool('workspace_commit',()=>({paths:['config.js'],message:'Repair parser'})),
  tool('artifact_publish',()=>({namespace:'deliverables',name:'parser',sourcePath:'config.js',metadata:{kind:'code'},requestId:'publish-parser'})),
  {text:'Parser committed and published.'},
 ]);
 const review=await openaiServer([
  {text:'No suggestion'},
  ...(frozenContext?[tool('read',()=>({path:skillPath(review)}))]:[]),
  tool('artifact_list',()=>({namespace:'deliverables'}),'private-review-reasoning-marker'),
  tool('artifact_read',()=>{
   const reply=messages(review).filter(message=>message.role==='tool').at(-1)!;
   const envelope=JSON.parse(String(reply.content)) as {content:{text:string}[]};
   const value=JSON.parse(envelope.content[0]!.text) as {artifacts:{artifactId:string;version:number}[]};
   return {artifactId:value.artifacts[0]!.artifactId,version:value.artifacts[0]!.version};
  }),
  tool('artifact_publish',()=>({namespace:'reviews',name:'parser',schema:'graph.review@1',mediaType:'application/json',
   content:JSON.stringify({commit:commit(),passed:true,reason:'Read the immutable parser implementation; it preserves equals and ignores empty lines.'}),requestId:'publish-review'})),
  {text:'Independent review published.'},{text:'No suggestion'},
 ]);
 const proposal={requirementVersion:1,summary:'Repair and deliver parser',
  acceptance:example.acceptance.map((item:{id:string;description:string;kind:string;module?:string;node?:string})=>({
   id:item.id,description:item.description,checkNode:item.kind==='check'?item.module:item.node,
  })),definition:example,
 };
 const main=await openaiServer([
  ...(context==='frozen-explicit' ? ['coder@2','reviewer@2'].flatMap(id=>[
   tool('get_agent_combination',()=>({id})),
   tool('get_agent_combination',()=>{
    const reply=messages(main).filter(message=>message.role==='tool').at(-1);
    const hint=/get_agent_combination\((\{[^)]*\})\)/.exec(String(reply?.content))?.[1];
    return hint?JSON.parse(hint):{id:'missing-recovery-hint'};
   }),
  ]) : []),
  ...(explicitRoles ? ['coding recipe','independent reviewer recipe'].map(label=>tool('get_agent_combination',()=>({
   id:new RegExp(`${label}: ([^;\\s]+)`).exec(JSON.stringify(messages(main)))?.[1]??'missing-recipe',
  }))) : [tool('list_agent_combinations',()=>({}))]),
  tool('propose_graph',()=>({proposal,requestId:'delivery-draft'}),'private-main-reasoning-marker'),{text:'Draft ready.'},
  tool('graph_send',()=>({graphId:graphId(),nodeId:'work',input:'job',value:{}})),
  ...(context==='frozen-explicit' ? [
   tool('get_task_status',()=>({graphId:graphId(),waitForNode:'work',timeoutMs:15000})),
   tool('get_task_status',()=>{
    const reply=messages(main).filter(message=>message.role==='tool').at(-1);
    const hint=/get_task_status\((\{[^)]*\})\)/.exec(String(reply?.content))?.[1];
    return hint?JSON.parse(hint):{taskId:'missing-status-target-hint'};
   }),
  ] : [tool('get_task_status',()=>({taskId:graphId(),waitForNode:'work',timeoutMs:15000}))]),
  tool('graph_inspect',()=>({graphId:graphId(),query:'acceptance'})),
  tool('graph_send',()=>({graphId:graphId(),nodeId:'check',input:'job',value:{}})),
  ...(context==='frozen-explicit' ? [
   tool('get_task_status',()=>({taskId:graphId(),nodeId:'toString'})),
   tool('get_task_status',()=>({taskId:graphId(),nodeId:'check'})),
   tool('get_task_status',()=>({taskId:graphId(),waitForNode:'check',timeoutMs:5000})),
   tool('graph_inspect',()=>{
    const reply=messages(main).filter(message=>message.role==='tool').at(-1);
    const hint=/graph_inspect\((\{[^)]*\})\)/.exec(String(reply?.content))?.[1];
    return hint?JSON.parse(hint):{graphId:graphId(),query:'missing-module-recovery-hint'};
   }),
   tool('graph_inspect',()=>({graphId:graphId(),query:'acceptance'})),
  ] : []),
  tool('graph_send',()=>({graphId:graphId(),nodeId:'review',input:'job',value:{commit:commit()}})),
  tool('get_task_status',()=>({taskId:graphId(),waitForNode:'review',timeoutMs:15000})),
  tool('graph_control',()=>({graphId:graphId(),action:'complete'})),{text:'Delivered.'},
 ]);
 try{
  const snapshot=join(root,'snapshot');
  if(frozenContext){
   const source=join(root,'context-source'),skill=join(source,'capabilities','skills','delivery-context');await mkdir(skill,{recursive:true});
   const text='---\nname: delivery-context\ndescription: Frozen delivery context.\n---\nFROZEN_DELIVERY_CONTEXT\n';
   await writeFile(join(skill,'SKILL.md'),text);
   await writeFile(join(skill,'capability.json'),JSON.stringify({id:'delivery-context',kind:'skill',version:'1',name:'delivery-context'}));
   await writeFile(join(source,'agent-combinations.json'),JSON.stringify({version:1,combinations:[['main','high',false],['coder','high',false],['reviewer','medium',true]].map(([id,recommendedGrade,review])=>({id,name:`Snapshot ${id}`,description:`Perform ${id} work with the frozen delivery skill.`,recommendedGrade,review,tags:[],...(id==='main'?{mode:'main'}:{}),systemPrompt:`Perform ${id} work with the bound delivery-context skill.`,resources:[{resourceId:'delivery-context',role:'skill',required:true,version:'1'}]}))}));
   await execute(process.execPath,['scripts/harness-eval-context.mjs',source,snapshot],{cwd:process.cwd()});
   await writeFile(join(skill,'SKILL.md'),text.replace('FROZEN_DELIVERY_CONTEXT','CHANGED_DELIVERY_CONTEXT'));
  }
  const configPath=join(root,'config.json');
  await writeFile(configPath,JSON.stringify({version:1,projects:[],credentials:{local:{secretRef:'GRAPH_EVAL_LOCAL_KEY'}},models:{entries:[['main',main,'high'],['worker',worker,'high'],['review',review,'medium']].map(([id,server,grade])=>({
   id,modelId:id,provider:`graph-${id}`,grade,api:'openai-completions',baseUrl:(server as typeof main).model.baseUrl,contextWindow:32000,maxTokens:256,credentialId:'local',cost:{input:2,output:4,cacheRead:.5,cacheWrite:1},
  })),preferences:frozenContext?{high:['worker']}:{}}}));
  const {stdout}=await execute(process.execPath,['scripts/harness-real-eval.mjs',configPath],{cwd:process.cwd(),timeout:60000,
   env:{...process.env,HOME:root,GRAPH_EVAL_LOCAL_KEY:'fixture-key',GRAPH_EVAL_CONFIRM_WORKFLOW:'1',GRAPH_EVAL_WORKER_MODEL:explicitRoles?'worker':'',GRAPH_EVAL_REVIEWER_MODEL:explicitRoles?'review':'',GRAPH_EVAL_TIMEOUT_MS:'35000',...(frozenContext?{GRAPH_EVAL_CONTEXT_SNAPSHOT:snapshot}:{})}});
  const report=JSON.parse(stdout);artifactRoot=report.root;
  expect(report,JSON.stringify({report,main:main.requests,worker:worker.requests,review:review.requests})).toMatchObject({completed:true,taskSuccess:true,success:true,workflow:{phase:'completed'}});
  if(explicitRoles){
   const initial=(main.requests[0] as {messages:{role:string;content:unknown}[]}).messages.filter(message=>message.role==='user');
   const text=JSON.stringify(initial);
   expect(text).toContain('修一下 config.js，空白行别当成配置，保留值里的等号。');
   expect(text).toContain('已批准的隔离评测执行约束');
   expect(text).toContain('worker model: worker');
   expect(text).toContain('reviewer model: review');
   expect(text).toContain('worktree');
   if(context==='frozen-explicit'){
    const replies=(main.requests[4] as {messages:{role:string;content:unknown}[]}).messages.filter(message=>message.role==='tool');
    expect(replies).toHaveLength(4);
    for(const [index,id] of [[0,'coder'],[2,'reviewer']] as const){
     expect(String(replies[index]?.content)).toContain(`Unknown Agent combination ${id}@2`);
     expect(JSON.parse(String(replies[index+1]?.content))).toMatchObject({id,name:`Snapshot ${id}`});
    }
   }
   const recoveryCalls=context==='frozen-explicit'?4:0;
   if(frozenContext)for(const [offset,id] of [[1,'coder'],[2,'reviewer']] as const){
    const index=offset+recoveryCalls;
    const reply=(main.requests[index] as {messages:{role:string;content:unknown}[]}).messages.filter(message=>message.role==='tool').at(-1);
    expect(JSON.stringify(reply)).not.toContain('Unknown Agent combination');
    expect(JSON.stringify(reply)).toContain(`Snapshot ${id}`);
   }
  }
  if(context==='frozen-explicit'){
   const replies=messages(main).filter(message=>message.role==='tool');
   const targetError=replies.find(message=>String(message.content).includes('uses taskId'));
   expect(String(targetError?.content)).toContain(`get_task_status(${JSON.stringify({taskId:graphId(),waitForNode:'work',timeoutMs:15000})})`);
   const status=replies.flatMap(message=>{try{return [JSON.parse(String(message.content))];}catch{return [];}})
    .find(value=>value.taskId===graphId() && value.reason==='settled');
   expect(status?.nodes).toEqual(expect.arrayContaining([expect.objectContaining({id:'work',status:'succeeded'})]));
   expect(replies.find(message=>String(message.content).includes('has no node toString'))?.content)
    .toBe(`RuntimeError: Task ${graphId()} has no node toString`);
   const rejected=replies.filter(message=>String(message.content).includes('has no node check'));
   expect(rejected).toHaveLength(2);
   for(const reply of rejected){
    expect(String(reply.content)).toContain('check is a module');
    expect(String(reply.content)).toContain(`graph_inspect(${JSON.stringify({graphId:graphId(),query:'operations'})})`);
   }
   const recovered=replies.flatMap(message=>{try{const value=JSON.parse(String(message.content));return Array.isArray(value)?value:[];}catch{return [];}})
    .find(value=>value.module_id==='check');
   expect(recovered).toMatchObject({request:{operation:{action:'workspace.command'}}});
   // Inspection can observe prepared/dispatched work; the completed runner report
   // above proves the real host check and final delivery subsequently settled.
  }
  // Observe actual outgoing provider bodies after real tool execution. Main also
  // crosses the persisted draft/confirmation operation boundary in this workflow.
  for(const [server,toolName,reasoning] of [
   [main,'propose_graph','private-main-reasoning-marker'],
   [worker,'write_file','private-worker-reasoning-marker'],
   [review,'artifact_list','private-review-reasoning-marker'],
  ] as const){
   const replayed=server.requests.flatMap(request=>(request as {messages:{role:string;reasoning_content?:string;content:unknown;tool_calls?:{function:{name:string}}[]}[]}).messages)
    .filter(message=>message.role==='assistant' && message.tool_calls?.some(call=>call.function.name===toolName));
   expect(replayed.length).toBeGreaterThan(1);
   for(const message of replayed){
    expect(message.reasoning_content).toBe(reasoning);
    expect(JSON.stringify(message.content)).not.toContain(reasoning);
   }
  }
  expect(await readFile(join(report.root,'project','config.js'),'utf8')).toBe(repaired);
  const ledger=JSON.parse(await readFile(join(report.root,'cost-report.json'),'utf8'));
  expect(ledger.tasks.find((task:{id:string})=>task.id===report.workflow.confirmedTaskId).executions).toBe(2);
  expect(ledger.summary.requests).toBe(main.requests.length+worker.requests.length+review.requests.length);
  const runPath=join(root,'run.json');await writeFile(runPath,stdout);
  const comparisonPath=join(root,'model-comparison.json');
  const group={name:'delivery',scope:'workflow',runs:[runPath]};
  const modelWeights={currency:'USD',models:[['main',2],['worker',1],['review',3]].map(([modelId,input])=>({model:modelId,perMillion:{input,output:4,cacheRead:.5,cacheWrite:null}}))};
  await writeFile(comparisonPath,JSON.stringify({groups:[group],modelWeights}));
  const compared=JSON.parse((await execute(process.execPath,['scripts/harness-eval-summary.mjs',comparisonPath],{cwd:process.cwd()})).stdout).groups[0];
  const expected=(main.requests.length*(25*2+10*4+15*.5)+worker.requests.length*(25+10*4+15*.5)+review.requests.length*(25*3+10*4+15*.5))/1_000_000;
  expect(compared.scenario.costPerCompletedTask).toBeCloseTo(expected,10);
  expect(compared.scenario.pricingComplete).toBe(true);
  await writeFile(comparisonPath,JSON.stringify({groups:[group],modelWeights:{...modelWeights,models:modelWeights.models.filter(row=>row.model!=='review')}}));
  const missingRate=JSON.parse((await execute(process.execPath,['scripts/harness-eval-summary.mjs',comparisonPath],{cwd:process.cwd()})).stdout).groups[0];
  expect(missingRate.scenario.costPerCompletedTask).toBeNull();
  expect(missingRate.scenario.pricingComplete).toBe(false);
  await writeFile(comparisonPath,JSON.stringify({groups:[group],modelWeights:{...modelWeights,models:modelWeights.models.map(row=>({...row,perMillion:{...row.perMillion,input:null}}))}}));
  const unknownRate=JSON.parse((await execute(process.execPath,['scripts/harness-eval-summary.mjs',comparisonPath],{cwd:process.cwd()})).stdout).groups[0];
  expect(unknownRate.scenario.costPerCompletedTask).toBeNull();
  expect(unknownRate.scenario.pricingComplete).toBe(false);


  if(frozenContext){
   for(const server of [worker,review]){expect(JSON.stringify(server.requests)).toContain('FROZEN_DELIVERY_CONTEXT');expect(JSON.stringify(server.requests)).not.toContain('CHANGED_DELIVERY_CONTEXT');}
   expect(report.evaluationContext.recipes).toHaveLength(3);
  }
 }finally{
  await Promise.all([main.close(),worker.close(),review.close()]);await rm(root,{recursive:true,force:true});
  if(artifactRoot)await rm(artifactRoot,{recursive:true,force:true});
 }
},75000);
