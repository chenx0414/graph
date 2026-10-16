import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {startGraphDaemon} from '../src/server/start.ts';
const exec=promisify(execFile);
if (process.argv.length !== 3) { console.error('Usage: GRAPH_COMPACT_DOCUMENTATION=0|1 node scripts/harness-real-eval.mjs /path/to/graph.config.json'); process.exit(1); }
const variant=process.env.GRAPH_DEFER_CATALOG_TOOLS==='1'?'deferred-catalog':process.env.GRAPH_COMPACT_DOCUMENTATION==='1'?'compact':'default';
const root=await mkdtemp(join(tmpdir(),`graph-real-eval-${variant}-`));
const project=join(root,'project');await mkdir(project);
await writeFile(join(project,'package.json'),'{"type":"module"}');
await writeFile(join(project,'config.js'),`export function parseConfig(text) { return Object.fromEntries(text.split('\\n').map(line => line.split('='))); }\n`);
const source=JSON.parse(await readFile(process.argv[2],'utf8'));
const model=source.models.entries[0];
const webDir=join(root,'web');await mkdir(webDir);await writeFile(join(webDir,'index.html'),'<!doctype html><div>Eval</div>');
const configPath=join(root,'config.json');
await writeFile(configPath,JSON.stringify({version:1,projects:[{id:'p',root:project}],credentials:source.credentials,models:{entries:[model]}}));
let daemon;
let result;
try {
 daemon=await startGraphDaemon({configPath,stateDir:join(root,'state'),graphHome:join(root,'graph'),webDir,port:0,mode:'execute',dynamic:true,env:process.env,log:()=>{}});
 const home=await fetch(daemon.url,{headers:{origin:daemon.url}});
 const headers={origin:daemon.url,cookie:home.headers.get('set-cookie')??'','content-type':'application/json'};
 const createdResponse=await fetch(`${daemon.url}/api/conversations`,{method:'POST',headers,body:JSON.stringify({projectId:'p',model:model.id,text:'修一下 config.js，空白行别当成配置，保留值里的等号。',requestId:'real-parser-eval'})});
 if(!createdResponse.ok)throw new Error(`create: ${createdResponse.status}`);
 const created=await createdResponse.json();
 const began=Date.now();let completed=false;
 while(Date.now()-began<120000){
  const view=await(await fetch(`${daemon.url}/api/conversations/${created.conversationId}`,{headers})).json();
  if(view.messages.some(m=>m.role==='assistant')){completed=true;break;}
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 let success=false;let verification='';
 try {const checked=await exec(process.execPath,['--input-type=module','-e',`import {parseConfig} from './config.js';const result=parseConfig('A=one=two\\n\\nB=3\\n');if(result.A!=='one=two'||result.B!=='3'||Object.keys(result).length!==2)process.exit(1);console.log('verified')`],{cwd:project});success=checked.stdout.trim()==='verified';verification=success?'verified':'wrong output';} catch {verification='behavioral CLI check failed';}
 result={variant,root,model:model.id,completed,success,verification,elapsedMs:Date.now()-began,taskId:created.taskId};
} catch(error){result={variant,root,model:model.id,error:error instanceof Error?error.message:String(error)};}
finally {await daemon?.close();}
const report=await exec(process.execPath,[new URL('./harness-cost.mjs', import.meta.url).pathname,join(root,'state','tasks.sqlite')]);
await writeFile(join(root,'cost-report.json'),report.stdout);
const cost=JSON.parse(report.stdout);
const db=new DatabaseSync(join(root,'state','tasks.sqlite'),{readOnly:true});
const settled=db.prepare('SELECT state,settled_at-dispatched_at AS operationMs FROM operations ORDER BY rowid DESC LIMIT 1').get();
db.close();
result={...result,settled};
console.log(JSON.stringify({...result,accounting:cost.summary,task:cost.tasks[0]},null,2));
