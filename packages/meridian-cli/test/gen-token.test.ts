import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { genToken } from "../src/commands/gen-token.js";

class StringSink {
  data = "";
  write(chunk: string | Uint8Array): boolean {
    this.data +=
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }
  // Minimal WritableStream shape so gen-token can use it. The real
  // Node stream has more methods but gen-token only calls `write()`.
  on(): this {
    return this;
  }
  once(): this {
    return this;
  }
  emit(): boolean {
    return true;
  }
  end(): void {}
}

function sink(): NodeJS.WritableStream {
  return new StringSink() as unknown as NodeJS.WritableStream;
}

describe("genToken", () => {
  it("prints an export line by default", () => {
    const s = new StringSink();
    const token = genToken({ stdout: s as unknown as NodeJS.WritableStream });
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(s.data).toContain(`export MERIDIAN_ADMIN_TOKEN="${token}"`);
  });

  it("prints a wrangler secret put command with --wrangler", () => {
    const s = new StringSink();
    const token = genToken({
      wrangler: true,
      stdout: s as unknown as NodeJS.WritableStream,
    });
    expect(s.data).toContain(
      `echo "${token}" | wrangler secret put MERIDIAN_ADMIN_TOKEN`,
    );
  });

  it("writes a fresh .dev.vars with the token when file is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-cli-gentok-"));
    const token = genToken({
      devVars: true,
      cwd: dir,
      stdout: sink(),
    });
    const contents = readFileSync(join(dir, ".dev.vars"), "utf8");
    expect(contents).toBe(`MERIDIAN_ADMIN_TOKEN="${token}"\n`);
  });

  it("replaces an existing MERIDIAN_ADMIN_TOKEN line in .dev.vars", () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-cli-gentok-"));
    writeFileSync(
      join(dir, ".dev.vars"),
      `FOO=bar\nMERIDIAN_ADMIN_TOKEN="old-value"\nBAZ=qux\n`,
    );
    const token = genToken({
      devVars: true,
      cwd: dir,
      stdout: sink(),
    });
    const contents = readFileSync(join(dir, ".dev.vars"), "utf8");
    expect(contents).toContain(`MERIDIAN_ADMIN_TOKEN="${token}"`);
    expect(contents).toContain("FOO=bar");
    expect(contents).toContain("BAZ=qux");
    expect(contents).not.toContain("old-value");
  });

  it("appends MERIDIAN_ADMIN_TOKEN when .dev.vars exists without it", () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-cli-gentok-"));
    writeFileSync(join(dir, ".dev.vars"), `FOO=bar\n`);
    const token = genToken({
      devVars: true,
      cwd: dir,
      stdout: sink(),
    });
    const contents = readFileSync(join(dir, ".dev.vars"), "utf8");
    expect(contents).toMatch(/FOO=bar\n/);
    expect(contents).toMatch(new RegExp(`MERIDIAN_ADMIN_TOKEN="${token}"\\n`));
  });

  it("produces distinct tokens on sequential calls", () => {
    const a = genToken({ stdout: sink() });
    const b = genToken({ stdout: sink() });
    expect(a).not.toBe(b);
  });
});
