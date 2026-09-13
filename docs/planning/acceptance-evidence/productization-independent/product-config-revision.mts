import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startGraphDaemon} from '../../../../src/server/start.ts';
const root=await mkdtemp(join(tmpdir(),'graph-review-config-')); let d;
try {
const web=join(root,'web'); await mkdir(web); await writeFile(join(web,'index.html'),'Graph');
const path=join(root,'config.json');const doc={version:1,revision:0,projects:[{id:'old',root}]};await writeFile(path,JSON.stringify(doc));
d=await startGraphDaemon({configPath:path,stateDir:join(root,'state'),webDir:web,port:0,mode:'view',env:{}});
const home=await fetch(d.url);const headers={origin:d.url,cookie:home.headers.get('set-cookie')!,'content-type':'application/json'};
const save=await fetch(d.url+'/api/config',{method:'POST',headers,body:JSON.stringify({expectedRevision:0,document:{...doc,projects:[{id:'new',root}]}})});
console.log('save',save.status,await save.json());
const task=await d.server.runtime.user.begin({projectId:'old',request:'old active config',requestId:'probe'});
console.log('activeProjects',await d.server.runtime.user.projects(),'created',d.server.runtime.events(task.taskId,0));
await d.close();d=undefined;
d=await startGraphDaemon({configPath:path,stateDir:join(root,'state'),webDir:web,port:0,mode:'view',env:{}});console.log('afterRestartProjects',await d.server.runtime.user.projects());
} finally {await d?.close();await rm(root,{recursive:true,force:true});}
