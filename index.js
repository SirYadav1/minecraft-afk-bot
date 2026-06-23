require('dotenv').config();
const mineflayer = require('mineflayer');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const mc = require('minecraft-protocol');

// ─────────────────────────────────────────
//  CONFIG (from .env)
// ─────────────────────────────────────────
const serverIp = process.env.SERVER_IP || 'play.soulcity.fun';
const serverPort = parseInt(process.env.SERVER_PORT) || 35525;
const dashboardPort = parseInt(process.env.DASHBOARD_PORT) || 20289;
const dashboardToken = process.env.DASHBOARD_TOKEN || '';
const startCooldown = parseInt(process.env.START_COOLDOWN) || 45000;
const mcVersion = process.env.MC_VERSION || '1.21.1';
const accountsPath = path.join(__dirname, 'accounts.json');

const NORMAL_RECONNECT = 8000;
const FAST_RECONNECT = 5000;
const SLOW_RECONNECT = 60000;
const SONAR_TIMEOUT = 15000;
const MAX_RECONNECT_DELAY = 300000;

// ─────────────────────────────────────────
//  TELEGRAM
// ─────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const USE_TELEGRAM = !!TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS
    ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())).filter(Boolean)
    : [];

// ─────────────────────────────────────────
//  CACHED ACCOUNTS (read once, not every call)
// ─────────────────────────────────────────
let cachedAccounts = null;

function loadAccounts() {
    if (cachedAccounts) return cachedAccounts;
    try {
        if (fs.existsSync(accountsPath)) {
            cachedAccounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8')).accounts || [];
            return cachedAccounts;
        }
    } catch (e) {
        console.log('Failed to load accounts:', e.message);
    }
    return [];
}

function reloadAccounts() {
    cachedAccounts = null;
    return loadAccounts();
}

// ─────────────────────────────────────────
//  DASHBOARD
// ─────────────────────────────────────────
let dashboardEnabled = true;
let app, server, io;

function initDashboard() {
    if (server) { dashboardEnabled = true; return; }
    app = express();
    server = http.createServer(app);
    io = socketIo(server);
    app.disable('x-powered-by');

    // Dashboard auth middleware (skip if no token configured)
    if (dashboardToken) {
        app.use((req, res, next) => {
            const token = req.query.token || req.headers['x-dashboard-token'];
            if (token === dashboardToken) return next();
            if (req.path === '/' || req.path.endsWith('.html')) {
                return res.status(401).send('Unauthorized — add ?token=YOUR_TOKEN to URL');
            }
            next();
        });
    }

    app.use(express.static(__dirname));
    setupSocketHandlers();
    server.listen(dashboardPort, '0.0.0.0', () => {
        console.log('Dashboard: http://localhost:' + dashboardPort + (dashboardToken ? ' (token protected)' : ''));
    });
}

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
//  HELPERS
// ─────────────────────────────────────────
function electPrimaryBot() {
    const online = Object.keys(bots);
    if (online.length === 0) { primaryBotUsername = null; return; }
    if (primaryBotUsername && bots[primaryBotUsername]) return;
    primaryBotUsername = online[0];
    sendTg('👑 Primary: ' + primaryBotUsername, 'info');
}

function isPrimary(u) { return u === primaryBotUsername; }

function normalizeText(text) {
    if (!text) return '';
    const map = {
        'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ꜰ': 'f', 'ɢ': 'g', 'ʜ': 'h', 'ɪ': 'i',
        'ᴊ': 'j', 'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p', 'ǫ': 'q', 'ʀ': 'r',
        'ꜱ': 's', 'ᴛ': 't', 'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'x': 'x', 'ʏ': 'y', 'ᴢ': 'z'
    };
    return text.split('').map(c => map[c] || c.toLowerCase()).join('');
}

function getUptime(t) {
    if (!t) return '---';
    const d = (Date.now() - t) / 1000;
    return Math.floor(d / 3600) + 'h ' + Math.floor((d % 3600) / 60) + 'm';
}

