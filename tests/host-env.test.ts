import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { hostEnv, mergeMissingKeys, parseDotEnv, parseServiceEnv } from "../src/host-env.ts";
import { resolveOptions } from "../src/config.ts";

describe("host env", () => {
  test("parseServiceEnv keeps only Jev key names", () => {
    const env = parseServiceEnv(
      JSON.stringify({ password: "nope", env: { TYPESAFE_API_KEY: " ts ", OTHER: "x", OPENROUTER_API_KEY: "" } }),
    );
    expect(env).toEqual({ TYPESAFE_API_KEY: "ts" });
  });

  test("parseServiceEnv ignores bad JSON", () => {
    expect(parseServiceEnv("{")).toEqual({});
    expect(parseServiceEnv("[]")).toEqual({});
  });

  test("parseDotEnv ignores comments and other names", () => {
    expect(parseDotEnv("# c\nFOO=1\nTYPESAFE_API_KEY=\"abc\"\nOPENROUTER_API_KEY='sk'\n")).toEqual({
      TYPESAFE_API_KEY: "abc",
      OPENROUTER_API_KEY: "sk",
    });
  });

  test("process env wins over the files", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-host-"));
    writeFileSync(join(dir, "service.json"), JSON.stringify({ env: { TYPESAFE_API_KEY: "from-service" } }));
    writeFileSync(join(dir, ".env"), "TYPESAFE_API_KEY=from-dotenv\n");
    const env = hostEnv({ TYPESAFE_API_KEY: "from-process" }, dir);
    expect(env.TYPESAFE_API_KEY).toBe("from-process");
  });

  test("service.json fills a missing process key and beats .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-host-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "service.json"), JSON.stringify({ env: { TYPESAFE_API_KEY: "from-service" } }));
    writeFileSync(join(dir, ".env"), "TYPESAFE_API_KEY=from-dotenv\nOPENROUTER_API_KEY=from-dotenv-or\n");
    const env = hostEnv({}, dir);
    expect(env.TYPESAFE_API_KEY).toBe("from-service");
    expect(env.OPENROUTER_API_KEY).toBe("from-dotenv-or");
    expect(resolveOptions({}, env).apiKeySource).toBe("TYPESAFE_API_KEY");
  });

  test("missing files do not throw", () => {
    expect(hostEnv({}, join(tmpdir(), "jev-host-missing-dir"))).toEqual({});
  });

  test("mergeMissingKeys does not replace a set value", () => {
    expect(mergeMissingKeys({ TYPESAFE_API_KEY: "a" }, { TYPESAFE_API_KEY: "b" }).TYPESAFE_API_KEY).toBe("a");
  });
});
