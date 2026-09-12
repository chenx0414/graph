import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskRuntime } from '../../../src/core/task-runtime.ts';
import { openaiServer } from '../../../tests/fixtures/openai-server.ts';
const root = await mkdtemp(join(tmpdir(), 'graph-sp01-recheck-'));
const provider = await openaiServer([{text:'Please clarify the matching rule.'},{text:'Acknowledged.'}]);
const runtime = await openTaskRuntime({stateDir:join(root,'state'),projects:[{id:'p',root}],models:{entries:[{id:'local',provider:'graph-openai',grade:'high',api:'openai-completions',baseUrl:provider.model.baseUrl,contextWindow:32000,maxTokens:256}],apiKey:'scripted-local-key',modelRuntime:provider.runtime},master:{action:'master',definitionVersion:'master@1',model:'local'}});
try {
 runtime.catalog.publishDefinition('master',{recommendedGrade:'high'},'def');
 const {taskId} = await runtime.user.begin({projectId:'p',request:'Implement title search.',requestId:'begin'});
 await runtime.host.runReady();
 await runtime.user.task(taskId).say('FOLLOWUP_SENTINEL_97531: titles must ignore case.','say');
 await runtime.host.runReady();
 const request = provider.requests.at(-1);
 console.log(JSON.stringify({requests:provider.requests.length,followupReachedProvider:JSON.stringify(request).includes('FOLLOWUP_SENTINEL_97531')}));
} finally { await runtime.close(); await provider.close(); await rm(root,{recursive:true,force:true}); }
