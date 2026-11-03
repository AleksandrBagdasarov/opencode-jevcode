/**
 * Integration check against the REAL `opencode` binary (ticket 0002, AC 1).
 * Skipped unless OPENCODE_INTEGRATION=1:
 *
 *   $env:OPENCODE_INTEGRATION=1; bun test tests/integration/agent.int.test.ts
 *
 * Loads this repository as a local plugin (the `plugins` array points at the repo root, which OpenCode
 * resolves through package.json `exports`), then queries `opencode --standalone api get /api/agent`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const enabled = process.env.OPENCODE_INTEGRATION === "1";
const repoRoot = resolve(import.meta.dir, "..", "..");

interface Agent {
  id: string;
  mode: string;
  system?: string;
  description?: string;
  permissions: unknown[];
  [k: string]: unknown;
}

async function listAgents(cwd: string): Promise<{ agents: Agent[]; stderr: string }> {
  const bin = Bun.which("opencode");
  if (!bin) throw new Error("opencode binary not found on PATH");
  const proc = Bun.spawn([bin, "--standalone", "api", "get", "/api/agent"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`opencode exited with ${code}: ${stderr}`);
  const parsed = JSON.parse(stdout) as { data?: Agent[] } | Agent[];
  const agents = Array.isArray(parsed) ? parsed : parsed.data;
  if (!Array.isArray(agents)) throw new Error(`unexpected /api/agent response: ${stdout.slice(0, 200)}`);
  return { agents, stderr };
}

describe.skipIf(!enabled)("jevCode agent in the real opencode binary", () => {
  let base: string;
  let withPlugin: { agents: Agent[]; stderr: string };
  let without: { agents: Agent[]; stderr: string };

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "jev-int-"));
    const on = join(base, "with-plugin");
    const off = join(base, "without-plugin");
    mkdirSync(on);
    mkdirSync(off);
    writeFileSync(join(on, "opencode.jsonc"), JSON.stringify({ plugins: [repoRoot.replaceAll("\\", "/")] }));
    writeFileSync(join(off, "opencode.jsonc"), JSON.stringify({}));
    [withPlugin, without] = await Promise.all([listAgents(on), listAgents(off)]);
  }, 120_000);

  afterAll(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test("jevCode is listed with mode primary, a description and a non-empty system prompt", () => {
    const jev = withPlugin.agents.find((a) => a.id === "jevCode");
    expect(jev).toBeDefined();
    expect(jev!.mode).toBe("primary");
    expect(jev!.description).toBeTruthy();
    expect((jev!.system ?? "").length).toBeGreaterThan(0);
    expect(jev!.system).toContain("jevCode");
  });

  // Best effort only: OpenCode 2.2.5 does not forward plugin console output under `api get`, so this
  // cannot fail today; the listing assertions above are the real evidence that the canary would pass.
  test("no registration error on stderr (best effort)", () => {
    expect(withPlugin.stderr).not.toContain("NOT in the agent list");
    expect(withPlugin.stderr).not.toContain("[jevcode] error");
  });

  test("jevCode permissions deep-equal build's", () => {
    const jev = withPlugin.agents.find((a) => a.id === "jevCode")!;
    const build = withPlugin.agents.find((a) => a.id === "build")!;
    expect(jev.permissions).toEqual(build.permissions);
  });

  test("isolation sanity: every agent except jevCode is identical with and without the plugin", () => {
    expect(without.agents.find((a) => a.id === "jevCode")).toBeUndefined();
    for (const id of ["build", "plan"]) {
      const a = withPlugin.agents.find((x) => x.id === id);
      const b = without.agents.find((x) => x.id === id);
      expect(a).toBeDefined();
      expect(a).toEqual(b!);
    }
    const others = (list: Agent[]) => list.filter((a) => a.id !== "jevCode").map((a) => a.id).sort();
    expect(others(withPlugin.agents)).toEqual(others(without.agents));
    const sameJson = (id: string) =>
      JSON.stringify(withPlugin.agents.find((a) => a.id === id)) === JSON.stringify(without.agents.find((a) => a.id === id));
    expect(withPlugin.agents.filter((a) => a.id !== "jevCode").every((a) => sameJson(a.id))).toBe(true);
  });
});
