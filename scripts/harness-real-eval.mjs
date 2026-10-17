import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {startGraphDaemon} from '../src/server/start.ts';
import {cases} from './harness-eval-cases.mjs';
const exec=promisify(execFile);
if (process.argv.length < 3 || process.argv.length > 4) { console.error('Usage: node scripts/harness-real-eval.mjs /path/to/graph.config.json [parser|cli|persistence|command]'); process.exit(1); }
const caseId=process.argv[3] ?? 'parser';
const scenario=cases[caseId];if(!scenario)throw new Error(`Unknown evaluation case: ${caseId}`);
const deadlineMs=Number(process.env.GRAPH_EVAL_TIMEOUT_MS ?? 120000);
if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error('Invalid GRAPH_EVAL_TIMEOUT_MS');
const variant=process.env.GRAPH_MATCH_SEARCH_GUIDANCE==='1'?'matched-search':process.env.GRAPH_CLASSIFY_HARNESS_FRICTION==='1'?'classified-friction':process.env.GRAPH_DEFER_BROWSER_TOOLS==='1'?'deferred-browser':process.env.GRAPH_DEFER_CATALOG_TOOLS==='1'?'deferred-catalog':process.env.GRAPH_COMPACT_DOCUMENTATION==='1'?'compact':'default';
const root=await mkdtemp(join(tmpdir(),`graph-real-eval-${variant}-`));
const project=join(root,'project');await mkdir(project);
await writeFile(join(project,'package.json'),'{"type":"module"}');
for(const [path,content] of Object.entries(scenario.files))await writeFile(join(project,path),content);
const source=JSON.parse(await readFile(process.argv[2],'utf8'));
const model=source.models.entries[0];
const webDir=join(root,'web');await mkdir(webDir);await writeFile(join(webDir,'index.html'),'<!doctype html><div>Eval</div>');
const configPath=join(root,'config.json');
await writeFile(configPath,JSON.stringify({version:1,projects:[{id:'p',root:project}],credentials:source.credentials,models:{entries:[model]}}));
const graphHome=join(root,'graph');
if(process.env.GRAPH_EVAL_BROWSER_SOURCE){
 const browserSource=process.env.GRAPH_EVAL_BROWSER_SOURCE;
 const pkg=JSON.parse(await readFile(join(browserSource,'package.json'),'utf8'));
 const capability=join(graphHome,'capabilities','eval-browser');await mkdir(capability,{recursive:true});
 await writeFile(join(capability,'capability.json'),JSON.stringify({id:'eval-browser',kind:'pi-extension',name:'Bound browser evaluation',version:pkg.version,source:browserSource,base:true,
  runtime:{commands:['agent-browser'],env:{PATH:process.env.PATH,HOME:process.env.HOME},networkAccess:'unrestricted'},
  tools:[{name:'agent_browser',description:'Browse live websites.'}]}));
}
let daemon;
let result;
let cleanupIncomplete=false;
try {
 daemon=await startGraphDaemon({configPath,stateDir:join(root,'state'),graphHome,webDir,port:0,mode:'execute',dynamic:true,env:process.env,log:()=>{}});
 const home=await fetch(daemon.url,{headers:{origin:daemon.url}});
 const headers={origin:daemon.url,cookie:home.headers.get('set-cookie')??'','content-type':'application/json'};
 const createdResponse=await fetch(`${daemon.url}/api/conversations`,{method:'POST',headers,body:JSON.stringify({projectId:'p',model:model.id,text:scenario.prompt,requestId:'real-parser-eval'})});
 if(!createdResponse.ok)throw new Error(`create: ${createdResponse.status}`);
 const created=await createdResponse.json();
 const began=Date.now();let completed=false;
 while(Date.now()-began<deadlineMs){
  const operations=await(await fetch(`${daemon.url}/api/tasks/${created.taskId}/operations?latest=true`,{headers})).json();
  if(operations.length && operations.every(operation=>operation.state!=='dispatched' && operation.state!=='prepared')){completed=operations.every(operation=>operation.state==='succeeded');break;}
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 const timedOut=!completed && Date.now()-began>=deadlineMs;
 if(timedOut){
  const paused=await fetch(`${daemon.url}/api/conversations/${created.conversationId}/pause`,{method:'POST',headers,body:JSON.stringify({requestId:'eval-deadline-pause'})});
  if(!paused.ok)throw new Error(`pause: ${paused.status}`);
  const cancelBegan=Date.now();
  while(true){
   const interrupted=await fetch(`${daemon.url}/api/conversations/${created.conversationId}/interrupt`,{method:'POST',headers,body:JSON.stringify({requestId:'eval-deadline-interrupt'})});
   if(interrupted.ok)break;
   const refusal=await interrupted.json();
   if(refusal.code!=='no_active_operation' || Date.now()-cancelBegan>=30000)throw new Error(`interrupt: ${interrupted.status} ${refusal.code}`);
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  // An interrupted SDK turn can finish before its transport usage observer.
  // cost is written for every settled invocation, including unknown usage.
  // Startup can be active before it creates its first invocation.
  const ledger=new DatabaseSync(join(root,'state','tasks.sqlite'),{readOnly:true});
  try {
   const pending=ledger.prepare(`SELECT
    (SELECT COUNT(*) FROM operations WHERE task_id=?1 AND worker_active=1) +
    (SELECT COUNT(*) FROM invocations i JOIN operations o ON o.id=i.operation_id WHERE o.task_id=?1 AND i.cost IS NULL) AS n`);
   const drainBegan=Date.now();
   while(pending.get(created.taskId).n>0 && Date.now()-drainBegan<30000)await new Promise(resolve=>setTimeout(resolve,100));
   cleanupIncomplete=pending.get(created.taskId).n>0;
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
  verification='behavioral CLI check failed';
 }

 result={variant,caseId,root,model:model.id,completed,timedOut,success,verification,verificationEvidence,elapsedMs:Date.now()-began,taskId:created.taskId};
} catch(error){result={variant,root,model:model.id,error:error instanceof Error?error.message:String(error)};}
finally {if(!cleanupIncomplete)await daemon?.close();}
// Persist the verifier only after the model process has stopped.
if(!cleanupIncomplete)await writeFile(join(root,'case.json'),JSON.stringify({caseId,...scenario},null,2));
const report=await exec(process.execPath,[new URL('./harness-cost.mjs', import.meta.url).pathname,join(root,'state','tasks.sqlite')]);
await writeFile(join(root,'cost-report.json'),report.stdout);
const cost=JSON.parse(report.stdout);
const db=new DatabaseSync(join(root,'state','tasks.sqlite'),{readOnly:true});
const settled=db.prepare('SELECT state,settled_at-dispatched_at AS operationMs FROM operations ORDER BY rowid DESC LIMIT 1').get();
db.close();
result={...result,settled,cleanupIncomplete,taskSuccess:result.success===true && result.completed===true && settled?.state==='succeeded'};
console.log(JSON.stringify({...result,accounting:cost.summary,task:cost.tasks[0]},null,2));

// This standalone evaluator owns its process. If a transport never drains, keep
// its durable unknown ledger and exit rather than closing SQLite under a writer.
if(cleanupIncomplete)process.exit(2);
