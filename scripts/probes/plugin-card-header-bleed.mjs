// Local CDP regression probe: settings plugin-card header bleed (2026-09-05).
// Asserts the settings toolbar rules (layout.css.ts) stay structurally anchored
// to the dialog toolbar and never touch plugin card headers in the Plugins
// section or the dsh-web-ui-all group pages. Run with the same env family as
// scripts/cdp-probe.mjs: DSH_PROBE_SESSION_ID, DSH_PROBE_URL (default
// http://127.0.0.1:3080/), DSH_PROBE_CHROME (default chromium),
// DSH_PROBE_TIMEOUT_MS.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const TMPDIR = join(HOME, 'tmp', 'bl');
const XDG = join(HOME, 'tmp', 'bx');
mkdirSync(TMPDIR, { recursive: true });
mkdirSync(XDG, { recursive: true });
mkdirSync(join(TMPDIR, 'p' + Date.now()), { recursive: true });

const results = [];
const pass = (name, detail = '') => { results.push({ status: 'PASS', name, detail }); console.log('PASS ' + name + (detail ? ' ' + detail : '')); };
const fail = (name, detail = '') => { results.push({ status: 'FAIL', name, detail }); console.log('FAIL ' + name + (detail ? ' ' + detail : '')); };
const check = (name, condition, detail = '') => (condition ? pass : fail)(name, detail);

function readConfig(env = process.env) {
  const sessionId = env.DSH_PROBE_SESSION_ID?.trim();
  if (!sessionId) throw new Error('DSH_PROBE_SESSION_ID is required');
  const parsedUrl = new URL(env.DSH_PROBE_URL || 'http://127.0.0.1:3080/');
  const timeoutMs = Number(env.DSH_PROBE_TIMEOUT_MS || 45000);
  return { url: parsedUrl.href, sessionId, chromePath: env.DSH_PROBE_CHROME || 'chromium', timeoutMs };
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(label + ' timed out');
}

const config = readConfig();
const port = await allocatePort();
const chrome = spawn(config.chromePath, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + join(TMPDIR, 'p' + Date.now()),
], { env: { ...process.env, TMPDIR, XDG_RUNTIME_DIR: XDG, HOME } });
let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/json');
    const pages = await res.json();
    const page = pages.find((p) => p.type === 'page');
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch {}
  await sleep(500);
}
if (!wsUrl) { console.log('FAIL chrome-boot: CDP endpoint never came up'); process.exitCode = 1; process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
};

try {
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage['dsh.sessions.current'] = JSON.stringify({sessionId:'" + config.sessionId + "'})" });
  await send('Page.navigate', { url: config.url });
  await waitFor('mobile frame', config.timeoutMs, () => evaluate("!!document.querySelector('[data-mobile-nav=frame]')"));
  await sleep(2500);
  await evaluate("(() => { document.querySelector('button.VOzbGW_trigger')?.click(); })()");
  await waitFor('settings dialog', config.timeoutMs, () => evaluate("!!document.querySelector('[aria-modal=true]')"));
  await evaluate("(() => { const c = [...document.querySelectorAll('button.VOzbGW_navCell')].find(b => (b.textContent||'').trim() === 'Plugins'); c?.click(); })()");
  await sleep(1500);

  const PROPS = "(el) => { const c = getComputedStyle(el); return { justify: c.justifyContent, gap: c.gap, padding: c.padding, minHeight: c.minHeight }; }";
  const plugs = await evaluate("(() => { const P = " + PROPS + "; const headers = [...document.querySelectorAll('[aria-modal=true] .YyYd_a_header')].map(P); const chevrons = [...document.querySelectorAll('[aria-modal=true] .YyYd_a_header > :last-child')].map(el => { const c = getComputedStyle(el); const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), radius: c.borderRadius, bg: c.backgroundColor }; }); const toolbar = document.querySelector('[aria-modal=true] .VOzbGW_header'); const tb = toolbar ? (() => { const c = getComputedStyle(toolbar); return { justify: c.justifyContent, parent: (toolbar.parentElement.className||'').toString().slice(0, 30) }; })() : null; const close = document.querySelector('[aria-modal=true] .VOzbGW_header > :last-child'); const cl = close ? (() => { const c = getComputedStyle(close); const r = close.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), radius: c.borderRadius, bg: c.backgroundColor }; })() : null; return { headers, chevrons, toolbar: tb, close: cl }; })()");
  check('boot.settings-dialog', !!plugs, 'modal opened');
  check('plugins.card-headers-count', plugs.headers?.length === 3, 'found ' + plugs.headers?.length);
  const cardOk = (h) => h && h.justify === 'normal' && h.gap === '12px' && h.padding === '14px 16px' && h.minHeight === '0px';
  check('plugins.card-headers-restored', plugs.headers?.every(cardOk), JSON.stringify(plugs.headers));
  const chevOk = (c) => c && c.w === 14 && c.h === 14 && (c.radius === '0px') && (c.bg === 'rgba(0, 0, 0, 0)');
  check('plugins.card-chevrons-restored', plugs.chevrons?.every(chevOk), JSON.stringify(plugs.chevrons));
  check('toolbar.still-flex-end', plugs.toolbar?.justify === 'flex-end', JSON.stringify(plugs.toolbar));
  check('toolbar.reparented-home', plugs.toolbar?.parent === 'VOzbGW_nav', 'parent=' + plugs.toolbar?.parent);
  check('toolbar.close-circle-kept', plugs.close?.w === 32 && plugs.close?.h === 32 && plugs.close?.radius === '50%' && plugs.close?.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(plugs.close));

  await evaluate("(() => { const c = [...document.querySelectorAll('button.VOzbGW_navCell')].find(b => (b.textContent||'').trim() === 'Web UI Plugins'); c?.click(); })()");
  await sleep(1500);
  const webui = await evaluate("(() => { const P = " + PROPS + "; const sel = (el) => /(Kwoi6G|bpnj3G|Jh0q7G|jmhvDG|rUBhvW)_header/.test(el.className); const headers = [...document.querySelectorAll('[aria-modal=true] [class*=_header]')].filter(sel).map(P); const chevrons = [...document.querySelectorAll('[aria-modal=true] [class*=_header] > :last-child')].filter(el => sel(el.parentElement)).map(el => { const c = getComputedStyle(el); const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), radius: c.borderRadius, bg: c.backgroundColor }; }); return { headers, chevrons }; })()");
  check('webui.card-headers-count', webui.headers?.length === 5, 'found ' + webui.headers?.length);
  check('webui.card-headers-restored', webui.headers?.every(cardOk), JSON.stringify(webui.headers));
  check('webui.card-chevrons-restored', webui.chevrons?.every(chevOk), JSON.stringify(webui.chevrons));
} catch (error) {
  fail('run', error.message);
} finally {
  try { ws.close(); } catch {}
  chrome.kill('SIGKILL');
}

const failCount = results.filter((r) => r.status === 'FAIL').length;
const passCount = results.filter((r) => r.status === 'PASS').length;
console.log('SUMMARY pass=' + passCount + ' fail=' + failCount + ' green=' + (failCount === 0));
process.exitCode = failCount === 0 ? 0 : 1;