function isPersonalMessage(msg) {
    const m = msg.toLowerCase();
    return m.includes('successfully logged in') || m.includes('you have been kicked') ||
        m.includes('you were kicked') || m.includes('you died') ||
        m.includes('logging in too fast') || m.includes('please login') ||
        m.includes('incorrect password') || m.includes('your ');
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
//  LOG
// ─────────────────────────────────────────
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

function updateStats(u, stats) {
    if (botStates[u]) botStates[u].stats = stats;
    if (dashboardEnabled && io) io.emit('stats-update', { username: u, stats });
}

function updateStatus(u, status) {
    if (botStates[u]) botStates[u].status = status;
    if (dashboardEnabled && io) {
        io.emit('status-update', { username: u, status });
        io.emit('global-status-update', { status: getGlobalStatus() });
    }
}

function getGlobalStatus() {
    return Object.values(botStates).some(s => s.status?.includes('Online')) ? 'ONLINE' : 'OFFLINE';
}

// ─────────────────────────────────────────
//  ANTI-AFK
// ─────────────────────────────────────────
async function doRandomMove(u) {
    const bot = bots[u];
    if (!bot || !bot.entity) return;
    const dirs = ['forward', 'back', 'left', 'right'];
    const dir = dirs[Math.floor(Math.random() * dirs.length)];
    try {
        bot.clearControlStates();
        bot.setControlState(dir, true);
        await new Promise(r => setTimeout(r, 400 + Math.floor(Math.random() * 400)));
        bot.setControlState(dir, false);
        bot.clearControlStates();
    } catch (e) {
        try { bot.clearControlStates(); } catch (_) { }
    }
}

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
            yaw += (Math.random() - 0.5) * 0.02;
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

    log(u, 'Anti-AFK started', 'info');
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
        await bot.equip(foods[0], 'hand');
        bot.activateItem();
        await new Promise(r => setTimeout(r, 3000));
        bot.deactivateItem();
        log(u, 'Ate ' + foods[0].name, 'success');
    } catch (e) { log(u, 'Eat failed', 'error'); }
}

// ─────────────────────────────────────────
//  PING SERVER
// ─────────────────────────────────────────
function pingServer(callback) {
    mc.ping({ host: serverIp, port: serverPort, version: mcVersion, timeout: 10000 }, (err, result) => {
        callback(err, result);
    });
}

