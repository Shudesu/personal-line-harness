import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
const runtimeState = vi.hoisted(() => ({
  boots: 0,
  steps: 0,
  phase: "connected",
  fail: false,
  pause: null as null | (() => Promise<void>),
}));
vi.mock("../../../packages/openchat-connector/managed/server.mjs", () => ({
  ManagedRuntime: class {
    metrics = {};
    generation = 0;
    client = { disabled: false };
    authTask = Promise.resolve();
    phase = "auth_required";
    constructor(private opts: any) {
      runtimeState.boots++;
    }
    async bootstrap() {
      this.phase = runtimeState.phase;
    }
    async startLogin() {
      this.phase = runtimeState.phase;
    }
    status() {
      return { phase: this.phase, metrics: this.metrics };
    }
    async step() {
      runtimeState.steps++;
      if (runtimeState.pause) await runtimeState.pause();
      if (runtimeState.fail) throw Error("secret must not leak");
      return this.status();
    }
    async stop() {}
  },
}));
import { ManagedOpenChat } from "./alarm-session";
import { type Env } from "./index";
import { StateCipher } from "./security";
const master = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const scope = "worker-pilot/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
function fixture() {
  runtimeState.boots = 0;
  runtimeState.steps = 0;
  runtimeState.fail = false;
  runtimeState.phase = "connected";
  runtimeState.pause = null;
  const records = new Map<string, any>();
  let alarm: number | null = null;
  const storage = {
    async get(k: string) {
      return records.get(k);
    },
    async put(k: any, v?: any) {
      if (typeof k === "string") records.set(k, v);
      else for (const [key, val] of Object.entries(k)) records.set(key, val);
    },
    async delete(k: string) {
      records.delete(k);
    },
    async deleteAll() {
      records.clear();
    },
    async setAlarm(n: number) {
      alarm = n;
    },
    async deleteAlarm() {
      alarm = null;
    },
  };
  const env = {
    STATE_KEY_B64: master,
    SELF_HOSTED_TENANTS: JSON.stringify({
      "worker-pilot": {
        secretHash: createHash("sha256").update("s".repeat(40)).digest("hex"),
        origin: "https://pilot.example",
      },
    }),
  } as Env;
  let instance = new ManagedOpenChat({ storage } as any, env);
  const request = (path: string, body?: unknown, scopeOverride = scope) =>
    instance.fetch(
      new Request("https://session" + path, {
        method: "POST",
        headers: {
          "X-Session-Scope": scopeOverride,
          "X-Tenant-Origin": "https://pilot.example",
          "X-Tenant-Secret": "s".repeat(40),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  const seed = async (k: string, v: any) =>
    records.set(
      "encrypted:" + k,
      await new StateCipher(master, scope).seal(k, v),
    );
  return {
    records,
    env,
    seed,
    request,
    run: () => instance.alarm(),
    reset: () => {
      instance = new ManagedOpenChat({ storage } as any, env);
    },
    get alarm() {
      return alarm;
    },
  };
}
describe("worker-only session lifecycle", () => {
  it("starts without a container, performs no LINE login or polling until requested", async () => {
    const x = fixture();
    expect(
      (await x.request("/create", { connectorToken: "oc_" + "a".repeat(64) }))
        .status,
    ).toBe(200);
    for (let i = 0; i < 5; i++) await x.request("/status");
    expect(x.alarm).toBeNull();
    expect(runtimeState.boots).toBe(0);
    expect(JSON.stringify([...x.records])).not.toContain(
      "oc_" + "a".repeat(64),
    );
  });
  it("one alarm is one bounded sync, survives object eviction and stops on reauthentication", async () => {
    const x = fixture();
    await x.request("/create", { connectorToken: "oc_" + "a".repeat(64) });
    await x.seed("session", { authToken: "secret-token" });
    await x.run();
    expect(runtimeState.steps).toBe(1);
    expect(x.alarm).toBeGreaterThan(Date.now());
    x.reset();
    await x.run();
    expect(runtimeState.steps).toBe(2);
    expect(runtimeState.boots).toBe(2);
    runtimeState.phase = "auth_required";
    await x.run();
    expect(x.alarm).toBeNull();
    expect(JSON.stringify([...x.records])).not.toContain("secret-token");
  });
  it("status remains responsive during a running alarm and never starts another sync", async () => {
    const x = fixture();
    await x.request("/create", { connectorToken: "oc_" + "a".repeat(64) });
    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    runtimeState.pause = () => pending;
    const run = x.run();
    await vi.waitFor(() => expect(runtimeState.steps).toBe(1));
    expect((await x.request("/status")).status).toBe(200);
    expect(runtimeState.steps).toBe(1);
    release();
    await run;
  });
  it("disconnect during a running sync cannot resurrect the alarm or credentials", async () => {
    const x = fixture();
    await x.request("/create", { connectorToken: "oc_" + "a".repeat(64) });
    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    runtimeState.pause = () => pending;
    const run = x.run();
    await vi.waitFor(() => expect(runtimeState.steps).toBe(1));
    const close = x.request("/close");
    await vi.waitFor(() => expect(x.records.get("enabled")).toBe(false));
    release();
    await run;
    await close;
    expect(x.alarm).toBeNull();
    expect([...x.records.keys()].sort()).toEqual(["closed", "scope"]);
    x.reset();
    await x.run();
    expect(x.alarm).toBeNull();
    expect(
      (await x.request("/create", { connectorToken: "oc_" + "a".repeat(64) }))
        .status,
    ).toBe(410);
  });
  it("backoffs on failure without leaking exception text and stops when tenant grant is revoked", async () => {
    const x = fixture();
    await x.request("/create", { connectorToken: "oc_" + "a".repeat(64) });
    runtimeState.fail = true;
    await x.run();
    const result = (await (await x.request("/status")).json()) as any;
    expect(result.phase).toBe("connection_error");
    expect(JSON.stringify(result)).not.toContain("secret must not leak");
    expect(x.alarm! - Date.now()).toBeGreaterThan(290000);
    x.env.SELF_HOSTED_TENANTS = "{}";
    await x.run();
    expect(x.alarm).toBeNull();
    expect(runtimeState.steps).toBe(1);
  });
  it("rejects cross-tenant scope reuse and changed connector credentials", async () => {
    const x = fixture();
    await x.request("/create", { connectorToken: "oc_" + "a".repeat(64) });
    expect(
      (await x.request("/create", { connectorToken: "oc_" + "b".repeat(64) }))
        .status,
    ).toBe(409);
    expect(
      (
        await x.request(
          "/status",
          undefined,
          scope.replace("worker-pilot", "other"),
        )
      ).status,
    ).toBe(503);
  });
});
