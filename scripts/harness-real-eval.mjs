import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {startGoDaemon,openConsole} from './go-daemon.mjs';
import {cases} from './harness-eval-cases.mjs';
import {installEvaluationContext} from './harness-eval-context.mjs';
const exec=promisify(execFile);
if (process.argv.length < 3 || process.argv.length > 4) { console.error('Usage: node scripts/harness-real-eval.mjs /path/to/graph.config.json [parser|cli|persistence|command]'); process.exit(1); }
const caseId=process.argv[3] ?? 'parser';
const scenario=cases[caseId];if(!scenario)throw new Error(`Unknown evaluation case: ${caseId}`);
const deadlineMs=Number(process.env.GRAPH_EVAL_TIMEOUT_MS ?? 120000);
if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error('Invalid GRAPH_EVAL_TIMEOUT_MS');
const variant=process.env.GRAPH_COMPACT_SHELL_RESULTS==='1'?'compact-shell':process.env.GRAPH_SCOPED_SYSTEM_CAPABILITIES==='1'?'scoped-capabilities':process.env.GRAPH_MATCH_SEARCH_GUIDANCE==='1'?'matched-search':process.env.GRAPH_CLASSIFY_HARNESS_FRICTION==='1'?'classified-friction':process.env.GRAPH_DEFER_BROWSER_TOOLS==='1'?'deferred-browser':process.env.GRAPH_DEFER_CATALOG_TOOLS==='1'?'deferred-catalog':process.env.GRAPH_COMPACT_DOCUMENTATION==='1'?'compact':'default';
const root=await mkdtemp(join(tmpdir(),`graph-real-eval-${variant}-`));
const project=join(root,'project');await mkdir(project);
await writeFile(join(project,'package.json'),'{"type":"module"}');
for(const [path,content] of Object.entries(scenario.files))await writeFile(join(project,path),content);
const source=JSON.parse(await readFile(process.argv[2],'utf8'));
const model=source.models.entries[0];
const contextSnapshot=process.env.GRAPH_EVAL_CONTEXT_SNAPSHOT;
const workerId=process.env.GRAPH_EVAL_WORKER_MODEL;
const reviewerId=process.env.GRAPH_EVAL_REVIEWER_MODEL;
const configuredModel=id=>{
 const entry=source.models.entries.find(entry=>entry.id===id);
 if(!entry)throw new Error(`Evaluation model is not configured: ${id}`);
 return entry;
};
const worker=workerId ? configuredModel(workerId) : model;
const reviewer=reviewerId ? configuredModel(reviewerId) : undefined;
if(reviewer && !workerId)throw new Error('Reviewer selection requires an explicit worker model');
const entries=contextSnapshot ? source.models.entries : [...new Map([model,worker,...(reviewer?[reviewer]:[])].map(entry=>[entry.id,entry])).values()];
const webDir=join(root,'web');await mkdir(webDir);await writeFile(join(webDir,'index.html'),'<!doctype html><div>Eval</div>');
const configPath=join(root,'config.json');
const evaluationConfig={...source,projects:[{id:'p',root:project}],models:contextSnapshot?source.models:{entries}};
await writeFile(configPath,JSON.stringify(evaluationConfig),{mode:0o600});
const graphHome=join(root,'graph');
let evaluationContext;
try {
 if(contextSnapshot){
  if(process.env.GRAPH_EVAL_BROWSER_SOURCE)throw new Error('Frozen context cannot be combined with an ad-hoc browser capability');
  const frozen=await installEvaluationContext(contextSnapshot,graphHome);
  evaluationContext={sha256:frozen.sha256,recipes:frozen.recipes,capabilities:frozen.capabilities.length,packageCacheIncluded:Boolean(frozen.packageCacheIncluded),catalogValidated:true,allRuntimeDependenciesProven:false};
 }
}catch(error){await rm(root,{recursive:true,force:true});throw error;}
if(process.env.GRAPH_EVAL_BROWSER_SOURCE){
 const browserSource=process.env.GRAPH_EVAL_BROWSER_SOURCE;
 const pkg=JSON.parse(await readFile(join(browserSource,'package.json'),'utf8'));
 const capability=join(graphHome,'capabilities','eval-browser');await mkdir(capability,{recursive:true});
 await writeFile(join(capability,'capability.json'),JSON.stringify({id:'eval-browser',kind:'pi-extension',name:'Bound browser evaluation',version:pkg.version,source:browserSource,base:true,
  runtime:{commands:['agent-browser'],env:{PATH:process.env.PATH,HOME:process.env.HOME},networkAccess:'unrestricted'},
  tools:[{name:'agent_browser',description:'Browse live websites.'}]}));
}
const workflowEnabled=process.env.GRAPH_EVAL_CONFIRM_WORKFLOW==='1';
const workflow=workflowEnabled ? {coderAvailable:false,proposalSeen:false,confirmedTaskId:null,phase:null,awaitingInput:false,taskIds:[]} : undefined;
let daemon;
let console_;
let result;
let ownerTaskId;
let cleanupError;
let cleanupIncomplete=false;
let toolTelemetry={collected:false,reason:'daemon_unavailable'};
// A recipe's resources are compared by what they mean, not by the order the
// daemon and the snapshot happen to serialize them in.
const resourceFacts=list=>(list??[]).map(item=>({resourceId:item.resourceId,version:item.version??'',role:item.role,required:Boolean(item.required)}))
 .sort((left,right)=>left.resourceId.localeCompare(right.resourceId));
