// review-2 attempt-3: independent re-verification of the two rework fixes in docs/design-graph-examples.md
// Black-box: parses the document itself, feeds each graph block to the product's own validateProposal,
// then mutates the v40 block per the document's own evidence table ("守得住/守不住").
// Run: node deliverables/review-2-recheck.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const doc = readFileSync(join(root, 'docs', 'design-graph-examples.md'), 'utf8');
const { validateProposal } = await import(pathToFileURL(join(root, 'src/core/proposal.ts')).href);

function blocks() {
  const out = [];
  for (const m of doc.matchAll(/```json\n([\s\S]*?)```/g)) {
    const body = m[1].trim();
    if (!body.includes('"nodes"')) continue;
    const parsed = JSON.parse(body.replaceAll('<模型 id>', 'example:model'));
    if (!Array.isArray(parsed.nodes)) continue;
    out.push(parsed);
  }
  return out;
}

function verdict(p) {
  try { validateProposal(p); return { ok: true }; }
  catch (e) { return { ok: false, msg: e.message }; }
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${detail}`); }
}

const bs = blocks();
console.log(`# document carries ${bs.length} graph blocks`);
const v40 = bs[bs.length - 1]; // last block in document order = v40 full draft
check('v40 block exists', !!v40 && Array.isArray(v40.nodes) && v40.nodes.length >= 9, JSON.stringify(v40?.nodes?.length));

// 1. all blocks accepted by the product validator (design-examples.test.ts contract)
for (let i = 0; i < bs.length; i++) {
  const r = verdict(bs[i]);
  check(`block #${i + 1} accepted (${bs[i].summary?.slice(0, 18) ?? '?'})`, r.ok, r.msg);
}

const base = verdict(v40);
check('v40 base accepted', base.ok, base.msg);

// 2. §3.1 re-check: deleting synth's predecessors must be ACCEPTED (document now says 守不住)
const synth = v40.nodes.find(n => n.id === 'synth');
check('synth carries context.purpose=review', synth?.context?.purpose === 'review', JSON.stringify(synth?.context));
const mNoPred = clone(v40);
const s2 = mNoPred.nodes.find(n => n.id === 'synth');
delete s2.context.predecessors;
const rNoPred = verdict(mNoPred);
check('MUT-516a: delete synth.predecessors -> ACCEPTED (doc says 守不住)', rNoPred.ok, rNoPred.msg);

// 3. deleting the whole context must be REFUSED (document's replacement claim)
const mNoCtx = clone(v40);
const s3 = mNoCtx.nodes.find(n => n.id === 'synth');
delete s3.context;
const rNoCtx = verdict(mNoCtx);
check('MUT-516b: delete synth.context -> REFUSED', !rNoCtx.ok, JSON.stringify(rNoCtx));
if (!rNoCtx.ok) check('  ... error mentions handoff policy', /handoff policy/.test(rNoCtx.msg), rNoCtx.msg);

// 4. §3.2 proposal.ts:61-72 rule: acceptance bound to non-router is refused; to router accepted
const mCheck = clone(v40);
mCheck.acceptance[0].checkNode = 'nope';
const rCheck = verdict(mCheck);
check('MUT-acceptance ghost checkNode -> REFUSED', !rCheck.ok && /mandatory program check or Agent router/.test(rCheck.msg), JSON.stringify(rCheck));

// acceptance bound to an ordinary agent (non-router) must be refused
const mOrd = clone(v40);
mOrd.acceptance[0].checkNode = 'worker-1';
const rOrd = verdict(mOrd);
check('MUT-acceptance bound to ordinary agent -> REFUSED', !rOrd.ok && /mandatory program check or Agent router/.test(rOrd.msg), JSON.stringify(rOrd));

// 5. when.case declared-branch rule
const mCase = clone(v40);
const w = mCase.nodes.find(n => n.id === 'worker-2');
if (w?.when) { w.when.case = 'nope-undeclared'; const r = verdict(mCase); check('MUT when.case undeclared -> REFUSED', !r.ok && /declared router case/.test(r.msg), JSON.stringify(r)); }
else { check('MUT when.case undeclared -> REFUSED', false, 'worker-2 has no when'); }

// 6. loop endpoint rule
const mLoop = clone(v40);
mLoop.loops[1] = { ...mLoop.loops[1], to: 'ghost' };
const rLoop = verdict(mLoop);
check('MUT loop endpoint ghost -> REFUSED', !rLoop.ok && /Loop endpoints must be distinct existing nodes/.test(rLoop.msg), JSON.stringify(rLoop));

// 7. line-reference integrity: every src/*.ts:NN-NN reference must point into the file
import { existsSync, readFileSync as rf } from 'node:fs';
const refs = [...doc.matchAll(/`(src\/[^`]+?\.ts):(\d+)(?:-(\d+))?`/g)].map(m => ({ file: m[1], a: +m[2], b: m[3] ? +m[3] : +m[2] }));
let badRefs = [];
for (const r of refs) {
  const p = join(root, r.file);
  if (!existsSync(p)) { badRefs.push(`${r.file} missing`); continue; }
  const n = rf(p, 'utf8').split('\n').length;
  if (r.a < 1 || r.b > n || r.a > r.b) badRefs.push(`${r.file}:${r.a}-${r.b} (file has ${n} lines)`);
}
check(`all ${refs.length} src line refs point inside their files`, badRefs.length === 0, badRefs.join('; '));

console.log(`\nSUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
