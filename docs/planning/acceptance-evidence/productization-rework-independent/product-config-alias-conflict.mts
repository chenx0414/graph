import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGraphDaemon } from '../../../../src/server/start.ts';
import { createModelScheduler } from '../../../../src/runtime/model-scheduler.ts';
const deadline=setTimeout(()=>{console.error('probe deadline');process.exit(124)},20_000);
const root=await mkdtemp(join(tmpdir(),'graph-071e21b-identity-'));
let daemon;
try {
 const web=join(root,'web');await mkdir(web);await writeFile(join(web,'index.html'),'<html>Graph</html>');
 const configPath=join(root,'config.json');
 const initial={version:1,projects:[{id:'p',root}],credentials:{a:{secretRef:'ALIAS_A'},b:{secretRef:'ALIAS_B'}},limits:{credentials:{a:1,b:1}}};
 await writeFile(configPath,JSON.stringify(initial));
 const opts={configPath,stateDir:join(root,'state'),webDir:web,port:0,mode:'view' as const,env:{ALIAS_A:'synthetic-key',ALIAS_B:'synthetic-key'}};
 daemon=await startGraphDaemon(opts);
 const home=await fetch(daemon.url);
 const headers={origin:daemon.url,cookie:home.headers.get('set-cookie')??'','content-type':'application/json'};
 const document={...initial,credentials:{a:{secretRef:'ALIAS_A',sharedLimitGroupId:'groupA'},b:{secretRef:'ALIAS_B',sharedLimitGroupId:'groupB'}},limits:{credentials:{a:1,b:1},sharedGroups:{groupA:1,groupB:1}}};
 const response=await fetch(`${daemon.url}/api/config`,{method:'POST',headers,body:JSON.stringify({expectedRevision:0,document})});
 const saved=await response.json();
 await daemon.close();daemon=undefined;
 let restart;
 try{daemon=await startGraphDaemon(opts);restart={started:true}}catch(e){restart={started:false,code:e.code,message:e.message}}
 const onDisk=JSON.parse(await readFile(configPath,'utf8'));
 console.log(JSON.stringify({probe:'config-save-alias-group-conflict',saveStatus:response.status,saved,persistedRevision:onDisk.revision,persistedGroups:Object.values(onDisk.credentials).map(c=>c.sharedLimitGroupId),restart}));
} finally {if(daemon)await daemon.close();await rm(root,{recursive:true,force:true});clearTimeout(deadline)}
