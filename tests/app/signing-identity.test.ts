import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  designatedRequirement,
  ensureSigningIdentity,
  keychainPath,
  signCode,
  signatureIsStable,
  signingIdentity,
} from '../../scripts/signing-identity.mjs';

const macOnly = process.platform === 'darwin';
const scratch = macOnly ? mkdtempSync(join(tmpdir(), 'graph-signing-')) : '';

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function copyOut(source: string, name: string): string {
  const target = join(scratch, name);
  copyFileSync(source, target);
  return target;
}

function cdhash(path: string): string {
  const result = spawnSync('codesign', ['-dvvv', path], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const hash = /CDHash=(\w+)/.exec(output)?.[1];
  if (!hash) throw new Error(`codesign printed no CDHash for ${path}: ${output}`);
  return hash;
}

describe.skipIf(!macOnly)('the local signing identity', () => {
  test('is created once and reused, outside the login keychain', () => {
    const first = ensureSigningIdentity();
    expect(first?.identity).toBe(signingIdentity);
    expect(first?.keychain).toBe(keychainPath());
    expect(keychainPath().startsWith(join(homedir(), '.graph', 'signing'))).toBe(true);
    expect(ensureSigningIdentity()).toEqual(first);
  });

  test('keeps one requirement across different builds, so the accessibility grant survives a rebuild', () => {
    ensureSigningIdentity();
    const built = copyOut('/bin/echo', 'built');
    const rebuilt = copyOut('/bin/ls', 'rebuilt');
    signCode(built);
    signCode(rebuilt);
    const requirement = designatedRequirement(built);
    expect(requirement).toBe(designatedRequirement(rebuilt));
    expect(requirement).toContain('certificate');
    expect(requirement).toContain('dev.graph.console');
    expect(requirement).not.toContain('cdhash');
    expect(cdhash(built)).not.toBe(cdhash(rebuilt));
    expect(signatureIsStable(rebuilt)).toBe(true);
  });

  test('reports an ad-hoc signature as unstable, because TCC keys its grant to the cdhash', () => {
    const adHoc = copyOut('/bin/echo', 'adhoc');
    execFileSync('codesign', ['--force', '--sign', '-', adHoc], { stdio: 'pipe' });
    expect(designatedRequirement(adHoc)).toContain('cdhash');
    expect(signatureIsStable(adHoc)).toBe(false);
  });
});
