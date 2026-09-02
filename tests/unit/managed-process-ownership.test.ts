import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

async function sourceFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await sourceFiles(path));
    else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) output.push(path);
  }
  return output;
}

describe('media subprocess ownership', () => {
  it('keeps every child-process spawn behind the managed supervisor', async () => {
    const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const srcRoot = join(serviceRoot, 'src');
    const violations: string[] = [];
    for (const path of await sourceFiles(srcRoot)) {
      if (relative(srcRoot, path) === 'runtime/managed-process.ts') continue;
      const source = await readFile(path, 'utf8');
      if (/from\s+["'](?:node:)?child_process["']|require\(["'](?:node:)?child_process["']\)/.test(source)) {
        violations.push(relative(serviceRoot, path));
      }
    }
    expect(violations, 'direct child_process imports bypass resource leases, cancellation, and process-group cleanup').toEqual([]);
  });
});
