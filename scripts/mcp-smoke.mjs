import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const client = new Client({ name: 'synthetic-check', version: '1' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/mcp.js'], env: { PATH: process.env.PATH || '', PERSONAL_LINE_API_URL: 'https://synthetic.invalid', PERSONAL_LINE_API_KEY: 'synthetic-unused' }, stderr: 'pipe' }));
  const { tools } = await client.listTools(); assert.equal(tools.length, 11);
  const r = await client.callTool({ name: 'send_personal_line_message', arguments: { roomId: 'synthetic', text: 'Not sent', requestId: 'synthetic', approved: false } });
  assert.equal(r.isError, true); console.log('stdio handshake, 11 tool schemas and unapproved-send rejection passed; no LINE calls.');
} finally { await client.close(); }
