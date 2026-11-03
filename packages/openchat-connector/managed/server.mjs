import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode/lib/server.js";
import { PersonalTransport, personalID } from '../personal-transport.mjs';
import { Connector, StandaloneTransport } from "../connector.mjs";
const require = (name) => createRequire(import.meta.url)(name);
import bridgeModule from "../bridge.cjs";
const { createBridge } = bridgeModule;
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
const codeError = (code) => Object.assign(new Error(code), { code });
const writePrivate = (file, data, ephemeral = false) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (ephemeral) { fs.writeFileSync(file, JSON.stringify(data), {mode:0o600}); return; }
  fs.writeFileSync(file + ".tmp", JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
};
export class RemoteState {
  constructor(url, token, fetcher = fetch) {
    this.url = url;
    this.token = token;
    this.fetcher = fetcher;
  }
  async request(key, value, put = false) {
    const response = await this.fetcher(
      this.url + "?key=" + encodeURIComponent(key),
      {
        method: put ? "PUT" : "GET",
        redirect: "error",
        headers: {
          Authorization: "Bearer " + this.token,
          "Content-Type": "application/json",
        },
        ...(put ? { body: JSON.stringify({ value }) } : {}),
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok) throw codeError("STATE_UNAVAILABLE");
    return (await response.json()).value;
  }
  get(key) {
    return this.request(key);
  }
  put(key, value) {
    return this.request(key, value, true);
  }
  getOutbound(id) { return this.get('sent/'+digest(id)); }
  putOutbound(id) { return this.put('sent/'+digest(id),true); }
  getReceipt(id) {
    return this.get("receipt/" + digest(id));
  }
  putReceipt(id, value) {
    return this.put("receipt/" + digest(id), value);
  }
}
export class ManagedRuntime {
  constructor({
    store,
    stateDir = "/state",
    clientFactory,
    fetcher = fetch,
    scheduled = false,
    onStatus = async () => {},
  } = {}) {
    this.scheduled = scheduled;
    this.onStatus = onStatus;
    this.store = store;
    this.dir = stateDir;
    this.fetcher = fetcher;
    this.clientFactory =
      clientFactory ||
      ((storage) =>
        new (require("../vendor/linejs-runtime.cjs").BaseClient)({
          device: "IOSIPAD",
          storage,
          timeout: 30000,
        }));
    this.metrics = { bootId: crypto.randomUUID(), startedAt: Date.now(), successfulSyncs: 0, failedSyncs: 0, lastSuccessAt: null, lastFailureAt: null, lastSyncMs: null };
    this.phase = "booting";
    this.generation = 0;
    this.session = {};
    this.authWrites = Promise.resolve();
    this.serial = Promise.resolve();
    this.running = false;
    this.accountName = "";
    this.accountFingerprint = "";
    this.roomCount = 0;
    this.discovered = [];
    this.discoveredAt = 0;
    this.lastError = null;
    this.config = null;
  }
  status() {
    if (
      this.qrExpiresAt &&
      Date.now() > this.qrExpiresAt &&
      ["awaiting_qr", "awaiting_pin"].includes(this.phase)
    ) {
      this.phase = "expired";
      this.qrImage = null;
      this.pin = null;
    }
    return {
      phase: this.phase,
      metrics: this.scheduled ? { ...this.metrics, executionMode: "worker-alarm" } : { ...this.metrics, processUptimeSeconds: Math.round(process.uptime()), rssMiB: Math.round(process.memoryUsage().rss / 1048576 * 10) / 10, cpuSeconds: Object.values(process.cpuUsage()).reduce((a,b) => a+b,0) / 1000000 },
      accountName: this.accountName,
      accountFingerprint: this.accountFingerprint,
      roomCount: this.roomCount,
      loginMethod: 'ipad',
      personalTalks: true,
      errorCode: this.lastError,
      ...(this.phase === "awaiting_qr"
        ? { qrImage: this.qrImage, expiresAt: this.qrExpiresAt }
        : {}),
      ...(this.phase === "awaiting_pin"
        ? { pin: this.pin, expiresAt: this.qrExpiresAt }
        : {}),
    };
  }
  async persistSession() {
    writePrivate(this.dir + "/session.json", this.session, this.scheduled);
    const snapshot = structuredClone(this.session);
    this.authWrites = this.authWrites
      .catch(() => {})
      .then(async () => {
        const encoded = JSON.stringify(snapshot);
        if (encoded !== this.sessionSnapshot) {
          await this.store.put("session", snapshot);
          this.sessionSnapshot = encoded;
        }
      });
    await this.authWrites;
  }
  makeClient(gen) {
    const storage = {
      get: async (key) => this.session[key],
      set: async (key, value) => {
        if (gen !== this.generation) throw codeError("AUTH_SUPERSEDED");
        this.session[key] = value;
        await this.persistSession();
      },
      delete: async (key) => {
        if (gen !== this.generation) throw codeError("AUTH_SUPERSEDED");
        delete this.session[key];
        await this.persistSession();
      },
      clear: async () => {
        throw codeError("NO_CLEAR");
      },
      migrate: async (other) => {
        for (const [k, v] of Object.entries(this.session))
          await other.set(k, v);
      },
    };
    const client = this.clientFactory(storage);
    client.on("update:authtoken", (token) => {
      if (gen === this.generation) {
        this.session.authToken = token;
        void this.persistSession().catch(() => {
          this.lastError = "STATE_UNAVAILABLE";
        });
      }
    });
    for (const method of ["checkQrCodeVerified", "checkPinCodeVerified"]) {
      if (client.loginProcess[method]) {
        const old = client.loginProcess[method].bind(client.loginProcess);
        client.loginProcess[method] = (id) => old(id, 8, 30);
      }
    }
    client.on("qrcall", async (url) => {
      let image; try { image = await QRCode.toDataURL(url, { width: 420, margin: 4 }); } catch { if(gen===this.generation){this.phase='auth_required';this.lastError='QR_RENDER_FAILED';} return; }
      if (gen !== this.generation) return;
      this.qrImage = image;
      this.qrExpiresAt = Date.now() + 180000;
      this.phase = "awaiting_qr";
      await this.onStatus(this.status());
    });
    client.on("pincall", async (pin) => {
      if (gen !== this.generation) return;
      this.qrImage = null;
      this.pin = String(pin);
      this.phase = "awaiting_pin";
      this.qrExpiresAt = Date.now() + 180000;
      await this.onStatus(this.status());
    });
    return client;
  }
  async bootstrap(config) {
    if (this.config) {
      if (
        config.connectorToken !== this.config.connectorToken ||
        config.harnessUrl !== this.config.harnessUrl
      )
        throw codeError("CONFIG_CONFLICT");
      if(this.phase === 'connection_error' && !this.running && Date.now()-(this.lastRecovery||0)>30000) {
        this.lastRecovery=Date.now();this.phase='restoring';
        if(this.client)this.client.disabled=true;
        this.authTask=this.authenticate(false);
      }
      return this.status();
    }
    const u = new URL(config.harnessUrl);
    if (u.protocol !== "https:") throw codeError("INVALID_ORIGIN");
    if (!/^oc_[a-f0-9]{64}$/.test(config.connectorToken || ""))
      throw codeError("INVALID_CONNECTOR");
    const nextConfig = {
      harnessUrl: u.origin,
      connectorToken: config.connectorToken,
      transport: "standalone",
      ephemeralFiles: this.scheduled,
      stateDir: this.dir,
      cursorPath: this.dir + "/cloud-sync.json",
      sessionPath: this.dir + "/session.json",
    };
    this.session = (await this.store.get("session")) || {};
    this.sessionSnapshot = JSON.stringify(this.session);
    this.identity = (await this.store.get("identity")) || {
      salt: crypto.randomBytes(32).toString("hex"),
    };
    await this.store.put("identity", this.identity);
    writePrivate(this.dir + "/identity.json", this.identity, this.scheduled);
    writePrivate(this.dir + "/session.json", this.session, this.scheduled);
    if (this.scheduled) {
      const registry = (await this.store.get("registry")) || {};
      writePrivate(this.dir + "/registry.json", registry, true);
      this.registrySnapshot = JSON.stringify(registry);
    }
    this.config=nextConfig;
    if (this.session.authToken) {
      this.phase = "restoring";
      this.authTask = this.authenticate(false);
    } else this.phase = "auth_required";
    return this.status();
  }
  async stopEngine() {
    this.running = false;
    if (this.wake) this.wake();
    if (this.loopPromise) await this.loopPromise;
    await this.serial.catch(() => {});
  }
  async startLogin() {
    if (!this.config) throw codeError("NOT_BOOTSTRAPPED");
    if (["awaiting_qr", "awaiting_pin", "authenticating"].includes(this.phase))
      return this.status();
    this.generation++;
    if (this.client) this.client.disabled = true;
    await this.stopEngine();
    if (this.authTask) await this.authTask.catch(() => {});
    this.phase = "authenticating";
    this.qrImage = null;
    this.pin = null;
    this.lastError = null;
    this.authTask = this.authenticate(true);
    return this.status();
  }
  async authenticate(qr) {
    const gen = ++this.generation;
    try {
      this.client = this.makeClient(gen);
      await this.client.loginProcess.login(
        qr ? { qr: true } : { authToken: this.session.authToken },
      );
      if (gen !== this.generation) return;
      await this.persistSession();
      this.accountName = this.client.profile.displayName || "";
      this.accountFingerprint = digest(
        this.identity.salt + this.client.profile.mid,
      );
      this.qrImage = null;
      this.pin = null;
      await this.activate(gen);
    } catch (e) {
      if (gen !== this.generation) return;
      this.qrImage = null;
      this.pin = null;
      this.phase = /410|expired|timeout/i.test(e.message || "")
        ? "expired"
        : "auth_required";
      this.lastError = e.code || e.data?.errorCode || "AUTH_REQUIRED";
    }
  }
  async checkpointRegistry() {
    if (!this.scheduled) return;
    const file = this.dir + '/registry.json';
    if (!fs.existsSync(file)) return;
    const value = JSON.parse(fs.readFileSync(file,'utf8'));
    const snapshot = JSON.stringify(value);
    if (snapshot !== this.registrySnapshot) {
      await this.store.put('registry',value);
      this.registrySnapshot=snapshot;
    }
  }
  dispatch(method, params) {
    const result = this.serial
      .catch(() => {})
      .then(async () => {
        if (!this.bridge) throw codeError("AUTH_REQUIRED");
        try { return await this.bridge.dispatch(method, params); }
        finally { await this.checkpointRegistry(); }
      });
    this.serial = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async discover() {
    if (Date.now() - this.discoveredAt < 60000) return this.discovered;
    const rooms = [];
    let continuationToken;
    const seen = new Set();
    for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
      // Same discovery path as LINEJS Client.fetchJoinedSquareChats.
      // Joinable chats exclude rooms already joined. Never consume message payloads here.
      const page = await this.client.square.fetchMyEvents({limit:200, ...(continuationToken ? {continuationToken} : {})});
      if (!Array.isArray(page.events)) throw codeError('OPENCHAT_DISCOVERY_UNAVAILABLE');
      for (const event of page.events) {
        const chat = event.payload?.notifiedCreateSquareChatMember?.chat;
        if (chat?.state === 'ALIVE' && /^m[a-f0-9]{32}$/.test(chat.squareChatMid || '')) rooms.push(chat.squareChatMid);
      }
      continuationToken = page.continuationToken;
      if (!continuationToken) break;
      if (seen.has(continuationToken) || pageIndex===9) throw codeError('OPENCHAT_DISCOVERY_INCOMPLETE');
      seen.add(continuationToken);
    }
    this.discoveredAt = Date.now();
    this.discovered = [...new Set(rooms)];
    this.roomCount = this.discovered.length;
    if (this.discovered.length) {
      const signature = this.discovered.slice().sort().join(",");
      if (signature !== this.bridgeSignature) {
        this.bridge = createBridge(
          {
            ...this.config,
            chatIDs: this.discovered,
            bundlePath: this.scheduled ? undefined : path.join(
              path.dirname(fileURLToPath(import.meta.url)),
              "../vendor/linejs-runtime.cjs",
            ),
          },
          this.client,
          {
            getOutbound: id => this.store.getOutbound(id),
            putOutbound: id => this.store.putOutbound(id),
            getReceipt: async (id) => {
              await this.authWrites;
              return this.store.getReceipt(id);
            },
            putReceipt: async (id, value) => {
              await this.authWrites;
              return this.store.putReceipt(id, value);
            },
          },
        );
        this.bridgeSignature = signature;
      }
    }
    if (!this.discovered.length) { this.bridge = null; this.bridgeSignature = ""; }
    return this.discovered;
  }
  async activate(gen) {
    this.discoveredAt = 0;
    this.personal = new PersonalTransport(this.client, this.store, this.identity);
    await this.discover();
    const baseTransport = new StandaloneTransport(this.config, {
      dispatch: (method, params) => this.dispatch(method, params),
    });
    const transport = {
      list: async () => {
        await this.discover();
        const personal = await this.personal.list();
        const openchat = this.bridge ? await baseTransport.list() : { rooms: [] };
        return { ...personal, rooms: [...personal.rooms, ...openchat.rooms] };
      },
      messages: (...args) => personalID(args[0]) ? this.personal.messages(...args) : baseTransport.messages(...args),
      media: (...args) => baseTransport.media(...args),
      send: (...args) => personalID(args[0].chatId) ? this.personal.send(...args) : baseTransport.send(...args),
    };
    this.connector = new Connector(
      this.config,
      transport,
      this.fetcher,
      this.store,
    );
    try {
      await this.connector.heartbeat();
    } catch (e) {
      this.phase = e.status === 409 ? "identity_mismatch" : "connection_error";
      this.lastError =
        e.status === 409 ? "ACCOUNT_MISMATCH" : "HARNESS_UNAVAILABLE";
      return;
    }
    if (gen !== this.generation) return;
    this.phase = "connected";
    this.lastError = null;
    if (this.scheduled) return;
    this.running = true;
    this.loopPromise = (async () => {
      let delay = 5000;
      while (this.running && gen === this.generation) {
        try {
          const started = Date.now();
          await this.connector.tick();
          this.metrics.successfulSyncs++;
          this.metrics.lastSuccessAt = Date.now();
          this.metrics.lastSyncMs = Date.now() - started;
          delay = 5000;
          this.lastError = null;
        } catch (e) {
          this.metrics.failedSyncs++;
          this.metrics.lastFailureAt = Date.now();
          delay = Math.min(delay * 2, 60000);
          this.lastError =
            e.code ||
            e.data?.errorCode ||
            (e.status ? "HTTP_" + e.status : "SYNC_UNAVAILABLE");
          if (e.status === 401 || e.status === 403) {
            this.phase = "connection_revoked";
            this.running = false;
          } else if (/AUTH|LOGGED_OUT|INVALID_SESSION/.test(this.lastError)) {
            this.phase = "auth_required";
            this.running = false;
          }
        }
        if (this.running)
          await new Promise((resolve) => {
            const timer = setTimeout(() => {
              this.wake = null;
              resolve();
            }, delay);
            this.wake = () => {
              clearTimeout(timer);
              this.wake = null;
              resolve();
            };
          });
      }
    })();
  }
  // One bounded sync per alarm; no timers or work survive between invocations.
  async step() {
    if (!this.scheduled || this.phase !== 'connected') return this.status();
    const started = Date.now();
    try {
      await this.connector.tick();
      this.metrics.successfulSyncs++;
      this.metrics.lastSuccessAt = Date.now();
      this.metrics.lastSyncMs = Date.now() - started;
      this.lastError = null;
    } catch (e) {
      this.metrics.failedSyncs++;
      this.metrics.lastFailureAt = Date.now();
      this.lastError = e.code || e.data?.errorCode || (e.status ? 'HTTP_' + e.status : 'SYNC_UNAVAILABLE');
      if (e.status === 401 || e.status === 403) this.phase = 'connection_revoked';
      else if (/AUTH|LOGGED_OUT|INVALID_SESSION/.test(String(this.lastError))) this.phase = 'auth_required';
    }
    await this.onStatus(this.status());
    return this.status();
  }
  createRoom(input) {
    const next = this.serial.catch(() => {}).then(() => this.createRoomOnce(input));
    this.serial = next.then(() => {}, () => {});
    return next;
  }
  async createRoomOnce(input) {
    if (this.phase !== 'connected') throw codeError('AUTH_REQUIRED');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input?.operationId || '') ||
        typeof input.name !== 'string' || !input.name.trim() || input.name.length > 50 ||
        typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.length > 20 ||
        typeof input.description !== 'string' || input.description.length > 1000 || input.approved !== true)
      throw codeError('INVALID_CREATION');
    const options = { squareName: input.name.trim(), displayName: input.displayName.trim(), description: input.description, searchable: false, squareJoinMethodType: 'NONE' };
    const key = 'create-room:' + input.operationId, fingerprint = digest(JSON.stringify(options));
    const old = await this.store.getReceipt(key);
    if (old) {
      if (old.hash !== fingerprint) throw codeError('REQUEST_ID_CONFLICT');
      if (old.status === 'done') return old.result;
      throw codeError('CREATE_OUTCOME_UNKNOWN');
    }
    await this.store.putReceipt(key, { hash: fingerprint, status: 'pending' });
    try {
      const response = await this.client.square.createSquare(options);
      const squareMid = response.square?.mid, chatMid = response.squareChat?.squareChatMid;
      if (!/^s[a-f0-9]{32}$/.test(squareMid || '') || !/^m[a-f0-9]{32}$/.test(chatMid || '')) throw codeError('CREATE_OUTCOME_UNKNOWN');
      const result = { squareMid, chatMid, name: options.squareName };
      await this.store.putReceipt(key, { hash: fingerprint, status: 'done', result });
      this.discoveredAt = 0;
      if (this.connector) this.connector.lastHeartbeat = 0;
      return result;
    } catch { throw codeError('CREATE_OUTCOME_UNKNOWN'); }
  }

  async creationStatus(input) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input?.operationId || '')) throw codeError('INVALID_CREATION');
    const saved = await this.store.getReceipt('create-room:' + input.operationId);
    if (!saved) return { status: 'not_found' };
    if (saved.status !== 'done') return { status: 'unknown' };
    const result = { status: 'created', ...saved.result };
    if (this.phase !== 'connected') return { ...result, invitationStatus: 'authentication_required' };
    try {
      const ticket = await this.client.square.getInvitationTicketUrl({ request: { mid: saved.result.squareMid } });
      const url = new URL(ticket.invitationURL);
      if (url.protocol !== 'https:' || url.username || url.password || url.hostname !== 'line.me' || !url.pathname.startsWith('/ti/g2/')) throw Error('invalid_invitation');
      return { ...result, invitationUrl: url.href, invitationStatus: 'available' };
    } catch { return { ...result, invitationStatus: 'unavailable' }; }
  }

  async rpc(method, params, allowed) {
    if (this.phase !== "connected") throw codeError("AUTH_REQUIRED");
    if (!["list", "events", "send", "sendMedia", "getMedia"].includes(method))
      throw codeError("UNKNOWN_METHOD");
    if (method !== "list" && !allowed.has(params?.chatID))
      throw codeError("CHAT_NOT_ALLOWED");
    if (method === 'list' && params?.threads !== undefined) {
      if (!Array.isArray(params.threads) || params.threads.length > 20 || params.threads.some(h => !/^t[a-f0-9]{32}$/.test(h?.id || '') || !/^m[a-f0-9]{32}$/.test(h?.parentID || '') || !allowed.has(h.parentID))) throw codeError('CHAT_NOT_ALLOWED');
    }
    const result = await this.dispatch(method, params);
    if (method === "list")
      return {
        ...result,
        chats: result.chats.filter((c) => allowed.has(c.id)),
      };
    if (method === "events")
      return {
        ...result,
        chats: (result.chats || []).filter((c) => allowed.has(c.id)),
      };
    return result;
  }
  async stop() {
    this.generation++;
    if (this.client) this.client.disabled = true;
    await this.stopEngine();
    this.phase = "stopped";
    this.qrImage = null;
    this.pin = null;
    this.client = null;
    this.bridge = null;
  }
}
function sameToken(actual, expected) {
  const a = Buffer.from(String(actual || "")),
    b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function body(req, limit) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw codeError("BODY_TOO_LARGE");
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
}
export function createRuntimeServer(runtime, token) {
  return http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    if (!sameToken(req.headers.authorization, "Bearer " + token)) {
      res.writeHead(401);
      res.end('{"error":"Unauthorized"}');
      return;
    }
    try {
      const url = new URL(req.url, "http://container");
      let result;
      if (url.pathname === "/health") result = { ready: true };
      else if (url.pathname === "/bootstrap" && req.method === "POST")
        result = await runtime.bootstrap(await body(req, 65536));
      else if (url.pathname === "/create-room" && req.method === "POST") result = await runtime.createRoom(await body(req, 8192));
      else if (url.pathname === "/creation-status" && req.method === "POST") result = await runtime.creationStatus(await body(req, 8192));
      else if (url.pathname === "/status") result = runtime.status();
      else if (url.pathname === "/login" && req.method === "POST")
        result = await runtime.startLogin();
      else if (url.pathname === "/stop" && req.method === "POST") {
        await runtime.stop();
        result = { stopped: true };
      } else if (url.pathname === "/rpc" && req.method === "POST") {
        const b = await body(req, 29 << 20);
        if (b.method !== req.headers["x-openchat-method"])
          throw codeError("METHOD_MISMATCH");
        let ids;
        try {
          ids = JSON.parse(String(req.headers["x-openchat-allowed"] || "[]"));
        } catch {
          throw codeError("CHAT_NOT_ALLOWED");
        }
        if (
          !Array.isArray(ids) ||
          ids.some((id) => !/^([mt])[a-f0-9]{32}$/.test(id))
        )
          throw codeError("CHAT_NOT_ALLOWED");
        result = {
          result: await runtime.rpc(b.method, b.params, new Set(ids)),
        };
      } else {
        res.writeHead(404);
        res.end('{"error":"Not found"}');
        return;
      }
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(e.code === "CHAT_NOT_ALLOWED" ? 403 : 503);
      res.end(
        JSON.stringify({
          error: { code: e.code || e.data?.errorCode || "RUNTIME_UNAVAILABLE" },
        }),
      );
    }
  });
}
if (
  import.meta.url && process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.umask(0o077);
  const token = process.env.RUNTIME_TOKEN,
    url = process.env.STATE_URL;
  if (!token || !url) throw Error("Managed runtime configuration missing");
  const runtime = new ManagedRuntime({
    store: new RemoteState(url, token),
    stateDir: process.env.STATE_DIR || "/state",
  });
  const server = createRuntimeServer(runtime, token);
  server.listen(8080, "0.0.0.0");
  process.on("SIGTERM", () => {
    void runtime.stop().finally(() => server.close(() => process.exit(0)));
  });
}
