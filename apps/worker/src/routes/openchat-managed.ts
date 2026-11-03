import { Hono, type Context } from "hono";
import type { Env } from "../index.js";
import { requireRole } from "../middleware/role-guard.js";

type Managed = {
  id: string;
  enabled: number;
  mode: string;
  managed_token: string | null;
};
export const managedOpenchat = new Hono<Env>();
const hash = async (s: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
const keyToken = (prefix: string) =>
  prefix +
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
const ok = (c: Context<Env>, data: unknown) =>
  c.json({ success: true, data }, 200, { "Cache-Control": "no-store" });
const fail = (
  c: Context<Env>,
  error: string,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 503 = 503,
) => c.json({ success: false, error }, status, { "Cache-Control": "no-store" });
function configured(env: Env["Bindings"]) {
  return !!(
    env.OPENCHAT_MANAGED_URL &&
    env.OPENCHAT_MANAGED_SECRET &&
    env.OPENCHAT_TENANT_ID
  );
}
async function vault(
  env: Env["Bindings"],
  id: string,
  value: string,
  decrypt = false,
) {
  if (!configured(env)) throw Error("Managed hosting is unavailable");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.OPENCHAT_MANAGED_SECRET),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(env.OPENCHAT_TENANT_ID),
      info: new TextEncoder().encode("openchat-connector-token-v1"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const aad = new TextEncoder().encode(id);
  if (decrypt) {
    const [iv, encrypted] = JSON.parse(value) as string[];
    const decode = (s: string) =>
      Uint8Array.from(atob(s), (x) => x.charCodeAt(0));
    return new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: decode(iv), additionalData: aad },
        key,
        decode(encrypted),
      ),
    );
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    new TextEncoder().encode(value),
  );
  const encode = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  return JSON.stringify([encode(iv), encode(new Uint8Array(encrypted))]);
}
export async function managedRequest(
  env: Env["Bindings"],
  id: string,
  suffix = "",
  method = "GET",
  body?: BodyInit,
  extra?: Record<string, string>,
) {
  if (!configured(env)) throw Error("Managed hosting is unavailable");
  const url = new URL(env.OPENCHAT_MANAGED_URL!);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw Error("Invalid managed origin");
  return fetch(url.origin + "/v1/sessions/" + encodeURIComponent(id) + suffix, {
    method,
    headers: {
      Authorization: "Bearer " + env.OPENCHAT_MANAGED_SECRET,
      "X-Tenant-ID": env.OPENCHAT_TENANT_ID!,
      "Content-Type": "application/json",
      ...extra,
    },
    ...(body === undefined ? {} : { body }),
    redirect: "manual",
    signal: AbortSignal.timeout(90000),
  });
}
export async function cleanupManaged(env: Env["Bindings"], id: string) {
  const row = await env.DB.prepare(
    "SELECT mode FROM openchat_connectors WHERE id=?",
  )
    .bind(id)
    .first<{ mode: string }>();
  if (row?.mode !== "managed") return true;
  await env.DB.prepare(
    "UPDATE openchat_connectors SET bridge_token_hash=NULL,managed_token=NULL,cleanup_pending=1 WHERE id=?",
  )
    .bind(id)
    .run();
  try {
    const response = await managedRequest(env, id, "", "DELETE");
    if (!response.ok) return false;
    await env.DB.prepare(
      "UPDATE openchat_connectors SET cleanup_pending=0 WHERE id=?",
    )
      .bind(id)
      .run();
    return true;
  } catch {
    return false;
  }
}
managedOpenchat.onError((_err, c) =>
  fail(c, "Cloud接続を確認できません。接続を再開して状態を確認してください。"),
);
managedOpenchat.get("/api/openchat/hosting", (c) =>
  ok(c, {
    managedAvailable: configured(c.env),
    automationAvailable: c.env.OPENCHAT_AUTOMATION_ENABLED === 'true',
    personalTalks: configured(c.env),
    loginMethod: 'ipad',
    defaultMode: configured(c.env) ? "managed" : "external",
  }),
);
managedOpenchat.post(
  "/api/openchat/managed/connectors",
  requireRole("owner", "admin"),
  async (c) => {
    if (!configured(c.env))
      return fail(c, "Cloud接続はこの環境では有効になっていません", 409);
    const b = await c.req.json<{ name: string }>();
    if (!b.name?.trim() || b.name.length > 100)
      return fail(c, "接続名を入力してください", 400);
    let row = await c.env.DB.prepare(
      "SELECT id,enabled,mode,managed_token FROM openchat_connectors WHERE mode='managed' AND enabled=1",
    ).first<Managed>();
    if (!row) {
      const id = crypto.randomUUID(),
        token = keyToken("oc_");
      await c.env.DB.prepare(
        "INSERT OR IGNORE INTO openchat_connectors(id,name,token_hash,created_at,created_by,mode,managed_token) VALUES(?,?,?,?,?,'managed',?)",
      )
        .bind(
          id,
          b.name.trim(),
          await hash(token),
          new Date().toISOString(),
          c.get("staff").id,
          await vault(c.env, id, token),
        )
        .run();
      row = await c.env.DB.prepare(
        "SELECT id,enabled,mode,managed_token FROM openchat_connectors WHERE mode='managed' AND enabled=1",
      ).first<Managed>();
    }
    if (!row?.managed_token) return fail(c, "接続の準備に失敗しました");
    // Return the same ID if startup failed. A retry bootstraps this session, never a second account.
    return ok(c, { id: row.id, mode: "managed" });
  },
);
async function managedRow(c: Context<Env>) {
  return c.env.DB.prepare(
    "SELECT id,enabled,mode,managed_token FROM openchat_connectors WHERE id=? AND mode='managed' AND enabled=1",
  )
    .bind(c.req.param("id"))
    .first<Managed>();
}
managedOpenchat.post(
  "/api/openchat/managed/connectors/:id/start",
  requireRole("owner", "admin"),
  async (c) => {
    const row = await managedRow(c);
    if (!row?.managed_token) return fail(c, "接続が見つかりません", 404);
    const response = await managedRequest(
      c.env,
      row.id,
      "",
      "POST",
      JSON.stringify({
        connectorToken: await vault(c.env, row.id, row.managed_token, true),
      }),
    );
    if (!response.ok)
      return fail(
        c,
        "Cloud接続の起動に失敗しました。再開ボタンから再試行できます。",
      );
    return ok(c, await response.json());
  },
);
managedOpenchat.get(
  "/api/openchat/managed/connectors/:id/status",
  requireRole("owner", "admin"),
  async (c) => {
    const row = await managedRow(c);
    if (!row) return fail(c, "接続が見つかりません", 404);
    const response = await managedRequest(c.env, row.id, "/status");
    if (!response.ok)
      return fail(
        c,
        "Cloud接続の状態を取得できません。再開ボタンから起動できます。",
      );
    return ok(c, await response.json());
  },
);
managedOpenchat.post(
  "/api/openchat/managed/connectors/:id/login",
  requireRole("owner", "admin"),
  async (c) => {
    const row = await managedRow(c);
    if (!row) return fail(c, "接続が見つかりません", 404);
    const response = await managedRequest(c.env, row.id, "/login", "POST");
    if (!response.ok)
      return fail(c, "QRを発行できません。接続を再開してください。");
    return ok(c, await response.json());
  },
);
managedOpenchat.post(
  "/api/openchat/managed/connectors/:id/bridge-key",
  requireRole("owner", "admin"),
  async (c) => {
    const row = await managedRow(c);
    if (!row) return fail(c, "接続が見つかりません", 404);
    const token = keyToken("ocb_");
    await c.env.DB.prepare(
      "UPDATE openchat_connectors SET bridge_token_hash=? WHERE id=? AND enabled=1",
    )
      .bind(await hash(token), row.id)
      .run();
    return ok(c, {
      connectorId: row.id,
      token,
      rpcPath: "/openchat-bridge/" + row.id + "/rpc",
    });
  },
);
managedOpenchat.get("/openchat-connector/self", async (c) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer /, "") || "";
  if (!/^oc_[a-f0-9]{64}$/.test(token)) return fail(c, "Unauthorized", 401);
  const row = await c.env.DB.prepare(
    "SELECT id,mode FROM openchat_connectors WHERE token_hash=? AND enabled=1",
  )
    .bind(await hash(token))
    .first();
  return row ? ok(c, row) : fail(c, "Unauthorized", 401);
});
managedOpenchat.post("/openchat-bridge/:id/rpc", async (c) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer /, "") || "";
  if (!/^ocb_[a-f0-9]{64}$/.test(token)) return fail(c, "Unauthorized", 401);
  const row = await c.env.DB.prepare(
    "SELECT id FROM openchat_connectors WHERE id=? AND bridge_token_hash=? AND enabled=1 AND mode='managed'",
  )
    .bind(c.req.param("id"), await hash(token))
    .first<{ id: string }>();
  if (!row) return fail(c, "Unauthorized", 401);
  if (Number(c.req.header("Content-Length") || 0) > 29 * 1024 * 1024)
    return fail(c, "Attachment too large", 413);
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).length > 29 * 1024 * 1024)
    return fail(c, "Attachment too large", 413);
  const b = JSON.parse(raw) as {
    method: string;
    params?: { chatID?: string; requestID?: string };
  };
  if (!["list", "events", "send", "sendMedia", "getMedia"].includes(b.method))
    return fail(c, "Invalid RPC method", 400);
  const allowed = (
    await c.env.DB.prepare(
      "SELECT external_id FROM openchat_rooms WHERE connector_id=? AND enabled=1 AND kind IN ('room','thread') ORDER BY external_id LIMIT 100",
    )
      .bind(row.id)
      .all<{ external_id: string }>()
  ).results.map((r) => r.external_id).filter((id) => /^[mt][a-f0-9]{32}$/.test(id));
  if (b.method !== "list" && !allowed.includes(b.params?.chatID || ""))
    return fail(c, "Room is not enabled", 403);
  if (
    ["send", "sendMedia"].includes(b.method) &&
    (!b.params?.requestID || b.params.requestID.length > 200)
  )
    return fail(c, "Stable requestID is required", 400);
  const response = await managedRequest(c.env, row.id, "/rpc", "POST", raw, {
    "X-Openchat-Method": b.method,
    "X-Openchat-Allowed": JSON.stringify(allowed),
  });
  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
});

