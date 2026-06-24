<div align="center">

# ⛏️ Minecraft AFK Bot

**Multi-account AFK bot with Telegram control, web dashboard & Sonar bypass**

[![Version](https://img.shields.io/badge/version-2.2.0-blue.svg)]()
[![License](https://img.shields.io/badge/license-MIT-green.svg)]()
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)]()
[![Minecraft](https://img.shields.io/badge/minecraft-1.21.1-orange.svg)]()

[Features](#-features) • [Setup](#-setup) • [Commands](#-telegram-commands) • [Dashboard](#-dashboard) • [How It Works](#-how-it-works)

</div>

---

## 📸 Dashboard

<div align="center">

```
┌─────────────────────────────────────────────────┐
│  🟢 MINECRAFT AFK BOT v2.2                      │
├─────────────┬───────────────────────────────────┤
│ 👑TestUser1 │  🟢 Online [PRIMARY]             │
│              │  HP: 20/20  Food: 20/20          │
│              │  Uptime: 5h 32m                  │
│              │  Coords: 120, 64, -890           │
├─────────────┼───────────────────────────────────┤
│ 👤aaaaaa_098 │  🟢 Online                        │
│              │  HP: 18/20  Food: 15/20          │
│              │  Uptime: 2h 10m                  │
│              │  Coords: -340, 72, 1200          │
├─────────────┼───────────────────────────────────┤
│ 👤Abhay_325  │  🔴 Offline                       │
├─────────────┴───────────────────────────────────┤
│  📊 Server: play.test.fun:25565             │
│  📱 Telegram: ON  │  🛡️ Dashboard: Protected    │
└─────────────────────────────────────────────────┘
```

</div>

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🤖 **Multi-Account** | Run multiple bots simultaneously with independent states |
| 🛡️ **Sonar Bypass** | Auto-bypasses Sonar anti-cheat verification |
| 🏃 **Anti-AFK** | Random movement + head rotation — Grim-safe |
| 📱 **Telegram Control** | Start, stop, restart, chat — all from Telegram |
| 🌐 **Web Dashboard** | Real-time stats, live logs, full control |
| 🔄 **Auto-Reconnect** | Exponential backoff, handles kicks & timeouts |
| 👀 **Player Detection** | Alerts when unknown players enter range |
| 📡 **Server Ping** | Check server status before connecting |
| 🔐 **Token Auth** | Dashboard protected with secret token |
| ⚡ **Crash Protection** | Handles errors gracefully, never crashes |

---

## 🚀 Setup

### 1. Clone & Install

```bash
git clone https://github.com/SirYadav1/minecraft-afk-bot.git
cd minecraft-afk-bot
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
# ─── Server ───
SERVER_IP=play.yourserver.com
SERVER_PORT=25565
MC_VERSION=1.21.1

# ─── Dashboard ───
DASHBOARD_PORT=20289
DASHBOARD_TOKEN=your-secret-token

# ─── Telegram ───
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=-1001234567890
ADMIN_IDS=123456789,987654321

# ─── Settings ───
START_COOLDOWN=45000
```

### 3. Add Accounts

Edit `accounts.json`:

```json
{
  "accounts": [
    {
      "username": "bot_username",
      "password": "your_password",
      "status": "active"
    }
  ]
}
```

### 4. Start

```bash
node index.js
```

---

## 📱 Telegram Commands

| Command | Description |
|---------|-------------|
| `/status` | 📊 View all bot status |
| `/on <user\|all>` | 🚀 Start bot(s) |
| `/off <user>` | ⏹️ Stop bot |
| `/restart <user\|all>` | 🔄 Restart bot(s) |
| `/send <user> <msg>` | 💬 Send chat message |
| `/all <cmd>` | 📢 Broadcast command to all |
| `/<user> <cmd>` | 🎯 Send command to specific bot |
| `/ping` | 📡 Check server status |
| `/reload` | 🔄 Reload accounts file |
| `/offd` | 📴 Disable dashboard |
| `/ond` | 🌐 Enable dashboard |

---

## 🌐 Dashboard

Open in browser:

```
http://localhost:20289?token=YOUR_DASHBOARD_TOKEN
```

**Features:**
- ✅ Start / Stop / Reconnect bots
- ✅ Send chat messages
- ✅ View health, food, coordinates
- ✅ Server ping
- ✅ Real-time log feed
- ✅ Mobile responsive

---

## ⚙️ How It Works

```
┌──────────┐    ┌──────────────┐    ┌──────────┐    ┌─────────┐    ┌──────────┐
│  Join    │───▶│ Sonar Bypass │───▶│  Kicked  │───▶│ Rejoin  │───▶│ /login   │
│  Server  │    │ (twerk 15s)  │    │ (verify) │    │         │    │          │
└──────────┘    └──────────────┘    └──────────┘    └─────────┘    └────┬─────┘
                                                                        │
                                                                        ▼
                                                                  ┌──────────┐
                                                                  │ Anti-AFK │
                                                                  │ (active) │
                                                                  └──────────┘
```

1. **Join** — Bot connects in offline/cracked mode
2. **Sonar Bypass** — Twerks + swings arm for 15 seconds
3. **Kicked** — Server verifies and kicks (Sonar complete)
4. **Rejoin** — Bot reconnects automatically
5. **Login** — Sends `/login` command
6. **Anti-AFK** — Random moves every 5 min + head rotation

---

## 🛡️ Security

- ✅ `.env` for secrets (never committed)
- ✅ `.gitignore` protects accounts, config, logs
- ✅ Dashboard token authentication
- ✅ Telegram admin ID verification

---

## 📁 Project Structure

```
minecraft-afk-bot/
├── index.js           # Main bot logic
├── index.html         # Dashboard UI
├── accounts.json      # Bot accounts (gitignored)
├── .env               # Secrets (gitignored)
├── .env.example       # Environment template
├── .gitignore         # Git ignore rules
├── whitelist.txt      # Player whitelist
├── package.json       # Dependencies
└── README.md          # This file
```

---

## 📄 License

[MIT](LICENSE) © [SirYadav1](https://github.com/SirYadav1)

---

<div align="center">

**Made with ❤️ for Minecraft AFK farming**

[⬆ Back to Top](#-minecraft-afk-bot)

</div>
