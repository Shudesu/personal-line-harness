import { Hono } from 'hono';
import type { Env } from '../index.js';
import { PERSONAL_LINE_NOTICE, PERSONAL_LINE_NOTICE_VERSION } from '../../../../shared/personal-line-notice.js';

export const personalNotice = new Hono<Env>();
async function accepted(env: Env['Bindings']) {
  return !!await env.DB.prepare('SELECT version FROM personal_line_consents WHERE version=?').bind(PERSONAL_LINE_NOTICE_VERSION).first();
}
personalNotice.get('/api/personal-line/notice', async c => c.json({ success: true, data: { ...PERSONAL_LINE_NOTICE, accepted: await accepted(c.env) } }));
personalNotice.post('/api/personal-line/consent', async c => {
  const body = await c.req.json().catch(() => null);
  if (body?.version !== PERSONAL_LINE_NOTICE_VERSION || body?.accepted !== true) return c.json({ success: false, error: 'Notice confirmation required' }, 400);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(PERSONAL_LINE_NOTICE)))), b => b.toString(16).padStart(2,'0')).join('');
  await c.env.DB.prepare('INSERT OR IGNORE INTO personal_line_consents(version,notice_hash,accepted_at,accepted_by) VALUES(?,?,?,?)')
    .bind(PERSONAL_LINE_NOTICE_VERSION, hash, new Date().toISOString(), c.get('staff').id).run();
  return c.json({ success: true, data: { accepted: true, version: PERSONAL_LINE_NOTICE_VERSION } });
});
personalNotice.use('/api/openchat/*', async (c, next) => {
  const beginsConnection = c.req.method === 'POST' && /^\/api\/openchat\/(?:connectors|managed\/connectors(?:\/[^/]+\/(?:start|login))?)$/.test(c.req.path);
  if (beginsConnection && !await accepted(c.env)) return c.json({ success: false, error: 'Read and confirm the personal LINE notice in the connection screen', code: 'personal_line_notice_required', setupPath: '/console/personal', noticeVersion: PERSONAL_LINE_NOTICE_VERSION }, 409);
  await next();
});
