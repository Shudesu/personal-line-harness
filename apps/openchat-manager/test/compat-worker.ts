import { ManagedOpenChat as AlarmSession } from "../src/alarm-session";
export class TestSession extends AlarmSession {
  async runTestAlarm() {
    await this.alarm();
    return true;
  }
}
import bridgeModule from "../../../packages/openchat-connector/bridge.cjs";
import { ManagedRuntime } from "../../../packages/openchat-connector/managed/server.mjs";
import QRCode from "../../../packages/openchat-connector/node_modules/qrcode/lib/server.js";
import { BaseClient } from "../../../packages/openchat-connector/vendor/linejs-worker.cjs";
import crypto from "node:crypto";
import fs from "node:fs";
export default {
  async fetch(request, env) {

    if (new URL(request.url).pathname.startsWith("/session/")) {
      const scope = "worker-pilot/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const stub = env.TESTSESSIONS.get(env.TESTSESSIONS.idFromName(scope));
      const op = new URL(request.url).pathname.slice(8);
      if (op === "/alarm") {
        await stub.runTestAlarm();
        return Response.json({ alarm: true });
      }
      return stub.fetch(
        new Request("https://session" + op, {
          method: request.method,
          headers: {
            "X-Session-Scope": scope,
            "X-Tenant-Origin": "https://pilot.example",
            "X-Tenant-Secret": "s".repeat(40),
          },
          body: request.body,
        }),
      );
    }

    try {
      const data = new Map();
      const client = new BaseClient({
        device: "IOSIPAD",
        storage: {
          get: async (k) => data.get(k),
          set: async (k, v) => data.set(k, v),
        },
        fetch: async () => new Response("mock"),
      });
      const [secret, url] = client.e2ee.createSqrSecret();
      const key = crypto.randomBytes(32),
        iv = crypto.randomBytes(16);
      const enc = crypto.createCipheriv("aes-256-cbc", key, iv);
      const encrypted = Buffer.concat([
        enc.update(Buffer.from("worker-crypto-check")),
        enc.final(),
      ]);
      const dec = crypto.createDecipheriv("aes-256-cbc", key, iv);
      const plain = Buffer.concat([
        dec.update(encrypted),
        dec.final(),
      ]).toString();
      const seq = await Promise.all([client.getReqseq(), client.getReqseq()]);
      fs.mkdirSync("/tmp/compat", { recursive: true });
      fs.writeFileSync("/tmp/compat/state", "ok");
      const values = new Map([["session", { authToken: "fake-token" }]]);
      const runtime = new ManagedRuntime({
        scheduled: true,
        stateDir: "/tmp/compat-runtime",
        store: {
          get: async (k) => values.get(k) || null,
          put: async (k, v) => values.set(k, v),
        },
        clientFactory: () => ({
          profile: { mid: "u" + "a".repeat(32), displayName: "Test" },
          on() {},
          loginProcess: { async login() {} },
          talk: {
            async getAllContactIds() {
              return [];
            },
            async getAllChatMids() {
              return { memberChatMids: [] };
            },
          },
          square: {
            async fetchMyEvents() {
              return { events: [] };
            },
          },
        }),
        fetcher: async () =>
          Response.json({ success: true, data: { rooms: [] } }),
      });
      await runtime.bootstrap({
        harnessUrl: "https://tenant.invalid",
        connectorToken: "oc_" + "a".repeat(64),
      });
      await runtime.authTask;
      if (runtime.phase !== "connected")
        throw Error("Synthetic restore failed: " + runtime.lastError);
      const state = await runtime.step();
      await runtime.stop();
      const qr = await QRCode.toDataURL("line://synthetic-test");
      const [privateKey, publicKey] = client.e2ee.createSqrSecret(true);
      const pub = Buffer.from(publicKey, "base64");
      const shared = Buffer.from(
        client.e2ee.generateSharedSecret(privateKey, pub),
      );
      const to = "u" + "a".repeat(32),
        from = "u" + "b".repeat(32);
      const chunks = client.e2ee.encryptE2EETextMessage(
        1,
        2,
        shared,
        2,
        "暗号往復テスト",
        to,
        from,
      );
      const decrypted = client.e2ee.decryptE2EEMessageV2(
        to,
        from,
        chunks,
        privateKey,
        pub,
      );
      let tamperRejected = false;
      chunks[1][0] ^= 1;
      try {
        client.e2ee.decryptE2EEMessageV2(to, from, chunks, privateKey, pub);
      } catch {
        tamperRejected = true;
      }
      fs.mkdirSync("/tmp/media-check", { recursive: true });
      fs.writeFileSync(
        "/tmp/media-check/session.json",
        JSON.stringify({ authToken: "synthetic-only" }),
      );
      const bridge = bridgeModule.createBridge(
        {
          sessionPath: "/tmp/media-check/session.json",
          stateDir: "/tmp/media-check",
          chatIDs: ["mroom"],
          ephemeralFiles: true,
        },
        {
          loginProcess: { async login() {} },
          square: {
            async getSquareChat() {
              return {
                squareChat: {
                  state: "ALIVE",
                  name: "Synthetic",
                  squareMid: "square",
                },
                squareChatMember: { squareMemberMid: "pself" },
              };
            },
          },
          obs: {
            async uploadObjTalk(id, kind, blob) {
              await blob.arrayBuffer();
              return { objId: "123" };
            },
          },
        },
      );
      const media = await bridge.dispatch("sendMedia", {
        chatID: "mroom",
        requestID: "synthetic20m",
        kind: "file",
        filename: "test.bin",
        data: Buffer.alloc(20 * 1024 * 1024, 1).toString("base64"),
      });
      return Response.json({
        e2ee: decrypted.text === "暗号往復テスト",
        tamperRejected,
        media20MiB: media.messages[0].id === "123",
        runtime: state.phase,
        errorCode: state.errorCode,
        syncs: state.metrics.successfulSyncs,
        qr: qr.startsWith("data:image/png;base64,"),
        ok: secret.length > 0 && !!url && plain === "worker-crypto-check",
        seq,
        fs: fs.readFileSync("/tmp/compat/state", "utf8"),
        fetch: await (await client.fetch("https://example.invalid")).text(),
        createSquare: typeof client.square.createSquare,
      });
    } catch (e) {
      return Response.json(
        { error: e.message, stack: e.stack },
        { status: 500 },
      );
    }
  },
};
