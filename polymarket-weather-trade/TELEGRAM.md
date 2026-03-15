# Telegram Bot Setup Guide

SoccerBot sends real-time notifications for every bet, match result, take-profit sell, error, and daily report directly to your Telegram chat.

---

## Step 1: Create the Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Choose a **name** for the bot (e.g., `SoccerBot`) — this is the display name
4. Choose a **username** (e.g., `my_soccerbot_bot`) — must end in `bot`
5. BotFather replies with your **bot token** — a string like `7123456789:AAH_your_secret_token_here`
6. Copy the token — you'll need it in Step 3

> The bot will automatically set its name to "SoccerBot" via the Telegram API when it starts.

## Step 2: Get Your Chat ID

The bot needs a **chat ID** to know where to send messages.

### Option A: Direct message (recommended)

1. Open your new bot in Telegram and click **Start** (or send `/start`)
2. Open this URL in your browser (replace `YOUR_TOKEN` with the token from Step 1):
   ```
   https://api.telegram.org/botYOUR_TOKEN/getUpdates
   ```
3. Look for `"chat": {"id": 123456789}` in the JSON response
4. Copy the numeric `id` value — that's your chat ID

### Option B: Group chat

1. Create a Telegram group and add the bot
2. Send any message in the group
3. Open `https://api.telegram.org/botYOUR_TOKEN/getUpdates`
4. Find the group `chat.id` (group IDs are negative numbers, e.g., `-1001234567890`)
5. Use that as your chat ID

## Step 3: Configure Environment Variables

Add these two variables to your `.env` file:

```bash
TELEGRAM_BOT_TOKEN=7123456789:AAH_your_secret_token_here
TELEGRAM_CHAT_ID=123456789
```

Then restart the bot. On startup you should see:
```
[telegram] Telegram bot polling started
[telegram] Telegram bot commands registered
```

And you'll receive a startup notification in Telegram:

> ⚽ **SoccerBot Started**
> Mode: 💰 LIVE
> Balance: **$25.00**
> ...

## Step 4: Verify It Works

Send `/help` to the bot in Telegram. You should get back the full command list.

---

## Commands

| Command | Description |
|---------|-------------|
| `/status` | Bot status, balance, active bets, scanning state |
| `/balance` | Current USDC balance |
| `/bets` | List all active (open) bets with details |
| `/recent` | Last 10 bet results (wins, losses, sells) |
| `/stats` | Today's stats: bets placed, W/L, P&L |
| `/scan` | Trigger a manual betting scan immediately |
| `/report` | Generate and send the daily report |
| `/health` | Run system health checks (DB, wallet, APIs) |
| `/risk` | Risk manager status (cooldowns, streak, limits) |
| `/matches` | Show last scanned matches with odds |
| `/pnl` | All-time P&L summary |
| `/help` | Show all available commands |

---

## Notifications

The bot automatically sends messages for these events:

| Event | When |
|-------|------|
| **Startup** | Bot server starts — shows mode, balance, wallet |
| **Bet Placed** | Every new bet — match, prediction, price, confidence, reasoning |
| **Take Profit** | Shares sold early because price rose >40% |
| **Win Redeemed** | Winning bet automatically redeemed |
| **Loss** | Match resolved as a loss |
| **Expired** | Stale unfilled order expired |
| **Needs Manual Redeem** | Sell/redeem failed 3+ times — requires manual action |
| **Scan Complete** | After each scan — matches found, bets placed, pass count |
| **Daily Report** | End-of-day summary at 23:50 UTC |
| **Low Balance** | Balance drops below $20 warning threshold |
| **Cooldown Activated** | Losing streak or consecutive loss-day cooldown triggered |
| **Error** | Bet placement failure, status check failure, scan pipeline errors |

---

## Troubleshooting

### Bot not sending messages
- Verify `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set in `.env`
- Make sure you sent `/start` to the bot in Telegram first
- Check logs for `[telegram] Telegram not configured — polling disabled`

### Commands not showing in the menu
- The bot registers commands on startup via `setMyCommands`
- Try sending `/help` directly — the menu may take a minute to update on Telegram's side

### Messages not arriving for bets/scans
- Notifications are fire-and-forget (`.catch(() => {})`) to avoid breaking the betting pipeline
- Check logs for `Telegram API error` or `Telegram API call failed` warnings

### Wrong chat ID
- Group chat IDs are negative numbers (e.g., `-1001234567890`)
- Personal chat IDs are positive numbers
- The bot only responds to commands from the configured `TELEGRAM_CHAT_ID` for security

### Rate limits
- Telegram allows ~30 messages per second per bot
- The bot is well within limits for normal operation
