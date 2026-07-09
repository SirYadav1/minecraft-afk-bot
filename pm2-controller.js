const WebSocket = require('ws');
const pm2 = require('pm2');
const fs = require('fs');
const path = require('path');

const WS_PORT = 3001;
const BOT_PM2_NAME = 'minecraft-afk-bot';
const BOT_SCRIPT = 'index.js';
const EDITABLE_DIR = __dirname;

let botStatus = 'stopped';
const connectedClients = new Set();

const wss = new WebSocket.Server({ port: WS_PORT });

function sendRaw(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connectPM2() {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function startBot() {
  return new Promise((resolve, reject) => {
    if (botStatus === 'running' || botStatus === 'online') return resolve('already running');
    pm2.start({
      name: BOT_PM2_NAME,
      script: BOT_SCRIPT,
      cwd: __dirname,
      watch: false,
      max_memory_restart: '500M',
      env: { NODE_ENV: 'production' }
    }, (err, proc) => {
      if (err) { botStatus = 'stopped'; reject(err); }
      else { botStatus = 'running'; broadcastStatus(); resolve('started'); }
    });
  });
}

function stopBot() {
  return new Promise((resolve, reject) => {
    if (botStatus === 'stopped' || botStatus === 'offline') return resolve('already stopped');
    pm2.stop(BOT_PM2_NAME, (err) => {
      if (err) reject(err);
      else { botStatus = 'stopped'; broadcastStatus(); resolve('stopped'); }
    });
  });
}

function restartBot() {
  return new Promise((resolve, reject) => {
    pm2.restart(BOT_PM2_NAME, (err) => {
      if (err) reject(err);
      else { broadcastStatus(); resolve('restarted'); }
    });
  });
}

function getBotStatus() {
  return new Promise((resolve) => {
    pm2.describe(BOT_PM2_NAME, (err, proc) => {
      if (err || !proc || proc.length === 0) {
        botStatus = 'stopped';
        resolve({ status: 'stopped', pid: null, uptime: 0 });
      } else {
        const p = proc[0];
        botStatus = p.pm2_env.status;
        resolve({
          status: p.pm2_env.status,
          pid: p.pid,
          uptime: Date.now() - (p.pm2_env.pm_uptime || Date.now()),
          memory: p.monit ? p.monit.memory : 0,
          cpu: p.monit ? p.monit.cpu : 0
        });
      }
    });
  });
}

function broadcastStatus() {
  getBotStatus().then(status => {
    const msg = JSON.stringify({ type: 'status', data: status });
    connectedClients.forEach(ws => ws.send(msg));
  });
}

function safePath(filename) {
  const full = path.resolve(EDITABLE_DIR, filename);
  if (!full.startsWith(EDITABLE_DIR)) return null;
  return full;
}

function listFiles() {
  try {
    return fs.readdirSync(EDITABLE_DIR).filter(f => {
      const ext = path.extname(f);
      const allowed = ['.js', '.json', '.html', '.css', '.txt', '.md', '.env'];
      return allowed.includes(ext) && fs.statSync(path.join(EDITABLE_DIR, f)).isFile();
    }).sort();
  } catch (e) { return []; }
}

function readFile(filename) {
  const full = safePath(filename);
  if (!full) throw new Error('Invalid path');
  return fs.readFileSync(full, 'utf8');
}

function writeFile(filename, content) {
  const full = safePath(filename);
  if (!full) throw new Error('Invalid path');
  fs.writeFileSync(full, content, 'utf8');
  return true;
}

wss.on('connection', (ws) => {
  console.log(`[WS] Client connected (${connectedClients.size + 1} total)`);
  connectedClients.add(ws);

  getBotStatus().then(status => sendRaw(ws, { type: 'status', data: status }));

  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch (e) { return; }

    try {
      switch (data.action) {
        case 'start':
          await startBot();
          sendRaw(ws, { type: 'result', action: 'start', success: true });
          break;
        case 'stop':
          await stopBot();
          sendRaw(ws, { type: 'result', action: 'stop', success: true });
          break;
        case 'restart':
          await restartBot();
          sendRaw(ws, { type: 'result', action: 'restart', success: true });
          break;
        case 'status':
          sendRaw(ws, { type: 'status', data: await getBotStatus() });
          break;
        case 'files':
          sendRaw(ws, { type: 'files', data: listFiles() });
          break;
        case 'read':
          try {
            sendRaw(ws, { type: 'file', data: { file: data.file, content: readFile(data.file) } });
          } catch (e) {
            sendRaw(ws, { type: 'error', data: 'Read failed: ' + e.message });
          }
          break;
        case 'write':
          try {
            writeFile(data.file, data.content);
            sendRaw(ws, { type: 'result', action: 'write', success: true, file: data.file });
          } catch (e) {
            sendRaw(ws, { type: 'error', data: 'Write failed: ' + e.message });
          }
          break;
        case 'logs':
          pm2.launchBus((err, bus) => {
            if (err) return;
            ws._bus = bus;
            bus.on('log:out', (log) => {
              if (log.process && log.process.name === BOT_PM2_NAME)
                sendRaw(ws, { type: 'log', data: log.data });
            });
            bus.on('log:err', (log) => {
              if (log.process && log.process.name === BOT_PM2_NAME)
                sendRaw(ws, { type: 'error', data: log.data });
            });
          });
          break;
      }
    } catch (e) {
      sendRaw(ws, { type: 'error', data: e.message });
    }
  });

  ws.on('close', () => {
    connectedClients.delete(ws);
    if (ws._bus) ws._bus.close();
    console.log(`[WS] Client disconnected (${connectedClients.size} total)`);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error:`, err.message);
    connectedClients.delete(ws);
  });
});

async function init() {
  try {
    await connectPM2();
    console.log('[PM2] Connected');
    const status = await getBotStatus();
    botStatus = status.status;
    console.log(`[PM2] Bot status: ${botStatus}`);
    console.log(`[WS] Native WebSocket server running on port ${WS_PORT}`);
    setInterval(broadcastStatus, 10000);
  } catch (err) {
    console.error('[PM2] Connection failed:', err.message);
    process.exit(1);
  }
}

function shutdown() {
  try { wss.close(); } catch (e) {}
  try { pm2.disconnect(); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

init();