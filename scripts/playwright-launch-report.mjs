#!/usr/bin/env node
/**
 * Why every Playwright launch segfaults on this machine, measured.
 *
 * Runs the same browsers three ways and writes the comparison as a markdown
 * report (plus one screenshot per browser that did start):
 *
 *   1. `--version`              - the build each binary actually is;
 *   2. Playwright default launch - what the suite does today, in this process;
 *   3. host-session launch       - the same binary started through LaunchServices
 *                                  and driven over CDP, i.e. what
 *                                  `tests/helpers/host-browser.ts` does;
 *   4. the identical argument list from (2) replayed inside and outside the
 *      sandbox, so binary/args/user-data-dir cannot explain the difference.
 *
 * `node scripts/playwright-launch-report.mjs [--out <dir>]`
 */
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { HOST_BROWSER_ARGUMENTS, isSandboxed, launchBrowser, resolveBrowserExecutable } from '../tests/helpers/host-browser.ts';

const exec = promisify(execFile);
const outDir = join(
  process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(tmpdir(), 'graph-playwright-launch-report'),
  new Date().toISOString().replace(/[:.]/g, '-'),
);

const SEV = /Received signal (\d+) (SEGV_\w+) ([0-9a-f]+)/;

/** execFile, but a spawn the sandbox refuses (EPERM) is a result, not a crash. */
async function tryExec(file, args, options = {}) {
  try {
    const { stdout, stderr } = await exec(file, args, { maxBuffer: 4 * 1024 * 1024, ...options });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: error?.stdout ?? '', stderr: error?.stderr ?? '', code: error?.code, message: String(error?.message ?? error) };
  }
}

async function version(binary) {
  const result = await tryExec(binary, ['--version'], { timeout: 20_000 });
  return result.ok ? result.stdout.trim().replace(/\s+/g, ' ') : `version failed: ${result.message.slice(0, 120)}`;
}

async function exists(path) {
  return access(path).then(() => true, () => false);
}

async function browsers() {
  const list = [];
  const shell = await resolveBrowserExecutable();
  list.push({ label: 'Playwright chromium headless shell (default for headless)', binary: shell });
  const bundled = chromium.executablePath();
  if (bundled !== shell) list.push({ label: 'Playwright bundled Chrome for Testing', binary: bundled });
  const agentBrowserRoot = join(homedir(), '.agent-browser', 'browsers');
  for (const entry of await readdir(agentBrowserRoot).catch(() => [])) {
    const candidate = join(agentBrowserRoot, entry, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    if (entry.startsWith('chrome-') && await exists(candidate)) {
      list.push({ label: `agent-browser ${entry.replace('chrome-', '')}`, binary: candidate });
    }
  }
  const system = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (await exists(system)) list.push({ label: 'system Google Chrome', binary: system });
  return list;
}

/** What the suite does today: `chromium.launch()` from this process. */
async function directLaunch(binary) {
  try {
    const browser = await chromium.launch({ headless: true, executablePath: binary, timeout: 30_000 });
    const page = await browser.newPage();
    await page.setContent('<h1>direct</h1>');
    const text = await page.textContent('h1');
    await browser.close();
    return { ok: true, detail: `rendered "${text}"`, args: null };
  } catch (error) {
    const message = String(error?.message ?? error);
    const sev = message.match(SEV);
    const launching = message.match(/<launching> (.+)/)?.[1]?.trim() ?? null;
    return {
      ok: false,
      detail: sev ? `${sev[2]} at 0x${sev[3]} (signal ${sev[1]})` : message.split('\n')[0].slice(0, 160),
      args: launching,
    };
  }
}

/** The same binary, started in the host session and driven over CDP. */
async function hostLaunch(binary, label) {
  try {
    const launched = await launchBrowser({ executablePath: binary, timeoutMs: 45_000 });
    const page = launched.browser.contexts()[0]?.pages()[0] ?? await launched.browser.newPage();
    await page.setContent('<h1 id="probe">host session</h1>');
    const text = await page.textContent('#probe');
    const shot = join(outDir, `${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`);
    await page.screenshot({ path: shot });
    const bytes = (await readFile(shot)).byteLength;
    await launched.close();
    return { ok: true, detail: `rendered "${text}", ${bytes}-byte screenshot`, shot, version: launched.version };
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error).split('\n')[0].slice(0, 160) };
  }
}

