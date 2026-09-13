// Run from the Graph repository root using its Node 24.20.0.
// Each restricted check has a two-second deadline. Probe exit 0 means evidence collection completed.
import {mkdtemp,mkdir,realpath,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {Server} from 'node:net';
import {openRestrictedExecutor} from '../../../src/runtime/restricted-process.ts';
const root=process.cwd();
const currentHead=execFileSync('/usr/bin/git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const base=await realpath(await mkdtemp(join(tmpdir(),'graph-event-order-spec-')));
const scratch=join(base,'scratch');await mkdir(scratch);
const req=createRequire(join(root,'package.json'));
const previous=execFileSync('/usr/bin/git',['show','283ffbb:src/runtime/restricted-process.ts'],{cwd:root,encoding:'utf8'}).replace("from '@anthropic-ai/sandbox-runtime'",'from '+JSON.stringify(req.resolve('@anthropic-ai/sandbox-runtime')));
await writeFile(join(base,'baseline.ts'),previous);
const {openRestrictedExecutor:openPrevious}=await import(join(base,'baseline.ts'));
const gate={dispatch(_id,_r,send){return send()},settle(){}};
const sources={
'cancel-relisten.cjs':`const assert=require('node:assert/strict');const {createServer}=require('node:net');const s=createServer();const events=[];const contexts=[];s.once('listening',function(){events.push('before');contexts.push(this===s)});s.listen(0,'127.0.0.1',function(){events.push('cancelled-callback');contexts.push(this===s)});s.close(function(error){events.push('close:'+error?.code);s.listen(0,'127.0.0.1',function(){events.push('retry-callback');contexts.push(this===s)});s.once('listening',function(){events.push('after');contexts.push(this===s);setImmediate(()=>s.close(()=>console.log(JSON.stringify({events,contexts,listening:s.listening,address:s.address()}))))})});`,
'failed-relisten.cjs':`const {createServer}=require('node:net');const s=createServer();const blocker=createServer();const events=[];const contexts=[];blocker.listen(0,'127.0.0.1',()=>{s.once('listening',function(){events.push('before');contexts.push(this===s)});s.once('error',error=>{events.push('error:'+error.code);blocker.close(()=>{s.listen(0,'127.0.0.1',function(){events.push('retry-callback');contexts.push(this===s)});s.once('listening',function(){events.push('after');contexts.push(this===s);setImmediate(()=>s.close(()=>console.log(JSON.stringify({events,contexts,listening:s.listening,address:s.address()}))))})})});s.listen(blocker.address().port,'127.0.0.1',function(){events.push('failed-callback');contexts.push(this===s)})});`
};
for(const [name,source]of Object.entries(sources))await writeFile(join(base,name),source);
const servers=()=>process._getActiveHandles().filter(h=>h instanceof Server&&h.listening);
try{for(const [revision,open]of [[currentHead,openRestrictedExecutor],['283ffbb',openPrevious]]){
 const executor=await open();const before=new Set(servers());
 try{for(const scenario of Object.keys(sources)){
 const start=Date.now();const result=await executor.run({broker:gate,cwd:base,scratchDir:scratch,executable:process.execPath,args:[scenario],readPaths:[base,dirname(process.execPath)],writePaths:[base],localNetwork:true,timeoutMs:2000});
 await new Promise(r=>setTimeout(r,20));const leaked=servers().filter(x=>!before.has(x));console.log(JSON.stringify({revision,scenario,elapsedMs:Date.now()-start,...result,hostListenersAfterRun:leaked.map(x=>x.address())}));for(const listener of leaked)listener.close();
 }}finally{await executor.close();const leaked=servers().filter(x=>!before.has(x));console.log(JSON.stringify({revision,hostListenersAfterClose:leaked.map(x=>x.address())}));for(const listener of leaked)listener.close();}
}}finally{await rm(base,{recursive:true,force:true});}
