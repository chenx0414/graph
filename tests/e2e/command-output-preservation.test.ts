import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { startGraphDaemon } from '../../src/server/start.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';

test('public graph command preserves bytes beyond its inline ceiling and reuses settled files after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-output-preservation-'));
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'p', root }], access: () => fullAccessPolicy() };
  let runtime = await openTaskRuntime(options);
  try {
    const owner = await runtime.user.begin({ projectId: 'p', request: 'Preserve a large check output', requestId: 'begin' });
    const main = runtime.supervisor(owner.taskId);
    const bytes = 32 * 1024 * 1024 + 123;
    const { graphId } = await main.graphCreate({ definition: {
      schemaVersion: 2, name: 'Output preservation', protocols: { data: { type: 'object' } }, nodes: {},
      modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', sandbox: false, output: 'result',
          args: ['-e', `process.stdout.write(Buffer.alloc(${bytes},120));process.stdout.write('FINAL-OUTPUT');process.stderr.write('FINAL-ERROR');`] } } },
      edges: {}, inputs: {}, outputs: {},
    } }) as { graphId: string };
    await main.graphSend({ graphId, nodeId: 'check', input: 'job', value: {} });
    await runtime.host.drive();
    const inspect = () => runtime.supervisor(owner.taskId).graphInspect({ graphId, query: 'operations' });
    type FileInfo = { path: string; bytes: number; digest: string };
    type Operation = { state: string; result: { outputs: { result: { passed: boolean; stdout: string; outputFiles: { stdout: FileInfo; stderr: FileInfo } } } } };
    const operations = await inspect() as Operation[];
    expect(operations).toHaveLength(1);
    expect(operations[0]!.state).toBe('settled');
    const output = operations[0]!.result.outputs.result;
    expect(output.passed).toBe(true);
    expect(output.stdout.length).toBeLessThanOrEqual(32_768);
    expect(output.outputFiles).toBeDefined();
    const stdout = await readFile(output.outputFiles.stdout.path);
    expect(stdout.length).toBe(bytes + 'FINAL-OUTPUT'.length);
    expect(stdout.subarray(-12).toString()).toBe('FINAL-OUTPUT');
    expect(output.outputFiles.stdout).toMatchObject({ bytes: stdout.length, digest: createHash('sha256').update(stdout).digest('hex') });
    expect(await readFile(output.outputFiles.stderr.path, 'utf8')).toBe('FINAL-ERROR');
    await runtime.close();
    runtime = await openTaskRuntime(options);
    await runtime.host.drive();
    expect(await inspect()).toEqual(operations);
    const restored = await readFile(output.outputFiles.stdout.path);
    expect(restored.length).toBe(stdout.length);
    expect(createHash('sha256').update(restored).digest('hex')).toBe(output.outputFiles.stdout.digest);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
}, 60_000);


