// src/telegram.js — Telegram Bot for polymarket-weather-trade notifications and commands
import { config } from './config.js';
import { createLogger, logDetailedError } from './logger.js';

const log = createLogger('telegram');

const BOT_TOKEN = () => config.telegramBotToken;
const CHAT_ID  = () => config.telegramChatId;
const API_BASE = () => `https://api.telegram.org/bot${BOT_TOKEN()}`;

let pollingActive = false;
let pollingOffset = 0;
let pollingTimer = null;

async function callApi(method, params = {}) {
  if (!BOT_TOKEN() || !CHAT_ID()) return null;
  try {
    const url = `${API_BASE()}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!data.ok) {
      log.warn(`Telegram API error (${method}): ${data.description}`);
      return null;
    }
    return data.result;
  } catch (err) {
    log.warn(`Telegram API call failed (${method}): ${err.message}`);
    return null;
  }
}

async function sendMessage(text, options = {}) {
  if (!BOT_TOKEN() || !CHAT_ID()) return null;
  const truncated = text.length > 4000 ? text.slice(0, 3997) + '...' : text;
  return callApi('sendMessage', {
    chat_id: CHAT_ID(),
    text: truncated,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...options,
  });
}

// ─── Notifications ──────────────────────────────────────────────────────────

export const notify = {
  async startup({ balance, paperTrade, wallet, model }) {
    const mode = paperTrade ? 'PAPER' : 'LIVE';
    await sendMessage(
      `<b>polymarket-weather-trade Started</b>\n\n` +
      `Mode: ${mode}\n` +
      `Balance: <b>$${balance?.toFixed(2) ?? '?'}</b>\n` +
      `Wallet: <code>${wallet?.slice(0, 10)}...${wallet?.slice(-6)}</code>\n` +
      `Model: ${model}\n` +
      `Time: ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`
    );
  },

  async betPlaced({ eventTitle, category, location, predictedOutcome, price, amount, shares, confidence, edge, reasoning, paperTrade }) {
    const mode = paperTrade ? ' [PAPER]' : '';
    await sendMessage(
      `<b>New Bet Placed${mode}</b>\n\n` +
      `<b>${eventTitle?.slice(0, 80) || 'Event'}</b>\n` +
      `Category: ${category || '?'} | Location: ${location || '?'}\n` +
      `Prediction: <b>${predictedOutcome}</b>\n` +
      `Price: ${price} | Amount: $${amount}\n` +
      `Shares: ${shares}\n` +
      `Confidence: ${confidence}% | Edge: ${((edge || 0) * 100).toFixed(1)}%\n\n` +
      `<i>${(reasoning || '').slice(0, 200)}</i>`
    );
  },

  async betResult({ action, eventTitle, predictedOutcome, buyPrice, sellPrice, pnl, shares }) {
    const labels = {
      redeemed: 'WIN',
      take_profit: 'TAKE PROFIT',
      cancelled: 'CANCELLED',
      lost: 'LOST',
      needs_manual_redeem: 'NEEDS MANUAL REDEEM',
      expired: 'EXPIRED',
    };
    const label = labels[action] || action;
    const pnlStr = pnl != null ? `$${pnl.toFixed(4)}` : 'N/A';

    await sendMessage(
      `<b>Bet ${label}</b>\n\n` +
      `<b>${eventTitle?.slice(0, 60) || 'Event'}</b>\n` +
      `${predictedOutcome}\n` +
      `Buy: ${buyPrice?.toFixed(3) ?? '?'} -> Sell: ${sellPrice?.toFixed(3) ?? 'N/A'}\n` +
      `P&amp;L: <b>${pnlStr}</b> | Shares: ${shares ?? '?'}`
    );
  },

  async scanComplete({ eventsFound, betsPlaced, decisions }) {
    if (eventsFound === 0 && betsPlaced === 0) return;

    const betLines = (decisions || [])
      .filter(d => d.shouldBet)
      .map(d => `  - ${d.event?.slice(0, 40)} -> ${d.predictedOutcome} (${d.confidence}%)`)
      .join('\n');

    const passedCount = (decisions || []).filter(d => !d.shouldBet).length;

    await sendMessage(
      `<b>Scan Complete</b>\n\n` +
      `Events found: ${eventsFound}\n` +
      `Bets placed: ${betsPlaced}\n` +
      `Passed: ${passedCount}\n` +
      (betLines ? `\n<b>Bets:</b>\n${betLines}` : '') +
      `\n\n${new Date().toISOString().slice(11, 19)} UTC`
    );
  },

  async dailyReport(reportText) {
    await sendMessage(
      `<b>Daily Report</b>\n\n<pre>${escapeHtml(reportText)}</pre>`
    );
  },

  async error({ context, error: errorMsg }) {
    await sendMessage(
      `<b>Error</b>\n\n` +
      `Context: ${context}\n` +
      `${escapeHtml(String(errorMsg).slice(0, 500))}`
    );
  },

  async balanceWarning({ balance, threshold }) {
    await sendMessage(
      `<b>Low Balance Warning</b>\n\n` +
      `Current: <b>$${balance.toFixed(2)}</b>\n` +
      `Threshold: $${threshold}`
    );
  },
};

// ─── Command Handler ────────────────────────────────────────────────────────

let commandHandlers = {};

export function registerCommands(handlers) {
  commandHandlers = { ...commandHandlers, ...handlers };
}

async function handleCommand(text, chatId) {
  if (String(chatId) !== String(CHAT_ID())) return;

  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/^\//, '').split('@')[0];

  const handler = commandHandlers[cmd];
  if (handler) {
    try {
      const response = await handler(chatId, parts.slice(1), text);
      if (response) {
        await callApi('sendMessage', {
          chat_id: chatId,
          text: response,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      }
    } catch (err) {
      logDetailedError(log, `Command /${cmd} error`, err, { command: cmd });
      await callApi('sendMessage', { chat_id: chatId, text: `Error: /${cmd}: ${err.message}` });
    }
  } else if (cmd === 'start' || cmd === 'help') {
    await callApi('sendMessage', { chat_id: chatId, text: getHelpText(), parse_mode: 'HTML' });
  } else {
    await callApi('sendMessage', { chat_id: chatId, text: `Unknown: /${cmd}\n\nType /help for commands.` });
  }
}

function getHelpText() {
  return (
    `<b>polymarket-weather-trade Commands</b>\n\n` +
    `/status — Bot status\n` +
    `/balance — USDC balance\n` +
    `/bets — Active bets\n` +
    `/recent — Recent bets\n` +
    `/stats — Stats (W/L/P&amp;L)\n` +
    `/scan — Trigger weather scan\n` +
    `/report — Daily report\n` +
    `/health — Health check\n` +
    `/risk — Risk status\n` +
    `/events — Last scanned events\n` +
    `/pnl — All-time P&amp;L\n` +
    `/help — Show commands`
  );
}

// ─── Polling ────────────────────────────────────────────────────────────────

export function startPolling() {
  if (!BOT_TOKEN() || !CHAT_ID()) return;
  pollingActive = true;
  log.info('Telegram bot polling started');
  registerBotCommands();
  poll();
}

async function poll() {
  if (!pollingActive) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35000);

    const res = await fetch(`${API_BASE()}/getUpdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset: pollingOffset, timeout: 30, allowed_updates: ['message'] }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const data = await res.json();
    if (data.ok && Array.isArray(data.result)) {
      for (const update of data.result) {
        pollingOffset = update.update_id + 1;
        if (update.message?.text?.startsWith('/')) {
          await handleCommand(update.message.text, update.message.chat.id);
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      log.warn(`Telegram polling error: ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  if (pollingActive) pollingTimer = setTimeout(poll, 100);
}

export function stopPolling() {
  pollingActive = false;
  if (pollingTimer) { clearTimeout(pollingTimer); pollingTimer = null; }
  log.info('Telegram bot polling stopped');
}

async function registerBotCommands() {
  await callApi('setMyCommands', {
    commands: [
      { command: 'status',  description: 'Bot status' },
      { command: 'balance', description: 'USDC balance' },
      { command: 'bets',    description: 'Active bets' },
      { command: 'recent',  description: 'Recent bets' },
      { command: 'stats',   description: 'Stats' },
      { command: 'scan',    description: 'Trigger weather scan' },
      { command: 'report',  description: 'Daily report' },
      { command: 'health',  description: 'Health check' },
      { command: 'risk',    description: 'Risk status' },
      { command: 'events',  description: 'Last scanned events' },
      { command: 'pnl',     description: 'All-time P&L' },
      { command: 'help',    description: 'Show commands' },
    ],
  });
  await callApi('setMyName', { name: 'polymarket-weather-trade' });
  await callApi('setMyDescription', { description: 'Autonomous weather betting bot on Polymarket using OpenWeatherMap forecasts.' });
  await callApi('setMyShortDescription', { short_description: 'Polymarket Weather Betting Bot' });
  log.info('Telegram bot commands registered');
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function isTelegramConfigured() {
  return !!(BOT_TOKEN() && CHAT_ID());
}
