import { build } from 'esbuild';
await build({entryPoints:['packages/mcp-server/src/index.ts'],outfile:'dist/mcp.js',bundle:true,platform:'node',format:'esm',target:'node22',packages:'external'});
