import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { init } from "../src/commands/init.js";

class StringSink {
  data = "";
  write(chunk: string | Uint8Array): boolean {
    this.data +=
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }
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

function sink() {
  return new StringSink();
}

describe("init", () => {
  it("scaffolds a full project with defaults into an empty directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-cli-init-"));
    const s = sink();
    const target = init({
      projectName: "scaffold-test",
      cwd: dir,
      stdout: s as unknown as NodeJS.WritableStream,
    });

    expect(existsSync(target)).toBe(true);
    for (const f of [
      "wrangler.toml",
      "package.json",
      "tsconfig.json",
      ".gitignore",
      ".dev.vars",
      "README.md",
      "src/worker.ts",
      "src/agent.ts",
    ]) {
      expect(existsSync(join(target, f))).toBe(true);
    }

    // Next-step banner is shown.
    expect(s.data).toContain("Next steps:");
    expect(s.data).toContain("meridian gen-token --dev-vars");
  });

  it("substitutes projectName / agentId / domain into every template", () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-cli-init-"));
    const target = init({
      projectName: "vars-project",
      agentId: "watcher",
      domain: "observability",
      cwd: dir,
      stdout: sink() as unknown as NodeJS.WritableStream,
    });

    const wrangler = readFileSync(join(target, "wrangler.toml"), "utf8");
    expect(wrangler).toContain('name = "vars-project"');

    const worker = readFileSync(join(target, "src/worker.ts"), "utf8");
    expect(worker).toContain('id: "watcher"');
    expect(worker).toContain('domain: "observability"');
    expect(worker).toContain('name: "vars-project"');

    const agent = readFileSync(join(target, "src/agent.ts"), "utf8");
    expect(agent).toContain('id: "watcher"');
    expect(agent).toContain('domain: "observability"');

    const readme = readFileSync(join(target, "README.md"), "utf8");
    expect(readme).toContain("# vars-project");
    expect(readme).toContain("meridian inspect watcher");
  });

  it("refuses to overwrite a non-empty target without --force", () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-cli-init-"));
    const target = join(dir, "occupied");
    // Seed the target with a file.
    writeFileSync(join(dir, "occupied-marker"), "");
    // Actually create the dir and put a file in it.
    init({
      projectName: "occupied",
      cwd: dir,
      stdout: sink() as unknown as NodeJS.WritableStream,
    });
    expect(existsSync(target)).toBe(true);

    // Second init without --force should refuse.
    expect(() =>
      init({
        projectName: "occupied",
        cwd: dir,
        stdout: sink() as unknown as NodeJS.WritableStream,
      }),
    ).toThrowError(/not empty/);
  });

  it("overwrites with --force", () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-cli-init-"));
    init({
      projectName: "over",
      cwd: dir,
      stdout: sink() as unknown as NodeJS.WritableStream,
    });
    // Shouldn't throw.
    const target = init({
      projectName: "over",
      agentId: "new-id",
      cwd: dir,
      force: true,
      stdout: sink() as unknown as NodeJS.WritableStream,
    });
    const agent = readFileSync(join(target, "src/agent.ts"), "utf8");
    expect(agent).toContain("new-id");
  });

  it(".gitignore excludes .dev.vars (secret safety)", () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-cli-init-"));
    const target = init({
      projectName: "secret-safety",
      cwd: dir,
      stdout: sink() as unknown as NodeJS.WritableStream,
    });
    const gi = readFileSync(join(target, ".gitignore"), "utf8");
    expect(gi).toMatch(/^\.dev\.vars$/m);
  });
});
