import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { startGraphDaemon } from '../../src/server/start.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

test.each([false,true])('HTTP main reads complete inventory or exact requested sections with scoped discovery=%s',async enabled=>{
 const previous=process.env.GRAPH_SCOPED_SYSTEM_CAPABILITIES;
 process.env.GRAPH_SCOPED_SYSTEM_CAPABILITIES=enabled?'1':'0';
 const root=await mkdtemp(join(tmpdir(),'graph-scoped-inventory-'));
 const sections=['configuredModels','access','agentCombinations','agentDefinitions','architectures','subscriptionPlans','summary','capabilities','agentContext','application'];
 const provider=await openaiServer([
  {tools:[{id:'full',name:'read_system_capabilities',arguments:'{}'}]},
  {tools:sections.map(section=>({id:section,name:'read_system_capabilities',arguments:JSON.stringify(enabled?{section}:{})}))},
  {tools:[{id:'use-model',name:'bash',arguments:()=>{
   const request=provider.requests.at(-1) as {messages:{role:string;content:string}[]};
   const reply=request.messages.filter(message=>message.role==='tool').find(message=>JSON.parse(message.content).configuredModels)!;
   const result=JSON.parse(reply.content) as {configuredModels:{id:string}[]};
   return JSON.stringify({command:`printf '%s' '${result.configuredModels[0]!.id}' > selected-model.txt`});
  }}]},
  {text:'Discovery completed.'},
 ]);
 let daemon:Awaited<ReturnType<typeof startGraphDaemon>>|undefined;
 try{
  const webDir=join(root,'web');await mkdir(webDir);await writeFile(join(webDir,'index.html'),'<!doctype html><div>Graph</div>');
  const configPath=join(root,'config.json');await writeFile(configPath,JSON.stringify({version:1,projects:[{id:'p',root}],credentials:{local:{secretRef:'GRAPH_LOCAL_KEY'}},models:{entries:[{
   id:'local',modelId:'local',provider:'graph-openai',grade:'high',api:'openai-completions',baseUrl:provider.model.baseUrl,contextWindow:32000,maxTokens:256,credentialId:'local',
  }]}}));
  daemon=await startGraphDaemon({configPath,stateDir:join(root,'state'),graphHome:join(root,'graph'),webDir,port:0,mode:'execute',dynamic:true,env:{HOME:root,GRAPH_LOCAL_KEY:'fixture-key'},log:()=>{}});
  const home=await fetch(daemon.url,{headers:{origin:daemon.url}});
  const headers={origin:daemon.url,cookie:home.headers.get('set-cookie')??'','content-type':'application/json'};
  const created=await fetch(`${daemon.url}/api/conversations`,{method:'POST',headers,body:JSON.stringify({projectId:'p',model:'local',text:'Discover the configured model and save its ID in selected-model.txt.',requestId:'discover'})});
  expect(created.ok).toBe(true);
  await expect.poll(async()=>readFile(join(root,'selected-model.txt'),'utf8').catch(()=>''),{timeout:15000}).toBe('local');
  const requests=provider.requests as {messages:{role:string;content:string}[]}[];
  const discovery=(provider.requests[0] as {tools:{function:{name:string;parameters:{properties:Record<string,unknown>}}}[]}).tools.find(tool=>tool.function.name==='read_system_capabilities')!;
  expect(Object.hasOwn(discovery.function.parameters.properties,'section')).toBe(enabled);
  const full=JSON.parse(requests[1]!.messages.filter(message=>message.role==='tool').at(-1)!.content);
  expect(full.configuredModels).toEqual(expect.arrayContaining([expect.objectContaining({id:'local'})]));
  expect(full).toHaveProperty('application');
  const replies=requests[2]!.messages.filter(message=>message.role==='tool').slice(-sections.length);
  for(const [index,section] of sections.entries()){
   const result=JSON.parse(replies[index]!.content);
   if(enabled){expect(Object.keys(result)).toEqual([section]);expect(result[section]).toEqual(full[section]);}
   else expect(result).toEqual(full);
  }
 }finally{
  await daemon?.close();await provider.close();await rm(root,{recursive:true,force:true});
  if(previous===undefined)delete process.env.GRAPH_SCOPED_SYSTEM_CAPABILITIES;else process.env.GRAPH_SCOPED_SYSTEM_CAPABILITIES=previous;
 }
},30000);
