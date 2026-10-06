import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

/** A supervisor's durable proof that its command has closed, independent of its result. */
export interface ProcessQuiescenceReceipt { path: string; nonce: string }

export function hasProcessQuiescence(receipt: ProcessQuiescenceReceipt): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(receipt.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024) return false;
    const value = JSON.parse(readFileSync(fd, 'utf8')) as { nonce?: unknown; quiescent?: unknown };
    return value.nonce === receipt.nonce && value.quiescent === true;
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}