test.each([false,true])('native shell output remains fully readable after a compact first view and restart: compact=%s', async compact=>{
  const root=await mkdtemp(join(tmpdir(),'graph-native-output-'));
  const previous=process.env.GRAPH_COMPACT_SHELL_RESULTS;process.env.GRAPH_COMPACT_SHELL_RESULTS=compact?'1':'0';
  const output=Array.from({length:5000},(_,i)=>i===2499?'MIDDLE-OUTPUT-PROOF':i===4999?'FINAL-OUTPUT-PROOF':`diagnostic-line-${i}`).join('\n')+'\n';
  const command=`node -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(output)});process.exitCode=7;`)}`;
  const text=(index:number)=>(provider.requests[index] as {messages:{role:string;content:unknown}[]}).messages.filter(m=>m.role==='tool').map(m=>String(m.content)).join('\n');
  let fullOutputPath:string|undefined;
  const original=()=>{
    const match=/Full output: ([^\s\]"\\]+)/.exec(text(1));
    if(!match)throw new Error('Missing native full-output path');fullOutputPath=match[1]!;return fullOutputPath;
  };
  const handle=()=>{const match=/handle: ([^\s"\\]+)/.exec(text(1));if(!match)throw new Error('Missing saved shell result');return match[1]!;};
  const readMiddle=()=>({tools:[{id:'read-middle',name:'read',arguments:()=>JSON.stringify({path:original(),offset:2500,limit:1})}]});
  const provider=await openaiServer([
    {tools:[{id:'large-output',name:'bash',arguments:JSON.stringify({command})}]},
    readMiddle(),
    ...(compact?[{tools:Array.from({length:256},(_,i)=>({id:`retention-${i}`,name:'bash',arguments:JSON.stringify({command:`printf 'retention-${i}-%05000d' 0`})}))}]:[]),
    {text:'Middle output verified.'},
    ...(compact?[{tools:[{id:'read-old-handle',name:'read',arguments:()=>JSON.stringify({path:handle(),offset:1900,limit:200})}]}]:[readMiddle()]),
    {text:'Output retained after restart.'},
  ]);
  const webDir=join(root,'web');await mkdir(webDir);await writeFile(join(webDir,'index.html'),'<!doctype html>');
  const configPath=join(root,'config.json');await writeFile(configPath,JSON.stringify({version:1,projects:[{id:'p',root}],credentials:{local:{secretRef:'GRAPH_OUTPUT_TEST_KEY'}},models:{entries:[{id:'local',modelId:'local',provider:'graph-openai',grade:'high',api:'openai-completions',baseUrl:provider.model.baseUrl,contextWindow:1000000,maxTokens:256,credentialId:'local'}]}}));
  const options={configPath,stateDir:join(root,'state'),graphHome:join(root,'graph'),webDir,port:0,mode:'execute' as const,dynamic:true,env:{...process.env,GRAPH_OUTPUT_TEST_KEY:'fixture'},log:()=>undefined};
  let daemon=await startGraphDaemon(options);
  const auth=async()=>{const home=await fetch(daemon.url,{headers:{origin:daemon.url}});return {origin:daemon.url,cookie:home.headers.get('set-cookie')??'','content-type':'application/json'};};
  try{
    const headers=await auth();
    const response=await fetch(`${daemon.url}/api/conversations`,{method:'POST',headers,body:JSON.stringify({projectId:'p',model:'local',text:'Run the diagnostic and verify its middle output.',requestId:'begin'})});
    expect(response.ok).toBe(true);const {conversationId}=await response.json() as {conversationId:string};
    const answered=async(count:number,headers:Record<string,string>)=>expect.poll(async()=>{const view=await(await fetch(`${daemon.url}/api/conversations/${conversationId}`,{headers})).json();return view.messages.filter((m:{role:string})=>m.role==='assistant').length;},{timeout:30000}).toBe(count);
    await answered(1,headers);
    const first=text(1);expect(first).toContain('FINAL-OUTPUT-PROOF');expect(first).toContain('code 7');
    if(compact)expect(first.length).toBeLessThan(2000);else expect(first.length).toBeGreaterThan(10000);
    expect(await readFile(original(),'utf8')).toBe(output);
    expect(text(2)).toContain('MIDDLE-OUTPUT-PROOF');
    if(compact)expect(await readFile(handle(),'utf8')).toContain('FINAL-OUTPUT-PROOF');
    await daemon.close();daemon=await startGraphDaemon(options);const restored=await auth();
    expect((await fetch(`${daemon.url}/api/conversations/${conversationId}/messages`,{method:'POST',headers:restored,body:JSON.stringify({text:'Read the saved output after restart.',requestId:'again'})})).ok).toBe(true);
    await answered(2,restored);expect(text(compact?5:4)).toContain(compact?'FINAL-OUTPUT-PROOF':'MIDDLE-OUTPUT-PROOF');expect(await readFile(original(),'utf8')).toBe(output);
  }finally{
    await daemon.close();await provider.close();await rm(root,{recursive:true,force:true});
    if(fullOutputPath)await rm(fullOutputPath,{force:true});
    if(previous===undefined)delete process.env.GRAPH_COMPACT_SHELL_RESULTS;else process.env.GRAPH_COMPACT_SHELL_RESULTS=previous;
  }
},75000);
