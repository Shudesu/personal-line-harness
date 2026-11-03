import { afterEach, describe, expect, test, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerPersonalLine } from '../packages/mcp-server/src/tools/personal-line.js';
const resources: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of resources.splice(0)) await close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function fixture(responses: unknown[] = []) {
  vi.stubEnv('PERSONAL_LINE_API_URL', 'https://personal.example'); vi.stubEnv('PERSONAL_LINE_API_KEY', 'synthetic-owner-key');
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => { const next = responses.shift(); if (next instanceof Error) throw next; return next instanceof Response ? next : Response.json({ success: true, data: next }); });
  vi.stubGlobal('fetch', fetcher);
  const server = new McpServer({ name: 'test', version: '1' }); registerPersonalLine(server);
  const client = new Client({ name: 'test-client', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  resources.push(async () => { await client.close(); await server.close(); });
  return { client, fetcher, call: (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) };
}
const room = { id: 'chat1', kind: 'personal', enabled: 1, connector_enabled: 1, name: 'Chosen chat' };
describe('personal LINE over the actual MCP transport', () => {
  test('publishes 11 tools with read/write annotations', async () => {
    const x = await fixture(); const { tools } = await x.client.listTools(); expect(tools).toHaveLength(11);
    expect(tools.find(t => t.name === 'get_personal_line_messages')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find(t => t.name === 'send_personal_line_message')?.annotations?.readOnlyHint).toBe(false);
    expect(x.fetcher).not.toHaveBeenCalled();
  });
  test.each([undefined, false])('rejects send without explicit approval (%s), before HTTP', async approved => {
    const x = await fixture(); const r = await x.call('send_personal_line_message', { roomId: 'chat1', text: 'hello', requestId: 'req-1', ...(approved === undefined ? {} : { approved }) });
    expect(r.isError).toBe(true); expect(x.fetcher).not.toHaveBeenCalled();
  });
  test.each([' ', 'あ'.repeat(1667)])('rejects empty or excessive UTF-8 text before HTTP', async text => {
    const x = await fixture(); expect((await x.call('send_personal_line_message', { roomId: 'chat1', text, requestId: 'req-1', approved: true })).isError).toBe(true); expect(x.fetcher).not.toHaveBeenCalled();
  });
  test('filters OpenChat and strips message previews from discovery', async () => {
    const x = await fixture([[{ ...room, preview: 'PRIVATE_BODY', token: 'PRIVATE_TOKEN' }, { id: 'openchat', kind: 'room', name: 'Other room' }]]);
    const r = await x.call('list_personal_line_chats'); const text = JSON.stringify(r); expect(text).toContain('Chosen chat'); expect(text).not.toMatch(/PRIVATE_|Other room/); expect(x.fetcher).toHaveBeenCalledTimes(1);
  });
  test.each([{ ...room, kind: 'room' }, { ...room, enabled: 0 }, { ...room, connector_enabled: 0 }])('does not send to wrong-kind/disabled rooms', async target => {
    const x = await fixture([[target]]); const r = await x.call('send_personal_line_message', { roomId: 'chat1', text: 'Approved', requestId: 'req-1', approved: true }); expect(r.isError).toBe(true); expect(x.fetcher).toHaveBeenCalledTimes(1); expect(x.fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET' });
  });
  test('queues exactly once and preserves content/request identity without claiming delivery', async () => {
    const x = await fixture([[room], { id: 'job1', state: 'queued' }]); const r = await x.call('send_personal_line_message', { roomId: 'chat1', text: 'Approved', requestId: 'req-1', approved: true });
    expect(r.isError).toBeUndefined(); expect(JSON.stringify(r)).toContain('queued'); expect(x.fetcher).toHaveBeenCalledTimes(2);
    expect(x.fetcher.mock.calls[1]).toEqual(['https://personal.example/api/openchat/rooms/chat1/messages', expect.objectContaining({ method: 'POST', redirect: 'manual', body: JSON.stringify({ text: 'Approved', requestId: 'req-1' }) })]);
  });
  test('uncertain send is not replayed and does not expose the error or bearer', async () => {
    const x = await fixture([[room], Error('PRIVATE_TRANSPORT_SECRET')]); const r = await x.call('send_personal_line_message', { roomId: 'chat1', text: 'Approved', requestId: 'req-1', approved: true }); expect(r.isError).toBe(true); expect(x.fetcher).toHaveBeenCalledTimes(2); expect(JSON.stringify(r)).not.toContain('PRIVATE_TRANSPORT_SECRET');
  });
  test('does not reset a connected account or reveal QR, PIN or tokens', async () => {
    const x = await fixture([{ phase: 'connected', qrImage: 'PRIVATE_QR', pin: 'PRIVATE_PIN', token: 'PRIVATE_TOKEN', metrics: { lastSuccessAt: 123, authToken: 'PRIVATE_TOKEN' } }]);
    const r = await x.call('request_personal_line_login', { connectorId: 'conn1', approved: true }); expect(x.fetcher).toHaveBeenCalledTimes(1); expect(JSON.stringify(r)).toContain('alreadyConnected'); expect(JSON.stringify(r)).not.toContain('PRIVATE_');
  });
  test('authorization failure stops all dependent operations', async () => {
    const x = await fixture([Response.json({ error: 'PRIVATE_ERROR' }, { status: 403 })]); const r = await x.call('send_personal_line_message', { roomId: 'chat1', text: 'hello', requestId: 'req-1', approved: true }); expect(r.isError).toBe(true); expect(x.fetcher).toHaveBeenCalledTimes(1); expect(JSON.stringify(r)).not.toContain('PRIVATE_ERROR');
  });
  test('encodes connector IDs and does not follow redirect responses', async () => {
    const x = await fixture([new Response(null, { status: 302, headers: { location: 'https://other.example' } })]); const r = await x.call('get_personal_line_connection_status', { connectorId: '../x' }); expect(r.isError).toBe(true); expect(x.fetcher).toHaveBeenCalledTimes(1); expect(x.fetcher.mock.calls[0][0]).toContain('..%2Fx/status'); expect(x.fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });
});