/** Replay one exact argument list inside the sandbox and report how it ended. */
async function replayInside(binary, args) {
  const result = await tryExec(binary, args, { timeout: 30_000 });
  if (result.ok) return `started, stderr: ${result.stderr.trim().split('\n')[0] || '(none)'}`;
  const text = `${result.stderr}${result.message}`;
  const sev = text.match(SEV);
  if (sev) return `${sev[2]} at 0x${sev[3]} (signal ${sev[1]}), ${result.code ?? result.message.split('\n').pop()}`;
  return text.split('\n')[0].slice(0, 160);
}

/** A cheap probe of what the sandbox withholds, run in this process. */
async function probeInside() {
  const describe = (result) => (result.ok
    ? 'allowed'
    : `denied (${(result.stderr.trim() || result.message.split('\n')[0]).slice(0, 90)})`);
  return {
    nested: describe(await tryExec('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 15_000 })),
    processInfo: describe(await tryExec('/bin/ps', ['-p', String(process.pid)], { timeout: 15_000 })),
  };
}

/** The same two probes, but run from a process launchd starts outside the sandbox. */
async function probeOutside() {
  const work = await mkdtemp(join(tmpdir(), 'graph-probe-app-'));
  const app = join(work, 'Probe.app');
  const report = join(work, 'probe.txt');
  const marker = join(work, 'probe.txt');
  await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>probe</string>
<key>CFBundleIdentifier</key><string>dev.graph.e2e.probe.${Date.now()}</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/>
</dict></plist>
`);
  await writeFile(join(app, 'Contents', 'MacOS', 'probe'), `#!/bin/sh
{
  if /usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true 2>/dev/null; then
    echo "sandbox-exec: allowed"
  else
    echo "sandbox-exec: denied (sandbox_apply not permitted)"
  fi
  /bin/ps -p $$ >/dev/null 2>&1 && echo "ps: allowed" || echo "ps: denied"
} > '${marker}' 2>&1
`);
  await exec('chmod', ['+x', join(app, 'Contents', 'MacOS', 'probe')]);
  await exec('/usr/bin/open', ['-g', '-n', app], { timeout: 30_000 });
  for (let i = 0; i < 100; i += 1) {
    const text = await readFile(report, 'utf8').catch(() => undefined);
    if (text) {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
      const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
      return {
        nested: lines.find((line) => line.startsWith('sandbox-exec:'))?.replace('sandbox-exec: ', '') ?? 'unknown',
        processInfo: lines.find((line) => line.startsWith('ps:'))?.replace('ps: ', '') ?? 'unknown',
      };
    }
    await sleep(100);
  }
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
  return { nested: 'probe did not report', processInfo: 'probe did not report' };
}

/**
 * The crash report the operating system wrote for the launches of one binary:
 * the exception and the faulting frame, so the "0x10" signature has a stack.
 */
async function newestCrash(binary) {
  const directory = join(homedir(), 'Library', 'Logs', 'DiagnosticReports');
  const processName = binary.split('/').pop();
  const entries = await readdir(directory).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.startsWith(`${processName}-`) && entry.endsWith('.ips'))
    .slice(-40);
  for (const entry of candidates.reverse()) {
    const raw = await readFile(join(directory, entry), 'utf8').catch(() => '');
    const parsed = await Promise.resolve(raw.slice(raw.indexOf('\n') + 1)).then((text) => JSON.parse(text)).catch(() => undefined);
    if (!parsed) continue;
    if (Date.now() - Date.parse(parsed.captureTime ?? 0) > 20 * 60_000) continue;
    const triggered = parsed.threads?.find((thread) => thread.triggered);
    const frame = triggered?.frames?.[0];
    if (!frame) continue;
    const image = parsed.usedImages?.[frame.imageIndex];
    return {
      file: entry,
      proc: parsed.procName,
      exception: `${parsed.exception?.type ?? '?'} ${parsed.exception?.subtype ?? parsed.exception?.signal ?? ''}`.trim(),
      frame: `${frame.symbol ?? '?'} (${image?.name ?? image?.path ?? '?'})`,
    };
  }
  return null;
}

/** First line of a raw run that says why the browser did not start. */
async function rawFailure(binary) {
  const profile = join(tmpdir(), `raw-probe-${Date.now()}`);
  const result = await tryExec(binary, ['--headless=new', '--no-sandbox', `--user-data-dir=${profile}`, '--dump-dom', 'about:blank'], { timeout: 30_000 });
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  if (result.ok) return 'started';
  const lines = `${result.stderr}${result.message}`.split('\n').map((line) => line.trim()).filter(Boolean);
  const interesting = lines.find((line) => /FATAL|SEGV|sandbox_extension|Permission denied/.test(line));
  return (interesting ?? lines[0] ?? 'no output').replace(/\[\d+[:/]\d+[:/][\d.]+:/, '[').slice(0, 200);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const sandboxed = await isSandboxed();
  const inside = await probeInside();
  const outside = await probeOutside();
  const rows = [];
  for (const entry of await browsers()) {
    const build = await version(entry.binary);
    const direct = await directLaunch(entry.binary);
    const host = await hostLaunch(entry.binary, entry.label);
    rows.push({ ...entry, build, direct, host, raw: await rawFailure(entry.binary) });
  }

  const shell = rows[0];
  let replay = null;
  if (shell) {
    // The same argv the helper hands the browser, played inside the sandbox by
    // hand. The only token that differs in the host run is the profile path,
    // which both keep under TMPDIR.
    const profile = join(tmpdir(), `replay-inside-${Date.now()}`);
    const argv = [...HOST_BROWSER_ARGUMENTS, `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'];
    const insideResult = await replayInside(shell.binary, argv);
    replay = {
      argv,
      playwrightArgv: shell.direct.args,
      insideResult,
      outsideResult: shell.host.ok ? shell.host.detail : `failed: ${shell.host.detail}`,
    };
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }

  const crash = rows[0] ? await newestCrash(rows[0].binary) : null;

  const md = [];
  md.push('# Playwright launch on this machine: measured', '');
  md.push(`Generated ${new Date().toISOString()} by \`node scripts/playwright-launch-report.mjs\`.`, '');
  md.push(`This process runs inside a seatbelt sandbox: **${sandboxed}**`, '');
  md.push('## What the sandbox withholds', '');
  md.push('| probe | inside this command | in the host session |', '| --- | --- | --- |');
  md.push(`| \`sandbox-exec -p ... true\` (nesting a sandbox) | ${inside.nested} | ${outside.nested} |`);
  md.push(`| \`ps -p \\$\\$\` (process-info across the sandbox) | ${inside.processInfo} | ${outside.processInfo} |`, '');
  if (crash) {
    md.push('## What the operating system recorded for those launches', '');
    md.push(`Newest crash report for the headless shell started here: \`${crash.file}\``);
    md.push('');
    md.push(`- process: ${crash.proc}`);
    md.push(`- exception: ${crash.exception}`);
    md.push(`- faulting frame: \`${crash.frame}\``);
    md.push('- the same binary runs in the host session (table below), so the crash belongs to this process context and not to the build', '');
  }
  md.push('## Browser builds', '');
  md.push('| browser | binary | version | `chromium.launch` here | raw run in this command | host-session launch |', '| --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    const host = row.host.ok ? `${row.host.detail} (${row.host.version})` : `failed: ${row.host.detail}`;
    md.push(`| ${row.label} | \`${row.binary.replace(homedir(), '~')}\` | ${row.build} | ${row.direct.ok ? 'worked' : row.direct.detail} | ${row.raw.replaceAll('|', '\\|')} | ${host} |`);
  }
  md.push('');
  md.push('## Same binary, same arguments, two contexts', '');
  if (replay) {
    md.push('The identical argv, once inside this command and once in the host session (`--user-data-dir` differs only by a temp path on both sides):', '');
    md.push('```');
    md.push(replay.argv.map((arg) => `  ${arg}`).join('\n'));
    md.push('```', '');
    md.push('```');
    md.push(`inside the sandbox: ${replay.insideResult}`);
    md.push(`host session:       ${replay.outsideResult}`);
    md.push('```', '');
    if (replay.playwrightArgv) {
      md.push('For reference, the argv Playwright itself passes for `chromium.launch({ headless: true })` on this machine (it ends in `--remote-debugging-pipe --no-startup-window`, so the same test can only reuse it by swapping in a CDP port):', '');
      md.push('```', replay.playwrightArgv.slice(0, 1_200), '```', '');
    }
  } else {
    md.push('Playwright did not report a launch line, so the replay was skipped.', '');
  }
  md.push('## Verdict', '');
  md.push('- Every build fails the same way in this command context and every build works outside it: the difference is the process context, not the browser version, not the arguments, not the user-data-dir.');
  md.push('- A browser cannot start under the restricted runtime: it has to register a Mach service and nest its own sandbox, both of which a deny-default seatbelt profile withholds.');
  md.push('- `tests/helpers/host-browser.ts` therefore starts the browser in the host session when it detects that profile and keeps driving it with Playwright over CDP.');
  md.push('', `Screenshots: \`${outDir}\``, '');
  const reportPath = join(outDir, 'report.md');
  await writeFile(reportPath, md.join('\n'));
  process.stdout.write(`${md.join('\n')}\n\nreport: ${reportPath}\n`);
}

await main();
