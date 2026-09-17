import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const sessionsRoot = join(homedir(), '.codex', 'sessions');

async function newestSession(dir) {
  let newest;
  let newestTime = 0;

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const candidate = await newestSession(path);
      if (candidate && candidate.time > newestTime) {
        newest = candidate.path;
        newestTime = candidate.time;
      }
      continue;
    }
    if (!entry.name.endsWith('.jsonl')) continue;
    const info = await stat(path);
    if (info.mtimeMs > newestTime) {
      newest = path;
      newestTime = info.mtimeMs;
    }
  }

  return newest ? { path: newest, time: newestTime } : undefined;
}

function messageText(payload) {
  if (!Array.isArray(payload.content)) return '';
  return payload.content
    .map(part => typeof part?.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n');
}

function userRequest(text) {
  const trimmed = text.trimStart();
  if (!trimmed
    || trimmed.startsWith('# AGENTS.md instructions')
    || trimmed.startsWith('<app-context>')
    || trimmed.startsWith('<subagent_notification>')
    || trimmed.startsWith('<skill>')) return '';
  const request = text.indexOf('## My request:');
  return (request >= 0 ? text.slice(request + '## My request:'.length) : text).trim();
}

function compact(text, max = 240) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

function commandText(raw) {
  try {
    const value = JSON.parse(raw);
    return compact(String(value.cmd ?? value.command ?? value.path ?? raw));
  } catch {
    return compact(raw);
  }
}

async function summarize(path) {
  let meta;
  let firstTimestamp;
  let lastTimestamp;
  let lastAssistant = '';
  let gitStatus = '';
  let commandCount = 0;
  const requests = [];
  const failed = [];
  const commands = new Map();

  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record.timestamp === 'string') {
      firstTimestamp ??= record.timestamp;
      lastTimestamp = record.timestamp;
    }

    if (record.type === 'session_meta') {
      meta = record.payload;
      continue;
    }

    if (record.type !== 'response_item') continue;
    const payload = record.payload;
    if (payload?.type === 'message' && payload.role === 'user') {
      const request = userRequest(messageText(payload));
      if (request) requests.push(compact(request));
      continue;
    }
    if (payload?.type === 'message' && payload.role === 'assistant') {
      const text = messageText(payload);
      if (text) lastAssistant = compact(text, 320);
      continue;
    }
    if (payload?.type === 'function_call' && payload.name === 'exec_command') {
      commandCount += 1;
      commands.set(payload.call_id, commandText(payload.arguments));
      continue;
    }
    if (payload?.type !== 'function_call_output') continue;

    const output = typeof payload.output === 'string' ? payload.output : '';
    const command = commands.get(payload.call_id) ?? 'unknown command';
    const exit = /(?:Process exited with code|Exit code:)\s*(-?\d+)/.exec(output);
    if (exit && Number(exit[1]) !== 0) failed.push(`exit ${exit[1]}: ${command}`);
    if (command.includes('git status')) {
      gitStatus = /(?:^|\n)(## [^\n]+)/.exec(output)?.[1] ?? gitStatus;
    }
  }

  console.log('Session');
  console.log(`  id: ${meta?.id ?? 'unknown'}`);
  if (meta?.session_id && meta.session_id !== meta.id) console.log(`  root_session: ${meta.session_id}`);
  if (meta?.parent_thread_id) console.log(`  parent: ${meta.parent_thread_id}`);
  if (meta?.forked_from_id) console.log(`  forked_from: ${meta.forked_from_id}`);
  console.log(`  cwd: ${meta?.cwd ?? 'unknown'}`);
  if (meta?.git?.branch || meta?.git?.commit_hash) {
    console.log(`  git: ${meta.git?.branch ?? 'unknown'} @ ${meta.git?.commit_hash ?? 'unknown'}`);
  }
  console.log(`  range: ${firstTimestamp ?? 'unknown'} -> ${lastTimestamp ?? 'unknown'}`);

  console.log('\nUser requests');
  if (!requests.length) console.log('  (none found)');
  for (const request of requests.slice(-30)) console.log(`  - ${request}`);
  if (requests.length > 30) console.log(`  (${requests.length - 30} earlier requests omitted)`);

  console.log('\nCommands');
  console.log(`  total: ${commandCount}`);
  console.log(`  failed: ${failed.length}`);
  for (const failure of failed.slice(-12)) console.log(`  - ${failure}`);
  if (failed.length > 12) console.log(`  (${failed.length - 12} earlier failures omitted)`);

  console.log('\nFinal repository state');
  console.log(`  ${gitStatus || '(no git status output found)'}`);

  console.log('\nLast assistant message');
  console.log(`  ${lastAssistant || '(none found)'}`);
}

const path = process.argv[2] ?? (await newestSession(sessionsRoot))?.path;
if (!path) {
  console.error(`No session JSONL found under ${sessionsRoot}`);
  process.exit(1);
}

await summarize(path);
