/**
 * Launch a real Chromium for a browser test, and survive Graph's command sandbox.
 *
 * Measured 2026-11-04: every Chromium build this machine has (Playwright's
 * chrome-headless-shell 1234 and 1243, the bundled Chrome for Testing
 * 153.0.8010.12, the agent-browser Chrome for Testing 153.0.8010.36 and the
 * system Google Chrome 156) dies the same way when Playwright starts it from a
 * worker command: SIGSEGV, EXC_BAD_ACCESS KERN_INVALID_ADDRESS at 0x10, main
 * thread frame `IONotificationPortGetRunLoopSource` (the system Chrome instead
 * prints its own FATAL `bootstrap_check_in ... Permission denied (1100)`). The
 * same binaries start, render and screenshot normally when they are started
 * outside that sandbox. The cause is the environment, not the test and not the
 * browser version: the restricted runtime runs every command under a
 * deny-default seatbelt profile, and a browser has to register a Mach service,
 * ask for dynamic sandbox extensions and create IOKit ports to start at all.
 * See tests/e2e/playwright-launch-environment.md for the measured table.
 *
 * So: when this process is seatbelt-sandboxed, the browser is started in the
 * host session instead - by LaunchServices (`open`), which is the one route out
 * of the sandbox that stays available - and Playwright drives it over CDP.
 * Assertions are untouched: the page under test is still the real daemon of this
 * test, over the real loopback, in a real Chromium. When the process is not
 * sandboxed (CI, a plain shell) the helper is a plain `chromium.launch`.
 */
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { chromium, type Browser } from 'playwright';

const run = promisify(execFile);

/** How the browser for this test was started: by Playwright itself, or through the host session over CDP. */
export type BrowserLaunchMode = 'direct' | 'host';

export interface LaunchedBrowser {
  browser: Browser;
  mode: BrowserLaunchMode;
  /** Where the browser's own stderr went; null for a direct launch. */
  logPath: string | null;
  /** Chrome version reported over CDP / after launch, for the evidence trail. */
  version: string;
  close(): Promise<void>;
}

export interface LaunchBrowserOptions {
  /** Extra browser arguments, appended to the launch. */
  args?: string[];
  /** Browser binary to start instead of the one Playwright ships. */
  executablePath?: string;
  /** Milliseconds to wait for the host-launched browser to open its CDP port. */
  timeoutMs?: number;
}

export const HOST_BROWSER_ARGUMENTS = [
  '--no-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  // The crashpad handler outlives the browser and keeps writing into the
  // profile; it must not, or the temporary directory comes back after cleanup.
  '--disable-breakpad',
  '--disable-crash-reporter',
];

/**
 * True when this process runs inside a seatbelt sandbox.
 *
 * `sandbox-exec` refuses to apply a nested profile ("sandbox_apply: Operation
 * not permitted", exit 71), which is exactly the restriction that stops a
 * browser from starting; outside a sandbox the same probe succeeds.
 */
