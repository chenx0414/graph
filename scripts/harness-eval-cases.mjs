// Frozen task inputs and independent public-behavior checks for real-model runs.
export const cases = {
  parser: {
    prompt: '修一下 config.js，空白行别当成配置，保留值里的等号。',
    files: { 'config.js': "export function parseConfig(text) { return Object.fromEntries(text.split('\\n').map(line => line.split('='))); }\n" },
    verify: `import assert from 'node:assert/strict';
      import {parseConfig} from './config.js';
      assert.deepEqual(parseConfig('A=one=two\\n\\nB=3\\n'),{A:'one=two',B:'3'});
      assert.deepEqual(parseConfig('A=1\\nB=2'),{A:'1',B:'2'});
      assert.deepEqual(parseConfig(''),{});`,
  },
  cli: {
    prompt: '给 greet.mjs 加 --count 参数重复输出，默认行为别变。非法值要报错退出。',
    files: { 'greet.mjs': "console.log('hello');\n" },
    verify: `import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {randomInt} from 'node:crypto';
      const run=(...args)=>spawnSync(process.execPath,['greet.mjs',...args],{encoding:'utf8',timeout:3000});
      const baseline=run();assert.equal(baseline.status,0);assert.equal(baseline.stdout,'hello\\n');
      const counts=new Set([3]);while(counts.size<7)counts.add(randomInt(1,101));
      for(const count of counts){const repeated=run('--count',String(count));assert.equal(repeated.status,0);assert.equal(repeated.stdout,'hello\\n'.repeat(count));}
      for(const args of [['--count','no'],['--count','-1'],['--count','1.5'],['--count']]){
        const result=run(...args);assert.notEqual(result.status,0);assert.ok(result.stderr.trim());
      }
      console.log(JSON.stringify({verifiedCounts:[...counts]}));`,
  },
  persistence: {
    prompt: 'counter.mjs 没保存指定的状态文件，修一下，重启后也要接着计数。',
    files: { 'counter.mjs': "const statePath = process.argv[2]; let count = 0; console.log(++count);\n" },
    verify: `import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawnSync} from 'node:child_process';
      const script=resolve('counter.mjs'),cwd=mkdtempSync(join(tmpdir(),'graph-counter-check-')),state=join(cwd,'count.json');
      for(const expected of [1,2,3]){const r=spawnSync(process.execPath,[script,state],{cwd,encoding:'utf8',timeout:3000});assert.equal(r.status,0);assert.equal(r.stdout.trim(),String(expected));}`,
  },
  command: {
    prompt: '运行 node check.mjs，修好配置让检查通过，不要改检查程序。',
    files: {
      'settings.json': '{"mode":"slow","label":"sample"}\n',
      'check.mjs': "import {readFileSync} from 'node:fs'; const config=JSON.parse(readFileSync('settings.json','utf8')); for(let i=0;i<5000;i++) console.log('diagnostic '+i); if(config.mode!=='fast'){console.error('mode must be fast');process.exit(1);} console.log('verified');\n",
    },
    verify: `import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
      assert.deepEqual(JSON.parse(readFileSync('settings.json','utf8')),{mode:'fast',label:'sample'});
      const result=spawnSync(process.execPath,['check.mjs'],{encoding:'utf8',timeout:3000});assert.equal(result.status,0);assert.ok(result.stdout.endsWith('verified\\n'));`,
    unchanged: ['check.mjs'],
  },
};
