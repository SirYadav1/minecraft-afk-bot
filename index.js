const mineflayer = require('mineflayer');
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const http = require('http');
const socketIo = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const pm2 = require('pm2');

// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────
const serverIp = 'insanesmp.net';
const serverPort = 25565;
const accountsPath = path.join(__dirname, 'accounts.json');
const dashboardPort = 20056;
const START_COOLDOWN = 45000;
const DASHBOARD_PASSWORD = 'staff123'; // Fallback
const staffPasswordsPath = path.join(__dirname, 'staff_passwords.json');
const IP_BLOCK_TIME = 5 * 60 * 1000; // 5 minutes
const MAX_LOGIN_ATTEMPTS = 5;
const PLAYER_NAME_PATTERN = /^[A-Za-z0-9_\.]{1,20}$/;
let ipBlocks = {}; // { ip: { count: 0, blockedUntil: 0 } }

// ─────────────────────────────────────────
//  AUTO-CREATE LOGS FOLDER & FILES
// ─────────────────────────────────────────
const logsDir = path.join(__dirname, 'logs');
const staffLogsPath = path.join(logsDir, 'staff_logs.json');
const staffDetailsPath = path.join(logsDir, 'staff_details.json');
const bansRecordPath = path.join(logsDir, 'bans_record.json');
const punishmentsHistoryPath = path.join(logsDir, 'punishments_history.json');
const staffActivityPath = path.join(logsDir, 'staff_activity.json');

// Function to ensure logs directory and files exist
function ensureLogsDirectory() {
    // Create logs directory if it doesn't exist
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
        console.log('📁 Created logs directory:', logsDir);
    }

    // Initialize each log file with empty array if not exists
    const logFiles = [staffLogsPath, staffDetailsPath, bansRecordPath, punishmentsHistoryPath, staffActivityPath];

    logFiles.forEach(filePath => {
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify([], null, 2));
            console.log(`📄 Created log file: ${path.basename(filePath)}`);
        }
    });
}

// Call this at startup
ensureLogsDirectory();

// Function to save punishment record with auto-rotation (keep last 1000 records)
function savePunishmentRecord(record) {
    try {
        let records = [];
        if (fs.existsSync(punishmentsHistoryPath)) {
            try {
                records = JSON.parse(fs.readFileSync(punishmentsHistoryPath, 'utf8'));
                if (!Array.isArray(records)) records = [];
            } catch (e) { records = []; }
        }

        // Add new record at the beginning
        records.unshift({
            id: Date.now(),
            ...record,
            timestamp: new Date().toISOString(),
            formattedDate: new Date().toLocaleString()
        });

        // Keep only last 1000 records to prevent file bloat
        if (records.length > 1000) {
            records = records.slice(0, 1000);
        }

        fs.writeFileSync(punishmentsHistoryPath, JSON.stringify(records, null, 2));
        return records;
    } catch (e) {
        console.log('Punishment record error:', e.message);
        return [];
    }
}

// Function to log staff activity
function logStaffActivity(activity) {
    try {
        let activities = [];
        if (fs.existsSync(staffActivityPath)) {
            try {
                activities = JSON.parse(fs.readFileSync(staffActivityPath, 'utf8'));
                if (!Array.isArray(activities)) activities = [];
            } catch (e) { activities = []; }
        }

        activities.unshift({
            id: Date.now(),
            ...activity,
            timestamp: new Date().toISOString(),
            formattedDate: new Date().toLocaleString()
        });

        // Keep last 500 activities
        if (activities.length > 500) {
            activities = activities.slice(0, 500);
        }

        fs.writeFileSync(staffActivityPath, JSON.stringify(activities, null, 2));
    } catch (e) {
        console.log('Staff activity log error:', e.message);
    }
}

function loadStaffPasswords() {
    try {
        if (fs.existsSync(staffPasswordsPath)) {
            return JSON.parse(fs.readFileSync(staffPasswordsPath, 'utf8'));
        }
    } catch (e) { }
    return { afk: DASHBOARD_PASSWORD, staff: DASHBOARD_PASSWORD };
}

// Telegram
const TELEGRAM_BOT_TOKEN = '8036282088:AAFEwBCykq80BEKiHDd13NNQYznFtRwUOx4';
const TELEGRAM_CHAT_ID = '-1003570290445';
const USE_TELEGRAM = true;

// Admin IDs
const ADMIN_IDS = [8045497365, 5770659918];

// ─────────────────────────────────────────
//  CONTROL WEBSOCKET (editor + panel)
// ─────────────────────────────────────────
const CTRL_PM2_NAME = 'minecraft-afk-bot';
const EDITABLE_DIR = __dirname;

function ctrlSafePath(filename) {
    const full = require('path').resolve(EDITABLE_DIR, filename);
    if (!full.startsWith(EDITABLE_DIR)) return null;
    return full;
}

function ctrlListFiles() {
    const fs = require('fs');
    const path = require('path');
    try {
        return fs.readdirSync(EDITABLE_DIR).filter(f => {
            const ext = path.extname(f);
            const allowed = ['.js', '.json', '.html', '.css', '.txt', '.md', '.env'];
            return allowed.includes(ext) && fs.statSync(path.join(EDITABLE_DIR, f)).isFile();
        }).sort();
    } catch (e) { return []; }
}

