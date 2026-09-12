// Synthetic local-only probe. No real provider or external service is contacted.
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceCommandRunner } from '../../../src/runtime/workspace-command.ts';
const network = Object.entries(networkInterfaces()).filter(([name]) => /^en[0-9]+$/.test(name)).flatMap(([, addresses]) => addresses ?? []).find(n => n.family === 'IPv4' && !n.internal);
if (!network) throw new Error('This probe requires a non-loopback local Ethernet/Wi-Fi IPv4 interface');
async function probe(localNetwork: boolean) {
 const root = await realpath(await mkdtemp(join(tmpdir(),'graph-local-network-probe-')));
 await writeFile(join(root,'listen.mjs'), `import {createServer} from 'node:http'; import {writeFileSync} from 'node:fs'; const s=createServer((q,r)=>{r.end('synthetic-loopback-boundary-probe');s.close();}); s.listen(0,'0.0.0.0',()=>{writeFileSync('ready.json',JSON.stringify(s.address()));}); setTimeout(()=>s.close(),3000).unref();`);
 const gate = {dispatch(_id: string, _reservation: number, send: () => unknown){return send();}, settle(){}};
 const runner = await openWorkspaceCommandRunner({workspace:root,scratchDir:join(root,'scratch'),gate,localNetwork});
 try {
  let finished = false;
  const run=runner.run('node',['listen.mjs']).finally(() => {finished = true;});
  let bind;
  for(let i=0;i<100&&!finished;i++){try{bind=JSON.parse(await readFile(join(root,'ready.json'),'utf8'));break;}catch{await new Promise(r=>setTimeout(r,30));}}
  let observation;
  if (bind) {
   try {const response=await fetch(`http://${network.address}:${bind.port}/`,{signal:AbortSignal.timeout(1500)}); observation={status:response.status,body:await response.text()};}
   catch(e){observation={error:String(e)};}
  }
  console.log(JSON.stringify({localNetwork,bind:bind??null,destinationIsNonLoopback:!network.internal,...observation,run:await run},null,2));
 } finally {await runner.close();await rm(root,{recursive:true,force:true});}
}
await probe(false);
await probe(true);
