import { describe, expect, test } from "bun:test";
import {
  createRestoreMemory,
  planRemember,
  planRestore,
  reconcileOnJevPrompt,
  restoreIfNeeded,
  restoreKey,
  sameModel,
  type ModelRef,
  type RestoreCtx,
  type StorageLike,
} from "../src/state/session-state.ts";

const A: ModelRef = { providerID: "anthropic", id: "sonnet" };
const B: ModelRef = { providerID: "openai", id: "mini" };
const C: ModelRef = { providerID: "google", id: "flash" };

function fakeStorage(seed: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(seed));
  const storage: StorageLike = {
    get: async (k) => (data.has(k) ? structuredClone(data.get(k)) : undefined),
    set: async (k, v) => void data.set(k, structuredClone(v)),
    remove: async (k) => void data.delete(k),
  };
  return { storage, data };
}

function fakeCtx(model: ModelRef | undefined, opts: { getFails?: boolean; switchFails?: boolean; wrap?: boolean } = {}) {
  const switches: Array<{ sessionID: string; model: ModelRef }> = [];
  const ctx: RestoreCtx = {
    session: {
      get: async () => {
        if (opts.getFails) throw new Error("get failed");
        const info = { id: "s", ...(model ? { model } : {}) };
        return opts.wrap ? { data: info } : info;
      },
      switchModel: async (input) => {
        if (opts.switchFails) throw new Error("switch failed");
        switches.push(input);
      },
    },
  };
  return { ctx, switches };
}

describe("restore memory (storage backed)", () => {
  test("remember / peek / clear under a namespaced key", async () => {
    const { storage, data } = fakeStorage();
    const mem = createRestoreMemory(storage);
    expect(await mem.peek("s1")).toBeUndefined();
    await mem.remember("s1", { previous: A, applied: { ...B, variant: "high" } });
    expect([...data.keys()]).toEqual(["restore/s1"]);
    expect(restoreKey("s1")).toBe("restore/s1");
    expect(await mem.peek("s1")).toEqual({ previous: A, applied: { ...B, variant: "high" } });
    expect(await mem.peek("s2")).toBeUndefined();
    await mem.clear("s1");
    expect(await mem.peek("s1")).toBeUndefined();
    expect(data.size).toBe(0);
  });

  test("survives a new memory instance on the same storage (restart)", async () => {
    const { storage } = fakeStorage();
    await createRestoreMemory(storage).remember("s", { previous: A, applied: B });
    expect(await createRestoreMemory(storage).peek("s")).toEqual({ previous: A, applied: B });
  });

  test("stored values are JSON-safe (no undefined variant key)", async () => {
    const { storage, data } = fakeStorage();
    await createRestoreMemory(storage).remember("s", { previous: A, applied: B });
    expect(JSON.parse(JSON.stringify(data.get("restore/s")))).toEqual(data.get("restore/s"));
    expect("variant" in (data.get("restore/s") as { previous: object }).previous).toBe(false);
  });

  test("corrupt entries read as no memory and are removed", async () => {
    const { storage, data } = fakeStorage({ "restore/s": { previous: "x" } });
    expect(await createRestoreMemory(storage).peek("s")).toBeUndefined();
    expect(data.has("restore/s")).toBe(false);
  });

  test("storage failures are swallowed and logged", async () => {
    const warns: string[] = [];
    const boom: StorageLike = {
      get: async () => {
        throw new Error("io");
      },
      set: async () => {
        throw new Error("io");
      },
      remove: async () => {
        throw new Error("io");
      },
    };
    const mem = createRestoreMemory(boom, { warn: (m) => warns.push(m) });
    await mem.remember("s", { previous: A, applied: B });
    expect(await mem.peek("s")).toBeUndefined();
    await mem.clear("s");
    expect(warns).toHaveLength(3);
  });
});

describe("planRestore (pure)", () => {
  const entry = { previous: A, applied: B };
  test("restore when current equals applied", () => {
    expect(planRestore(entry, { ...B })).toEqual({ action: "restore", model: A });
  });
  test("clear (no switch) when the user changed the model", () => {
    expect(planRestore(entry, C)).toEqual({ action: "clear" });
    expect(planRestore(entry, A)).toEqual({ action: "clear" });
    expect(planRestore(entry, undefined)).toEqual({ action: "clear" });
  });
  test("a different variant counts as a manual change", () => {
    expect(planRestore(entry, { ...B, variant: "high" })).toEqual({ action: "clear" });
  });
  test("none without memory", () => {
    expect(planRestore(undefined, B)).toEqual({ action: "none" });
  });
  test("sameModel", () => {
    expect(sameModel(A, { ...A })).toBe(true);
    expect(sameModel(A, B)).toBe(false);
    expect(sameModel(A, undefined)).toBe(false);
  });
});

describe("planRemember (pure)", () => {
  test("first routing: previous = current", () => {
    expect(planRemember(undefined, A, B)).toEqual({ previous: A, applied: B });
  });
  test("chained routed turns keep the original previous", () => {
    expect(planRemember({ previous: A, applied: B }, B, C)).toEqual({ previous: A, applied: C });
  });
  test("after a manual change the current model becomes previous", () => {
    expect(planRemember({ previous: A, applied: B }, C, B)).toEqual({ previous: C, applied: B });
  });
});

