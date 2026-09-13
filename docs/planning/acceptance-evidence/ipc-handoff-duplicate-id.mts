// Run from the Graph repository root with its Node 24.20.0.
// Each restricted process has a two-second deadline; finally releases probe-owned listeners.
import { mkdtemp,mkdir,realpath,writeFile,rm } from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {openRestrictedExecutor} from '../../../src/runtime/restricted-process.ts';
const root=process.cwd();
const currentHead=execFileSync('/usr/bin/git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const dir=await realpath(await mkdtemp(join(tmpdir(),'graph-handoff-duplicate-')));const scratch=join(dir,'scratch');await mkdir(scratch);
const req=createRequire(join(root,'package.json'));
const old=execFileSync('/usr/bin/git',['show','742bf98:src/runtime/restricted-process.ts'],{cwd:root,encoding:'utf8'}).replace("from '@anthropic-ai/sandbox-runtime'",'from '+JSON.stringify(req.resolve('@anthropic-ai/sandbox-runtime')));
await writeFile(join(dir,'baseline.ts'),old);
const {openRestrictedExecutor:openOld}=await import(join(dir,'baseline.ts'));
await writeFile(join(dir,'duplicate.cjs'),`process.send({type:'graph-check-listener',id:44,port:0,host:'127.0.0.1'});process.send({type:'graph-check-listener',id:44,port:0,host:'127.0.0.1'});setTimeout(()=>process.exit(0),250);`);
const handles=()=>process._getActiveHandles();const gate={dispatch(_i,_r,send){return send()},settle(){}};
try {for (const [revision,open] of [[currentHead,openRestrictedExecutor],['742bf98',openOld]]) {
const before=new Set(handles()); const executor=await open();let added=[];
try { const result=await executor.run({broker:gate,cwd:dir,scratchDir:scratch,executable:process.execPath,args:['duplicate.cjs'],readPaths:[dir,dirname(process.execPath)],writePaths:[dir],localNetwork:true,timeoutMs:2000});await new Promise(r=>setTimeout(r,40));added=handles().filter(h=>!before.has(h)&&h.constructor.name==='Server');
console.log(JSON.stringify({revision,result,afterRun:added.map(s=>s.address())}));await executor.close();await new Promise(r=>setTimeout(r,40));console.log(JSON.stringify({revision,afterExecutorClose:added.filter(s=>s.listening).map(s=>s.address())}));
} finally {added=handles().filter(h=>!before.has(h)&&h.constructor.name==='Server');for(const s of added)s.close();await executor.close();}
}} finally {await rm(dir,{recursive:true,force:true})}
