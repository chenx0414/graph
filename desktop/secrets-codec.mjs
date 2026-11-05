import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * The cipher that protects the secrets file, kept on this disk instead of in the
 * login keychain.
 *
 * Measured 2026-11-05: the app's encrypted store was reached through the system
 * keychain, and macOS answered every touch with 「找不到用于储存 Graph Key 的钥匙串」-
 * a system dialog the reader cannot dismiss for good. The store only needs a
 * symmetric key that survives restarts, so the key lives beside the file with
 * mode 0600 and the values are sealed with AES-256-GCM.
 *
 * What this does and does not buy: the file alone is useless without the key file,
 * so a copied secrets.json (log, backup, a paste into a message) stays unreadable.
 * It does not defend against a process running as this user, which could read the
 * key beside it - the keychain did not defend against that either once granted.
 * The window, the API and the config still never see a value.
 */
export function fileSecretsCodec(keyPath) {
  const readKey = () => {
    if (!existsSync(keyPath)) return null;
    const key = readFileSync(keyPath);
    return key.length === 32 ? key : null;
  };
  const ensureKey = () => readKey() ?? (() => {
    const created = randomBytes(32);
    writeFileSync(keyPath, created, { mode: 0o600 });
    return created;
  })();
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const key = ensureKey();
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const sealed = Buffer.concat([cipher.update(Buffer.from(value, 'utf8')), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), sealed]);
    },
    decryptString(value) {
      const key = readKey();
      // No key file means this value was sealed by the keychain in an earlier
      // version; refusing keeps the app from ever opening the keychain again. The
      // entry stays in the file untouched and reads as an unconfigured provider.
      if (!key || value.length < 29) throw new Error('sealed by another key');
      const iv = value.subarray(0, 12);
      const tag = value.subarray(12, 28);
      const sealed = value.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(sealed), decipher.final()]).toString('utf8');
    },
  };
}

/** Where the key file sits, given the secrets file it belongs to. */
export function secretsKeyPath(secretsPath) {
  return `${secretsPath}.key`;
}
