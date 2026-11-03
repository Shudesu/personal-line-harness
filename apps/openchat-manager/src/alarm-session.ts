import { DurableObject } from "cloudflare:workers";
import fs from "node:fs";
// The pinned Worker bundle uses native fetch, never Node socket pools.
// @ts-expect-error JS runtime has its own Node and workerd integration tests.
import { BaseClient } from "../../../packages/openchat-connector/vendor/linejs-worker.cjs";
// @ts-expect-error Shared runtime is tested independently of this adapter.
import { ManagedRuntime } from "../../../packages/openchat-connector/managed/server.mjs";
import { authorize, type Env } from "./index";
import { StateCipher, sha, type EncryptedValue } from "./security";

type Config = {
  tenantId: string;
  connectorId: string;
  tenantSecret: string;
  harnessUrl: string;
  connectorToken: string;
};
const json = (v: unknown, status = 200) =>
  Response.json(v, { status, headers: { "Cache-Control": "no-store" } });
const terminal = new Set([
  "auth_required",
  "expired",
  "identity_mismatch",
  "connection_revoked",
  "stopped",
]);
const PERIOD = 60000; // Explicit pilot budget: at most one normal sync per minute, no idle loop.
async function body(r: Request, max = 65536): Promise<any> {
  if (Number(r.headers.get("content-length") || 0) > max)
    throw Error("BODY_TOO_LARGE");
  const raw = await r.text();
  if (new TextEncoder().encode(raw).length > max) throw Error("BODY_TOO_LARGE");
  return JSON.parse(raw || "{}");
}

