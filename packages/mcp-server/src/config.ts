export function getApiConfig() {
  const apiUrl = (process.env.PERSONAL_LINE_API_URL || process.env.LINE_HARNESS_API_URL)?.trim();
  const apiKey = (process.env.PERSONAL_LINE_API_KEY || process.env.LINE_HARNESS_API_KEY)?.trim();
  if (!apiUrl || !apiKey) throw Error('PERSONAL_LINE_API_URL and PERSONAL_LINE_API_KEY are required');
  const url = new URL(apiUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Use an HTTPS origin (HTTP permitted only on loopback)');
  return { apiUrl: url.origin, apiKey };
}
