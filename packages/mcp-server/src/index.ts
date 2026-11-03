import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerPersonalLine } from './tools/personal-line.js';
import { getApiConfig } from './config.js';
getApiConfig();
const server = new McpServer({ name: 'personal-line-harness', version: '0.1.0-preview.1' });
registerPersonalLine(server);
await server.connect(new StdioServerTransport());
