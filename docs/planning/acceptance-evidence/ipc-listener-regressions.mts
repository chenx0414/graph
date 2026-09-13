// Run from the Graph repository root using its Node 24.20.0.
// Synthetic checks only; every restricted process has a 2-second deadline.
// Exit 0 means the probe completed; inspect each scenario code and observations.
import {mkdtemp,mkdir,realpath,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {openRestrictedExecutor} from '../../../src/runtime/restricted-process.ts';
const root=process.cwd();
const currentHead=execFileSync('/usr/bin/git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const base=await realpath(await mkdtemp(join(tmpdir(),'graph-ipc-contract-')));
const scratch=join(base,'scratch');await mkdir(scratch);
const scripts={
 'close-pending.cjs':`const {createServer}=require('node:net'); const s=createServer(); let callback=false;
s.listen(0,'127.0.0.1',()=>{callback=true;console.log('LISTEN_AFTER_CLOSE',JSON.stringify(s.address()))});
s.close(error=>console.log('closeCallback',error?.code));
setTimeout(()=>console.log(JSON.stringify({callback,listening:s.listening,address:s.address()})),200);`,
 'parallel.cjs':`const {createServer}=require('node:http');
(async()=>{const servers=[];try{const results=await Promise.all([1,2,3].map(index=>new Promise(resolve=>{const s=createServer((q,r)=>r.end('ok-'+index));servers.push(s);s.once('error',e=>resolve({index,error:e.code}));s.listen(0,'127.0.0.1',()=>resolve({index,port:s.address().port}));})));console.log(JSON.stringify({results}));for(const result of results){if(!result.port)continue;try{const body=await(await fetch('http://127.0.0.1:'+result.port,{signal:AbortSignal.timeout(500)})).text();console.log(JSON.stringify({index:result.index,body}));}catch(e){console.log(JSON.stringify({index:result.index,fetchError:e.name}))}}}finally{for(const s of servers)await new Promise(resolve=>s.close(resolve))}})().catch(e=>{console.error(e);process.exitCode=1});`,
};
for(const [name,source] of Object.entries(scripts))await writeFile(join(base,name),source);
const req=createRequire(join(root,'package.json'));
const previous=execFileSync('/usr/bin/git',['show','283ffbb:src/runtime/restricted-process.ts'],{cwd:root,encoding:'utf8'}).replace("from '@anthropic-ai/sandbox-runtime'",'from '+JSON.stringify(req.resolve('@anthropic-ai/sandbox-runtime')));
await writeFile(join(base,'baseline.ts'),previous);
const {openRestrictedExecutor:openPrevious}=await import(join(base,'baseline.ts'));
const gate={dispatch(_id,_r,send){return send()},settle(){}};
try{
for(const [revision,open] of [[currentHead,openRestrictedExecutor],['283ffbb',openPrevious]]){
 const executor=await open();
 try{for(const name of Object.keys(scripts)){
 const started=Date.now();
 const result=await executor.run({broker:gate,cwd:base,scratchDir:scratch,executable:process.execPath,args:[name],readPaths:[base,dirname(process.execPath)],writePaths:[base],localNetwork:true,timeoutMs:2000});
 console.log(JSON.stringify({revision,scenario:name,elapsedMs:Date.now()-started,...result}));
 }}finally{await executor.close()}
}
}finally{await rm(base,{recursive:true,force:true})}
