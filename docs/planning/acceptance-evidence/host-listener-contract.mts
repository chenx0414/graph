// Run from the Graph repository root with project Node 24.20.0.
// Local synthetic probes; each restricted command has a 5-second timeout.
import {mkdtemp,mkdir,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer as createTcpServer} from 'node:net';
import {createRequire} from 'node:module';
import {openRestrictedExecutor} from '../../../src/runtime/restricted-process.ts';
const root=process.cwd();
const reserve=createTcpServer();
await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
const requestedPort=(reserve.address() as {port:number}).port;
await new Promise(resolve=>reserve.close(resolve));
const base=await realpath(await mkdtemp(join(tmpdir(),'graph-r6-spec-')));
const workspace=join(base,'workspace'); const scratch=join(workspace,'scratch');
await mkdir(scratch,{recursive:true});
const gate={dispatch(_id:string,_r:number,send:()=>unknown){return send()},settle(){}};
const scripts={
 'http.cjs':`const http=require('node:http'); (async()=>{for(const host of ['127.0.0.1','::1']){const s=http.createServer((q,r)=>r.end('r6-'+host));await new Promise((r,j)=>{s.on('error',j);s.listen(0,host,r)}); const a=s.address(); const text=await (await fetch('http://'+(host==='::1'?'[::1]':host)+':'+a.port,{signal:AbortSignal.timeout(1000)})).text(); await new Promise(r=>s.close(r)); console.log(JSON.stringify({host,address:a,body:text}));}})().catch(e=>{console.error(e);process.exitCode=1});`,
 'denied.cjs':`const {spawnSync}=require('node:child_process');const env={...process.env};delete env.NODE_OPTIONS;const node=spawnSync(process.execPath,['raw.cjs'],{env,encoding:'utf8',timeout:3000});console.log(JSON.stringify({kind:'cleared-Node',status:node.status,stdout:node.stdout,stderr:node.stderr}));const python=spawnSync('/Library/Developer/CommandLineTools/usr/bin/python3',['raw.py'],{env,encoding:'utf8',timeout:3000});console.log(JSON.stringify({kind:'non-Node',status:python.status,stdout:python.stdout,stderr:python.stderr}));`,
 'raw.cjs':`const net=require('node:net');(async()=>{for(const host of ['0.0.0.0','127.0.0.1','::','::1']){const result=await new Promise(resolve=>{const s=net.createServer();s.on('error',e=>resolve(e.code));s.listen(0,host,()=>s.close(()=>resolve('LISTENED')));});console.log(JSON.stringify({host,result}));}})();`,
 'raw.py':`import socket\nfor family,host in [(socket.AF_INET,'0.0.0.0'),(socket.AF_INET,'127.0.0.1'),(socket.AF_INET6,'::'),(socket.AF_INET6,'::1')]:\n s=socket.socket(family,socket.SOCK_STREAM)\n try:\n  s.bind((host,0))\n  print(host,'BOUND')\n except OSError as e:\n  print(host,e.errno,str(e))\n finally:\n  s.close()\n`,
 'port.cjs':`const http=require('node:http');const requested=${requestedPort};const s=http.createServer((q,r)=>r.end('r6-fixed'));s.on('error',e=>{console.log(JSON.stringify({error:e.code}));process.exitCode=1});s.listen(requested,'127.0.0.1',async()=>{const actual=s.address();let body;try{body=await (await fetch('http://127.0.0.1:'+requested,{signal:AbortSignal.timeout(1000)})).text()}catch(e){body=e.cause?.code||e.name;}console.log(JSON.stringify({requested,actual,body}));s.close();});`
};
for(const [name,source] of Object.entries(scripts))await writeFile(join(workspace,name),source);
await writeFile(join(workspace,'five.cjs'),`const http=require('node:http');(async()=>{for(let index=1;index<=5;index++){const s=http.createServer((q,r)=>r.end('round-'+index));try{await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r)});const body=await(await fetch('http://127.0.0.1:'+s.address().port,{signal:AbortSignal.timeout(1000)})).text();console.log(JSON.stringify({index,body}));}catch(e){console.log(JSON.stringify({index,error:e.code||e.name}));}finally{await new Promise(r=>s.close(r));}}})();`);
const req=createRequire(join(root,'package.json'));
const previous=execFileSync('/usr/bin/git',['show','283ffbb:src/runtime/restricted-process.ts'],{cwd:root,encoding:'utf8'}).replace("from '@anthropic-ai/sandbox-runtime'",'from '+JSON.stringify(req.resolve('@anthropic-ai/sandbox-runtime')));
await writeFile(join(base,'baseline.ts'),previous);
async function run(executor:any,name:string){return executor.run({broker:gate,cwd:workspace,scratchDir:scratch,executable:process.execPath,args:[name],readPaths:[workspace,dirname(process.execPath)],writePaths:[workspace,scratch],localNetwork:true,timeoutMs:5000});}
try {
 const current=await openRestrictedExecutor();
 try{for(const name of ['http.cjs','denied.cjs','port.cjs','five.cjs'])console.log(JSON.stringify({revision:'7476f1c',probe:name,...await run(current,name)}));}finally{await current.close();}
 const {openRestrictedExecutor:openPrevious}=await import(join(base,'baseline.ts'));
 const baseline=await openPrevious();try{for(const name of ['port.cjs','five.cjs'])console.log(JSON.stringify({revision:'283ffbb',probe:name,...await run(baseline,name)}));}finally{await baseline.close();}
}finally{await rm(base,{recursive:true,force:true});}
