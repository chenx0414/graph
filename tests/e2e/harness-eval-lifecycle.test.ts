import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openaiServer } from '../fixtures/openai-server.ts';

const execute = promisify(execFile);

test.each([{suggestion:true,missingUsage:false,caseId:'cli',fixedCount:false,timedOut:false,lane:'main'}, {missingUsage:true,caseId:'cli',fixedCount:false,timedOut:false,lane:'main'}, {missingUsage:false,caseId:'cli',fixedCount:false,timedOut:false,lane:'main'}, {missingUsage:false,caseId:'cli',fixedCount:true,timedOut:false,lane:'main'}, {missingUsage:false,caseId:'parser',fixedCount:false,timedOut:true,lane:'main'}, {missingUsage:false,caseId:'parser',fixedCount:false,timedOut:false,lane:'main'}, {missingUsage:false,caseId:'parser',fixedCount:false,timedOut:false,lane:'worker'}, {missingUsage:false,caseId:'parser',fixedCount:false,timedOut:true,lane:'worker'}])('real evaluation CLI records terminal state and closes its ledger ($lane, case=$caseId, fixedCount=$fixedCount, missingUsage=$missingUsage, timeout=$timedOut, suggestion=$suggestion)', async ({timedOut,lane,caseId,fixedCount,missingUsage,suggestion}) => {
  const root = await mkdtemp(join(tmpdir(), 'graph-eval-lifecycle-'));
  await writeFile(join(root,'hidden-verifier.txt'),'private-independent-verifier-marker');
  const cliCommand = `cat > greet.mjs <<'EOF'
const args=process.argv.slice(2);let n=1;if(args.length){n=Number(args[1]);if(args[0]!=='--count'||!args[1]||!Number.isInteger(n)||n<1){console.error('Invalid count');process.exit(1);} }
for(let i=0;i<(${fixedCount ? "args.length ? 3 : 1" : 'n'});i++)console.log('hello');
EOF`;
  const provider = await openaiServer((caseId==='cli'
    ? [{tools:[{id:'write-cli',name:'bash',arguments:JSON.stringify({command:cliCommand})}]},{text:'CLI ready.'}]
    : timedOut
    ? [{ text: 'Too late', beforeReply: () => new Promise<void>(resolve => setTimeout(resolve, lane==='worker' ? 20_000 : 5_000)) }]
    : [...(lane==='worker' ? [{tools:[{id:'outside-read',name:'read',arguments:JSON.stringify({path:join(root,'hidden-verifier.txt')})}]}] : []), { tools: [{ id: 'repair', name: 'bash', arguments: JSON.stringify({ command: `if test -e ../case.json; then echo 'verification leaked' >&2; exit 1; fi
cat > config.js <<'EOF'
export function parseConfig(text) { return Object.fromEntries(text.split('\\n').filter(line => line.trim()).map(line => { const index = line.indexOf('='); return [line.slice(0,index),line.slice(index+1)]; })); }
EOF` }) }] }, { text: 'Fixed.' }]).map(plan=>({...plan,...(missingUsage ? {usage:null} : {})})));
  const auxiliary=suggestion ? await openaiServer([{text:'Run another check.'}]) : undefined;
  let artifactRoot: string | undefined;
  try {
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [],
      credentials: { local: { secretRef: 'GRAPH_EVAL_LOCAL_KEY' } },
      models: { entries: [{ id: 'local', modelId: 'local', provider: 'graph-openai', grade: 'high',
        api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256,
        credentialId: 'local', cost: { input: 2, output: 4, cacheRead: 0.5, cacheWrite: 1 },
      },...(auxiliary?[{id:'suggestion',modelId:'suggestion',provider:'graph-suggestion',grade:'low',api:'openai-completions',baseUrl:auxiliary.model.baseUrl,contextWindow:32000,maxTokens:256,credentialId:'local',cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]:[])] },
    }));
    const snapshot=join(root,'snapshot');
    if(auxiliary){
      const context=join(root,'context');await mkdir(context);
      await writeFile(join(context,'agent-combinations.json'),JSON.stringify({version:1,combinations:[{id:'main',mode:'main',name:'Main',description:'Handle the requested project work.',recommendedGrade:'high',review:false,tags:[],resources:[]}]}));
      await execute(process.execPath,['scripts/harness-eval-context.mjs',context,snapshot],{cwd:process.cwd()});
    }
    const { stdout, stderr } = await execute(process.execPath, [lane==='worker' ? 'scripts/harness-worker-eval.mjs' : 'scripts/harness-real-eval.mjs', configPath, caseId], {
      cwd: process.cwd(), timeout: 45_000,
      env: { ...process.env, HOME: root,...(auxiliary?{GRAPH_EVAL_CONTEXT_SNAPSHOT:snapshot}:{}), GRAPH_EVAL_LOCAL_KEY: 'fixture-key', GRAPH_EVAL_TIMEOUT_MS: timedOut ? (lane==='worker' ? '10000' : '1000') : '15000' },
    });
    const report = JSON.parse(stdout);
    artifactRoot = report.root;
    expect(provider.requests.length, JSON.stringify(report)).toBeGreaterThan(0);
    if(lane==='worker'){
      expect(report).toMatchObject({taskSuccess:!timedOut,behavior:!timedOut,timedOut});
      expect(report.execution.state).toBe(timedOut ? 'failed' : 'completed');
      expect(report.workspace).not.toBe(join(report.root,'project'));
      if(!timedOut)expect(JSON.stringify(provider.requests[1])).not.toContain('private-independent-verifier-marker');
      if(!timedOut)expect(JSON.stringify(provider.requests[1])).toMatch(/outside|denied|not permitted|not allowed/i);
      expect(report.accounting.summary.requests).toBeGreaterThan(0);
    } else {
      expect(report).toMatchObject({ completed: !timedOut, success: !timedOut && !fixedCount, timedOut });
      expect(report.settled.state).toBe(timedOut ? 'interrupted' : 'succeeded');
      expect(report.cleanupIncomplete).toBe(false);
      expect(report.task.requests).toBeGreaterThan(0);
    }
    if(caseId==='cli'){
      const evidence=JSON.parse(report.verificationEvidence) as {generatedCounts:number[]};
      expect(new Set(evidence.generatedCounts).size).toBe(7);
      expect(evidence.generatedCounts).toContain(3);
      const runPath=join(root,'run.json');await writeFile(runPath,stdout);
      const manifestPath=join(root,'comparison.json');
      await writeFile(manifestPath,JSON.stringify({groups:[{name:'observed',scope:'main-operation',runs:[runPath]}],weights:{currency:'USD',perMillion:{input:2,output:4,cacheRead:.5,cacheWrite:1}}}));
      if(auxiliary){
        expect(auxiliary.requests.length).toBeGreaterThan(0);
        await expect(execute(process.execPath,['scripts/harness-eval-summary.mjs',manifestPath],{cwd:process.cwd()})).rejects.toThrow(/mixed-model operation/);
        return;
      }
      const comparison=await execute(process.execPath,['scripts/harness-eval-summary.mjs',manifestPath],{cwd:process.cwd()});
      const group=JSON.parse(comparison.stdout).groups[0];
      expect(group).toMatchObject({attempts:1,completed:fixedCount ? 0 : 1});
      expect(group.requests).toBe(report.accounting.requests);
      expect(Object.values(group.knownCost).some(amount=>typeof amount==='number' && amount>0)).toBe(true);
      if(fixedCount || missingUsage){expect(group.costPerCompletedTask).toBeNull();expect(group.scenario.costPerCompletedTask).toBeNull();}
      else {expect(group.costPerCompletedTask).toEqual(group.knownCost);expect(group.scenario.costPerCompletedTask).toBeGreaterThan(0);}
      await writeFile(manifestPath,JSON.stringify({groups:[{name:'duplicate',scope:'main-operation',runs:[runPath,runPath]}]}));
      await expect(execute(process.execPath,['scripts/harness-eval-summary.mjs',manifestPath],{cwd:process.cwd()})).rejects.toThrow(/Duplicate evaluation/);

    }
    expect(stderr).not.toMatch(/database is not open|ERR_INVALID_STATE/);
  } finally {
    await provider.close();await auxiliary?.close();
    await rm(root, { recursive: true, force: true });
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
  }
}, 60_000);
