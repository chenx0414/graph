// 这个文件在 tests/env-layers.json 里登记为 nested-sandbox 层：它的用例要让 daemon 跑
// 真命令，而 daemon 的 bash 工具会把命令裹进 macOS seatbelt，seatbelt 不能嵌套。
// 已经身处 seatbelt 的进程（例如一个 Agent 会话）只能得到
// `sandbox-exec: sandbox_apply: Operation not permitted`，于是命令退出 71、什么都没做。
// 那是这台机器缺少能力，不是回归：宿主门禁会跑它。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { openaiServer } from '../fixtures/openai-server.ts';

const execute = promisify(execFile);

test.each([{stalledUsage:true,missingUsage:false,caseId:'parser',fixedCount:false,timedOut:true,lane:'main'}, {missingUsage:true,caseId:'cli',fixedCount:false,timedOut:false,lane:'main'}, {missingUsage:false,caseId:'cli',fixedCount:false,timedOut:false,lane:'main'}, {missingUsage:false,caseId:'cli',fixedCount:true,timedOut:false,lane:'main'}, {missingUsage:false,caseId:'parser',fixedCount:false,timedOut:true,lane:'main'}, {missingUsage:false,caseId:'parser',fixedCount:false,timedOut:false,lane:'main'}])('real evaluation CLI records terminal state and closes its ledger ($lane, case=$caseId, fixedCount=$fixedCount, missingUsage=$missingUsage, timeout=$timedOut, stalledUsage=$stalledUsage)', async ({timedOut,lane,caseId,fixedCount,missingUsage,stalledUsage}) => {
  const root = await mkdtemp(join(tmpdir(), 'graph-eval-lifecycle-'));
  await writeFile(join(root,'hidden-verifier.txt'),'private-independent-verifier-marker');
  const cliCommand = `cat > greet.mjs <<'EOF'
const args=process.argv.slice(2);let n=1;if(args.length){n=Number(args[1]);if(args[0]!=='--count'||!args[1]||!Number.isInteger(n)||n<1){console.error('Invalid count');process.exit(1);} }
for(let i=0;i<(${fixedCount ? "args.length ? 3 : 1" : 'n'});i++)console.log('hello');
EOF`;
  const plans=(caseId==='cli'
    ? [{tools:[{id:'write-cli',name:'bash',arguments:JSON.stringify({command:cliCommand})}]},{text:'CLI ready.'}]
    : timedOut
    ? [...(lane==='main' ? [{tools:[{id:'before-timeout',name:'bash',arguments:JSON.stringify({command:'printf observed-before-interrupt > observed.txt'})}]}] : []), stalledUsage ? {text:'Waiting for final usage.',holdBeforeUsage:true} : { tools:[{id:'late-action',name:'bash',arguments:JSON.stringify({command:'printf forbidden > after-interrupt.txt'})}], beforeReply: () => new Promise<void>(resolve => setTimeout(resolve, lane==='worker' ? 20_000 : 5_000)) }]
    : [...(lane==='worker' ? [{tools:[{id:'outside-read',name:'read',arguments:JSON.stringify({path:join(root,'hidden-verifier.txt')})}]}] : []), { tools: [{ id: 'repair', name: 'bash', arguments: JSON.stringify({ command: `if test -e ../case.json; then echo 'verification leaked' >&2; exit 1; fi
cat > config.js <<'EOF'
export function parseConfig(text) { return Object.fromEntries(text.split('\\n').filter(line => line.trim()).map(line => { const index = line.indexOf('='); return [line.slice(0,index),line.slice(index+1)]; })); }
EOF` }) }] }, { text: 'Fixed.' }]).map(plan=>({...plan,...(missingUsage ? {usage:null} : {})}));
  const provider=await openaiServer(plans);
  let artifactRoot: string | undefined;
  let defaultArtifactRoot: string | undefined;
  try {
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [],
      credentials: { local: { secretRef: 'GRAPH_EVAL_LOCAL_KEY' } },
      models: { entries: [{ id: 'local', modelId: 'local', provider: 'graph-openai', grade: 'high',
        api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256,
        credentialId: 'local', cost: { input: 2, output: 4, cacheRead: 0.5, cacheWrite: 1 },
      }] },
    }));
    const { stdout, stderr } = await execute(process.execPath, ['scripts/harness-real-eval.mjs', configPath, caseId], {
      cwd: process.cwd(), timeout: 45_000,
      env: { ...process.env, GRAPH_DRAIN_CANCELED_USAGE:'1', HOME: root, GRAPH_EVAL_LOCAL_KEY: 'fixture-key', GRAPH_EVAL_TIMEOUT_MS: timedOut ? '4000' : '15000' },
    });
    const report = JSON.parse(stdout);
    artifactRoot = report.root;
    expect(provider.requests.length, JSON.stringify(report)).toBeGreaterThan(0);
    expect(report, JSON.stringify(report)).toMatchObject({ completed: !timedOut, success: !timedOut && !fixedCount, timedOut });
    // A transport that never answers leaves the Go daemon's ledger unsettled: the
    // operation settles as an unknown outcome and the call stays unknown, because
    // settling a transport that never drained belongs with the PiG kernel
    // takeover. A transport that does answer settles as interrupted.
    expect(report.settled.state, JSON.stringify(report)).toBe(timedOut ? 'unknown' : 'succeeded');
    expect(report.cleanupIncomplete).toBe(timedOut ? true : false);
    expect(report.task.requests).toBeGreaterThan(0);
    const ledger=JSON.parse(await readFile(join(report.root,'cost-report.json'),'utf8'));
    expect(ledger.tools.find((item:{tool:string})=>item.tool==='bash')).toMatchObject({calls:1,errors:0,tasks:1,taskReach:1});
    if(timedOut)expect(await readFile(join(report.root,'project','observed.txt'),'utf8')).toBe('observed-before-interrupt');
    expect(report.toolTelemetry).toMatchObject({collected:true});
    if(timedOut){
      expect(ledger.tasks.reduce((sum:number,task:{unknownUsage:number})=>sum+task.unknownUsage,0)).toBe(1);
      expect(ledger.tasks.reduce((sum:number,task:{estimatedUsage:number})=>sum+task.estimatedUsage,0)).toBe(0);
      expect(provider.requests).toHaveLength(2);
      await expect(readFile(join(report.root,'project','after-interrupt.txt'),'utf8')).rejects.toMatchObject({code:'ENOENT'});
      if(stalledUsage){
        // A cancelled transport settles in seconds now; the budget only has to hold.
        expect(report.elapsedMs, JSON.stringify(report)).toBeLessThan(42_000);
        expect(ledger.summary.costPerCompletedTask).toBeNull();
      }else expect(ledger.models[0].tokens.input, JSON.stringify(ledger.models[0].tokens)).toBeGreaterThan(0);
    }
    if(caseId==='cli'){
      const evidence=JSON.parse(report.verificationEvidence) as {generatedCounts:number[]};
      expect(new Set(evidence.generatedCounts).size).toBe(7);
      expect(evidence.generatedCounts).toContain(3);
      const runPath=join(root,'run.json');await writeFile(runPath,stdout);
      const manifestPath=join(root,'comparison.json');
      await writeFile(manifestPath,JSON.stringify({groups:[{name:'observed',scope:'main-operation',runs:[runPath]}],weights:{currency:'USD',perMillion:{input:2,output:4,cacheRead:.5,cacheWrite:1}}}));
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
    await provider.close();
    await rm(root, { recursive: true, force: true });
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
    if (defaultArtifactRoot) await rm(defaultArtifactRoot,{recursive:true,force:true});
  }
}, 60_000);
