import { DurableObject } from "cloudflare:workers";
import {
  StateCipher,
  equalToken,
  runtimeToken,
  sha,
  type EncryptedValue,
} from "./security";
interface Port {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}
interface ContainerAPI {
  running: boolean;
  start(options?: {
    env?: Record<string, string>;
    enableInternet: boolean;
  }): void;
  getTcpPort(port: number): Port;
  setInactivityTimeout(ms: number): Promise<void>;
  destroy(reason?: string): Promise<void>;
}
type RuntimeContext = Omit<DurableObjectState, "container"> & { container: ContainerAPI };
export interface Env {
  SESSIONS: DurableObjectNamespace<ManagedOpenChat>;
  STATE_KEY_B64: string;
  RUNTIME_KEY_B64: string;
  PUBLIC_BASE_URL: string;
  CONTROL_AUTHORIZE_URL?: string;
  SELF_HOSTED_TENANTS?: string;
}
type Grant = { tenantId: string; origin: string; cleanupOnly?: boolean };
type SessionConfig = {
  tenantId: string;
  connectorId: string;
  tenantSecret: string;
  harnessUrl: string;
  connectorToken: string;
};
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const cache = new Map<string, { expires: number; grant: Grant }>();
const tenantPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const connectorPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export async function authorize(
  env: Env,
  tenantId: string,
  secret: string,
  cleanup = false,
  bypass = false,
): Promise<Grant | null> {
  if (
    !tenantPattern.test(tenantId) ||
    secret.length < 32 ||
    secret.length > 200
  )
    return null;
  const key =
    tenantId + ":" + (cleanup ? "cleanup:" : "active:") + (await sha(secret));
  const saved = cache.get(key);
  if (!bypass && saved && saved.expires > Date.now()) return saved.grant;
  let grant: Grant | null = null;
  if (env.CONTROL_AUTHORIZE_URL) {
    const url = new URL(env.CONTROL_AUTHORIZE_URL);
    if (url.protocol !== "https:") throw Error("Invalid control URL");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let r: Response;
    try { r = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: "Bearer " + secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tenantId,
        intent: cleanup ? "cleanup" : "active",
      }),
      signal: controller.signal,
    }); } finally { clearTimeout(timer); }
    if ([401, 403, 404].includes(r.status)) return null;
    if (!r.ok) throw Error("Control unavailable");
    const body = await r.json<Grant & { authorized: boolean }>();
    if (body.authorized && body.tenantId === tenantId) grant = body;
  } else {
    const entries = JSON.parse(env.SELF_HOSTED_TENANTS || "{}") as Record<
      string,
      { secretHash: string; origin: string }
    >;
    const row = entries[tenantId];
    if (row && (await equalToken(await sha(secret), row.secretHash)))
      grant = { tenantId, origin: row.origin };
  }
  if (!grant || (grant.cleanupOnly && !cleanup)) return null;
  if (grant.origin) {
    const url = new URL(grant.origin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    grant.origin = url.origin;
  } else if (!cleanup) return null;
  if (cache.size > 500) cache.clear();
  cache.set(key, { expires: Date.now() + 30000, grant });
  return grant;
}
function parseScope(tenantId: string, connectorId: string) {
  if (!tenantPattern.test(tenantId) || !connectorPattern.test(connectorId))
    throw Error("Invalid session identity");
  return tenantId + "/" + connectorId;
}
async function smallJSON<T>(request: Request, max = 65536): Promise<T> {
  if (Number(request.headers.get("Content-Length") || 0) > max)
    throw Error("Body too large");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > max) throw Error("Body too large");
  return JSON.parse(raw || "{}") as T;
}