describe("restoreIfNeeded (non-jev prompt)", () => {
  test("no memory: no-op and the session is not even read", async () => {
    const { storage } = fakeStorage();
    let reads = 0;
    const { ctx, switches } = fakeCtx(B);
    const spy: RestoreCtx = { session: { ...ctx.session, get: async (i) => (reads++, ctx.session.get(i)) } };
    expect(await restoreIfNeeded(spy, createRestoreMemory(storage), "s")).toBe("none");
    expect(reads).toBe(0);
    expect(switches).toEqual([]);
  });

  test("restores previous when the session model still equals applied, then clears", async () => {
    const { storage } = fakeStorage();
    const mem = createRestoreMemory(storage);
    await mem.remember("s", { previous: A, applied: B });
    const { ctx, switches } = fakeCtx(B);
    expect(await restoreIfNeeded(ctx, mem, "s")).toBe("restored");
    expect(switches).toEqual([{ sessionID: "s", model: A }]);
    expect(await mem.peek("s")).toBeUndefined();
  });

  test("does not switch (but clears) when the user changed the model manually", async () => {
    const { storage } = fakeStorage();
    const mem = createRestoreMemory(storage);
    await mem.remember("s", { previous: A, applied: B });
    const { ctx, switches } = fakeCtx(C);
    expect(await restoreIfNeeded(ctx, mem, "s")).toBe("cleared");
    expect(switches).toEqual([]);
    expect(await mem.peek("s")).toBeUndefined();
  });

  test("works with a { data } session wrapper", async () => {
    const { storage } = fakeStorage();
    const mem = createRestoreMemory(storage);
    await mem.remember("s", { previous: A, applied: B });
    const { ctx, switches } = fakeCtx(B, { wrap: true });
    expect(await restoreIfNeeded(ctx, mem, "s")).toBe("restored");
    expect(switches).toHaveLength(1);
  });

  test("memory is per session", async () => {
    const { storage } = fakeStorage();
    const mem = createRestoreMemory(storage);
    await mem.remember("s1", { previous: A, applied: B });
    const { ctx, switches } = fakeCtx(B);
    expect(await restoreIfNeeded(ctx, mem, "s2")).toBe("none");
    expect(switches).toEqual([]);
    expect(await mem.peek("s1")).toBeDefined();
  });

  test("switch failure is reported as failed, never thrown, and clears (no retry loop)", async () => {
    const { storage } = fakeStorage();
    const mem = createRestoreMemory(storage);
    await mem.remember("s", { previous: A, applied: B });
    const { ctx } = fakeCtx(B, { switchFails: true });
    expect(await restoreIfNeeded(ctx, mem, "s")).toBe("failed");
    expect(await mem.peek("s")).toBeUndefined();
  });

  test("unreadable session keeps the memory for the next prompt", async () => {
    const { storage } = fakeStorage();
    const mem = createRestoreMemory(storage);
    await mem.remember("s", { previous: A, applied: B });
    const { ctx, switches } = fakeCtx(B, { getFails: true });
    expect(await restoreIfNeeded(ctx, mem, "s")).toBe("unverified");
    expect(switches).toEqual([]);
    expect(await mem.peek("s")).toBeDefined();
  });

  test("never throws even if the memory itself throws", async () => {
    const mem = {
      peek: async () => {
        throw new Error("boom");
      },
      remember: async () => {},
      clear: async () => {},
    };
    expect(await restoreIfNeeded(fakeCtx(B).ctx, mem, "s")).toBe("failed");
  });
});

describe("reconcileOnJevPrompt (session returns to jevCode)", () => {
  test("clears stale memory when the user changed the model meanwhile", async () => {
    const { storage } = fakeStorage();
    const mem = createRestoreMemory(storage);
    await mem.remember("s", { previous: A, applied: B });
    expect(await reconcileOnJevPrompt(fakeCtx(C).ctx, mem, "s")).toBe("cleared");
    expect(await mem.peek("s")).toBeUndefined();
  });

  test("keeps memory (original previous) when the session is still on the applied model", async () => {
    const { storage } = fakeStorage();
    const mem = createRestoreMemory(storage);
    await mem.remember("s", { previous: A, applied: B });
    const { ctx, switches } = fakeCtx(B);
    expect(await reconcileOnJevPrompt(ctx, mem, "s")).toBe("kept");
    expect(switches).toEqual([]);
    expect(await mem.peek("s")).toEqual({ previous: A, applied: B });
  });

  test("no memory, unreadable session", async () => {
    const { storage } = fakeStorage();
    const mem = createRestoreMemory(storage);
    expect(await reconcileOnJevPrompt(fakeCtx(B).ctx, mem, "s")).toBe("none");
    await mem.remember("s", { previous: A, applied: B });
    expect(await reconcileOnJevPrompt(fakeCtx(B, { getFails: true }).ctx, mem, "s")).toBe("unverified");
    expect(await mem.peek("s")).toBeDefined();
  });
});
