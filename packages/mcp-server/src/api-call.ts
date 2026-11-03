import { getApiConfig } from './config.js';
export interface ApiCallResult { ok: boolean; status: number; data: unknown }
export async function apiCall(path: string, method = 'GET', body?: unknown): Promise<ApiCallResult> {
  const { apiUrl, apiKey } = getApiConfig();
  try {
    const r = await fetch(`${apiUrl}${path}`, {
      method, redirect: 'manual', signal: AbortSignal.timeout(95000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!r.ok) {
      const error = await r.json().catch(() => null) as {code?:string}|null;
      if(error?.code==='personal_line_notice_required')return {ok:false,status:r.status,data:{success:false,error:'Confirm the personal LINE notice in the connection screen before starting authentication.',setupPath:'/console/personal'}};
      return { ok: false, status: r.status, data: { success: false, error: `HTTP ${r.status}`, hint: r.status === 404 ? 'This workspace may not support personal LINE. Check the installed version; do not guess alternative IDs.' : 'Check authorization and connection status. A failed or uncertain response must not trigger automatic replay.' } };
    }
    const data = await r.json() as { success?: boolean };
    if (data?.success !== true) return { ok: false, status: 502, data: { success: false, error: 'Invalid API response; no automatic retry' } };
    return { ok: true, status: r.status, data };
  } catch {
    return { ok: false, status: 503, data: { success: false, error: 'Request outcome unavailable. Read status before recovery; do not automatically repeat or change requestId.' } };
  }
}
export function toToolResult(r: ApiCallResult) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(r.data, null, 2) }], ...(r.ok ? {} : { isError: true as const }) };
}
