import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("media process ownership", () => {
  it("keeps every child-process spawn behind the managed supervisor", () => {
    const srcRoot = join(process.cwd(), "src");
    // Do not confuse RegExp/String.prototype.exec with a child-process API.
    // The negative lookbehind still catches bare `exec(` and `execFile(` while
    // allowing ordinary parsing helpers such as `pattern.exec(value)`.
    const forbidden = /(?<![.\w])\b(?:spawn|execFile|exec|fork|createChildProcess)\s*\(/;
    const violations = sourceFiles(srcRoot)
      .filter((file) => !file.endsWith("src/runtime/managed-process.ts"))
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return forbidden.test(source) ? [file.replace(`${srcRoot}/`, "")] : [];
      });

    expect(violations).toEqual([]);
  });
});