export async function isSandboxed(): Promise<boolean> {
  try {
    await run('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 10_000 });
    return false;
  } catch {
    return true;
  }
}

/**
 * The headless-shell binary Playwright would use for `headless: true`, derived
 * from the Chrome for Testing path Playwright reports (same revision, sibling
 * directory in the browser cache); when the cache layout is different it falls
 * back to the bundled Chrome for Testing, which then runs with `--headless=new`.
 */
export async function resolveBrowserExecutable(): Promise<string> {
  const bundled = chromium.executablePath();
  // .../chromium-<rev>/chrome-mac-<arch>/<App>.app/Contents/MacOS/<binary>
  let revisionDirectory = dirname(bundled);
  while (revisionDirectory !== '/' && !/^chromium-\d+$/.test(revisionDirectory.split('/').pop() ?? '')) {
    revisionDirectory = dirname(revisionDirectory);
  }
  const cacheRoot = resolve(revisionDirectory, '..');
  const revision = revisionDirectory.split('-').pop();
  try {
    const entries = await readdir(cacheRoot);
    for (const entry of entries) {
      if (!entry.startsWith('chromium_headless_shell-')) continue;
      if (revision && !entry.endsWith(`-${revision}`)) continue;
      const shell = join(cacheRoot, entry, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
      if (await access(shell).then(() => true, () => false)) return shell;
    }
  } catch {
    // Fall through to the bundled Chrome for Testing.
  }
  return bundled;
}

/** Launch a browser, picking the route this process is actually allowed to use. */
export async function launchBrowser(options: LaunchBrowserOptions = {}): Promise<LaunchedBrowser> {
  const args = options.args ?? [];
  if (!(await isSandboxed())) {
    const browser = await chromium.launch({
      headless: true,
      ...(args.length ? { args } : {}),
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    });
    return {
      browser,
      mode: 'direct',
      logPath: null,
      version: browser.version(),
      close: async () => {
        await browser.close().catch(() => undefined);
      },
    };
  }
  return launchInHostSession(args, options.timeoutMs ?? 60_000, options.executablePath);
}

/**
 * Start the browser from the host session through LaunchServices and attach to
 * it over CDP.
 *
 * The wrapper is a throwaway `.app` whose executable execs the browser: an app
 * launched that way is spawned by launchd in the user session, outside the
 * seatbelt profile of this process, which is the only difference from a
 * `chromium.launch` that segfaults here.
 */
async function launchInHostSession(args: string[], timeoutMs: number, requestedExecutable?: string): Promise<LaunchedBrowser> {
  const work = await mkdtemp(join(tmpdir(), 'graph-host-browser-'));
  const app = join(work, 'HostBrowser.app');
  const profile = join(work, 'profile');
  const logPath = join(work, 'browser.log');
  const bundleId = `dev.graph.e2e.hostbrowser.${work.split('-').pop() ?? 'x'}`;
  const executable = requestedExecutable ?? await resolveBrowserExecutable();
  const headless = executable.endsWith('chrome-headless-shell') ? [] : ['--headless=new'];

  await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>launch</string>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
</dict></plist>
`);
  const argv = [
    executable,
    ...headless,
    ...HOST_BROWSER_ARGUMENTS,
    ...args,
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    'about:blank',
  ];
  const launchScript = join(app, 'Contents', 'MacOS', 'launch');
  await writeFile(launchScript, `#!/bin/sh\nexec ${argv.map(shellQuote).join(' ')} >>${shellQuote(logPath)} 2>&1\n`);
  await chmod(launchScript, 0o755);

  const started = Date.now();
  await run('/usr/bin/open', ['-g', '-n', app], { timeout: 30_000 });

  let endpoint: string | undefined;
  while (Date.now() - started < timeoutMs) {
    try {
      const raw = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
      const port = Number(raw.split('\n')[0]);
      if (port > 0) {
        endpoint = `http://127.0.0.1:${port}`;
        break;
      }
    } catch {
      // The browser is still starting up.
    }
    await sleep(100);
  }
  if (!endpoint) {
    const log = await readFile(logPath, 'utf8').catch(() => '');
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`host-launched browser never opened a CDP port in ${timeoutMs}ms (${executable})\n${log.slice(-2_000)}`);
  }

  const browser = await chromium.connectOverCDP(endpoint);
  let closed = false;
  const removed = async () => !(await access(work).then(() => true, () => false));
  // The browser and its crashpad handler keep writing under the profile after
  // Browser.close returns, so a single rm loses the race: delete, wait for the
  // directory to actually stay gone, and only then call it cleaned up.
  const removeWork = async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
      await sleep(250);
      if (!(await removed())) continue;
      await sleep(250);
      if (await removed()) return;
    }
    // A leftover is not a test failure, but it should never be silent either.
    process.emitWarning(`host-browser: could not remove ${work}`);
  };
  return {
    browser,
    mode: 'host',
    logPath,
    version: browser.version(),
    close: async () => {
      if (closed) return;
      closed = true;
      // Browser.close is what actually ends a browser this process does not own;
      // disconnecting alone would leave it running in the host session.
      const session = await browser.newBrowserCDPSession().catch(() => undefined);
      await session?.send('Browser.close').catch(() => undefined);
      await browser.close().catch(() => undefined);
      await removeWork();
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
