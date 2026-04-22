import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveConfig } from "../src/util/config.js";

function fresh() {
  return mkdtempSync(join(tmpdir(), "meridian-cli-cfg-"));
}

describe("resolveConfig", () => {
  it("prefers flags over env over .dev.vars", () => {
    const dir = fresh();
    writeFileSync(
      join(dir, ".dev.vars"),
      `MERIDIAN_ENDPOINT="https://file"\nMERIDIAN_ADMIN_TOKEN="from-file"\n`,
    );
    const config = resolveConfig({
      flags: {
        endpoint: "https://flag",
        token: "from-flag",
      },
      env: {
        MERIDIAN_ENDPOINT: "https://env",
        MERIDIAN_ADMIN_TOKEN: "from-env",
      },
      cwd: dir,
    });
    expect(config.endpoint).toBe("https://flag");
    expect(config.token).toBe("from-flag");
  });

  it("falls back to env when flags omit the value", () => {
    const dir = fresh();
    writeFileSync(
      join(dir, ".dev.vars"),
      `MERIDIAN_ENDPOINT="https://file"\nMERIDIAN_ADMIN_TOKEN="from-file"\n`,
    );
    const config = resolveConfig({
      flags: {},
      env: {
        MERIDIAN_ENDPOINT: "https://env",
        MERIDIAN_ADMIN_TOKEN: "from-env",
      },
      cwd: dir,
    });
    expect(config.endpoint).toBe("https://env");
    expect(config.token).toBe("from-env");
  });

  it("falls back to .dev.vars when neither flags nor env set values", () => {
    const dir = fresh();
    writeFileSync(
      join(dir, ".dev.vars"),
      `MERIDIAN_ENDPOINT="https://file"\nMERIDIAN_ADMIN_TOKEN="from-file"\n`,
    );
    const config = resolveConfig({
      flags: {},
      env: {},
      cwd: dir,
    });
    expect(config.endpoint).toBe("https://file");
    expect(config.token).toBe("from-file");
  });

  it("returns undefined for both when nothing is set", () => {
    const dir = fresh();
    const config = resolveConfig({
      flags: {},
      env: {},
      cwd: dir,
    });
    expect(config.endpoint).toBeUndefined();
    expect(config.token).toBeUndefined();
  });

  it("parses .dev.vars entries wrapped in single + double quotes", () => {
    const dir = fresh();
    writeFileSync(
      join(dir, ".dev.vars"),
      `MERIDIAN_ENDPOINT='https://single'\nMERIDIAN_ADMIN_TOKEN="double"\n`,
    );
    const config = resolveConfig({ flags: {}, env: {}, cwd: dir });
    expect(config.endpoint).toBe("https://single");
    expect(config.token).toBe("double");
  });

  it("ignores blank lines and # comments in .dev.vars", () => {
    const dir = fresh();
    writeFileSync(
      join(dir, ".dev.vars"),
      `\n# a comment\nMERIDIAN_ADMIN_TOKEN="ok"\n\n# another\n`,
    );
    const config = resolveConfig({ flags: {}, env: {}, cwd: dir });
    expect(config.token).toBe("ok");
  });
});