// ─────────────────────────────────────────
//  CREATE BOT — Sonar Verification Flow
// ─────────────────────────────────────────
function createBot(acc, attempt = 1) {
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
            sonarVerified: false,
            reconnectAttempts: 0,
            lastError: null
        };
    }

    botStates[u].manual = false;
    log(u, 'Connecting... (attempt ' + attempt + ')', 'info');
    updateStatus(u, 'Connecting');

    const bot = mineflayer.createBot({
        host: serverIp,
        port: serverPort,
        username: u,
        version: mcVersion,
        auth: 'offline',
        hideErrors: false,
        brand: 'vanilla',
        checkTimeoutInterval: 60000
    });

    bots[u] = bot;
    let statTimer;
    let sonarTimer = null;
    let reconnectCooldown = NORMAL_RECONNECT;

    // ── SPAWN ──
    bot.on('spawn', () => {
        electPrimaryBot();

        if (!botStates[u].sonarVerified) {
            log(u, '⏳ Bypassing Sonar (Twerking)...', 'info');
            updateStatus(u, 'Sonar Bypassing' + (isPrimary(u) ? ' [PRIMARY]' : ''));
            botStates[u].onlineSince = Date.now();

            let yaw = bot.entity ? bot.entity.yaw : 0;
            let pitch = bot.entity ? bot.entity.pitch : 0;
            botStates[u].sonarBypassInterval = setInterval(() => {
                if (!bots[u] || !bot.entity) return;
                try {
                    bot.setControlState('sneak', true);
                    bot.swingArm('right');
                    yaw += (Math.random() - 0.5) * 0.5;
                    pitch += (Math.random() - 0.5) * 0.5;
                    bot.look(yaw, pitch, false);
                    setTimeout(() => {
                        if (bots[u]) bot.setControlState('sneak', false);
                    }, 200);
                } catch (e) {}
            }, 500);

            sonarTimer = setTimeout(() => {
                if (!bots[u]) return;
                log(u, '⚠️ Sonar timeout — assuming verified, sending /login...', 'warning');
                botStates[u].sonarVerified = true;
                if (botStates[u].sonarBypassInterval) {
                    clearInterval(botStates[u].sonarBypassInterval);
                    botStates[u].sonarBypassInterval = null;
                }
                bot.chat('/login ' + acc.password);
                log(u, '⌨️ Sent /login', 'info');
            }, SONAR_TIMEOUT);
        } else {
            log(u, '✅ Spawned (Sonar verified)' + (isPrimary(u) ? ' [PRIMARY]' : ''), 'success');
            updateStatus(u, 'Online' + (isPrimary(u) ? ' [PRIMARY]' : ''));
            botStates[u].onlineSince = Date.now();

            setTimeout(() => {
                if (!bots[u]) return;
                bot.chat('/login ' + acc.password);
                log(u, '⌨️ Sent /login', 'info');
            }, 1500);
        }

        statTimer = setInterval(() => {
            if (!bot.entity) return;
            updateStats(u, {
                health: bot.health || 0,
                food: bot.food || 0,
                x: Math.round(bot.entity.position?.x || 0),
                y: Math.round(bot.entity.position?.y || 0),
                z: Math.round(bot.entity.position?.z || 0)
            });
        }, 2000);
    });

    // ── MESSAGES ──
    bot.on('message', m => {
        const txt = m.toString().trim();
        if (!txt) return;

        log(u, txt, 'info');
        const n = normalizeText(txt);

        if (n.includes('successfully logged in') ||
            n.includes('your login session has been continued') ||
            n.includes('you are already logged')) {

            log(u, '🚀 Login confirmed! Starting Anti-AFK...', 'success');
            updateStatus(u, 'Online' + (isPrimary(u) ? ' [PRIMARY]' : ''));
            setTimeout(() => { if (bots[u]) startAntiAfk(u); }, 3000);
        }

        if (n.includes('please login') || n.includes('/login') || n.includes('register')) {
            if (!botStates[u].sonarVerified) {
                log(u, '✅ Sonar verification bypassed! Sending login...', 'success');
                botStates[u].sonarVerified = true;
                if (sonarTimer) { clearTimeout(sonarTimer); sonarTimer = null; }
                if (botStates[u].sonarBypassInterval) {
                    clearInterval(botStates[u].sonarBypassInterval);
                    botStates[u].sonarBypassInterval = null;
                }
                setTimeout(() => {
                    if (bots[u]) bot.chat('/login ' + acc.password);
                }, 1000);
            }
        }

        if (n.includes('logging in too fast') || n.includes('too fast')) {
            reconnectCooldown = SLOW_RECONNECT;
            log(u, '⚠️ Logging too fast! Will wait 60s before rejoin.', 'warning');
        }

        if (n.includes('verification') || n.includes('captcha') || n.includes('complete the')) {
            log(u, '🔍 Detected verification/captcha prompt', 'warning');
        }
    });

    // ── ERROR ──
    bot.on('error', e => {
        const msg = e.message || String(e);
        log(u, 'Error: ' + msg, 'error');
        botStates[u].lastError = msg;

        if (msg.includes('ECONNREFUSED')) {
            log(u, '🔴 Server refused connection.', 'error');
            reconnectCooldown = Math.min(startCooldown * Math.pow(1.5, botStates[u].reconnectAttempts), MAX_RECONNECT_DELAY);
        } else if (msg.includes('ETIMEDOUT') || msg.includes('timeout')) {
            log(u, '⏱️ Connection timed out.', 'warning');
            reconnectCooldown = Math.min(30000 * Math.pow(1.5, botStates[u].reconnectAttempts), MAX_RECONNECT_DELAY);
        } else if (msg.includes('ECONNRESET')) {
            log(u, '🔌 Connection reset by server.', 'warning');
        }
    });

    // ── KICKED ──
    bot.on('kicked', r => {
        const reason = typeof r === 'string' ? r : JSON.stringify(r);
        log(u, 'Kicked: ' + reason, 'warning');

        if (sonarTimer) { clearTimeout(sonarTimer); sonarTimer = null; }

        const rLow = reason.toLowerCase();

        if (!botStates[u].sonarVerified) {
            botStates[u].sonarVerified = true;
            if (botStates[u].sonarBypassInterval) {
                clearInterval(botStates[u].sonarBypassInterval);
                botStates[u].sonarBypassInterval = null;
            }
            reconnectCooldown = NORMAL_RECONNECT;
            log(u, '✅ Sonar verification kick received! Reconnecting to login...', 'success');
        } else if (rLow.includes('logging in too fast') || rLow.includes('too fast')) {
            reconnectCooldown = SLOW_RECONNECT;
            log(u, '⏳ Too fast kick — waiting 60s', 'warning');
        } else if (rLow.includes('internal') || rLow.includes('limbo')) {
            reconnectCooldown = FAST_RECONNECT;
        } else {
            reconnectCooldown = NORMAL_RECONNECT;
        }
    });

    // ── END → Reconnect ──
    bot.on('end', reason => {
        if (statTimer) clearInterval(statTimer);
        if (sonarTimer) { clearTimeout(sonarTimer); sonarTimer = null; }
        if (botStates[u] && botStates[u].sonarBypassInterval) {
            clearInterval(botStates[u].sonarBypassInterval);
            botStates[u].sonarBypassInterval = null;
        }
        stopAntiAfk(u);
        delete bots[u];
        updateStatus(u, 'Offline');

        log(u, 'Disconnected. Reason: ' + (reason || 'unknown'), 'warning');

        if (isPrimary(u)) { primaryBotUsername = null; electPrimaryBot(); }

        if (botStates[u] && !botStates[u].manual) {
            const cooldown = reconnectCooldown;
            reconnectCooldown = NORMAL_RECONNECT;

            if (botStates[u].lastError && botStates[u].lastError.includes('ECONNREFUSED')) {
                botStates[u].reconnectAttempts++;
            } else {
                botStates[u].reconnectAttempts = 0;
            }

            log(u, 'Reconnecting in ' + Math.round(cooldown / 1000) + 's...', 'warning');
            updateStatus(u, 'Reconnecting in ' + Math.round(cooldown / 1000) + 's...');

            setTimeout(() => {
                const a = loadAccounts().find(x => x.username === u);
                if (a && botStates[u] && !botStates[u].manual) {
                    createBot(a, botStates[u].reconnectAttempts + 1);
                }
            }, cooldown);
        } else {
            log(u, 'Offline (manual stop)', 'info');
        }
    });
}