try {
 daemon=await startGoDaemon({root,configPath,stateDir:join(root,'state'),graphHome,webDir,mode:'execute'});
 console_=await openConsole(daemon.url);
 if(evaluationContext){
  const catalog=await console_.json('/api/catalog');
  for(const expected of evaluationContext.recipes){
   const actual=catalog.agentCombinations.find(recipe=>recipe.id===expected.id);
   if(actual?.status!=='valid'||JSON.stringify(resourceFacts(actual.resources))!==JSON.stringify(resourceFacts(expected.resources)))throw new Error(`Frozen recipe did not load: ${expected.id}`);
  }
 }
 if(workflow){
  if(evaluationContext){
   workflow.coderDefinition=(await console_.post('/api/catalog/combinations/coder/compile')).definitionVersion;
   const frozenCatalog=await console_.json('/api/catalog');
   if(frozenCatalog.agentCombinations.some(recipe=>recipe.id==='reviewer'))workflow.reviewerDefinition=(await console_.post('/api/catalog/combinations/reviewer/compile')).definitionVersion;
  }else{
  const coderRecipe=await console_.post('/api/catalog/combinations',{combination:{id:'coder',name:'Controlled coding worker',description:`Implement the assigned project change and verify its acceptance in its worktree.${workerId ? ` Evaluation worker model: ${worker.id}.` : ''}`,recommendedGrade:worker.grade,review:false,tags:[],resources:[],systemPrompt:'Implement the assigned project change in the provided worktree. Follow the declared acceptance criteria and report evidence through the bound tools.'}});
  workflow.coderDefinition=coderRecipe.definition?.definitionVersion;
  if(reviewer){
   const reviewRecipe=await console_.post('/api/catalog/combinations',{combination:{id:'reviewer',name:'Independent reviewer',description:`Review immutable code artifacts and the exact integration commit. Evaluation reviewer model: ${reviewer.id}.`,recommendedGrade:reviewer.grade,review:true,tags:[],resources:[],systemPrompt:'Review the immutable code artifacts and current integration commit, and publish the independent review through the bound tools.'}});
   workflow.reviewerDefinition=reviewRecipe.definition?.definitionVersion;
  }
  }
  await console_.post('/api/projects/p/prepare',{requestId:'eval-prepare',initialize:true,createBaseline:true});
  workflow.coderAvailable=true;
 }
 // Model selection is an approved evaluation constraint, not a recipe rewrite.
 // Keep the original business request separate from this user-role setup.
 const executionConstraints=workflow && workerId ? [
  '[已批准的隔离评测执行约束]',
  `通过正式 graph 完成交付，coding recipe: coder; graph node definition: ${workflow.coderDefinition}; worker model: ${worker.id}; workspace.base: worktree。main 负责规划、协调和验收，由 coding worker 修改业务文件。`,
  ...(reviewer ? [`independent reviewer recipe: reviewer; graph node definition: ${workflow.reviewerDefinition}; reviewer model: ${reviewer.id}。reviewer 读取不可变代码 artifact 并审查当前 integration commit，独立于实现者。`] : []),
  '发布 proposal 后，隔离 runner 将通过公开接口确认。保留真实 worktree 提交、代码 artifact、host check、正式验收和目标项目交付；完成整个 graph 后再报告交付。',
 ].join('\n') : '';
 const initialText=[scenario.prompt,executionConstraints].filter(Boolean).join('\n\n');
 await writeFile(join(root,'execution-setup.json'),JSON.stringify({originalTask:scenario.prompt,executionConstraints,initialText},null,2),{mode:0o600});
 const created=await console_.post('/api/conversations',{projectId:'p',model:model.id,text:initialText,requestId:'real-parser-eval'});
 ownerTaskId=created.taskId;
 if(workflow)workflow.taskIds.push(created.taskId);
 const began=Date.now();let completed=false;
 while(Date.now()-began<deadlineMs){
  const operations=await console_.json(`/api/tasks/${created.taskId}/operations?latest=true`);
  const masterIdle=operations.length && operations.every(operation=>!operation.workerActive && !['dispatched','prepared','not_sent'].includes(operation.state));
  if(workflow){
   const view=await console_.json(`/api/conversations/${created.conversationId}`);
   if(view.proposal && !view.proposal.stale && masterIdle && !workflow.confirmedTaskId){
    workflow.proposalSeen=true;
    if(workerId){
     const draft=await console_.json(`/api/conversations/${created.conversationId}/proposals/${view.proposal.version}`);
     for(const node of Object.values(draft.spec.definition.nodes)){
      const expected=node.recipe===workflow.coderDefinition ? worker.id : node.recipe===workflow.reviewerDefinition ? reviewer?.id : undefined;
      if(!expected || node.model!==expected || (node.recipe===workflow.coderDefinition && node.workspace?.base!=='worktree'))throw new Error('Draft violates frozen evaluation worker/reviewer configuration');
     }
    }
    const confirmed=await console_.post(`/api/conversations/${created.conversationId}/confirm`,{proposalVersion:view.proposal.version,draftRevision:view.proposal.draftRevision,targetBranch:'main',requestId:'eval-confirm'});
    workflow.confirmedTaskId=confirmed.taskId;workflow.taskIds.push(confirmed.taskId);
    await console_.post(`/api/conversations/${created.conversationId}/messages`,{text:`已确认 graph ${confirmed.taskId}，继续按验收执行并交付。`,requestId:'eval-continue'});
   }
   const graph=view.tasks.find(task=>task.id===workflow.confirmedTaskId);
   workflow.phase=graph?.phase ?? null;
   if(graph?.phase==='completed' && masterIdle){completed=true;break;}
   if(masterIdle && ((graph?.openQuestions?.length ?? 0)>0 || (view.questions?.length ?? 0)>0)){
    workflow.awaitingInput=true;break;
   }
  } else if(masterIdle){completed=operations.every(operation=>operation.state==='succeeded');break;}

  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 const timedOut=!completed && Date.now()-began>=deadlineMs;
 if(timedOut){
  if(workflow?.confirmedTaskId)await console_.post(`/api/tasks/${workflow.confirmedTaskId}/graph/control`,{action:'stop'});
  const paused=await console_.request(`/api/conversations/${created.conversationId}/pause`,{method:'POST',body:JSON.stringify({requestId:'eval-deadline-pause'})});
  if(paused.status!==200)throw new Error(`pause: ${paused.status}`);
  const cancelBegan=Date.now();
  while(true){
   const interrupted=await console_.request(`/api/conversations/${created.conversationId}/interrupt`,{method:'POST',body:JSON.stringify({requestId:'eval-deadline-interrupt'})});
   if(interrupted.status===200)break;
   const refusal=interrupted.body??{};
   if(refusal.code!=='no_active_operation' || Date.now()-cancelBegan>=30000)throw new Error(`interrupt: ${interrupted.status} ${refusal.code}`);
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  // An interrupted SDK turn can finish before its transport usage observer.
  // cost is written for every settled invocation, including unknown usage.
  // Startup can be active before it creates its first invocation.
  const ledger=new DatabaseSync(join(root,'state','tasks.sqlite'),{readOnly:true});
  try {
   const pending=ledger.prepare(`SELECT
    (SELECT COUNT(*) FROM operations WHERE task_id IN (?1,?2) AND worker_active=1) +
    (SELECT COUNT(*) FROM invocations i JOIN operations o ON o.id=i.operation_id WHERE o.task_id IN (?1,?2) AND i.cost IS NULL) AS n`);
   const drainBegan=Date.now();
   // Allow the opt-in 30s transport drain to settle and persist before this
   // outer cleanup deadline; equal deadlines race the final unknown write.
   const drainDeadlineMs=process.env.GRAPH_DRAIN_CANCELED_USAGE==='1' ? 35000 : 30000;
   while(pending.get(created.taskId,workflow?.confirmedTaskId ?? created.taskId).n>0 && Date.now()-drainBegan<drainDeadlineMs)await new Promise(resolve=>setTimeout(resolve,100));
   cleanupIncomplete=pending.get(created.taskId,workflow?.confirmedTaskId ?? created.taskId).n>0 || ledger.prepare("SELECT COUNT(*) AS n FROM operations WHERE task_id IN (?,?) AND state='unknown'").get(created.taskId,workflow?.confirmedTaskId ?? created.taskId).n>0;
  } finally {ledger.close();}
 }
 let success=false;let verification='';let verificationEvidence;
 try {
  const checked=await exec(process.execPath,['--input-type=module','-e',scenario.verify],{cwd:project,timeout:15000});
  verificationEvidence=checked.stdout.trim() || undefined;
  for(const path of scenario.unchanged ?? [])if(await readFile(join(project,path),'utf8')!==scenario.files[path])throw new Error('protected file changed');
  success=true;verification='verified';
 } catch(error) {
  if(typeof error?.stdout==='string')verificationEvidence=error.stdout.trim() || undefined;
  verification='behavioral CLI check failed: '+String(error?.stderr || error?.message || error).slice(0,4000);
 }

 result={variant,caseId,root,model:model.id,completed,timedOut,success,verification,verificationEvidence,workflow,elapsedMs:Date.now()-began,taskId:created.taskId};
} catch(error){result={variant,caseId,root,model:model.id,taskId:ownerTaskId,workflow,error:error instanceof Error?error.message:String(error)};}
finally {
 if(workflow?.confirmedTaskId && ownerTaskId && workflow.phase!=='completed'){
  try {await console_?.post(`/api/tasks/${workflow.confirmedTaskId}/graph/control`,{action:'stop'});}
  catch(error){cleanupError=String(error);}
 }
 // The daemon owns the state directory and this process only reads it. A
 // transport that never drains leaves the daemon's ledger unsettled - the
 // report says so out loud instead of keeping the process alive.
 if(console_)try {await console_.json('/api/tool-stats');toolTelemetry={collected:true};}
 catch(error){toolTelemetry={collected:false,error:String(error)};}
 await daemon?.close();
}
// Persist the verifier only after the model process has stopped.
await writeFile(join(root,'case.json'),JSON.stringify({caseId,...scenario},null,2));
const report=await exec(process.execPath,[new URL('./harness-cost.mjs', import.meta.url).pathname,join(root,'state','tasks.sqlite')]);
await writeFile(join(root,'cost-report.json'),report.stdout);
const cost=JSON.parse(report.stdout);
const db=new DatabaseSync(join(root,'state','tasks.sqlite'),{readOnly:true});
const settled=db.prepare('SELECT state,settled_at-dispatched_at AS operationMs FROM operations ORDER BY rowid DESC LIMIT 1').get();
db.close();
result={...result,evaluationContext,settled,cleanupIncomplete,toolTelemetry,...(cleanupError ? {cleanupError} : {}),taskSuccess:result.success===true && result.completed===true && settled?.state==='succeeded'};
const finalReport={...result,accounting:cost.summary,task:cost.tasks[0]};
await writeFile(join(root,'evaluation-report.json'),JSON.stringify(finalReport,null,2));
console.log(JSON.stringify(finalReport,null,2));