function setupControlWS(httpServer) {
    pm2.connect((err) => { if (err) console.log('[CTRL] pm2 connect error:', err.message); else console.log('[CTRL] pm2 connected'); });
    const wss = new WebSocket.Server({ server: httpServer, path: '/ctrl' });
    const clients = new Set();

    const sendRaw = (ws, obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

    const getStatus = () => new Promise((resolve) => {
        pm2.describe(CTRL_PM2_NAME, (err, proc) => {
            if (err || !proc || proc.length === 0) {
                resolve({ status: 'stopped', pid: null, uptime: 0 });
            } else {
                const p = proc[0];
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

    const broadcastStatus = () => getStatus().then(s => {
        const msg = JSON.stringify({ type: 'status', data: s });
        clients.forEach(ws => ws.send(msg));
    });

    wss.on('connection', (ws) => {
        console.log('[CTRL] client connected');
        clients.add(ws);
        getStatus().then(s => sendRaw(ws, { type: 'status', data: s }));

        ws.on('message', async (raw) => {
            let data;
            try { data = JSON.parse(raw.toString()); } catch (e) { return; }
            try {
                switch (data.action) {
                    case 'start':
                        pm2.start({ name: CTRL_PM2_NAME, script: 'index.js', cwd: __dirname, watch: false, max_memory_restart: '500M', env: { NODE_ENV: 'production' } },
                            (err) => { if (err) sendRaw(ws, { type: 'error', data: err.message }); else { broadcastStatus(); sendRaw(ws, { type: 'result', action: 'start', success: true }); } });
                        break;
                    case 'stop':
                        pm2.stop(CTRL_PM2_NAME, (err) => { if (err) sendRaw(ws, { type: 'error', data: err.message }); else { broadcastStatus(); sendRaw(ws, { type: 'result', action: 'stop', success: true }); } });
                        break;
                    case 'restart':
                        pm2.restart(CTRL_PM2_NAME, (err) => { if (err) sendRaw(ws, { type: 'error', data: err.message }); else { broadcastStatus(); sendRaw(ws, { type: 'result', action: 'restart', success: true }); } });
                        break;
                    case 'status':
                        sendRaw(ws, { type: 'status', data: await getStatus() });
                        break;
                    case 'files':
                        sendRaw(ws, { type: 'files', data: ctrlListFiles() });
                        break;
                    case 'read': {
                        const fs = require('fs');
                        const full = ctrlSafePath(data.file);
                        if (!full) { sendRaw(ws, { type: 'error', data: 'Invalid path' }); break; }
                        try { sendRaw(ws, { type: 'file', data: { file: data.file, content: fs.readFileSync(full, 'utf8') } }); }
                        catch (e) { sendRaw(ws, { type: 'error', data: 'Read failed: ' + e.message }); }
                        break;
                    }
                    case 'write': {
                        const fs = require('fs');
                        const full = ctrlSafePath(data.file);
                        if (!full) { sendRaw(ws, { type: 'error', data: 'Invalid path' }); break; }
                        try { fs.writeFileSync(full, data.content, 'utf8'); sendRaw(ws, { type: 'result', action: 'write', success: true, file: data.file }); }
                        catch (e) { sendRaw(ws, { type: 'error', data: 'Write failed: ' + e.message }); }
                        break;
                    }
                    case 'logs':
                        pm2.launchBus((err, bus) => {
                            if (err) return;
                            ws._bus = bus;
                            bus.on('log:out', (log) => { if (log.process && log.process.name === CTRL_PM2_NAME) sendRaw(ws, { type: 'log', data: log.data }); });
                            bus.on('log:err', (log) => { if (log.process && log.process.name === CTRL_PM2_NAME) sendRaw(ws, { type: 'error', data: log.data }); });
                        });
                        break;
                }
            } catch (e) { sendRaw(ws, { type: 'error', data: e.message }); }
        });

        ws.on('close', () => {
            clients.delete(ws);
            if (ws._bus) ws._bus.close();
            console.log('[CTRL] client disconnected');
        });
    });

    setInterval(broadcastStatus, 10000);
    console.log('[CTRL] WebSocket control server on /ctrl');
}

// ─────────────────────────────────────────
//  DASHBOARD
// ─────────────────────────────────────────
let dashboardEnabled = true;
let app, server, io;

function initDashboard() {
    if (server) { dashboardEnabled = true; console.log('Dashboard ON'); return; }
    dashboardEnabled = true;
    app = express();
    server = http.createServer(app);
    io = socketIo(server);
    app.disable('x-powered-by');
    app.use(helmet({ contentSecurityPolicy: false }));
    app.use(express.static(__dirname));
    setupSocketHandlers();
    server.listen(dashboardPort, '0.0.0.0', () => {
        console.log('Dashboard: http://localhost:' + dashboardPort);
    });
    setupControlWS(server);
}

// Keep process alive — Termux safe
process.stdin.resume();

// ─────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────
let bots = {};
let botStates = {};
let telegramBot = null;
let telegramQueue = [];
let primaryBotUsername = null;
let serverChatCache = new Set();

const FOOD_PRIORITY = {
    'golden_carrot': 14, 'steak': 12, 'cooked_beef': 12,
    'bread': 5, 'apple': 4, 'carrot': 3
};

// ─────────────────────────────────────────
//  PRIMARY BOT ELECTION
// ─────────────────────────────────────────
function electPrimaryBot() {
    const online = Object.keys(bots);
    if (online.length === 0) { primaryBotUsername = null; return; }
    if (primaryBotUsername && bots[primaryBotUsername]) return;
    primaryBotUsername = online[0];
    console.log('Primary: ' + primaryBotUsername);
    sendTg('👑 Primary: ' + primaryBotUsername, 'info');
}

function isPrimary(u) { return u === primaryBotUsername; }

// ─────────────────────────────────────────
//  MESSAGE CLASSIFIER
// ─────────────────────────────────────────
function isPersonalMessage(msg) {
    const m = msg.toLowerCase();
    return m.includes('successfully logged in') ||
        m.includes('you have been kicked') ||
        m.includes('you were kicked') ||
        m.includes('you died') ||
        m.includes('you have') ||
        m.includes('your ') ||
        m.includes('logging in too fast') ||
        m.includes('please login') ||
        m.includes('incorrect password');
}

function deduplicatedServerChat(msg, type) {
    if (serverChatCache.has(msg)) return;
    serverChatCache.add(msg);
    setTimeout(() => serverChatCache.delete(msg), 10000);
    sendTg('💬 ' + msg, type);
}

// ─────────────────────────────────────────
//  TELEGRAM SETUP
// ─────────────────────────────────────────
if (USE_TELEGRAM) {
    try {
        telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
        console.log('Telegram OK');
        telegramBot.on('message', handleTelegramCommand);
        setInterval(() => {
            if (telegramQueue.length > 0) {
                const m = telegramQueue.shift();
                telegramBot.sendMessage(TELEGRAM_CHAT_ID, m, { parse_mode: 'Markdown' })
                    .catch(e => {
                        if (e.response?.statusCode === 429) telegramQueue.unshift(m);
                        else console.log('TG Error:', e.message);
                    });
            }
        }, 1500);
    } catch (e) { console.log('Telegram error:', e.message); }
}

function sendTg(msg, type) {
    if (!telegramBot) return;
    const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
    const safe = String(msg).replace(/([_*[\]()~`>#+=|{}.!-])/g, '\\$1');
    telegramQueue.push((icons[type] || 'ℹ️') + ' ' + safe);
}

// ─────────────────────────────────────────
//  STAFF LOGS (Updated with auto-save)
// ─────────────────────────────────────────
function saveBanRecord(player, reason, botName, staffIp = null) {
    try {
        const record = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            formattedDate: new Date().toLocaleString(),
            player,
            reason,
            bot: botName,
            staffIp: staffIp || 'unknown'
        };

        let records = [];
        if (fs.existsSync(bansRecordPath)) {
            try { records = JSON.parse(fs.readFileSync(bansRecordPath, 'utf8')); } catch (e) { records = []; }
        }

        records.unshift(record);

        // Keep only last 500 ban records
        if (records.length > 500) records = records.slice(0, 500);

        fs.writeFileSync(bansRecordPath, JSON.stringify(records, null, 2));

        // Also save to punishments history
        savePunishmentRecord({
            type: 'BAN',
            player,
            reason,
            moderator: botName,
            staffIp
        });

        return records;
    } catch (e) { console.log('Ban record error:', e.message); return []; }
}

function saveStaffLog(botName, targetPlayer, title, window) {
    try {
        const timestamp = new Date().toISOString();
        const formattedTime = new Date().toLocaleString();
        const items = [];

        for (let i = 0; i < window.slots.length; i++) {
            const item = window.slots[i];
            if (item) {
                items.push({
                    slot: i,
                    name: item.name,
                    displayName: item.displayName || item.name,
                    count: item.count,
                    nbt: item.nbt ? JSON.stringify(item.nbt).substring(0, 250) + '...' : null
                });
            } else {
                items.push({ slot: i, name: 'empty', displayName: 'EMPTY', count: 0, nbt: null });
            }
        }

        const logEntry = {
            timestamp,
            formattedTime,
            botAccount: botName,
            targetPlayer,
            guiTitle: title,
            totalSlots: window.slots.length,
            items
        };

        let logs = [];
        if (fs.existsSync(staffLogsPath)) {
            try { logs = JSON.parse(fs.readFileSync(staffLogsPath, 'utf8')); if (!Array.isArray(logs)) logs = []; } catch (e) { logs = []; }
        }

        logs.push(logEntry);

        // Keep last 200 logs
        if (logs.length > 200) logs = logs.slice(0, 200);

        fs.writeFileSync(staffLogsPath, JSON.stringify(logs, null, 2));

        const actualItemCount = items.filter(i => i.name !== 'empty').length;
        log(botName, '✅ Saved staff log for: ' + targetPlayer + ' (' + actualItemCount + ' items)', 'success');
        sendTg('📁 *LOG SAVED*\nTarget: `' + targetPlayer + '`\nItems Found: ' + actualItemCount + '\nTotal Slots: ' + items.length, 'success');
    } catch (err) { log(botName, '❌ Failed to save staff log: ' + err.message, 'error'); }
}

function saveStaffDetailLog(botName, targetPlayer, title, window) {
    try {
        const timestamp = new Date().toISOString();
        const formattedTime = new Date().toLocaleString();
        const items = window.slots
            .filter(slot => slot !== null)
            .map(item => ({
                slot: item.slot,
                name: item.name,
                displayName: item.displayName || item.name,
                count: item.count,
                nbt: item.nbt ? JSON.stringify(item.nbt).substring(0, 500) : null
            }));

        const logEntry = {
            timestamp,
            formattedTime,
            botAccount: botName,
            targetPlayer,
            guiTitle: title,
            items
        };

        let logs = [];
        if (fs.existsSync(staffDetailsPath)) {
            try {
                logs = JSON.parse(fs.readFileSync(staffDetailsPath, 'utf8'));
                if (!Array.isArray(logs)) logs = [];
            } catch (e) { logs = []; }
        }

        logs.push(logEntry);

        if (logs.length > 200) logs = logs.slice(0, 200);

        fs.writeFileSync(staffDetailsPath, JSON.stringify(logs, null, 2));
        log(botName, '📝 Saved staff DETAILS for: ' + targetPlayer, 'success');
        sendTg('🗒️ *DETAILS SAVED*\nTarget: `' + targetPlayer + '`\nItems: ' + items.length, 'info');
    } catch (err) {
        log(botName, '❌ Failed to save staff details: ' + err.message, 'error');
    }
}

function log(user, msg, type) {
    const t = new Date().toLocaleTimeString();
    console.log('[' + t + '] [' + user + '] ' + msg);
    if (dashboardEnabled && io)
        io.emit('log', { username: user, msg, type: type || 'info', time: t });
    if (!telegramBot) return;
    if (user === 'SYSTEM') { sendTg('[SYSTEM] ' + msg, type); return; }
    if (isPersonalMessage(msg)) sendTg('[' + user + '] ' + msg, type);
    else if (isPrimary(user)) deduplicatedServerChat(msg, type);
}

function getUptime(t) {
    if (!t) return '---';
    const d = (Date.now() - t) / 1000;
    return Math.floor(d / 3600) + 'h ' + Math.floor((d % 3600) / 60) + 'm';
}

function updateStats(u, stats) {
    if (botStates[u]) botStates[u].stats = stats;
    if (dashboardEnabled && io) io.emit('stats-update', { username: u, stats });
}

function updateStatus(u, status) {
    if (botStates[u]) botStates[u].status = status;
    if (dashboardEnabled && io) {
        io.emit('status-update', { username: u, status });
        emitGlobalStatus();
    }
}

function getGlobalStatus() {
    const onlineBots = Object.values(botStates).filter(s => s.status && s.status.includes('Online'));
    return onlineBots.length > 0 ? 'ONLINE' : 'OFFLINE';
}

function emitGlobalStatus() {
    if (dashboardEnabled && io) {
        io.emit('global-status-update', { status: getGlobalStatus() });
    }
}

// ─────────────────────────────────────────
//  RANDOM MOVEMENT
// ─────────────────────────────────────────
async function doRandomMove(u) {
    const bot = bots[u];
    if (!bot || !bot.entity) return;

    const directions = ['forward', 'back', 'left', 'right'];
    const dir = directions[Math.floor(Math.random() * directions.length)];
    const steps = 1 + Math.floor(Math.random() * 2);

    try {
        bot.clearControlStates();
        bot.setControlState(dir, true);
        await new Promise(r => setTimeout(r, steps * 400));
        bot.setControlState(dir, false);
        bot.clearControlStates();
        log(u, 'Moved: ' + dir + ' x' + steps, 'info');
    } catch (e) {
        try { bot.clearControlStates(); } catch (_) { }
    }
}

function startTickLoop(u) {
    log(u, 'Physics: mineflayer native (20 ticks/sec)', 'info');
}

function stopTickLoop(u) { }

function startAntiAfk(u) {
    const state = botStates[u];
    if (!state) return;
    stopAntiAfk(u);

    const bot = bots[u];
    if (!bot) return;

    bot.physicsEnabled = true;
    let yaw = bot.entity ? bot.entity.yaw : 0;

    state.afkInterval = setInterval(() => {
        if (!bots[u] || !bot.entity) return;
        try {
            yaw += (Math.random() - 0.5) * 0.017;
            bot.look(yaw, bot.entity.pitch, false);
        } catch (e) { }
    }, 30000);

    const firstMove = 60000 + Math.floor(Math.random() * 60000);
    setTimeout(() => {
        if (!bots[u]) return;
        doRandomMove(u);
        state.moveInterval = setInterval(() => {
            if (!bots[u]) return;
            doRandomMove(u);
        }, 300000);
    }, firstMove);

    log(u, 'Anti-AFK started (move + look)', 'info');
}

function stopAntiAfk(u) {
    const state = botStates[u];
    if (!state) return;
    if (state.afkInterval) { clearInterval(state.afkInterval); state.afkInterval = null; }
    if (state.moveInterval) { clearInterval(state.moveInterval); state.moveInterval = null; }
}

async function eatFood(u) {
    const bot = bots[u];
    if (!bot) return;
    if (bot.food >= 20 && bot.health >= 20) { log(u, 'Already full', 'success'); return; }
    try {
        const foods = bot.inventory.items()
            .filter(i => FOOD_PRIORITY[i.name])
            .sort((a, b) => FOOD_PRIORITY[b.name] - FOOD_PRIORITY[a.name]);
        if (foods.length === 0) { log(u, 'No food', 'error'); return; }
        const best = foods[0];
        log(u, 'Eating ' + best.name, 'info');
        await bot.equip(best, 'hand');
        bot.activateItem();
        await new Promise(r => setTimeout(r, 3000));
        log(u, 'Ate ' + best.name, 'success');
    } catch (e) { log(u, 'Eat failed', 'error'); }
}

async function handleLobbyJoinItem(u) {
    const bot = bots[u];
    if (!bot) return;
    log(u, 'Lobby detected. Syncing inventory (3s)...', 'info');
    await new Promise(r => setTimeout(r, 3000));
    try {
        bot.setQuickBarSlot(2);
        await new Promise(r => setTimeout(r, 500));
        const item = bot.inventory.slots[36 + 2];
        if (item && (item.name.includes('dye') || item.displayName.includes('Dye'))) {
            log(u, `[MATCH] Found Join Item: ${item.displayName} in Slot 3`, 'success');
            bot.joinPending = true;
            bot.activateItem();
            setTimeout(() => { if (bot) bot.joinPending = false; }, 10000);
            log(u, '✅ Item activated! Waiting for confirmation GUI...', 'success');
        } else {
            log(u, '⚠️ Slot 3 does not contain a selector item (Dye).', 'error');
        }
    } catch (e) {
        log(u, '❌ Item activation failed: ' + e.message, 'error');
    }
}

function loadAccounts() {
    try {
        if (fs.existsSync(accountsPath))
            return JSON.parse(fs.readFileSync(accountsPath)).accounts || [];
    } catch (e) { console.log('Failed to load accounts:', e.message); }
    return [];
}

async function createBot(acc) {
    const u = acc.username;
    if (bots[u]) return;

    if (!botStates[u]) {
        botStates[u] = {
            status: 'Offline',
            stats: { health: 0, food: 0, x: 0, y: 0, z: 0 },
            manual: false,
            onlineSince: null,
            afkInterval: null,
            moveInterval: null,
            tickRunning: false,
            stopTick: null
        };
    }

    botStates[u].manual = false;
    log(u, 'Connecting...', 'info');
    updateStatus(u, 'Connecting');

    const bot = mineflayer.createBot({
        host: serverIp,
        port: serverPort,
        username: u,
        version: '1.21.1',
        skipValidation: true,
        hideErrors: false,
        brand: 'vanilla'
    });

    bots[u] = bot;
    let statTimer;

    bot.tpPending = false;
    bot.joinPending = false;
    bot.pendingStaffCheck = null;
    bot.pendingSubStaffCheck = null;
    bot.staffLockUntil = 0;

    bot.on('spawn', () => {
        electPrimaryBot();
        log(u, 'Spawned' + (isPrimary(u) ? ' [PRIMARY]' : ''), 'success');
        updateStatus(u, 'Online' + (isPrimary(u) ? ' [PRIMARY]' : ''));
        botStates[u].onlineSince = Date.now();

        setTimeout(() => {
            startTickLoop(u);
            startAntiAfk(u);
        }, 4000);

        statTimer = setInterval(() => {
            if (bot.entity) {
                updateStats(u, {
                    health: bot.health || 0,
                    food: bot.food || 0,
                    x: bot.entity.position ? Math.round(bot.entity.position.x) : 0,
                    y: bot.entity.position ? Math.round(bot.entity.position.y) : 0,
                    z: bot.entity.position ? Math.round(bot.entity.position.z) : 0
                });
            }
        }, 2000);
    });

    bot.on('message', m => {
        const txt = m.toString().trim();
        if (txt) {
            log(u, txt, 'info');
            if (txt.includes('/login')) {
                setTimeout(() => {
                    bot.chat('/login ' + acc.password);
                    log(u, '⌨️ Sent /login <password> in chat!', 'info');
                }, 1000);
            }

            const normalizedTxt = normalizeText(txt);
            if (normalizedTxt.includes('successfully logged in') ||
                normalizedTxt.includes('your login session has been continued') ||
                normalizedTxt.includes('if you do not want to login next time') ||
                normalizedTxt.includes('you are already logged')) {

                log(u, '🚀 Login confirmed! Transitioning to survival...', 'success');
                handleLobbyJoinItem(u);
                setTimeout(() => {
                    bot.chat('/server survival');
                    log(u, '➡️ Sent /server survival', 'info');
                    setTimeout(() => {
                        bot.chat('/ping');
                        log(u, '💓 Sent /ping to verify connection', 'info');
                    }, 3000);
                }, 2000);
            }

            if (txt.includes('teleport request accepted') || txt.includes('tpaccept') || txt.includes('accepting teleport')) {
                bot.tpPending = true;
                setTimeout(() => { if (bot) bot.tpPending = false; }, 20000);
            }

            if (txt.includes('connecting to') || txt.includes('sending you to')) {
                bot.joinPending = false;
            }

            if (txt.includes('[StaffGUI] Selected') || txt.includes('[StaffGUI] You already have')) {
                const parts = txt.split(' ');
                const target = parts[parts.length - 1].replace(/[^a-zA-Z0-9_\.]/g, '');
                if (target) {
                    bot.pendingStaffCheck = target;
                    log(u, '🎯 Staff GUI detected in chat for: ' + target, 'success');
                }
            }
        }
    });

    function normalizeText(text) {
        if (!text) return '';
        const smallCapsMap = {
            'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ꜰ': 'f', 'ɢ': 'g', 'ʜ': 'h', 'ɪ': 'i',
            'ᴊ': 'j', 'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p', 'ǫ': 'q', 'ʀ': 'r',
            'ꜱ': 's', 'ᴛ': 't', 'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'x': 'x', 'ʏ': 'y', 'ᴢ': 'z'
        };
        return text.split('').map(char => smallCapsMap[char] || char.toLowerCase()).join('');
    }

    bot.on('windowOpen', async (window) => {
        let titleText = '';
        try {
            if (typeof window.title === 'string') {
                try {
                    const parsed = JSON.parse(window.title);
                    titleText = parsed?.value?.text?.value || parsed?.text || window.title;
                } catch (e) { titleText = window.title; }
            } else if (window.title && typeof window.title === 'object') {
                titleText = window.title?.value?.text?.value || window.title?.text || '';
            }
        } catch (e) { titleText = ''; }

        const normalizedTitle = normalizeText(titleText);
        const isConfirmGui = normalizedTitle.includes('confirm');
        const isJoinGui = bot.joinPending || normalizedTitle.includes('survival') || normalizedTitle.includes('server') || normalizedTitle.includes('lobby');
        const isStaffTitle = normalizedTitle.includes('discipline') || normalizedTitle.includes('staff') || normalizedTitle.includes('inventory');
        const isPunishConfirm = bot.waitingForPunishConfirm || (isConfirmGui && bot.lastPunishReason);

        if (bot.pendingStaffCheck) {
            const target = bot.pendingStaffCheck;
            log(u, '🔍 Logging discipline GUI for: ' + target + ' | Title: ' + titleText, 'info');
            saveStaffLog(u, target, titleText, window);
            bot.pendingStaffCheck = null;
        } else if (bot.pendingSubStaffCheck || isStaffTitle) {
            const target = bot.pendingSubStaffCheck || 'Unknown';
            log(u, '📝 Logging SUB-GUI details for: ' + target + ' | Title: ' + titleText, 'info');
            saveStaffDetailLog(u, target, titleText, window);
            bot.pendingSubStaffCheck = null;
        }

        if (isPunishConfirm) {
            bot.waitingForPunishConfirm = false;
            log(u, '🛡️ Punishment Confirm GUI detected: ' + titleText, 'info');
            if (io) io.emit('punish-confirm-required', { username: u, player: bot.lastPunishTarget || 'Unknown', reason: bot.lastPunishReason });
            return;
        }

        if (bot.pendingStaffCheck || isStaffTitle) return;
        if (!bot.tpPending && !bot.joinPending && !isConfirmGui && !isJoinGui) return;

        log(u, 'GUI detected: "' + titleText + '"', 'success');
        const joinWasPending = bot.joinPending;
        bot.tpPending = false;
        bot.joinPending = false;

        setTimeout(() => {
            try {
                let targetSlot = -1;
                const slot16 = window.slots[16];
                if (slot16 && (slot16.name.includes('green') || slot16.name.includes('lime') || normalizeText(slot16.displayName).includes('confirm'))) {
                    targetSlot = 16;
                }
                if (targetSlot === -1) {
                    const found = window.slots.find(item => {
                        if (!item) return false;
                        const display = normalizeText(item.displayName);
                        const name = item.name.toLowerCase();
                        if (joinWasPending) {
                            return display.includes('survival') || display.includes('join') || display.includes('confirm') || name.includes('lime');
                        }
                        return display.includes('confirm') || name.includes('lime') || name.includes('green');
                    });
                    if (found) targetSlot = found.slot;
                }
                if (targetSlot !== -1) {
                    bot.clickWindow(targetSlot, 0, 0);
                    log(u, 'GUI Action: Clicked slot ' + targetSlot, 'success');
                } else {
                    log(u, 'GUI Warning: Could not find confirmation item in GUI', 'warning');
                }
            } catch (err) { log(u, 'GUI click failed: ' + err.message, 'error'); }
        }, 800 + Math.floor(Math.random() * 700));
    });

    bot.on('error', e => {
        const msg = e.message || String(e);
        log(u, 'Error: ' + msg, 'error');
    });

    bot.on('kicked', r => {
        const reason = typeof r === 'string' ? r : JSON.stringify(r);
        log(u, 'Kicked: ' + reason, 'warning');
        if (reason.toLowerCase().includes('internal error occurred in your connection')) {
            log(u, 'Login redirect detected. Fast reconnecting...', 'success');
            bot.fastReconnect = true;
        }
    });

    bot.on('end', reason => {
        if (statTimer) clearInterval(statTimer);
        stopTickLoop(u);
        stopAntiAfk(u);
        const isFastReconnect = bot.fastReconnect;
        delete bots[u];
        updateStatus(u, 'Offline');
        emitGlobalStatus();

        log(u, 'Connection ended. Reason: ' + (reason || 'unknown'), 'warning');

        if (isPrimary(u)) { primaryBotUsername = null; electPrimaryBot(); }

        if (botStates[u] && !botStates[u].manual) {
            const cooldown = isFastReconnect ? 5000 : START_COOLDOWN;
            log(u, 'Reconnecting in ' + Math.round(cooldown / 1000) + 's', 'warning');
            updateStatus(u, 'Reconnecting...');
            setTimeout(() => {
                const a = loadAccounts().find(x => x.username === u);
                if (a && botStates[u] && !botStates[u].manual) createBot(a);
            }, cooldown);
        } else {
            log(u, 'Offline', 'info');
        }
    });
}

// ─────────────────────────────────────────
//  TELEGRAM COMMANDS (Keep same as before)
// ─────────────────────────────────────────
function handleTelegramCommand(msg) {
    if (!telegramBot) return;
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text || '';

    if (!ADMIN_IDS.includes(userId)) {
        telegramBot.sendMessage(chatId, '❌ Unauthorized\nYour ID: ' + userId);
        console.log('Unauthorized attempt from:', userId);
        return;
    }
    if (!text.startsWith('/')) return;

    const parts = text.split(' ');
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ');

    if (cmd === '/status') {
        let s = '📊 *STATUS*\n\n';
        const accs = loadAccounts();
        if (accs.length === 0) { telegramBot.sendMessage(chatId, 'No accounts'); return; }
        accs.forEach(a => {
            const on = !!bots[a.username];
            const p = a.username === primaryBotUsername;
            s += (p ? '👑' : '👤') + ' *' + a.username + '*\n';
            s += (on ? '🟢 Online' : '🔴 Offline') + '\n';
            if (on && botStates[a.username]) {
                const st = botStates[a.username].stats;
                s += 'HP: ' + Math.round(st.health) + '/20 | Food: ' + Math.round(st.food) + '/20\n';
                s += 'Uptime: ' + getUptime(botStates[a.username].onlineSince) + '\n';
            }
            s += '\n';
        });
        s += '📱 Dashboard: ' + (dashboardEnabled ? 'ON' : 'OFF');
        telegramBot.sendMessage(chatId, s, { parse_mode: 'Markdown' });
        return;
    }

    if (cmd === '/on') {
        if (!arg) { telegramBot.sendMessage(chatId, '⚠️ Usage: /on USERNAME or /on all'); return; }
        const accs = loadAccounts();
        const targets = arg === 'all' ? accs : accs.filter(a => a.username === arg);
        if (targets.length === 0) { telegramBot.sendMessage(chatId, '❌ Not found: ' + arg); return; }
        telegramBot.sendMessage(chatId, '🚀 Starting ' + (arg === 'all' ? 'all' : arg) + '...');
        targets.forEach((acc, i) => {
            const u = acc.username;
            if (bots[u]) return;
            setTimeout(() => {
                if (botStates[u]) botStates[u].manual = false;
                createBot(acc);
                setTimeout(() => { if (bots[u]) telegramBot.sendMessage(chatId, '✅ ' + u + ' is online'); }, 8000);
            }, i * 5000);
        });
        return;
    }

    if (cmd === '/punish') {
        if (!arg) { telegramBot.sendMessage(chatId, '⚠️ Usage: /punish PLAYERNAME'); return; }
        if (!primaryBotUsername || !bots[primaryBotUsername]) {
            telegramBot.sendMessage(chatId, '❌ No primary bot online to execute command');
            return;
        }
        const b = bots[primaryBotUsername];
        b.pendingStaffCheck = arg;
        b.chat('/punish ' + arg);
        telegramBot.sendMessage(chatId, '🔍 Checking staff info for *' + arg + '*...\n(Logging GUI contents to file)');
        log(primaryBotUsername, 'Executing staff check on: ' + arg, 'info');
        return;
    }

    if (cmd === '/off') {
        if (!arg) { telegramBot.sendMessage(chatId, '⚠️ Usage: /off USERNAME'); return; }
        const b = bots[arg];
        if (!b) { telegramBot.sendMessage(chatId, '⚠️ ' + arg + ' is already offline'); return; }
        if (botStates[arg]) botStates[arg].manual = true;
        telegramBot.sendMessage(chatId, '⏹️ Stopping ' + arg + ' and disconnecting...');
        try {
            b.quit();
            setTimeout(() => { if (bots[arg] === b) b.end(); }, 500);
        } catch (e) {
            try { b.end(); } catch (_) { }
        }
        return;
    }

    if (cmd === '/restart') {
        if (!arg) { telegramBot.sendMessage(chatId, '⚠️ Usage: /restart USERNAME or /restart all'); return; }
        const accs = loadAccounts();
        const targets = arg === 'all' ? accs : accs.filter(a => a.username === arg);
        if (targets.length === 0) { telegramBot.sendMessage(chatId, '❌ Not found: ' + arg); return; }
        telegramBot.sendMessage(chatId, '🔄 Restarting ' + (arg === 'all' ? 'all' : arg) + '...');
        targets.forEach((acc, i) => {
            const u = acc.username;
            if (bots[u]) { botStates[u].manual = true; try { bots[u].quit(); } catch (e) { } }
            setTimeout(() => {
                if (botStates[u]) botStates[u].manual = false;
                createBot(acc);
            }, START_COOLDOWN + i * 5000);
        });
        telegramBot.sendMessage(chatId, '✅ Restarting in ' + (START_COOLDOWN / 1000) + 's');
        return;
    }

    if (cmd === '/send') {
        if (parts.length < 3) { telegramBot.sendMessage(chatId, '⚠️ Usage: /send USERNAME MESSAGE'); return; }
        const tu = parts[1];
        const tmsg = parts.slice(2).join(' ');
        if (!bots[tu]) { telegramBot.sendMessage(chatId, '❌ ' + tu + ' is offline'); return; }
        bots[tu].chat(tmsg);
        telegramBot.sendMessage(chatId, '✅ Sent via ' + tu + ':\n"' + tmsg + '"');
        log(tu, 'Manual chat: ' + tmsg, 'info');
        return;
    }

    if (cmd === '/offd') {
        dashboardEnabled = false;
        telegramBot.sendMessage(chatId, '📴 Dashboard disabled');
        log('SYSTEM', 'Dashboard disabled', 'info');
        return;
    }

    if (cmd === '/ond') {
        dashboardEnabled = true;
        telegramBot.sendMessage(chatId, '🌐 Dashboard enabled');
        log('SYSTEM', 'Dashboard enabled', 'success');
        return;
    }

    if (cmd === '/all') {
        if (!arg) { telegramBot.sendMessage(chatId, '⚠️ Usage: /all COMMAND'); return; }
        const online = Object.keys(bots);
        if (online.length === 0) { telegramBot.sendMessage(chatId, '❌ No bots online'); return; }
        online.forEach(u => bots[u].chat(arg));
        telegramBot.sendMessage(chatId, '✅ Broadcast to ' + online.length + ' bot(s): "' + arg + '"');
        return;
    }

    const u = cmd.substring(1);
    if (bots[u] && arg) {
        if (arg === '/eat') {
            eatFood(u);
            telegramBot.sendMessage(chatId, '🍖 ' + u + ' eating...');
        } else {
            bots[u].chat(arg);
            telegramBot.sendMessage(chatId, '✅ ' + u + ': "' + arg + '"');
        }
        return;
    }

    if (cmd !== '/start') {
        telegramBot.sendMessage(chatId,
            '❓ Unknown command\n\nAvailable:\n' +
            '/status\n/on <user>\n/off <user>\n' +
            '/restart <user|all>\n/send <user> <msg>\n' +
            '/all <cmd>\n/<user> <cmd>\n/offd, /ond'
        );
    }
}

// ─────────────────────────────────────────
//  SOCKET HANDLERS
// ─────────────────────────────────────────
function setupSocketHandlers() {
    if (!io) return;
    io.on('connection', s => {
        let socketAuthed = false;
        let staffUsername = null;

        const requireAuth = () => {
            if (socketAuthed) return true;
            s.emit('login-fail', 'Please login first.');
            return false;
        };

        const accs = loadAccounts();
        s.emit('init', {
            accounts: accs.map(a => ({
                username: a.username,
                status: botStates[a.username]?.status || 'Offline',
                stats: botStates[a.username]?.stats || { health: 0, food: 0, x: 0, y: 0, z: 0 }
            })),
            serverIp,
            primaryBot: primaryBotUsername,
            globalStatus: getGlobalStatus()
        });

        s.on('start-bot', u => {
            if (!requireAuth()) return;
            const a = accs.find(x => x.username === u);
            if (a && !bots[u]) createBot(a);
            logStaffActivity({
                action: 'START_BOT',
                target: u,
                staffIp: s.handshake.address,
                username: staffUsername
            });
        });

        s.on('stop-bot', u => {
            if (!requireAuth()) return;
            const b = bots[u];
            if (b) {
                if (botStates[u]) botStates[u].manual = true;
                log(u, 'Manual STOP from Dashboard', 'warning');
                try {
                    b.quit();
                    setTimeout(() => { if (bots[u] === b) b.end(); }, 500);
                } catch (e) { try { b.end(); } catch (_) { } }
            }
            logStaffActivity({
                action: 'STOP_BOT',
                target: u,
                staffIp: s.handshake.address,
                username: staffUsername
            });
        });

        s.on('disconnect-bot', u => {
            if (!requireAuth()) return;
            const b = bots[u];
            if (b) {
                if (botStates[u]) botStates[u].manual = true;
                log(u, 'Manual DISCONNECT from Dashboard', 'warning');
                try {
                    b.quit();
                    setTimeout(() => { if (bots[u] === b) b.end(); }, 500);
                } catch (e) { try { b.end(); } catch (_) { } }
            }
        });

        s.on('eat-food', u => {
            if (!requireAuth()) return;
            if (u === 'all') Object.keys(bots).forEach(user => eatFood(user));
            else eatFood(u);
        });

        s.on('staff-click-slot', data => {
            if (!requireAuth()) return;
            const bot = bots[data.username];
            if (bot) {
                if (bot.currentWindow) {
                    bot.pendingSubStaffCheck = bot.pendingStaffCheck || 'SelectedPlayer';
                    bot.clickWindow(parseInt(data.slot), 1, 0);
                    log(data.username, 'Dashboard: Right-clicked slot ' + data.slot + ' (Staff Detail)', 'info');
                } else {
                    s.emit('error', 'No GUI open to click');
                }
            }
        });

        s.on('staff-login', data => {
            const ip = s.handshake.address;
            const now = Date.now();
            const referer = s.handshake.headers.referer || '';
            const dbType = referer.includes('staff_dashboard.html') ? 'staff' : 'afk';

            if (ipBlocks[ip] && ipBlocks[ip].blockedUntil > now) {
                const remaining = Math.ceil((ipBlocks[ip].blockedUntil - now) / 1000 / 60);
                s.emit('login-fail', `Too many attempts. Blocked for ${remaining} more minutes.`);
                return;
            }

            const passes = loadStaffPasswords();
            const correctPass = passes[dbType] || DASHBOARD_PASSWORD;

            if (data.password === correctPass) {
                socketAuthed = true;
                staffUsername = data.username || 'unknown';
                s.emit('login-success', { authenticated: true });
                log('SYSTEM', `Staff login successful (Type: ${dbType}, IP: ${ip})`, 'success');
                logStaffActivity({
                    action: 'LOGIN',
                    type: dbType,
                    staffIp: ip,
                    username: staffUsername,
                    success: true
                });
                if (ipBlocks[ip]) delete ipBlocks[ip];
            } else {
                if (!ipBlocks[ip]) ipBlocks[ip] = { count: 0, blockedUntil: 0 };
                ipBlocks[ip].count++;

                logStaffActivity({
                    action: 'LOGIN_FAILED',
                    type: dbType,
                    staffIp: ip,
                    success: false,
                    attemptCount: ipBlocks[ip].count
                });

                if (ipBlocks[ip].count >= MAX_LOGIN_ATTEMPTS) {
                    ipBlocks[ip].blockedUntil = now + IP_BLOCK_TIME;
                    ipBlocks[ip].count = 0;
                    s.emit('login-fail', 'Incorrect password. Too many failed attempts! You are blocked for 5 minutes.');
                    log('SYSTEM', `IP Blocked: ${ip} after 5 failed attempts`, 'warning');
                } else {
                    const left = MAX_LOGIN_ATTEMPTS - ipBlocks[ip].count;
                    s.emit('login-fail', `Incorrect password. ${left} attempts remaining.`);
                }
            }
        });

        s.on('get-status', () => {
            if (!requireAuth()) return;
            const uptimeData = Object.keys(bots).map(u => ({
                username: u,
                uptime: getUptime(botStates[u]?.onlineSince)
            }));
            s.emit('status-response', uptimeData);
        });

        s.on('staff-target-confirm', data => {
            if (!requireAuth()) return;
            const player = String(data.player || '').trim();
            if (!player) {
                s.emit('error', 'Player name cannot be empty.');
                return;
            }
            const bot = bots[data.username || primaryBotUsername];
            if (bot) {
                bot.pendingStaffCheck = player;
                bot.lastPunishTarget = player;
                bot.chat('/punish ' + player);
                log(bot.username, `Target Confirmed: ${player} | /punish sent`, 'info');
                logStaffActivity({
                    action: 'TARGET_CONFIRM',
                    target: player,
                    bot: bot.username,
                    staffIp: s.handshake.address,
                    username: staffUsername
                });

                if (bot.punishTimeout) clearTimeout(bot.punishTimeout);
                bot.punishTimeout = setTimeout(() => {
                    if (bot.currentWindow) {
                        bot.closeWindow(bot.currentWindow);
                        log(bot.username, `Punishment session timed out (30s). GUI closed.`, 'warning');
                    }
                    bot.punishTimeout = null;
                }, 30000);
            }
        });

        s.on('staff-punish-intent', data => {
            if (!requireAuth()) return;
            const bot = bots[data.username || primaryBotUsername];
            if (bot) {
                bot.lastPunishReason = data.reason;
                bot.staffLockUntil = Date.now() + 30000;
                log(bot.username, `Intent: ${data.reason} on ${bot.lastPunishTarget} | Slot: ${data.slot}`, 'info');
                logStaffActivity({
                    action: 'PUNISH_INTENT',
                    target: bot.lastPunishTarget,
                    reason: data.reason,
                    slot: data.slot,
                    bot: bot.username,
                    staffIp: s.handshake.address,
                    username: staffUsername
                });

                if (bot.currentWindow) {
                    bot.clickWindow(data.slot, 1, 0);
                    bot.waitingForPunishConfirm = true;
                    log(bot.username, `Clicked Slot ${data.slot} for ${data.reason}`, 'success');
                } else {
                    log(bot.username, `FAILED: No window open for punishment slot click`, 'error');
                }
            }
        });

        s.on('staff-punish-confirm', data => {
            if (!requireAuth()) return;
            const bot = bots[data.username || primaryBotUsername];
            if (bot && bot.currentWindow) {
                bot.clickWindow(11, 0, 0);
                const requestedTarget = String(data.player || '').trim();
                const target = PLAYER_NAME_PATTERN.test(requestedTarget) ? requestedTarget : (bot.lastPunishTarget || 'Unknown');
                const records = saveBanRecord(target, bot.lastPunishReason || 'Unknown', bot.username, s.handshake.address);
                s.emit('ban-updated', records);
                log(bot.username, `Punishment CONFIRMED for ${target}`, 'success');
                logStaffActivity({
                    action: 'PUNISH_CONFIRM',
                    target: target,
                    reason: bot.lastPunishReason,
                    bot: bot.username,
                    staffIp: s.handshake.address,
                    username: staffUsername
                });
                if (bot.punishTimeout) { clearTimeout(bot.punishTimeout); bot.punishTimeout = null; }
            }
        });

        s.on('staff-punish-cancel', data => {
            if (!requireAuth()) return;
            const bot = bots[data.username || primaryBotUsername];
            if (bot && bot.currentWindow) {
                bot.clickWindow(15, 0, 0);
                log(bot.username, `Punishment CANCELLED for ${bot.lastPunishTarget}`, 'warning');
                logStaffActivity({
                    action: 'PUNISH_CANCEL',
                    target: bot.lastPunishTarget,
                    bot: bot.username,
                    staffIp: s.handshake.address,
                    username: staffUsername
                });
                if (bot.punishTimeout) { clearTimeout(bot.punishTimeout); bot.punishTimeout = null; }
            }
        });

        s.on('get-bans-record', () => {
            if (!requireAuth()) return;
            if (fs.existsSync(bansRecordPath)) {
                try {
                    const records = JSON.parse(fs.readFileSync(bansRecordPath, 'utf8'));
                    s.emit('ban-updated', records);
                } catch (e) { s.emit('ban-updated', []); }
            } else { s.emit('ban-updated', []); }
        });

        s.on('send-chat', data => {
            if (!requireAuth()) return;
            const message = String(data.message || '').slice(0, 256);
            if (!message.trim()) return;
            if (data.username === 'all') Object.values(bots).forEach(b => b.chat(message));
            else if (bots[data.username]) bots[data.username].chat(message);
            logStaffActivity({
                action: 'SEND_CHAT',
                target: data.username,
                message: message.substring(0, 100),
                staffIp: s.handshake.address,
                username: staffUsername
            });
        });
    });
}

// ─────────────────────────────────────────
//  CRASH PROTECTION
// ─────────────────────────────────────────
process.on('uncaughtException', err => {
    console.error('[CRASH PREVENTED] ' + err.message);
    console.error(err.stack);
    sendTg('[SYSTEM] ⚠️ Crash prevented: ' + err.message, 'error');
});

process.on('unhandledRejection', reason => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error('[UNHANDLED REJECTION] ' + msg);
    sendTg('[SYSTEM] ⚠️ Unhandled error: ' + msg, 'error');
});

// ─────────────────────────────────────────
//  GRACEFUL SHUTDOWN
// ─────────────────────────────────────────
function shutdown(sig) {
    console.log('\nShutting down (' + sig + ')...');
    sendTg('[SYSTEM] 🔴 Bot shutting down (' + sig + ')', 'warning');
    Object.keys(bots).forEach(u => {
        botStates[u].manual = true;
        stopTickLoop(u);
        stopAntiAfk(u);
        try { bots[u].quit(); } catch (e) { }
    });
    setTimeout(() => process.exit(0), 2000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─────────────────────────────────────────
//  STARTUP
// ─────────────────────────────────────────
const loadedAccounts = loadAccounts();

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('    MINECRAFT AFK BOT  (Grim-Safe)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Server   :', serverIp + ':' + serverPort);
console.log('Accounts :', loadedAccounts.length);
console.log('Admins   :', ADMIN_IDS.length);
console.log('Cooldown :', START_COOLDOWN / 1000 + 's');
console.log('Brand    : vanilla');
console.log('Version  : auto-detect');
console.log('Tick     : hrtime precise (Timer fix)');
console.log('\n📁 Logs Directory:', logsDir);
console.log('   - staff_logs.json');
console.log('   - staff_details.json');
console.log('   - bans_record.json');
console.log('   - punishments_history.json');
console.log('   - staff_activity.json');
console.log('\n📱 Telegram Commands:');
console.log('  /status              - All bot status');
console.log('  /on <user>           - Start bot');
console.log('  /off <user>          - Stop bot');
console.log('  /restart <user|all>  - Restart bot(s)');
console.log('  /send <user> <msg>   - Send chat');
console.log('  /all <cmd>           - Broadcast');
console.log('  /<user> <cmd>        - Single bot cmd');
console.log('  /offd  /ond          - Dashboard toggle');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

log('SYSTEM', 'Bot ready', 'success');
initDashboard();

// Startup Telegram message
setTimeout(() => {
    if (telegramBot) {
        telegramBot.sendMessage(TELEGRAM_CHAT_ID,
            '🟢 *Bot Started*\n\n' +
            '🖥️ Server: ' + serverIp + ':' + serverPort + '\n' +
            '👤 Accounts: ' + loadedAccounts.length + '\n' +
            '⏱️ Cooldown: ' + (START_COOLDOWN / 1000) + 's\n' +
            '📊 Dashboard: ON \\(port ' + dashboardPort + '\\)\n' +
            '🛡️ Grim bypass: ON \\(vanilla \\+ hrtime tick\\)\n' +
            '📁 Logs: Auto-created in /logs directory\n\n' +
            '💡 Use /status to check bots',
            { parse_mode: 'Markdown' }
        ).catch(e => console.log('Startup TG error:', e.message));
    }
}, 3000);