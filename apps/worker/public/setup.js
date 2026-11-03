const byId = id => document.getElementById(id);
let key = '';
let timer;
let deadline = 0;
let epoch = 0;
let noticeVersion = '';
let noticeAccepted = false;
const applyNoticeGate = () => { for (const id of ['prepare','start','login']) byId(id).disabled = !noticeAccepted; };
applyNoticeGate();
async function readNotice() {
 const data = await api('/api/personal-line/notice'); noticeVersion = data.version; noticeAccepted = data.accepted === true;
 byId('notice-title').textContent = data.title; byId('notice-text').replaceChildren();
 for (const section of data.sections) { const h = document.createElement('h3'); h.textContent = section.title; const paragraph = document.createElement('p'); paragraph.textContent = section.text; byId('notice-text').append(h, paragraph); }
 byId('notice-acknowledgement').textContent = data.acknowledgement; byId('notice-state').textContent = data.accepted ? '確認済みです。' : '接続前に内容を確認してください。';
 byId('notice-section').hidden = false; byId('accept-notice').hidden = data.accepted; byId('notice-agree').checked = false;
}
const clearAuth = () => { byId('auth').hidden = true; byId('qr').removeAttribute('src'); byId('pin').textContent = ''; };
const stop = () => { clearTimeout(timer); deadline = 0; };
async function api(path, method = 'GET', body) {
  if (!key) throw Error('管理APIキーを入力し、接続一覧を確認してください。');
  const response = await fetch(path, { method, redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(95000), headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok || result.success !== true) throw Error('処理を確認できません（HTTP ' + response.status + '）。状態を確認してから次の操作を選んでください。');
  return result.data;
}
function path() {
  const id = byId('connections').value;
  if (!id) throw Error('保存済みの接続を選んでください。');
  return '/api/openchat/managed/connectors/' + encodeURIComponent(id);
}
async function connections(selectId) {
  const rows = await api('/api/openchat/connectors');
  byId('connections').replaceChildren();
  for (const row of rows.filter(row => row.mode === 'managed' && row.enabled === 1)) {
    const option = document.createElement('option'); option.value = row.id; option.textContent = row.name; byId('connections').append(option);
  }
  if (selectId) byId('connections').value = selectId;
}
async function status() {
  const currentEpoch = epoch, currentId = byId('connections').value;
  const data = await api(path() + '/status');
  if (currentEpoch !== epoch || currentId !== byId('connections').value) return;
  clearAuth();
  byId('status').textContent = JSON.stringify({ phase: data.phase, accountName: data.accountName, errorCode: data.errorCode, lastSuccessAt: data.metrics?.lastSuccessAt }, null, 2);
  if (data.phase === 'awaiting_qr' && typeof data.qrImage === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.qrImage) && data.qrImage.length < 200000) { byId('qr').src = data.qrImage; byId('qr').hidden = false; byId('auth').hidden = false; }
  if (data.phase === 'awaiting_pin' && /^\d{4,12}$/.test(String(data.pin))) { byId('qr').hidden = true; byId('pin').textContent = '確認番号: ' + data.pin; byId('auth').hidden = false; }
  if (data.phase === 'connected') stop();
  return data;
}
function watch() {
  clearTimeout(timer);
  if (Date.now() >= deadline || document.hidden) return;
  timer = setTimeout(async () => { try { await status(); watch(); } catch (error) { stop(); byId('error').textContent = error.message; } }, 3000);
}
const act = (id, fn) => byId(id).addEventListener('click', async () => {
  const buttons = [...document.querySelectorAll('button')]; buttons.forEach(b => b.disabled = true); byId('error').textContent = '';
  try { await fn(); } catch (error) { stop(); byId('error').textContent = error.message; } finally { buttons.forEach(b => b.disabled = false); applyNoticeGate(); }
});
act('unlock', async () => { stop(); epoch++; clearAuth(); key = byId('key').value.trim(); byId('key').value = ''; await readNotice(); await connections(); });
act('forget', async () => { stop(); epoch++; key = ''; byId('key').value = ''; byId('connections').replaceChildren(); clearAuth(); byId('notice-section').hidden = true; noticeVersion = ''; noticeAccepted = false; byId('status').textContent = '終了しました。LINE接続自体は継続します。'; });
act('accept-notice', async () => { if (!byId('notice-agree').checked || !noticeVersion) throw Error('注意事項を確認してチェックしてください。'); await api('/api/personal-line/consent', 'POST', { version: noticeVersion, accepted: true }); await readNotice(); });
act('prepare', async () => { const data = await api('/api/openchat/managed/connectors', 'POST', { name: byId('name').value }); await connections(data.id); byId('status').textContent = '保存しました。注意事項を確認して接続を開始してください。'; });
act('refresh', status);
for (const action of ['start', 'login']) act(action, async () => {
  if (!byId('consent').checked) throw Error('接続開始への確認をチェックしてください。');
  const current = await status();
  if (current?.phase === 'connected') { byId('status').textContent = '認証済みです。QR認証は不要です。MCPから連携する会話を選んでください。'; return; }
  await api(path() + '/' + action, 'POST');
  await status(); deadline = Date.now() + 120000; watch();
});
byId('connections').addEventListener('change', () => { stop(); epoch++; clearAuth(); byId('status').textContent = '接続を選択しました。状態を確認してください。'; });
document.addEventListener('visibilitychange', () => { if (document.hidden) { stop(); clearAuth(); } });
