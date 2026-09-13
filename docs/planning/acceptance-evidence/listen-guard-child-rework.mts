// Synthetic local child-process confinement probe for Graph 283ffbb.
// Only connects to this host; all data and processes are temporary.
import {mkdtemp,writeFile,readFile,realpath,rm,mkdir} from 'node:fs/promises';
import {tmpdir,networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {openWorkspaceCommandRunner} from '../../../src/runtime/workspace-command.ts';
const base=await realpath(await mkdtemp(join(tmpdir(),'graph-r3-spec-')));
const workspace=join(base,'workspace'); await mkdir(workspace); const scratch=join(workspace,'scratch'); await mkdir(scratch);
const gate={dispatch(_id:string,_r:number,send:()=>unknown){return send()},settle(){}};
const network=Object.entries(networkInterfaces()).filter(([name])=>/^en[0-9]+$/.test(name)).flatMap(([,values])=>values??[]).find(n=>n.family==='IPv4'&&!n.internal);
const payload=`const {createServer}=require('node:http');const {writeFileSync}=require('node:fs');const s=createServer((q,r)=>{r.end('synthetic-r6');s.close()});s.listen(0,'0.0.0.0',()=>writeFileSync('ready.json',JSON.stringify(s.address())));setTimeout(()=>s.close(),2500).unref();`;
await writeFile(join(workspace,'listen.cjs'),payload);
await writeFile(join(workspace,'launch.cjs'),`const {spawnSync}=require('node:child_process'); const env={...process.env}; delete env.NODE_OPTIONS; const p=spawnSync(process.execPath,['listen.cjs'],{env,stdio:'inherit'}); process.exitCode=p.status;`);
const runner=await openWorkspaceCommandRunner({workspace,scratchDir:scratch,gate,localNetwork:true});
try {
 console.log('baseline',await runner.run('node',['listen.cjs']));
 const running=runner.run('node',['launch.cjs']);let bind;
 for(let i=0;i<100;i++){try{bind=JSON.parse(await readFile(join(workspace,'ready.json'),'utf8'));break;}catch{await new Promise(r=>setTimeout(r,20));}}
 let external; if(bind&&network){try{external=await(await fetch(`http://${network.address}:${bind.port}`,{signal:AbortSignal.timeout(1000)})).text()}catch(e){external=String(e)}}
 console.log('cleared_NODE_OPTIONS',{bind,destinationIsNonLoopback:network ? !network.internal : null,nonLoopbackFetch:external,result:await running});

}finally{await runner.close();await rm(base,{recursive:true,force:true});}