managedOpenchat.post('/api/openchat/managed/connectors/:id/create-room', requireRole('owner','admin'), async c => {
  if(c.env.OPENCHAT_AUTOMATION_ENABLED!=='true')return fail(c,'オプチャ作成はこの環境では準備中です',409);
  const row=await managedRow(c);if(!row)return fail(c,'接続が見つかりません',404);
  const b=await c.req.json<{operationId:string;name:string;displayName:string;description:string;approved:boolean}>();
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(b.operationId||'')||typeof b.name!=='string'||!b.name.trim()||b.name.length>50||typeof b.displayName!=='string'||!b.displayName.trim()||b.displayName.length>20||typeof b.description!=='string'||b.description.length>1000||b.approved!==true)return fail(c,'作成内容と実際に作成することへの確認が必要です',400);
  const payload={operationId:b.operationId,name:b.name.trim(),displayName:b.displayName.trim(),description:b.description,approved:true};
  const signature=await hash(JSON.stringify(payload));
  const old=await c.env.DB.prepare('SELECT * FROM openchat_creations WHERE id=?').bind(b.operationId).first<{connector_id:string;body_hash:string;status:string;room_id:string}>();
  if(old&&(old.connector_id!==row.id||old.body_hash!==signature))return fail(c,'同じ作成番号の内容を変更できません',409);
  if(old?.status==='linked')return ok(c,{roomId:old.room_id,status:'linked'});
  const at=new Date().toISOString();
  await c.env.DB.prepare("INSERT OR IGNORE INTO openchat_creations(id,connector_id,body_hash,status,created_at) VALUES(?,?,?,'pending',?)").bind(b.operationId,row.id,signature,at).run();
  const response=await managedRequest(c.env,row.id,'/create-room','POST',JSON.stringify(payload));
  if(!response.ok){await c.env.DB.prepare("UPDATE openchat_creations SET status='unknown' WHERE id=?").bind(b.operationId).run();return fail(c,'作成結果を確認できません。同じ作成内容・番号のまま確認し直してください。新しい番号で作り直すと重複する場合があります。',409)}
  const result=await response.json<{squareMid:string;chatMid:string;name:string}>();
  if(!/^s[a-f0-9]{32}$/.test(result.squareMid)||!/^m[a-f0-9]{32}$/.test(result.chatMid))return fail(c,'作成結果を確認できません',409);
  const roomId=await hash(row.id+'\0'+result.chatMid);
  const active=await c.env.DB.prepare('SELECT enabled FROM openchat_connectors WHERE id=? AND enabled=1').bind(row.id).first();
  if(!active){await c.env.DB.prepare("UPDATE openchat_creations SET status='created_unlinked',square_mid=?,chat_mid=? WHERE id=?").bind(result.squareMid,result.chatMid,b.operationId).run();return fail(c,'部屋は作成されましたが、接続停止のため自動連携していません。',409)}
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO openchat_rooms(id,connector_id,external_id,name,kind,enabled,enabled_at) SELECT ?,?,?,?,'room',1,? WHERE EXISTS(SELECT 1 FROM openchat_connectors WHERE id=? AND enabled=1) ON CONFLICT(connector_id,external_id) DO UPDATE SET enabled=1,enabled_at=excluded.enabled_at WHERE EXISTS(SELECT 1 FROM openchat_connectors WHERE id=? AND enabled=1)").bind(roomId,row.id,result.chatMid,result.name,at,row.id,row.id),
    c.env.DB.prepare("UPDATE openchat_creations SET status='linked',square_mid=?,chat_mid=?,room_id=? WHERE id=? AND EXISTS(SELECT 1 FROM openchat_rooms WHERE id=? AND enabled=1)").bind(result.squareMid,result.chatMid,roomId,b.operationId,roomId),
  ]);
  return ok(c,{roomId,status:'linked'});
});