export class ManagedOpenChat extends DurableObject<Env> {
  private state: RuntimeContext;
  private configEnv: Env;
  private starting: Promise<void> | null = null;
  private scope = "";
  private cipher: StateCipher | null = null;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = ctx as RuntimeContext;
    this.configEnv = env;
    if (this.state.container?.running)
      ctx.waitUntil(this.state.container.setInactivityTimeout(300000));
  }
  private vault(scope: string) {
    if (this.scope && this.scope !== scope)
      throw Error("Session identity mismatch");
    this.scope = scope;
    return (this.cipher ??= new StateCipher(
      this.configEnv.STATE_KEY_B64,
      scope,
    ));
  }
  private async get<T>(key: string): Promise<T | null> {
    const value = await this.state.storage.get<EncryptedValue>(
      "encrypted:" + key,
    );
    return value ? this.vault(this.scope).open<T>(key, value) : null;
  }
  private async put(key: string, value: unknown) {
    await this.state.storage.put(
      "encrypted:" + key,
      await this.vault(this.scope).seal(key, value),
    );
  }
  private async token() {
    return runtimeToken(this.configEnv.RUNTIME_KEY_B64, this.scope);
  }
  private async node(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.set("Authorization", "Bearer " + (await this.token()));
    return this.state.container
      .getTcpPort(8080)
      .fetch("http://container" + path, { ...options, headers });
  }
  private async ensure() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const cfg = await this.get<SessionConfig>("config");
      if (
        !cfg ||
        !(await this.state.storage.get("enabled")) ||
        (await this.state.storage.get("closed"))
      )
        throw Error("Session is disabled");
      const c = this.state.container;
      if (!c) throw Error("Container unavailable");
      if (!c.running) {
        const base = new URL(this.configEnv.PUBLIC_BASE_URL);
        if (base.protocol !== "https:") throw Error("Invalid state origin");
        c.start({
          enableInternet: true,
          env: {
            RUNTIME_TOKEN: await this.token(),
            STATE_URL: base.origin + "/internal/" + this.scope + "/state",
            STATE_DIR: "/state",
            NODE_NO_WARNINGS: "1",
          },
        });
      }
      await c.setInactivityTimeout(300000);
      let ready = false;
      for (let i = 0; i < 30; i++) {
        try {
          const r = await this.node("/health");
          if (r.ok) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!ready) throw Error("Container did not become ready");
      const r = await this.node("/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          harnessUrl: cfg.harnessUrl,
          connectorToken: cfg.connectorToken,
        }),
      });
      if (!r.ok) throw Error("Runtime bootstrap failed");
      await this.state.storage.setAlarm(Date.now() + 60000);
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }
  private async close(erase: boolean) {
    await this.state.storage.put("enabled", false);
    await this.state.storage.deleteAlarm();
    if (this.state.container?.running) {
      try {
        await this.node("/stop", { method: "POST" });
      } catch {}
      await this.state.container.destroy("OpenChat connection stopped");
    }
    if (erase) {
      await this.state.storage.deleteAll();
      await this.state.storage.put("closed", true);
      await this.state.storage.put("scope", this.scope);
    }
    return json({ closed: true });
  }
  async alarm() {
    this.scope = (await this.state.storage.get<string>("scope")) || "";
    if (!this.scope || !(await this.state.storage.get("enabled"))) return;
    const cfg = await this.get<SessionConfig>("config");
    if (!cfg) return;
    try {
      const grant = await authorize(
        this.configEnv,
        cfg.tenantId,
        cfg.tenantSecret,
        false,
        true,
      );
      if (!grant) {
        await this.close(false);
        return;
      }
      await this.ensure();
      const r = await this.node("/status");
      const s = await r.json<{ phase: string }>();
      if (s.phase === "connection_revoked") {
        await this.close(true);
        return;
      }
      if (["auth_required", "expired", "identity_mismatch"].includes(s.phase)) {
        await this.state.storage.deleteAlarm();
        return;
      }
      await this.state.storage.setAlarm(Date.now() + 60000);
    } catch {
      await this.state.storage.setAlarm(Date.now() + 60000);
    }
  }
  async fetch(request: Request): Promise<Response> {
    const scope = request.headers.get("X-Session-Scope") || "";
    const [tenantId, connectorId] = scope.split("/");
    try {
      parseScope(tenantId, connectorId);
      this.vault(scope);
      const url = new URL(request.url);
      // State callbacks must remain reentrant while a container request is awaiting a checkpoint.
      if (url.pathname === "/state") {
        if (
          !(await equalToken(
            request.headers.get("Authorization") || "",
            "Bearer " + (await this.token()),
          ))
        )
          return json({ error: "Unauthorized" }, 401);
        if (
          !(await this.state.storage.get("enabled")) ||
          (await this.state.storage.get("closed"))
        )
          return json({ error: "Session closed" }, 410);
        const key = url.searchParams.get("key") || "";
        if (
          !/^(session|identity|pending|receipt\/[a-f0-9]{64}|sent\/[a-f0-9]{64}|cursor\/[a-f0-9]{64})$/.test(
            key,
          )
        )
          return json({ error: "Invalid state key" }, 400);
        if (request.method === "GET")
          return json({ value: await this.get(key) });
        if (request.method === "PUT") {
          const b = await smallJSON<{ value: unknown }>(request, 90000);
          await this.put(key, b.value);
          return json({ value: true });
        }
        return json({ error: "Method not allowed" }, 405);
      }
      if (url.pathname === "/close") return this.close(true);
      if (await this.state.storage.get("closed"))
        return json({ error: "Session permanently closed" }, 410);
      if (url.pathname === "/create") {
        const b = await smallJSON<{ connectorToken: string }>(request, 8192);
        if (!/^oc_[a-f0-9]{64}$/.test(b.connectorToken || ""))
          return json({ error: "Invalid connector" }, 400);
        const config: SessionConfig = {
          tenantId,
          connectorId,
          tenantSecret: request.headers.get("X-Tenant-Secret") || "",
          harnessUrl: request.headers.get("X-Tenant-Origin") || "",
          connectorToken: b.connectorToken,
        };
        const old = await this.get<SessionConfig>("config");
        if (
          old &&
          (old.connectorToken !== config.connectorToken ||
            old.harnessUrl !== config.harnessUrl)
        )
          return json({ error: "Session configuration conflict" }, 409);
        await this.put("config", config);
        await this.state.storage.put({ scope, enabled: true });
        await this.ensure();
        return this.node("/status");
      }
      await this.ensure();
      if (url.pathname === "/status") return this.node("/status");
      if (url.pathname === "/login")
        return this.node("/login", { method: "POST" });
      if (url.pathname === "/creation-status") return this.node("/creation-status", { method: "POST", headers: {"Content-Type":"application/json"}, body: request.body });
      if (url.pathname === "/create-room") return this.node("/create-room", { method: "POST", headers: {"Content-Type":"application/json"}, body: request.body });
      if (url.pathname === "/rpc") {
        const headers = new Headers({ "Content-Type": "application/json" });
        headers.set(
          "X-Openchat-Method",
          request.headers.get("X-Openchat-Method") || "",
        );
        headers.set(
          "X-Openchat-Allowed",
          request.headers.get("X-Openchat-Allowed") || "[]",
        );
        return this.node("/rpc", {
          method: "POST",
          headers,
          body: request.body,
        });
      }
      return json({ error: "Not found" }, 404);
    } catch {
      return json({ error: "Managed runtime unavailable" }, 503);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let stage = "route";
    try {
      const url = new URL(request.url);
      const internal = /^\/internal\/([^/]+)\/([^/]+)\/state$/.exec(
        url.pathname,
      );
      if (internal) {
        const scope = parseScope(internal[1], internal[2]);
        if (
          !(await equalToken(
            request.headers.get("Authorization") || "",
            "Bearer " + (await runtimeToken(env.RUNTIME_KEY_B64, scope)),
          ))
        )
          return json({ error: "Unauthorized" }, 401);
        const headers = new Headers(request.headers);
        headers.set("X-Session-Scope", scope);
        stage = "session_dispatch";
      return await env.SESSIONS.get(env.SESSIONS.idFromName(scope)).fetch(
          new Request("https://session/state" + url.search, {
            method: request.method,
            headers,
            body: request.body,
          }),
        );
      }
      const route = /^\/v1\/sessions\/([^/]+)(?:\/(status|login|rpc|create-room|creation-status))?$/.exec(
        url.pathname,
      );
      if (!route) return json({ error: "Not found" }, 404);
      const tenantId = request.headers.get("X-Tenant-ID") || "",
        connectorId = route[1];
      stage = "scope";
      const scope = parseScope(tenantId, connectorId);
      const secret =
        request.headers.get("Authorization")?.replace(/^Bearer /, "") || "";
      const cleanup = request.method === "DELETE" && !route[2];
      stage = "authorize";
      const grant = await authorize(env, tenantId, secret, cleanup);
      if (!grant) return json({ error: "Unauthorized tenant" }, 403);
      let operation = cleanup ? "close" : route[2] || "create";
      if (
        (operation === "create" && request.method !== "POST") ||
        (operation === "status" && request.method !== "GET") ||
        (["login", "rpc", "create-room", "creation-status"].includes(operation) && request.method !== "POST")
      )
        return json({ error: "Method not allowed" }, 405);
      let body: BodyInit | null = request.body;
      if (operation === "create") {
        const b = await smallJSON<{ connectorToken: string }>(request, 8192);
        stage = "connector_check";
        const self = await fetch(grant.origin + "/openchat-connector/self", {
          headers: { Authorization: "Bearer " + b.connectorToken },
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
        });
        if (!self.ok)
          return json({ error: "Connector is not registered" }, 403);
        const record = await self.json<{
          success: boolean;
          data: { id: string; mode: string };
        }>();
        if (
          !record.success ||
          record.data.id !== connectorId ||
          record.data.mode !== "managed"
        )
          return json({ error: "Connector identity mismatch" }, 403);
        body = JSON.stringify(b);
      }
      const headers = new Headers({
        "X-Session-Scope": scope,
        "X-Tenant-Origin": grant.origin || "",
        "X-Tenant-Secret": secret,
        "Content-Type": "application/json",
      });
      if (operation === "rpc") {
        const method = request.headers.get("X-Openchat-Method") || "";
        if (
          !["list", "events", "send", "sendMedia", "getMedia"].includes(method)
        )
          return json({ error: "Invalid RPC method" }, 400);
        headers.set("X-Openchat-Method", method);
        headers.set(
          "X-Openchat-Allowed",
          request.headers.get("X-Openchat-Allowed") || "[]",
        );
      }
      stage = "session_dispatch";
      return await env.SESSIONS.get(env.SESSIONS.idFromName(scope)).fetch(
        new Request("https://session/" + operation, {
          method: operation === "status" ? "GET" : "POST",
          headers,
          ...(operation === "status" ? {} : { body }),
        }),
      );
    } catch (error) {
      const known = ["Invalid session identity", "Invalid control URL", "Control unavailable", "Body too large"];
      const code = error instanceof Error && known.includes(error.message) ? error.message : error instanceof TypeError ? "TYPE_ERROR" : "REQUEST_FAILED";
      return json({ error: "Managed OpenChat request failed", stage, code }, 503);
    }
  },
};
