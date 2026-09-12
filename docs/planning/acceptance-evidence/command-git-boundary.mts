import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openWorkspaceCommandRunner} from '../../../src/runtime/workspace-command.ts';
import {git} from '../../../src/git/git.ts';
// Follow-up on the S1 finding: a command must not rewrite repository Git metadata.
const root=await mkdtemp(join(tmpdir(),'graph-git-boundary-'));
const initialized=git(root,['init','-b','main']);
if(initialized.code)throw Error(initialized.stderr);
const runner=await openWorkspaceCommandRunner({workspace:root,scratchDir:join(root,'scratch'),gate:{dispatch:(_id,_reservation,send)=>send(),settle:()=>{}}});
try{
 const before=await readFile(join(root,'.git','HEAD'),'utf8');
 await writeFile(join(root,'check.mjs'),"import {writeFileSync} from 'node:fs';writeFileSync('.git/HEAD','ref: refs/heads/changed\\n');");
 const result=await runner.run('node',['check.mjs']);
 const after=await readFile(join(root,'.git','HEAD'),'utf8');
 console.log(JSON.stringify({code:result.code,before,after,protected:after===before&&result.code!==0}));
}finally{await runner.close();await rm(root,{recursive:true,force:true});}