// ─────────────────────────────────────────
//  TELEGRAM COMMANDS
// ─────────────────────────────────────────
function handleTelegramCommand(msg) {
    if (!telegramBot) return;
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text || '';

    if (!ADMIN_IDS.includes(userId)) {
        telegramBot.sendMessage(chatId, '❌ Unauthorized\nYour ID: ' + userId);
        return;
    }
    if (!text.startsWith('/')) return;

    const parts = text.split(' ');
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ');

    if (cmd === '/status') {
        let s = '📊 *STATUS*\n\n';
        loadAccounts().forEach(a => {
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
        telegramBot.sendMessage(chatId, s, { parse_mode: 'Markdown' });
        return;
    }

    if (cmd === '/on') {
        if (!arg) { telegramBot.sendMessage(chatId, '⚠️ Usage: /on <user|all>'); return; }
        const accs = loadAccounts();
        const targets = arg === 'all' ? accs : accs.filter(a => a.username === arg);
        if (!targets.length) { telegramBot.sendMessage(chatId, '❌ Not found: ' + arg); return; }
        telegramBot.sendMessage(chatId, '🚀 Starting...');
        targets.forEach((acc, i) => {
            if (bots[acc.username]) return;
            setTimeout(() => {
                if (botStates[acc.username]) botStates[acc.username].manual = false;
                createBot(acc);
            }, i * 3000);
        });
        return;
    }

    if (cmd === '/off') {
        if (!arg) { telegramBot.sendMessage(chatId, '⚠️ Usage: /off <user>'); return; }
        const b = bots[arg];
        if (!b) { telegramBot.sendMessage(chatId, '⚠️ Already offline'); return; }
        if (botStates[arg]) botStates[arg].manual = true;
        telegramBot.sendMessage(chatId, '⏹️ Stopping ' + arg + '...');
        try { b.quit(); setTimeout(() => { if (bots[arg] === b) b.end(); }, 500); }
        catch (e) { try { b.end(); } catch (_) { } }
        return;
    }

    if (cmd === '/restart') {
        if (!arg) { telegramBot.sendMessage(chatId, '⚠️ Usage: /restart <user|all>'); return; }
        const accs = loadAccounts();
        const targets = arg === 'all' ? accs : accs.filter(a => a.username === arg);
        if (!targets.length) { telegramBot.sendMessage(chatId, '❌ Not found: ' + arg); return; }
        targets.forEach((acc, i) => {
            const u = acc.username;
            if (bots[u]) { botStates[u].manual = true; try { bots[u].quit(); } catch (e) { } }
            if (botStates[u]) botStates[u].sonarVerified = false;
            setTimeout(() => {
                if (botStates[u]) botStates[u].manual = false;
                createBot(acc);
            }, 5000 + i * 3000);
        });
        telegramBot.sendMessage(chatId, '🔄 Restarting...');
        return;
    }

    if (cmd === '/send') {
        if (parts.length < 3) { telegramBot.sendMessage(chatId, '⚠️ Usage: /send <user> <msg>'); return; }
        const tu = parts[1], tmsg = parts.slice(2).join(' ');
        if (!bots[tu]) { telegramBot.sendMessage(chatId, '❌ ' + tu + ' offline'); return; }
        bots[tu].chat(tmsg);
        telegramBot.sendMessage(chatId, '✅ Sent: "' + tmsg + '"');
        return;
    }

    if (cmd === '/all') {
        if (!arg) { telegramBot.sendMessage(chatId, '⚠️ Usage: /all <cmd>'); return; }
        const online = Object.keys(bots);
        if (!online.length) { telegramBot.sendMessage(chatId, '❌ No bots online'); return; }
        online.forEach(u => bots[u].chat(arg));
        telegramBot.sendMessage(chatId, '✅ Sent to ' + online.length + ' bot(s)');
        return;
    }

    if (cmd === '/reload') {
        reloadAccounts();
        telegramBot.sendMessage(chatId, '🔄 Accounts reloaded (' + loadAccounts().length + ')');
        return;
    }

    if (cmd === '/offd') { dashboardEnabled = false; telegramBot.sendMessage(chatId, '📴 Dashboard OFF'); return; }
    if (cmd === '/ond') { dashboardEnabled = true; telegramBot.sendMessage(chatId, '🌐 Dashboard ON'); return; }
    if (cmd === '/ping') {
        pingServer((err, result) => {
            if (err) {
                telegramBot.sendMessage(chatId, '❌ Ping failed: ' + err.message);
            } else {
                const motd = result.description?.text || result.description || 'N/A';
                telegramBot.sendMessage(chatId, `✅ Server Online\nPlayers: ${result.players?.online || 0}/${result.players?.max || 0}\nVersion: ${result.version?.name || 'N/A'}\nMOTD: ${motd}`);
            }
        });
        return;
    }

    const u = cmd.substring(1);
    if (bots[u] && arg) {
        if (arg === '/eat') { eatFood(u); telegramBot.sendMessage(chatId, '🍖 Eating...'); }
        else { bots[u].chat(arg); telegramBot.sendMessage(chatId, '✅ Sent: "' + arg + '"'); }
        return;
    }

    if (cmd !== '/start') {
        telegramBot.sendMessage(chatId,
            '❓ Commands:\n/status\n/on <user|all>\n/off <user>\n/restart <user|all>\n/send <user> <msg>\n/all <cmd>\n/<user> <cmd>\n/ping\n/reload\n/offd /ond'
        );
    }
}

// ─────────────────────────────────────────
//  SOCKET HANDLERS (Dashboard)
// ─────────────────────────────────────────
function setupSocketHandlers() {
    if (!io) return;
    io.on('connection', s => {
        // Socket auth (if dashboard token is set)
        if (dashboardToken) {
            const token = s.handshake?.auth?.token || s.handshake?.query?.token;
            if (token !== dashboardToken) {
                s.emit('auth_error', { message: 'Invalid token' });
                s.disconnect();
                return;
            }
        }

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
            const a = accs.find(x => x.username === u);
            if (a && !bots[u]) createBot(a);
        });

        s.on('stop-bot', u => {
            const b = bots[u];
            if (!b) return;
            if (botStates[u]) botStates[u].manual = true;
            log(u, 'Manual STOP from Dashboard', 'warning');
            try { b.quit(); setTimeout(() => { if (bots[u] === b) b.end(); }, 500); }
            catch (e) { try { b.end(); } catch (_) { } }
        });

        s.on('reconnect-bot', u => {
            const a = accs.find(x => x.username === u);
            if (!a) return;
            if (bots[u]) {
                botStates[u].manual = true;
                try { bots[u].quit(); } catch (e) { }
            }
            if (botStates[u]) botStates[u].sonarVerified = false;
            setTimeout(() => {
                if (botStates[u]) botStates[u].manual = false;
                createBot(a);
            }, 3000);
        });

        s.on('eat-food', u => {
            if (u === 'all') Object.keys(bots).forEach(user => eatFood(user));
            else eatFood(u);
        });

        s.on('send-chat', data => {
            const message = String(data.message || '').slice(0, 256).trim();
            if (!message) return;
            if (data.username === 'all') Object.values(bots).forEach(b => b.chat(message));
            else if (bots[data.username]) bots[data.username].chat(message);
        });

        s.on('get-status', () => {
            s.emit('status-response', Object.keys(bots).map(u => ({
                username: u, uptime: getUptime(botStates[u]?.onlineSince)
            })));
        });

        s.on('ping-server', () => {
            pingServer((err, result) => {
                if (err) {
                    s.emit('server-ping', { online: false, error: err.message });
                } else {
                    s.emit('server-ping', { online: true, ...result });
                }
            });
        });
    });
}