export class ManagedOpenChat extends DurableObject<Env> {
  private scope = "";
  private cipher: StateCipher | null = null;
  private runtime: any;
  private dir = "";
  private budgetTimer: ReturnType<typeof setTimeout> | null = null;
  private cancel = new AbortController();
  private sequence: Promise<unknown> = Promise.resolve();
  private statusWrites: Promise<unknown> = Promise.resolve();
  constructor(
    private state: DurableObjectState,
    private configEnv: Env,
  ) {
    super(state, configEnv);
  }
  private vault(scope: string) {
    if (
      !/^[a-z0-9][a-z0-9_-]{0,63}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        scope,
      ) ||
      (this.scope && this.scope !== scope)
    )
      throw Error("INVALID_SCOPE");
    this.scope = scope;
    return (this.cipher ??= new StateCipher(
      this.configEnv.STATE_KEY_B64,
      scope,
    ));
  }
  private async get<T = any>(key: string): Promise<T | null> {
    const v = await this.state.storage.get<EncryptedValue>("encrypted:" + key);
    return v ? this.vault(this.scope).open<T>(key, v) : null;
  }
  private async put(key: string, value: unknown) {
    if (await this.state.storage.get("closed")) throw Error("SESSION_CLOSED");
    await this.state.storage.put(
      "encrypted:" + key,
      await this.vault(this.scope).seal(key, value),
    );
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.sequence.catch(() => {}).then(fn);
    this.sequence = next;
    return next;
  }
  private async status() {
    const value = (await this.get("status")) || {
      phase: "auth_required",
      loginMethod: "ipad",
      personalTalks: true,
    };
    if (
      value.expiresAt &&
      Date.now() > value.expiresAt &&
      ["awaiting_qr", "awaiting_pin"].includes(value.phase)
    ) {
      value.phase = "expired";
      delete value.qrImage;
      delete value.pin;
    }
    return {
      ...value,
      executionMode: "worker-alarm",
      pollIntervalSeconds: PERIOD / 1000,
    };
  }
  private boundedFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const request = new Request(input, init);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 45000);
    try {
      return await fetch(request, {
        signal: AbortSignal.any([
          request.signal,
          this.cancel.signal,
          timeout.signal,
        ]),
      });
    } finally {
      clearTimeout(timer);
    }
  };
  private async initialize(cfg: Config) {
    if (this.runtime) return;
    this.cancel = new AbortController();
    this.budgetTimer = setTimeout(() => this.cancel.abort(), 600000);
    this.dir =
      "/tmp/personal-line-" +
      (await sha(this.scope)) +
      "-" +
      crypto.randomUUID();
    const store = {
      get: (k: string) => this.get(k),
      put: (k: string, v: unknown) => this.put(k, v),
      getReceipt: async (id: string) => this.get("receipt/" + (await sha(id))),
      putReceipt: async (id: string, v: unknown) =>
        this.put("receipt/" + (await sha(id)), v),
      getOutbound: async (id: string) => this.get("sent/" + (await sha(id))),
      putOutbound: async (id: string) =>
        this.put("sent/" + (await sha(id)), true),
    };
    const saved = await this.get("status");
    this.runtime = new ManagedRuntime({
      store,
      stateDir: this.dir,
      scheduled: true,
      fetcher: this.boundedFetch,
      clientFactory: (storage: any) =>
        new BaseClient({
          device: "IOSIPAD",
          storage,
          fetch: this.boundedFetch,
        }),
      onStatus: (value: unknown) => {
        this.statusWrites = this.statusWrites
          .catch(() => {})
          .then(async () => {
            if (await this.state.storage.get("enabled"))
              await this.put("status", value);
          });
        return this.statusWrites;
      },
    });
    if (saved?.metrics)
      this.runtime.metrics = {
        ...this.runtime.metrics,
        ...saved.metrics,
        bootId: crypto.randomUUID(),
        startedAt: Date.now(),
      };
    await this.runtime.bootstrap({
      harnessUrl: cfg.harnessUrl,
      connectorToken: cfg.connectorToken,
    });
    if (this.runtime.authTask) await this.runtime.authTask;
    await this.statusWrites;
    await this.put("status", this.runtime.status());
  }
  private async retire() {
    if (this.budgetTimer) clearTimeout(this.budgetTimer);
    this.budgetTimer = null;
    this.cancel.abort();
    if (this.runtime) await this.runtime.stop();
    this.runtime = null;
    if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
    this.dir = "";
  }
  private async close(erase: boolean) {
    await this.state.storage.put("enabled", false);
    await this.state.storage.deleteAlarm();
    this.cancel.abort();
    // Invalidate login/client callbacks before waiting on the current alarm.
    if (this.runtime) {
      this.runtime.generation++;
      if (this.runtime.client) this.runtime.client.disabled = true;
    }
    return this.exclusive(async () => {
      await this.retire();
      if (erase) {
        await this.state.storage.deleteAll();
        await this.state.storage.put({ closed: true, scope: this.scope });
      } else await this.put("status", { phase: "stopped" });
      return json({ closed: true });
    });
  }
  async alarm() {
    return this.exclusive(async () => {
      const scope = await this.state.storage.get<string>("scope");
      if (!scope) return;
      this.vault(scope);
      if (
        !(await this.state.storage.get("enabled")) ||
        (await this.state.storage.get("closed"))
      )
        return;
      const cfg = await this.get<Config>("config");
      if (!cfg) return;
      const alarmStarted = Date.now();
      // Pre-arm recovery. A runtime crash must not silently stop monitoring.
      await this.state.storage.setAlarm(Date.now() + PERIOD);
      try {
        const grant = await authorize(
          this.configEnv,
          cfg.tenantId,
          cfg.tenantSecret,
          false,
          true,
        );
        if (!grant || grant.origin !== cfg.harnessUrl) {
          await this.state.storage.put("enabled", false);
          await this.state.storage.deleteAlarm();
          await this.retire();
          await this.put("status", { phase: "connection_revoked" });
          return;
        }
        const login = await this.state.storage.get<boolean>("loginRequested");
        await this.state.storage.delete("loginRequested");
        await this.initialize(cfg);
        if (login) {
          await this.runtime.startLogin();
          // QR/PIN callbacks persist status, so concurrent status requests stay responsive.
          // The login itself is bounded by LINEJS check counts and request timeouts.
          await this.runtime.authTask;
        }
        if (await this.state.storage.get("enabled")) {
          const result = await this.runtime.step();
          const metrics = result.metrics || {};
          result.metrics = {
            ...metrics,
            alarmCount: (metrics.alarmCount || 0) + 1,
            alarmActiveMs:
              (metrics.alarmActiveMs || 0) + (Date.now() - alarmStarted),
            lastAlarmMs: Date.now() - alarmStarted,
          };
          await this.put("status", result);
          if (terminal.has(result.phase))
            await this.state.storage.deleteAlarm();
          else
            await this.state.storage.setAlarm(
              Date.now() + (result.errorCode ? 300000 : PERIOD),
            );
        }
      } catch {
        if (await this.state.storage.get("enabled")) {
          const old = await this.status();
          // Never leave a stale QR or a falsely connected status after failure.
          await this.put("status", {
            phase: "connection_error",
            errorCode: "WORKER_SYNC_UNAVAILABLE",
            metrics: old.metrics,
          });
          await this.state.storage.setAlarm(Date.now() + 300000);
        }
      } finally {
        // Drop timers, pending-client state and virtual files: only encrypted DO state survives.
        await this.statusWrites.catch(() => {});
        await this.retire();
        if (!(await this.state.storage.get("enabled")))
          await this.state.storage.deleteAlarm();
      }
    });
  }
  async fetch(request: Request): Promise<Response> {
    try {
      this.vault(request.headers.get("X-Session-Scope") || "");
      const path = new URL(request.url).pathname;
      if (path === "/close") return await this.close(true);
      if (await this.state.storage.get("closed"))
        return json({ error: "Session permanently closed" }, 410);
      if (path === "/status") return json(await this.status());
      return await this.exclusive(async () => {
        if (path === "/create") {
          const b = await body(request, 8192);
          if (!/^oc_[a-f0-9]{64}$/.test(b.connectorToken || ""))
            return json({ error: "Invalid connector" }, 400);
          const [tenantId, connectorId] = this.scope.split("/");
          const cfg: Config = {
            tenantId,
            connectorId,
            connectorToken: b.connectorToken,
            tenantSecret: request.headers.get("X-Tenant-Secret") || "",
            harnessUrl: request.headers.get("X-Tenant-Origin") || "",
          };
          const old = await this.get<Config>("config");
          if (
            old &&
            (old.connectorToken !== cfg.connectorToken ||
              old.harnessUrl !== cfg.harnessUrl)
          )
            return json({ error: "Session configuration conflict" }, 409);
          await this.put("config", cfg);
          await this.state.storage.put({ scope: this.scope, enabled: true });
          if (await this.get("session"))
            await this.state.storage.setAlarm(Date.now() + 1000);
          return json(await this.status());
        }
        if (!(await this.state.storage.get("enabled")))
          return json({ error: "Session disabled" }, 409);
        const cfg = await this.get<Config>("config");
        if (!cfg) return json({ error: "Session not created" }, 409);
        if (path === "/login") {
          const current = await this.status();
          if (
            [
              "connected",
              "authenticating",
              "awaiting_qr",
              "awaiting_pin",
            ].includes(current.phase)
          )
            return json(current);
          await this.put("status", {
            phase: "authenticating",
            loginMethod: "ipad",
            personalTalks: true,
          });
          await this.state.storage.put("loginRequested", true);
          await this.state.storage.setAlarm(Date.now() + 1000);
          return json(await this.status());
        }
        if (path !== "/create-room" && path !== "/rpc" && path !== "/creation-status")
          return json({ error: "Not found" }, 404);
        if ((await this.status()).phase !== "connected")
          return json({ error: { code: "AUTH_REQUIRED" } }, 409);
        try {
          await this.initialize(cfg);
          if (path === "/creation-status") return json(await this.runtime.creationStatus(await body(request, 8192)));
          if (path === "/create-room")
            return json(
              await this.runtime.createRoom(await body(request, 8192)),
            );
          const b = await body(request, 29 << 20);
          if (b.method !== request.headers.get("X-Openchat-Method"))
            throw Error("METHOD_MISMATCH");
          const allowed = JSON.parse(
            request.headers.get("X-Openchat-Allowed") || "[]",
          );
          if (
            !Array.isArray(allowed) ||
            allowed.some((x) => !/^([mt])[a-f0-9]{32}$/.test(x))
          )
            throw Error("CHAT_NOT_ALLOWED");
          return json({
            result: await this.runtime.rpc(
              b.method,
              b.params,
              new Set(allowed),
            ),
          });
        } finally {
          await this.retire();
        }
      });
    } catch {
      return json({ error: { code: "WORKER_RUNTIME_UNAVAILABLE" } }, 503);
    }
  }
}
