import { describe, expect, test } from "bun:test";
import { isJevAgent, resolveSessionAgent, unwrapSession } from "../src/agent/isolation.ts";

const ctxWith = (get: () => Promise<unknown>) => ({ session: { get: async (_: { sessionID: string }) => get() } });

describe("isJevAgent", () => {
  test("true only for the exact id jevCode", () => {
    expect(isJevAgent("jevCode")).toBe(true);
    for (const other of ["build", "plan", "jevcode", "JevCode", "jevCode ", " jevCode", "jevCode2", "xjevCode", "", undefined, null, 0, {}, ["jevCode"]]) {
      expect(isJevAgent(other)).toBe(false);
    }
  });
});

describe("resolveSessionAgent", () => {
  test("returns the session agent as is", async () => {
    expect(await resolveSessionAgent(ctxWith(async () => ({ id: "s", agent: "jevCode" })), "s", { makeDefault: false })).toBe("jevCode");
    expect(await resolveSessionAgent(ctxWith(async () => ({ id: "s", agent: "build" })), "s", { makeDefault: true })).toBe("build");
  });

  test("passes the session id to session.get", async () => {
    let seen: unknown;
    const ctx = { session: { get: async (i: { sessionID: string }) => ((seen = i), { id: "x", agent: "plan" }) } };
    await resolveSessionAgent(ctx, "ses_1", { makeDefault: false });
    expect(seen).toEqual({ sessionID: "ses_1" });
  });

  test("unset agent: jevCode only when makeDefault", async () => {
    const unset = ctxWith(async () => ({ id: "s", projectID: "p" }));
    expect(await resolveSessionAgent(unset, "s", { makeDefault: true })).toBe("jevCode");
    expect(await resolveSessionAgent(unset, "s", { makeDefault: false })).toBeUndefined();
  });

  test("tolerates a { data } wrapper", async () => {
    expect(await resolveSessionAgent(ctxWith(async () => ({ data: { id: "s", agent: "jevCode" } })), "s", { makeDefault: false })).toBe("jevCode");
    expect(await resolveSessionAgent(ctxWith(async () => ({ data: { id: "s" } })), "s", { makeDefault: true })).toBe("jevCode");
  });

  test("errors and garbage resolve to undefined (never throw), even with makeDefault", async () => {
    const boom = ctxWith(async () => {
      throw new Error("session not found");
    });
    expect(await resolveSessionAgent(boom, "s", { makeDefault: true })).toBeUndefined();
    const sync = { session: { get: () => { throw new Error("sync"); } } } as never;
    expect(await resolveSessionAgent(sync, "s", { makeDefault: true })).toBeUndefined();
    expect(await resolveSessionAgent(ctxWith(async () => undefined), "s", { makeDefault: false })).toBeUndefined();
    expect(await resolveSessionAgent(ctxWith(async () => "oops"), "s", { makeDefault: false })).toBeUndefined();
    expect(await resolveSessionAgent(ctxWith(async () => ({ id: "s", agent: 5 })), "s", { makeDefault: false })).toBeUndefined();
  });
});

describe("unwrapSession", () => {
  test("reads model through both shapes", () => {
    const model = { providerID: "p", id: "m" };
    expect(unwrapSession({ id: "s", model })?.model).toEqual(model);
    expect(unwrapSession({ data: { id: "s", model } })?.model).toEqual(model);
    expect(unwrapSession(null)).toBeUndefined();
  });
});