// Inspect an existing creation only. This route cannot create a room or re-send a creation request.
managedOpenchat.get('/api/openchat/managed/connectors/:id/creations/:operationId',requireRole('owner','admin'),async c=>{
  const row=await managedRow(c);if(!row)return fail(c,'接続が見つかりません',404);
  const operationId=c.req.param('operationId')??'';
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId))return fail(c,'作成番号が不正です',400);
  const created=await c.env.DB.prepare('SELECT status,room_id,square_mid,chat_mid FROM openchat_creations WHERE id=? AND connector_id=?').bind(operationId,row.id).first<{status:string;room_id:string|null;square_mid:string|null;chat_mid:string|null}>();
  if(!created)return fail(c,'作成記録が見つかりません',404);
  if(created.status!=='linked')return ok(c,{status:created.status,roomId:created.room_id,invitationStatus:'creation_needs_review'});
  const response=await managedRequest(c.env,row.id,'/creation-status','POST',JSON.stringify({operationId}));
  if(!response.ok)return ok(c,{status:'linked',roomId:created.room_id,invitationStatus:'unavailable'});
  const result=await response.json<{status:string;squareMid?:string;chatMid?:string;invitationUrl?:string;invitationStatus?:string}>();
  if(result.status!=='created'||result.squareMid!==created.square_mid||result.chatMid!==created.chat_mid)return fail(c,'作成記録の照合が必要です',409);
  let invitationUrl:string|undefined;
  try {const url=new URL(result.invitationUrl??'');if(url.protocol==='https:'&&!url.username&&!url.password&&url.hostname==='line.me'&&url.pathname.startsWith('/ti/g2/'))invitationUrl=url.href;}catch{}
  return ok(c,{status:'linked',roomId:created.room_id,...(invitationUrl?{invitationUrl}:{}),invitationStatus:invitationUrl?'available':'unavailable'});
});
