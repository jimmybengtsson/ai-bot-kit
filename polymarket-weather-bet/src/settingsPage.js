import { getSettingsPayload } from './settingsStore.js';

function escapeHtml(s) {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderSettingsPage() {
  const payload = getSettingsPayload();
  const rows = payload.settings.map((item) => {
    const key = escapeHtml(item.key);
    const value = escapeHtml(item.value);
    const defaultValue = escapeHtml(item.defaultValue);
    const type = escapeHtml(item.type);
    const applyMode = escapeHtml(item.applyMode || 'realtime');
    const description = escapeHtml(item.description);
    const source = escapeHtml(item.source);
    const rangeBits = [];
    if (typeof item.min === 'number') rangeBits.push(`min ${item.min}`);
    if (typeof item.minExclusive === 'number') rangeBits.push(`> ${item.minExclusive}`);
    if (typeof item.max === 'number') rangeBits.push(`max ${item.max}`);
    if (item.integer) rangeBits.push('integer');
    if (Array.isArray(item.enum) && item.enum.length) rangeBits.push(`one of: ${item.enum.join(', ')}`);
    if (item.validatorHelp) rangeBits.push(item.validatorHelp);
    if (item.patternHelp) rangeBits.push(item.patternHelp);
    const rules = escapeHtml(rangeBits.join(' | '));

    let inputAttrs = '';
    const inputType = type === 'number' ? 'number' : 'text';
    if (type === 'number') {
      inputAttrs += ' inputmode="decimal"';
      if (typeof item.min === 'number') inputAttrs += ` min="${item.min}"`;
      if (typeof item.max === 'number') inputAttrs += ` max="${item.max}"`;
      if (typeof item.step === 'number') inputAttrs += ` step="${item.step}"`;
      else if (item.integer) inputAttrs += ' step="1"';
      else inputAttrs += ' step="any"';
      if (typeof item.minExclusive === 'number') {
        const adjustedMin = item.minExclusive + (typeof item.step === 'number' ? item.step : 0.0001);
        inputAttrs += ` min="${adjustedMin}"`;
      }
    }
    if (type === 'boolean') {
      inputAttrs += ' placeholder="true|false" pattern="^(true|false)$"';
    }
    if (Array.isArray(item.enum) && item.enum.length) {
      inputAttrs += ` placeholder="${item.enum.join('|')}"`;
    }

    return `
      <tr>
        <td>
          <div class="key">${key}</div>
          <div class="desc">${description}</div>
          <div class="meta">default: ${defaultValue || '(empty)'} | source: ${source}</div>
          ${rules ? `<div class="meta">rules: ${rules}</div>` : ''}
        </td>
        <td><span class="mode-badge mode-${applyMode}">${applyMode === 'restart' ? 'Restart Required' : 'Realtime'}</span></td>
        <td>
          <input type="${inputType}" data-key="${key}" data-type="${type}" value="${value}"${inputAttrs} />
        </td>
      </tr>
    `;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>polymarket-weather-bet settings</title>
  <style>
    :root {
      --bg: #f4f7fb;
      --card: #ffffff;
      --ink: #122033;
      --muted: #6d7c8f;
      --line: #dce5ef;
      --btn: #174ea6;
      --btn-ink: #ffffff;
      --ok: #117a43;
      --warn-bg: #fff7e8;
      --warn-ink: #8a5a00;
    }
    body {
      margin: 0;
      font-family: Menlo, Consolas, Monaco, monospace;
      color: var(--ink);
      background: linear-gradient(180deg, #eef4fb 0%, #f9fcff 100%);
    }
    .wrap {
      max-width: 1050px;
      margin: 0 auto;
      padding: 20px 14px 40px;
    }
    .head, .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 12px;
      box-shadow: 0 6px 18px rgba(18, 32, 51, 0.06);
    }
    .head {
      padding: 14px;
      margin-bottom: 12px;
    }
    .title {
      margin: 0 0 8px;
      font-size: 20px;
    }
    .muted { color: var(--muted); }
    .notice {
      margin-top: 8px;
      background: var(--warn-bg);
      color: var(--warn-ink);
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 12px;
    }
    .actions {
      margin-top: 10px;
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .btn {
      border: 0;
      border-radius: 8px;
      background: var(--btn);
      color: var(--btn-ink);
      padding: 8px 12px;
      cursor: pointer;
      font-weight: 700;
      font-family: inherit;
    }
    .btn.secondary {
      background: #dfe7f5;
      color: #1f3655;
    }
    .status {
      font-size: 12px;
      color: var(--muted);
    }
    .status.ok { color: var(--ok); font-weight: 700; }
    .card {
      overflow: hidden;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th, td {
      padding: 10px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    th {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      background: #f8fbff;
      color: var(--muted);
    }
    tr:last-child td { border-bottom: none; }
    input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      font: inherit;
      font-size: 12px;
      color: var(--ink);
      padding: 8px;
      background: #fff;
    }
    .key {
      font-weight: 700;
      margin-bottom: 2px;
    }
    .desc {
      color: var(--muted);
      margin-bottom: 2px;
    }
    .meta {
      color: var(--muted);
      font-size: 11px;
    }
    .mode-badge {
      display: inline-block;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.2px;
      white-space: nowrap;
    }
    .mode-realtime {
      background: #e8f8ef;
      color: #0e7b43;
    }
    .mode-restart {
      background: #fdebed;
      color: #ad233d;
    }
    @media (max-width: 760px) {
      .hide-sm { display: none; }
      th, td { padding: 8px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="head">
      <h1 class="title">polymarket-weather-bet /settings</h1>
      <div class="muted">Edit non-private-key settings. Empty input removes override and falls back to .env value.</div>
      <div class="notice">Overrides are persisted in <code>data/settings.json</code> and loaded before .env defaults.</div>
      <div class="notice">Realtime: ${escapeHtml(payload.summary.realtime.join(', '))}</div>
      <div class="notice">Restart required: ${escapeHtml(payload.summary.restartRequired.join(', '))}</div>
      <div class="actions">
        <button class="btn" id="saveBtn">Save Settings</button>
        <button class="btn secondary" id="reloadBtn">Reload</button>
        <span id="status" class="status">Ready</span>
      </div>
    </section>

    <section class="card">
      <table>
        <thead>
          <tr>
            <th>Variable</th>
            <th>Apply</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody id="settingsRows">${rows}</tbody>
      </table>
    </section>
  </div>

  <script>
    const statusEl = document.getElementById('status');

    function setStatus(text, ok = false) {
      statusEl.textContent = text;
      statusEl.className = ok ? 'status ok' : 'status';
    }

    async function loadSettings() {
      const res = await fetch('/settings/data');
      if (!res.ok) throw new Error('Failed to load settings');
      const payload = await res.json();

      for (const item of payload.settings || []) {
        const input = document.querySelector('input[data-key="' + item.key + '"]');
        if (!input) continue;
        input.value = item.value || '';
      }
      setStatus('Reloaded from server', true);
    }

    async function saveSettings() {
      const inputs = Array.from(document.querySelectorAll('input[data-key]'));
      const patch = {};

      for (const input of inputs) {
        const key = input.getAttribute('data-key');
        patch[key] = input.value;
      }

      setStatus('Saving...');
      const res = await fetch('/settings/data', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: patch }),
      });

      if (!res.ok) {
        let msg = 'Failed to save settings';
        try {
          const errPayload = await res.json();
          if (Array.isArray(errPayload.errors) && errPayload.errors.length) {
            msg = errPayload.errors.join(' | ');
          } else if (errPayload.error) {
            msg = errPayload.error;
          }
        } catch {
          const txt = await res.text();
          if (txt) msg = txt;
        }
        throw new Error(msg);
      }

      const payload = await res.json();
      for (const item of payload.settings || []) {
        const input = document.querySelector('input[data-key="' + item.key + '"]');
        if (!input) continue;
        input.value = item.value || '';
      }
      setStatus('Saved', true);
    }

    document.getElementById('saveBtn').addEventListener('click', async () => {
      try {
        await saveSettings();
      } catch (err) {
        setStatus('Save failed: ' + (err.message || err));
      }
    });

    document.getElementById('reloadBtn').addEventListener('click', async () => {
      try {
        await loadSettings();
      } catch (err) {
        setStatus('Reload failed: ' + (err.message || err));
      }
    });
  </script>
</body>
</html>`;
}
