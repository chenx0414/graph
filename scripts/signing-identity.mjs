import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const signingIdentity = 'Graph Self-Signed';
export const codeIdentifier = 'dev.graph.console';

const requestConfig = `[req]
distinguished_name = dn
x509_extensions = codesign
prompt = no
[dn]
CN = ${signingIdentity}
O = Graph
[codesign]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
`;

export function signingDirectory() {
  return join(homedir(), '.graph', 'signing');
}

export function keychainPath() {
  return join(signingDirectory(), 'graph-signing.keychain-db');
}

function passwordPath() {
  return join(signingDirectory(), 'keychain.pass');
}

function keychainPassword(create = false) {
  const path = passwordPath();
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  if (!create) throw new Error(`the keychain password is missing at ${path}; delete ${keychainPath()} and rerun to recreate the identity`);
  const generated = randomBytes(24).toString('hex');
  writeFileSync(path, `${generated}\n`, { mode: 0o600 });
  return generated;
}

function run(command, args) {
  return execFileSync(command, args, { stdio: 'pipe', encoding: 'utf8' });
}

export function identityPresent() {
  if (!existsSync(keychainPath())) return false;
  const listing = spawnSync('security', ['find-identity', '-p', 'codesigning', keychainPath()], { encoding: 'utf8' });
  return listing.status === 0 && listing.stdout.includes(signingIdentity);
}

export function ensureSigningIdentity() {
  if (identityPresent()) return { identity: signingIdentity, keychain: keychainPath() };

  mkdirSync(signingDirectory(), { recursive: true, mode: 0o700 });
  const password = keychainPassword(true);
  const scratch = mkdtempSync(join(tmpdir(), 'graph-identity-'));
  const key = join(scratch, 'key.pem');
  const certificate = join(scratch, 'cert.pem');
  const bundle = join(scratch, 'identity.p12');
  try {
    const config = join(scratch, 'request.cnf');
    writeFileSync(config, requestConfig, { mode: 0o600 });
    run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '3650', '-config', config]);
    run('openssl', ['pkcs12', '-export', '-inkey', key, '-in', certificate, '-out', bundle, '-passout', `pass:${password}`, '-name', signingIdentity]);
    rmSync(keychainPath(), { force: true });
    run('security', ['create-keychain', '-p', password, keychainPath()]);
    run('security', ['set-keychain-settings', keychainPath()]);
    run('security', ['unlock-keychain', '-p', password, keychainPath()]);
    run('security', ['import', bundle, '-k', keychainPath(), '-P', password, '-T', '/usr/bin/codesign', '-A']);
    run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychainPath()]);
    chmodSync(keychainPath(), 0o600);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (!identityPresent()) throw new Error(`${signingIdentity} could not be imported into ${keychainPath()}`);
  return { identity: signingIdentity, keychain: keychainPath() };
}

export function signCode(target, options = {}) {
  const { identifier = codeIdentifier, deep = false } = options;
  const { keychain } = ensureSigningIdentity();
  run('security', ['unlock-keychain', '-p', keychainPassword(), keychain]);
  const args = ['--force', '--keychain', keychain, '--sign', signingIdentity];
  if (identifier) args.push('--identifier', identifier);
  if (deep) args.push('--deep');
  args.push(target);
  run('codesign', args);
}

export function designatedRequirement(target) {
  const result = spawnSync('codesign', ['-dr-', target], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (!output) throw new Error(`codesign printed no requirement for ${target}`);
  const lines = output.split('\n').map(line => line.trim());
  return lines.find(line => line.includes('=>')) ?? output;
}

export function signatureIsStable(target) {
  const requirement = designatedRequirement(target);
  return requirement.includes('certificate') && !requirement.includes('cdhash');
}

export function installBundleSigning(bundle, binary) {
  if (!existsSync(binary)) throw new Error(`${bundle} has no executable at ${binary}`);
  signCode(binary);
  signCode(bundle, { identifier: false });
  run('codesign', ['--verify', '--strict', '--deep', bundle]);
  return designatedRequirement(binary);
}
