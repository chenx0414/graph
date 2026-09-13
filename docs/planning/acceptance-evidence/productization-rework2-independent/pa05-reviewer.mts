import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGraphDaemon } from '/Users/macmini/workspace/13-Graph/src/server/start.ts';
const deadline=setTimeout(()=>{console.error('probe deadline');process.exit(124)},20_000);
const root=await mkdtemp(join(tmpdir(),'graph-35118a5-pa05-'));
let daemon;let requests=0;
const provider=createServer(async(req,res)=>{for await(const chunk of req){}requests++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'ok'}}],usage:{prompt_tokens:1,completion_tokens:1}}))});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
try {
 const web=join(root,'web');await mkdir(web);await writeFile(join(web,'index.html'),'<html>Graph</html>');
 const configPath=join(root,'config.json');
 const model=(id,credentialId)=>({id,provider:`p-${id}`,grade:'high',api:'openai-completions',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,contextWindow:32000,maxTokens:256,credentialId});
 const valid={version:1,projects:[{id:'p',root}],models:{entries:[model('a','a'),model('b','b')]},credentials:{a:{secretRef:'ALIAS_A',sharedLimitGroupId:'g1'},b:{secretRef:'ALIAS_B',sharedLimitGroupId:'g1'}},limits:{credentials:{a:1,b:1},sharedGroups:{g1:1,g2:1}}};
 await writeFile(configPath,JSON.stringify(valid));
 const logs=[];
 const opts={configPath,stateDir:join(root,'state'),webDir:web,port:0,mode:'view',env:{ALIAS_A:'synthetic-key',ALIAS_B:'synthetic-key'},log:line=>logs.push(line)};
 const headersFor=async daemon=>({origin:daemon.url,cookie:(await fetch(daemon.url)).headers.get('set-cookie')??'','content-type':'application/json'});
 daemon=await startGraphDaemon(opts);
 let headers=await headersFor(daemon);
 const before=await readFile(configPath,'utf8');
 const observations=[];
 for(const ref of ['ALIAS_A','ALIAS_B']){
  const document={...valid,credentials:{a:{secretRef:'ALIAS_A',sharedLimitGroupId:'g1'},b:{secretRef:ref,sharedLimitGroupId:'g2'}}};
  const saved=await fetch(`${daemon.url}/api/config`,{method:'POST',headers,body:JSON.stringify({expectedRevision:0,document})});
  observations.push({ref,status:saved.status,result:await saved.json(),unchanged:(await readFile(configPath,'utf8'))===before});
 }
 console.log(JSON.stringify({probe:'save-conflicts',observations,providerRequests:requests}));
 await daemon.close();daemon=undefined;
 const conflict={...valid,credentials:{a:{secretRef:'ALIAS_A',sharedLimitGroupId:'g1'},b:{secretRef:'ALIAS_B',sharedLimitGroupId:'g2'}}};
 await writeFile(configPath,JSON.stringify(conflict));
 daemon=await startGraphDaemon(opts);headers=await headersFor(daemon);
 const startup=await(await fetch(`${daemon.url}/api/startup`,{headers})).json();
 const beforeTest=requests;
 const tested=await fetch(`${daemon.url}/api/config/test`,{method:'POST',headers,body:JSON.stringify({modelId:'a'})});
 console.log(JSON.stringify({probe:'hand-edited-view-conflict',startup,logs,providerRequestsBeforeExplicitTest:beforeTest,testStatus:tested.status,testResult:await tested.json(),providerRequestsAfterExplicitTest:requests}));
 await daemon.close();daemon=undefined;
 try{daemon=await startGraphDaemon({...opts,mode:'execute'});console.log(JSON.stringify({probe:'execute-conflict',started:true}))}catch(error){console.log(JSON.stringify({probe:'execute-conflict',started:false,code:error.code}))}
} finally {if(daemon)await daemon.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await rm(root,{recursive:true,force:true});clearTimeout(deadline)}