// ─────────────────────────────────────────
//  CRASH PROTECTION
// ─────────────────────────────────────────
process.on('uncaughtException', err => {
    if (err.message?.includes('PartialReadError') || err.name === 'PartialReadError') return;
    console.error('[CRASH PREVENTED] ' + err.message);
    sendTg('[SYSTEM] ⚠️ Crash: ' + err.message, 'error');
});

process.on('unhandledRejection', reason => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error('[UNHANDLED] ' + msg);
    sendTg('[SYSTEM] ⚠️ Unhandled: ' + msg, 'error');
});

// ─────────────────────────────────────────
//  SHUTDOWN
// ─────────────────────────────────────────
function shutdown(sig) {
    console.log('Shutting down (' + sig + ')...');
    sendTg('[SYSTEM] 🔴 Shutting down', 'warning');
    Object.keys(bots).forEach(u => {
        botStates[u].manual = true;
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

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('       MINECRAFT AFK BOT v2.2');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Server   :', serverIp + ':' + serverPort);
console.log('Accounts :', loadedAccounts.length);
console.log('Version  :', mcVersion, '(Offline/Cracked)');
console.log('Dashboard:', dashboardToken ? 'Token protected' : 'OPEN (no auth)');
console.log('Telegram :', USE_TELEGRAM ? 'ON' : 'OFF');
console.log('Flow     : join → Sonar verify → reconnect → /login → Anti-AFK');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

pingServer((err, result) => {
    if (err) {
        console.log('⚠️  Server ping failed:', err.message);
        sendTg('[SYSTEM] ⚠️ Server unreachable: ' + err.message, 'warning');
    } else {
        const motd = result.description?.text || result.description || 'N/A';
        console.log('✅ Server ONLINE — Players:', (result.players?.online || 0) + '/' + (result.players?.max || 0));
        console.log('   MOTD:', motd);
        sendTg('[SYSTEM] ✅ Server online: ' + (result.players?.online || 0) + ' players', 'success');
    }

    initDashboard();

    loadedAccounts.forEach((acc, i) => {
        setTimeout(() => createBot(acc), 2000 + i * 3000);
    });
});

setTimeout(() => {
    if (!telegramBot) return;
    telegramBot.sendMessage(TELEGRAM_CHAT_ID,
        '🟢 *Bot Started v2.2*\n' +
        '🖥️ Server: ' + serverIp + ':' + serverPort + '\n' +
        '👤 Accounts: ' + loadedAccounts.length + '\n' +
        '📊 Dashboard: port ' + dashboardPort,
        { parse_mode: 'Markdown' }
    ).catch(e => console.log('TG startup error:', e.message));
}, 3000);
