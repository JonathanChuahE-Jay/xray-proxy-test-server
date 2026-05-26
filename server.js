'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PROXY_PING_PORT || process.env.PORT || 8791);
const HOST = process.env.PROXY_PING_HOST || '0.0.0.0';
const DATA_DIR = process.env.PROXY_PING_DATA_DIR || path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'proxy-pings.jsonl');
const MAX_BODY_BYTES = Number(process.env.PROXY_PING_MAX_BODY_BYTES || 32 * 1024);
const SHARED_SECRET = process.env.PROXY_PING_SECRET || '';
const STALE_AFTER_MS = Number(process.env.PROXY_PING_STALE_AFTER_MS || 2 * 60 * 1000);

fs.mkdirSync(DATA_DIR, { recursive: true });

const devices = new Map();
const clients = new Set();

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-ping-secret'
  });
  res.end(JSON.stringify(payload));
}

function safeString(value, max = 512) {
  if (value === undefined || value === null) return undefined;
  return String(value).slice(0, max);
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function snapshot() {
  const now = Date.now();
  return Array.from(devices.values())
    .sort((a, b) => b.last_seen - a.last_seen)
    .map(d => ({
      ...d,
      stale: now - d.last_seen > STALE_AFTER_MS,
      seconds_since_seen: Math.round((now - d.last_seen) / 1000),
      last_seen_iso: new Date(d.last_seen).toISOString()
    }));
}

function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch (_) { clients.delete(res); }
  }
}

function html() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Xray Proxy Ping</title><style>
body{font-family:system-ui,Segoe UI,Arial,sans-serif;background:#0f172a;color:#e5e7eb;margin:0;padding:24px}h1{margin:0 0 8px}.muted{color:#94a3b8}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-top:18px}.card{background:#111827;border:1px solid #334155;border-radius:14px;padding:16px;box-shadow:0 8px 30px #0004}.ok{color:#22c55e}.bad{color:#ef4444}.ping{font-size:34px;font-weight:800}.mono{font-family:ui-monospace,Consolas,monospace;white-space:pre-wrap;font-size:13px;background:#020617;padding:10px;border-radius:10px;overflow:auto}small{color:#94a3b8}</style></head><body>
<h1>🍌 Xray Proxy Live Ping</h1><div class="muted">Waiting for APK reports on <code>POST /proxy-ping</code>. This page updates live.</div><div id="devices" class="grid"></div>
<script>
const el=document.getElementById('devices');
function esc(s){return String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function card(d){
 return '<div class="card"><div><b>'+esc(d.device_id||d.ip||'device')+'</b> <span class="'+(d.stale?'bad':'ok')+'">● '+(d.stale?'stale':'live')+'</span></div><div class="ping">'+(d.best_ping_ms!=null?esc(d.best_ping_ms)+' ms':'—')+'</div><div>'+esc(d.best_ip||'No active IP')+(d.active_port?':'+esc(d.active_port):'')+'</div><small>'+esc(d.event||'proxy_ping')+' • '+esc(d.manufacturer||'')+' '+esc(d.model||'')+' • '+esc(d.app_version||'-')+' • '+esc(d.ip||'-')+' • '+esc(d.seconds_since_seen)+'s ago</small><div class="mono">'+esc(d.ping_results||'')+'</div></div>';
}
function render(list){if(!list.length){el.innerHTML='<div class="card muted">No devices yet.</div>';return;} el.innerHTML=list.map(card).join('');}
async function load(){const r=await fetch('/status'); const j=await r.json(); render(j.devices||[]);} load();
const es=new EventSource('/events'); es.addEventListener('snapshot',e=>render(JSON.parse(e.data).devices||[])); es.onerror=()=>setTimeout(load,2000);
setInterval(load,30000);
</script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html());
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, service: 'xray-proxy-ping-server', time: new Date().toISOString() });
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      return sendJson(res, 200, { ok: true, devices: snapshot() });
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'access-control-allow-origin': '*' });
      clients.add(res);
      res.write(`event: snapshot\ndata: ${JSON.stringify({ devices: snapshot() })}\n\n`);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/proxy-ping') {
      if (SHARED_SECRET && req.headers['x-ping-secret'] !== SHARED_SECRET) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      const raw = await readBody(req);
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
      const entry = {
        received_at: new Date().toISOString(),
        event: safeString(body.event || 'proxy_ping', 64),
        device_id: safeString(body.app_instance_id || body.device_id, 128),
        app_version: safeString(body.app_version, 64),
        platform: safeString(body.platform || 'android', 32),
        package: safeString(body.package, 128),
        manufacturer: safeString(body.manufacturer, 128),
        model: safeString(body.model, 128),
        active_tag: safeString(body.active_tag, 256),
        best_ip: safeString(body.best_ip, 128),
        best_ping_ms: safeNumber(body.best_ping_ms),
        active_port: safeNumber(body.active_port),
        fetch_source: safeString(body.fetch_source, 256),
        ping_results: safeString(body.ping_results, 4096),
        device_time: safeString(body.device_time, 64),
        ip: clientIp(req),
        user_agent: safeString(req.headers['user-agent'], 256)
      };
      fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
      const key = entry.device_id || entry.ip || 'unknown';
      devices.set(key, { ...entry, key, last_seen: Date.now() });
      console.log(`📡 ${new Date().toLocaleTimeString()} ${entry.best_ip || '-'} ${entry.best_ping_ms ?? '-'}ms ${key}`);
      broadcast('snapshot', { devices: snapshot() });
      return sendJson(res, 202, { ok: true });
    }
    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    return sendJson(res, err.status || 500, { ok: false, error: err.message || 'server error' });
  }
});

setInterval(() => broadcast('snapshot', { devices: snapshot() }), 15000).unref();
server.listen(PORT, HOST, () => {
  console.log(`🚀 proxy ping dashboard http://${HOST}:${PORT}`);
  console.log(`📝 log ${LOG_FILE}`);
  if (!SHARED_SECRET) console.warn('⚠️  no secret; /proxy-ping is open');
});
