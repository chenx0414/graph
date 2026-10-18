import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,test} from 'vitest';
import {openaiServer} from '../fixtures/openai-server.ts';
const execute=promisify(execFile);

test.each(['valid','missing','tampered','limited','limited-bare'])('evaluation preserves frozen skills and configured constraints: %s',async state=>{
 const root=await mkdtemp(join(tmpdir(),'graph-context-e2e-'));const source=join(root,'source'),snapshot=join(root,'snapshot');
 const skill=join(source,'capabilities','skills','eval-skill');await mkdir(skill,{recursive:true});
 const skillText='---\nname: eval-skill\ndescription: Context snapshot proof.\n---\nFROZEN_CONTEXT_SKILL\n';
 await writeFile(join(skill,'SKILL.md'),skillText);
 await mkdir(join(source,'extensions'),{recursive:true});
 await writeFile(join(source,'extensions','empty-proof.mjs'),'');
 await writeFile(join(source,'extensions','cache-proof.mjs'),"import './empty-proof.mjs';console.log('FROZEN_CACHE_CODE');\n");
 await writeFile(join(skill,'capability.json'),JSON.stringify({id:'eval-skill',version:'1',kind:'skill',name:'eval-skill'}));
 await writeFile(join(source,'agent-combinations.json'),JSON.stringify({version:1,combinations:[{id:'main',mode:'main',name:'Snapshot main',description:'Use the bound eval-skill before implementing the requested project change.',recommendedGrade:'high',review:false,tags:[],systemPrompt:'Use the bound eval-skill before implementing the requested project change.',resources:[{resourceId:'eval-skill',version:state==='missing'?'2':'1',role:'skill',required:true}]}]}));
 let advertisedSkillPath=join(skill,'SKILL.md');
 const provider=await openaiServer([
  {tools:[{id:'read-context',name:'read',arguments:()=>{
   const request=provider.requests[0] as {messages:{content:unknown}[]};
   const text=request.messages.map(message=>typeof message.content==='string'?message.content:JSON.stringify(message.content)).join('\n');
   advertisedSkillPath=[...text.matchAll(/\/[^\s"<>]+\/SKILL\.md/g)].map(match=>match[0]).find(path=>path.includes('eval-skill'))??join(skill,'SKILL.md');
   return JSON.stringify({path:advertisedSkillPath});
  }}]},
  {tools:[{id:'run-frozen-cache',name:'bash',arguments:()=>{
   const home=advertisedSkillPath.replace(/\/(?:capabilities|agents)\/.*/,'');
   const file=join(home,'extensions','cache-proof.mjs');
   return JSON.stringify({command:"node '"+file.replaceAll("'","'\\''")+"'"});
  }}]},
  {tools:[{id:'repair',name:'write',arguments:JSON.stringify({path:'config.js',content:"export function parseConfig(text) { return Object.fromEntries(text.split('\\n').filter(line=>line.trim()).map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];})); }\n"})}]},
  {text:'Parser repaired using the frozen skill.'},
 ]);
 let artifactRoot:string|undefined;
 try{
  const create=()=>execute(process.execPath,['scripts/harness-eval-context.mjs',source,snapshot],{cwd:process.cwd(),timeout:15000});
  if(state==='missing'){
   await expect(create()).rejects.toThrow(/Missing required capability eval-skill@2/);expect(provider.requests).toHaveLength(0);return;
  }
  await create();
  await writeFile(join(skill,'SKILL.md'),skillText.replace('FROZEN_CONTEXT_SKILL','CHANGED_SOURCE_SKILL'));
  await writeFile(join(source,'extensions','cache-proof.mjs'),"console.log('CHANGED_CACHE_CODE');\n");
  if(state==='valid')await rm(join(snapshot,'graph','extensions','empty-proof.mjs'),{force:true});
  if(state==='tampered')await writeFile(join(snapshot,'context.tar.gz'),'TAMPERED_ARCHIVE');
  const configPath=join(root,'config.json');await writeFile(configPath,JSON.stringify({version:1,projects:[],credentials:{local:{secretRef:'GRAPH_LOCAL_KEY'}},models:{entries:[{id:'local',modelId:'local',provider:'graph-openai',grade:'high',api:'openai-completions',baseUrl:provider.model.baseUrl,contextWindow:32000,maxTokens:256,credentialId:'local'}]},...(state.startsWith('limited')?{access:{mode:'standard'},limits:{credentials:{},sharedGroups:{},defaultBudgetTokens:1}}:{})}));
  const run=()=>execute(process.execPath,['scripts/harness-real-eval.mjs',configPath],{cwd:process.cwd(),timeout:30000,env:{...process.env,HOME:root,GRAPH_LOCAL_KEY:'fixture',GRAPH_EVAL_CONTEXT_SNAPSHOT:state==='limited-bare'?'':snapshot,GRAPH_EVAL_TIMEOUT_MS:'10000'}});
  if(state==='tampered'){
   await expect(run()).rejects.toThrow(/snapshot is invalid or changed/);expect(provider.requests).toHaveLength(0);return;
  }
  const {stdout}=await run();const report=JSON.parse(stdout);artifactRoot=report.root;
  if(state.startsWith('limited')){
   const saved=JSON.parse(await readFile(join(report.root,'config.json'),'utf8'));
   expect(report.taskSuccess,JSON.stringify({report,savedLimits:saved.limits})).toBe(false);expect(provider.requests).toHaveLength(0);return;
  }
  expect(report.error,JSON.stringify(report)).toBeUndefined();
  const reply=(provider.requests[1] as {messages:{role:string;content:string}[]}).messages.filter(message=>message.role==='tool').at(-1)!.content;
  expect(reply).toContain('FROZEN_CONTEXT_SKILL');expect(reply).not.toContain('CHANGED_SOURCE_SKILL');
  const cacheReply=(provider.requests[2] as {messages:{role:string;content:string}[]}).messages.filter(message=>message.role==='tool').at(-1)!.content;
  expect(cacheReply).toContain('FROZEN_CACHE_CODE');expect(cacheReply).not.toContain('CHANGED_CACHE_CODE');
  expect(report,JSON.stringify({report,writeReply:(provider.requests[3] as {messages:{role:string;content:string}[]})?.messages.filter(message=>message.role==='tool').at(-1)?.content})).toMatchObject({taskSuccess:true,evaluationContext:{recipes:[expect.objectContaining({id:'main',resources:[expect.objectContaining({resourceId:'eval-skill',version:'1'})]})]}});
  expect(await readFile(join(skill,'SKILL.md'),'utf8')).toContain('CHANGED_SOURCE_SKILL');
 }finally{
  await provider.close();await rm(root,{recursive:true,force:true});if(artifactRoot)await rm(artifactRoot,{recursive:true,force:true});
 }
},45000);
