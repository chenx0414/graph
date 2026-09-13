// Run from the Graph repository root with its Node 24.20.0.
// A separate host client reacts to the normal listening event. Restricted runs have a 3-second deadline.
import {mkdtemp,mkdir,realpath,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {request} from 'node:http';
import {openRestrictedExecutor} from '../../../src/runtime/restricted-process.ts';
const root=process.cwd();
const currentHead=execFileSync('/usr/bin/git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const base=await realpath(await mkdtemp(join(tmpdir(),'graph-ready-race-')));
const scratch=join(base,'scratch');await mkdir(scratch);
const req=createRequire(join(root,'package.json'));
const previous=execFileSync('/usr/bin/git',['show','283ffbb:src/runtime/restricted-process.ts'],{cwd:root,encoding:'utf8'}).replace("from '@anthropic-ai/sandbox-runtime'",'from '+JSON.stringify(req.resolve('@anthropic-ai/sandbox-runtime')));
await writeFile(join(base,'baseline.ts'),previous);
const {openRestrictedExecutor:openPrevious}=await import(join(base,'baseline.ts'));
const gate={dispatch(_id,_r,send){return send()},settle(){}};
try{for(const [revision,open] of [[currentHead,openRestrictedExecutor],['283ffbb',openPrevious]]){
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 await writeFile(join(base,'event.cjs'),`const {createServer}=require('node:http');const fs=require('node:fs');const s=createServer((q,r)=>r.end('ok'));s.once('listening',()=>{fs.writeFileSync(${JSON.stringify(join(base,'ready'))},'ready');const end=Date.now()+250;while(Date.now()<end){};});s.listen(${port},'127.0.0.1',()=>console.log('CALLBACK'));setTimeout(()=>s.close(()=>console.log('CLOSED')),900);`);
 await rm(join(base,'ready'),{force:true});
 const executor=await open();const started=Date.now();
 try{
 const running=executor.run({broker:gate,cwd:base,scratchDir:scratch,executable:process.execPath,args:['event.cjs'],readPaths:[base,dirname(process.execPath)],writePaths:[base],localNetwork:true,timeoutMs:3000});
 const client=await new Promise(resolve=>{let tries=0;const tick=async()=>{if(++tries>200){resolve({error:'READY_TIMEOUT'});return}try{await realpath(join(base,'ready'))}catch{setTimeout(tick,5);return}const start=Date.now();const q=request({hostname:'127.0.0.1',port,agent:false},r=>{let body='';r.on('data',x=>body+=x);r.on('end',()=>resolve({body,elapsedMs:Date.now()-start}))});q.setTimeout(600,()=>q.destroy(new Error('TIMEOUT')));q.on('error',e=>resolve({error:e.message,elapsedMs:Date.now()-start}));q.end()};void tick()});
 const result=await running;console.log(JSON.stringify({revision,client,elapsedMs:Date.now()-started,...result}));
 }finally{await executor.close()}
}}finally{await rm(base,{recursive:true,force:true})}
