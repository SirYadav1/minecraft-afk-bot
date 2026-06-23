# Minecraft AFK Bot v2.2

Multi-account Minecraft AFK bot with Telegram control, web dashboard, and Sonar anti-cheat bypass.

## Features

- **Multi-account** — Run multiple bots simultaneously
- **Sonar Bypass** — Auto-bypasses Sonar verification (twerk + reconnect flow)
- **Anti-AFK** — Random movement + head rotation (Grim-safe)
- **Telegram Control** — Start/stop/restart bots from Telegram
- **Web Dashboard** — Real-time stats, chat, control (token-protected)
- **Auto-Reconnect** — Exponential backoff, handles kicks/timeouts
- **Player Detection** — Alerts when unknown players enter range
- **Server Ping** — Check if server is online before connecting

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure .env

```bash
cp .env.example .env
```

Edit `.env`:

```env
SERVER_IP=play.yourserver.com
SERVER_PORT=25565
DASHBOARD_PORT=20289
DASHBOARD_TOKEN=your-secret-token
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id
ADMIN_IDS=123456789,987654321
MC_VERSION=1.21.1
```

### 3. Add Accounts

Edit `accounts.json`:

```json
{
  "accounts": [
    {
      "username": "bot1",
      "password": "yourpassword",
      "status": "active"
    }
  ]
}
```

### 4. Run

```bash
node index.js
```

## Telegram Commands

| Command | Description |
|---|---|
| `/status` | All bot status |
| `/on <user\|all>` | Start bot(s) |
| `/off <user>` | Stop bot |
| `/restart <user\|all>` | Restart bot(s) |
| `/send <user> <msg>` | Send chat message |
| `/all <cmd>` | Broadcast to all bots |
| `/<user> <cmd>` | Send command to specific bot |
| `/ping` | Check server status |
| `/reload` | Reload accounts from file |
| `/offd` `/ond` | Toggle dashboard |

## Dashboard

Open `http://localhost:20289?token=YOUR_TOKEN` in browser.

- Start/stop/reconnect bots
- Send chat messages
- View real-time health, food, coords
- Server ping
- Live log feed

## How It Works

```
Join Server → Sonar Bypass (twerk 15s) → Kicked → Reconnect → /login → Anti-AFK
```

1. Bot joins in offline/cracked mode
2. Twerks + swings arm to bypass Sonar verification
3. Gets kicked (Sonar verified), reconnects
4. Sends `/login` command
5. Starts anti-AFK (random moves every 5 min + head rotation)

## License

MIT
