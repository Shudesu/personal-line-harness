import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2), values = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--api-origin', '--manager-origin', '--database-id', '--bucket'].includes(args[i]) || !args[i+1]) throw Error('Required: --api-origin --manager-origin --database-id --bucket');
  values[args[i].slice(2)] = args[i+1];
}
for (const key of ['api-origin', 'manager-origin']) {
  const u = new URL(values[key]);
  if (u.protocol !== 'https:' || u.pathname !== '/' || u.username || u.password || u.search || u.hash || u.hostname.endsWith('.example')) throw Error('Use your actual HTTPS origin: ' + key);
  values[key] = u.origin;
}
if (!/^[0-9a-f-]{36}$/i.test(values['database-id'] || '') || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(values.bucket || '')) throw Error('Valid new D1 database ID and R2 bucket required');
if (existsSync('.local/api-secrets.json') || existsSync('.local/manager-secrets.json')) throw Error('Secrets already exist; do not regenerate or rotate an existing installation blindly');
const secret = randomBytes(32).toString('hex');
const api = { ADMIN_API_KEY: randomBytes(32).toString('hex'), OPENCHAT_MANAGED_SECRET: secret };
const manager = { STATE_KEY_B64: randomBytes(32).toString('base64'), RUNTIME_KEY_B64: randomBytes(32).toString('base64'), SELF_HOSTED_TENANTS: JSON.stringify({ personal: { secretHash: createHash('sha256').update(secret).digest('hex'), origin: values['api-origin'] } }) };
const workerFile = 'apps/worker/wrangler.jsonc', managerFile = 'apps/openchat-manager/wrangler.worker.jsonc';
const workerConfig = JSON.parse(readFileSync(workerFile, 'utf8')), managerConfig = JSON.parse(readFileSync(managerFile, 'utf8'));
workerConfig.vars.OPENCHAT_MANAGED_URL = values['manager-origin']; workerConfig.d1_databases[0].database_id = values['database-id']; workerConfig.r2_buckets[0].bucket_name = values.bucket;
managerConfig.vars.PUBLIC_BASE_URL = values['manager-origin'];
mkdirSync('.local', { recursive: true, mode: 0o700 });
writeFileSync('.local/api-secrets.json', JSON.stringify(api, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
writeFileSync('.local/manager-secrets.json', JSON.stringify(manager, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
writeFileSync(workerFile, JSON.stringify(workerConfig, null, 2) + '\n'); writeFileSync(managerFile, JSON.stringify(managerConfig, null, 2) + '\n');
console.log('Prepared local settings and .local/{api,manager}-secrets.json. No remote changes. Keep these files private.');
