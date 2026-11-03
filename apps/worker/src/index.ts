import { Hono } from 'hono';
import { openchat } from './routes/openchat.js';
import { managedOpenchat } from './routes/openchat-managed.js';
import { openchatAutomation } from './routes/openchat-automation.js';
export type Env = {
  Bindings: {
    DB: D1Database; IMAGES: R2Bucket; ASSETS: Fetcher; ADMIN_API_KEY: string;
    OPENCHAT_MANAGED_URL?: string; OPENCHAT_MANAGED_SECRET?: string; OPENCHAT_TENANT_ID?: string;
    OPENCHAT_AUTOMATION_ENABLED?: string; OPENCHAT_AI_URL?: string;
  };
  Variables: { staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' } };
};
const app = new Hono<Env>();
app.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
});
app.get('/health', c => c.json({ status: 'ok', product: 'personal-line-harness', version: '0.1.0-preview.1' }));
app.use('/api/*', async (c, next) => {
  // Cookie authentication is deliberately absent. Every request needs a bearer key;
  // cross-origin browser requests are rejected and no CORS grant is emitted.
  const origin = c.req.header('Origin');
  if (origin && origin !== new URL(c.req.url).origin) return c.json({ success: false, error: 'Forbidden origin' }, 403);
  const expected = c.env.ADMIN_API_KEY;
  const supplied = c.req.header('Authorization')?.replace(/^Bearer /, '');
  if (!expected || expected.length < 32 || !supplied || supplied.length > 512) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(expected), digest(supplied)]);
  let difference = 0; for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  if (difference) return c.json({ success: false, error: 'Unauthorized' }, 401);
  c.set('staff', { id: 'self-hosted-owner', name: 'Owner', role: 'owner' });
  await next();
});
// Connector callbacks verify their own scoped tokens inside the existing routes.
app.route('/', managedOpenchat);
app.route('/', openchatAutomation);
app.route('/', openchat);
app.get('/console/personal', c => c.env.ASSETS.fetch(new Request(new URL('/', c.req.url), c.req.raw)));
app.get('/', c => c.redirect('/console/personal', 302));
app.get('/setup.js', c => c.env.ASSETS.fetch(c.req.raw));
app.get('/style.css', c => c.env.ASSETS.fetch(c.req.raw));
app.notFound(c => c.json({ success: false, error: 'Not found' }, 404));
app.onError((_e, c) => c.json({ success: false, error: 'Request failed; inspect state before recovery' }, 503));
export default app;
