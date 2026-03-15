import express from 'express';
import { config, validateConfig } from './config.js';
import { createLogger } from './logger.js';
import { startScheduler, runDailyTemperatureJob, state } from './scheduler.js';
import { renderSettingsPage } from './settingsPage.js';
import { getSettingsPayload, saveSettingsPatch, SettingsValidationError, startSettingsStore } from './settingsStore.js';
import {
  registerStatusStreamClient,
  refreshStatusSnapshot,
  renderStatusPage,
  startStatusMonitor,
  unregisterStatusStreamClient,
} from './status.js';

const log = createLogger('index');
const app = express();
app.use(express.json());

startSettingsStore();

const validation = validateConfig();
if (!validation.valid) {
  for (const e of validation.errors) log.error(e);
  process.exit(1);
}
for (const w of validation.warnings) log.warn(w);

app.get('/', (_req, res) => {
  res.json({
    name: 'polymarket-weather-bet',
    status: 'ok',
    initialized: state.initialized,
    running: state.running,
    lastRunAt: state.lastRunAt,
    lastSummary: state.lastSummary,
    cron: config.dailyScanCron,
    windowHours: { min: config.scanWindowMinHours, max: config.scanWindowMaxHours },
    dailySlots: config.dailyBetSlots,
    paperTrade: config.paperTrade(),
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.post('/trigger/run', async (_req, res) => {
  const summary = await runDailyTemperatureJob('manual');
  res.json(summary);
});

app.get('/status', (_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.send(renderStatusPage());
});

app.get('/status/data', async (_req, res) => {
  const payload = await refreshStatusSnapshot();
  res.json(payload);
});

app.get('/status/stream', (req, res) => {
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders?.();

  registerStatusStreamClient(res);
  req.on('close', () => {
    unregisterStatusStreamClient(res);
    res.end();
  });
});

app.get('/settings', (_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.send(renderSettingsPage());
});

app.get('/settings/data', (_req, res) => {
  res.json(getSettingsPayload());
});

app.post('/settings/data', async (req, res) => {
  try {
    const patch = req.body?.settings;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ error: 'Invalid payload. Expected { settings: { ... } }' });
    }

    const payload = await saveSettingsPatch(patch);
    return res.json({ ok: true, ...payload });
  } catch (err) {
    if (err instanceof SettingsValidationError) {
      return res.status(err.statusCode || 400).json({ error: err.message, errors: err.errors || [] });
    }
    return res.status(500).json({ error: err.message });
  }
});

app.listen(config.port, () => {
  log.info(`polymarket-weather-bet listening on :${config.port}`);
  startStatusMonitor();
  startScheduler();
});
