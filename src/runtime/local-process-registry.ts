import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** Retain exact ownership of detached helpers if their npm/worker exits. */
export function registerLocalProcess(pid: number, start: string): (() => void) | undefined {
  const directory = process.env.WAHB_PROCESS_REGISTRY_DIR;
  const runtime = process.env.WAHB_RUNTIME_ID;
  const token = process.env.WAHB_PROCESS_OWNER_TOKEN;
  if (process.env.WAHB_MANAGED_ENV !== '1' || !directory || !runtime || !token) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${pid}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(descriptor, JSON.stringify({ runtime_id: runtime, owner_token: token, pid, process_start: start }));
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  renameSync(temporary, path);
  const parent = openSync(directory, 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
  return () => { try { unlinkSync(path); } catch { /* already reclaimed */ } };
}
