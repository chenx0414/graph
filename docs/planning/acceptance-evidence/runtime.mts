// Acceptance diagnostics for d0193bb. Run from the Graph repository root.
// Prints observed behavior; exit code 0 is not a product acceptance verdict.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskRuntime } from '../../../src/core/task-runtime.ts';
import { createApp } from '../../../src/server/app.ts';
import { openaiServer } from '../../../tests/fixtures/openai-server.ts';
async function scenario(name, plans, master = false) {
  const root = await mkdtemp(join(tmpdir(), 'graph-review-runtime-'));
  const provider = await openaiServer(plans);
  const runtime = await openTaskRuntime({ stateDir: join(root,'state'), projects: [{id:'p',root}], models: {entries:[{id:'local', provider:'graph-openai',grade:'high',api:'openai-completions',baseUrl:provider.model.baseUrl,contextWindow:32000,maxTokens:256}],apiKey:'scripted-local-key',modelRuntime:provider.runtime}, ...(master ? {master:{action:'master',definitionVersion:'master@1',model:'local'}} : {}) });
  const app=await createApp(runtime,{origin:'http://127.0.0.1'});
  const cookie=(await app.inject({method:'GET',url:'/'})).cookies[0];
  const headers={cookie:`${cookie.name}=${cookie.value}`,origin:'http://127.0.0.1'};
  try {
    runtime.catalog.publishDefinition(master?'master':'coder',{recommendedGrade:'high'},'def');
    const {taskId}=(await app.inject({method:'POST',url:'/api/tasks',headers,payload:{projectId:'p',request:'Read the source and implement title search; discuss acceptance and propose a graph.',requestId:'begin'}})).json();
    if (!master) {
      const proposed=await runtime.supervisor(taskId).propose({requirementVersion:1,summary:'Work',acceptance:[{id:'ok',description:'Works',checkNode:'check'}],nodes:[{id:'work',kind:'agent',action:'work',definitionVersion:'coder@1',model:'local'},{id:'check',kind:'program',action:'check',dependsOn:['work']}]},'proposal');
      await runtime.user.task(taskId).accept({proposalVersion:proposed.proposalVersion,targetBranch:'main',requestId:'accept'});
    }
    await runtime.host.runReady();
    if(master) {
      await app.inject({method:'POST',url:`/api/tasks/${taskId}/say`,headers,payload:{text:'Yes, please use case-insensitive matching.',requestId:'say'}});
      await runtime.host.runReady();
    }
    const view=await runtime.user.task(taskId).view();
    console.log(JSON.stringify({name,requests:provider.requests.length,tools:provider.requests.map(r=>r.tools??null),phase:view.phase,proposalVersion:view.proposalVersion,nodes:view.nodes.map(n=>({id:n.id,status:n.status,used:n.used})),questions:view.questions.map(q=>q.kind),invocations:view.invocations.map(i=>i.usage)}));
  } finally {await app.close();await runtime.close();await provider.close();await rm(root,{recursive:true,force:true});}
}
await scenario('production-master',[{text:'I propose a case-insensitive title search implementation.'}],true);
await scenario('missing-usage-multicall',[{tools:[{id:'read-1',name:'read',arguments:'{"path":"package.json"}'}],usage:null},{text:'Implementation done.'}]);
await scenario('budget-multicall',[{tools:[{id:'read-1',name:'read',arguments:'{"path":"package.json"}'}],usage:{prompt_tokens:20000000,completion_tokens:1}},{text:'Implementation done.'}]);
