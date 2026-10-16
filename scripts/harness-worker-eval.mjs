import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startGraphDaemon} from '../src/server/start.ts';
import {parseGraphDefinition} from '../src/core/interface-spec.ts';
import {cases} from './harness-eval-cases.mjs';
const exec=promisify(execFile);
const [configFile,caseId='parser']=process.argv.slice(2);
if(!configFile || !cases[caseId])throw new Error('Usage: node scripts/harness-worker-eval.mjs config.json [parser|cli|persistence|command]');
const scenario=cases[caseId];
const deadlineMs=Number(process.env.GRAPH_EVAL_TIMEOUT_MS ?? 120000);
if(!Number.isSafeInteger(deadlineMs)||deadlineMs<=0)throw new Error('Invalid deadline');
const root=await mkdtemp(join(tmpdir(),'graph-worker-eval-'));
const project=join(root,'project');await mkdir(project);
await writeFile(join(project,'package.json'),'{"type":"module"}');
for(const [path,content] of Object.entries(scenario.files))await writeFile(join(project,path),content);
const source=JSON.parse(await readFile(configFile,'utf8'));
const model=source.models.entries[0];
const configPath=join(root,'config.json');
await writeFile(configPath,JSON.stringify({version:1,projects:[{id:'p',root:project}],credentials:source.credentials,models:{entries:[model]},access:{mode:'standard'}}),{mode:0o600});
const webDir=join(root,'web');await mkdir(webDir);await writeFile(join(webDir,'index.html'),'<!doctype html>');
const began=Date.now();let daemon;let result;let drive;
try {
 daemon=await startGraphDaemon({configPath,stateDir:join(root,'state'),graphHome:join(root,'graph'),webDir,port:0,mode:'view',dynamic:true,env:process.env,log:()=>{}});
 const runtime=daemon.server.runtime;
 runtime.catalog.publishDefinition('eval-worker',{recommendedGrade:model.grade},'publish-worker');
 const {taskId}=await runtime.user.begin({projectId:'p',request:scenario.prompt,requestId:'begin'});
 const main=runtime.supervisor(taskId);
 const definition=parseGraphDefinition({schemaVersion:2,name:'Frozen worker evaluation',protocols:{data:{type:'object'}},
  nodes:{work:{recipe:'eval-worker@1',model:model.id,task:scenario.prompt,workspace:{base:'worktree'},inputs:{job:{protocol:'data'}},outputs:{},submission:{}}},
  modules:{},edges:{},inputs:{},outputs:{},acceptance:[{id:'behavior',description:'External CLI verification',kind:'human'}]});
 await main.propose({requirementVersion:1,summary:scenario.prompt,acceptance:[{id:'behavior',description:'External CLI verification',checkNode:'work'}],definition},'proposal');
 await runtime.user.task(taskId).accept({proposalVersion:1,draftRevision:1,targetBranch:'main',requestId:'accept'});
 await main.graphSend({graphId:taskId,nodeId:'work',input:'job',value:{}});
 let driveError;let driving=true;
 drive=runtime.host.drive().catch(error=>{driveError=String(error);}).finally(()=>{driving=false;});
 const executionBegan=Date.now();let execution;
 while(Date.now()-executionBegan<deadlineMs){
  const view=await main.graphInspect({graphId:taskId,query:'executions'});
  execution=view.items.at(-1);
  if(execution && ['completed','failed','cancelled','interrupted'].includes(execution.state))break;
  if(!driving)break;
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 const timedOut=driving && execution?.state!=='completed' && Date.now()-executionBegan>=deadlineMs;
 if(timedOut)await main.graphControl({graphId:taskId,action:'stop'});
 await drive;
 const executions=await main.graphInspect({graphId:taskId,query:'executions'});
 execution=executions.items.at(-1);
 const view=await runtime.user.task(taskId).view();
 const workspace=view.worktrees.find(item=>item.nodeId==='work')?.path;
 let behavior=false;let verification='No isolated workspace';
 if(workspace){
  try {
   await exec(process.execPath,['--input-type=module','-e',scenario.verify],{cwd:workspace,timeout:15000});
   for(const path of scenario.unchanged ?? [])if(await readFile(join(workspace,path),'utf8')!==scenario.files[path])throw new Error('Protected file changed');
   behavior=true;verification='verified';
  } catch {verification='Behavioral CLI verification failed';}
 }
 result={root,caseId,model:model.id,grade:model.grade,taskId,workspace,execution,timedOut,behavior,verification,driveError,
  taskSuccess:!timedOut && execution?.state==='completed' && behavior,elapsedMs:Date.now()-began};
} catch(error){result={root,caseId,model:model.id,error:String(error),taskSuccess:false};}
finally {await daemon?.close();}
// Worker has ended before the verifier becomes a local artifact.
await writeFile(join(root,'case.json'),JSON.stringify({caseId,...scenario},null,2));
const {stdout}=await exec(process.execPath,[resolve('scripts/harness-cost.mjs'),join(root,'state','tasks.sqlite')]);
await writeFile(join(root,'cost-report.json'),stdout);
console.log(JSON.stringify({...result,accounting:JSON.parse(stdout)},null,2));
