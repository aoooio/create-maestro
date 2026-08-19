import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Echo of `server/internal/domain/session/architecture_test.go`: the domain
 * knows nothing of React, of Next, of the DOM or of the wire format. Breaking
 * that is what turns a testable timing model into something you can only
 * exercise in a browser.
 */
const FORBIDDEN = [
  /from\s+["']react["']/,
  /from\s+["']react-dom/,
  /from\s+["']next\//,
  /from\s+["']three["']/,
  /from\s+["']zustand/,
  /from\s+["']zod["']/,
  /\bwindow\./,
  /\bdocument\./,
  /\bperformance\.now\b/,
  /\bAudioContext\b/,
  /from\s+["']\.\.\//, // nothing outside src/domain
];

const domainDir = dirname(fileURLToPath(import.meta.url));

function sourceFiles(): string[] {
  return readdirSync(domainDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => join(domainDir, name));
}

describe("domain isolation", () => {
  it("finds the domain sources", () => {
    expect(sourceFiles().length).toBeGreaterThan(3);
  });

  it.each(sourceFiles())("%s depends on nothing but itself", (file) => {
    const source = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN) {
      expect(source, `${file} must not match ${pattern}`).not.toMatch(pattern);
    }
  });
});
