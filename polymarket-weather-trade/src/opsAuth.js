// src/opsAuth.js — Simple token auth middleware for operational endpoints
import { config } from './config.js';

function parseBearerToken(headerValue) {
  const raw = String(headerValue || '').trim();
  if (!raw) return '';
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? String(m[1] || '').trim() : '';
}

export function hasOpsTokenConfigured() {
  return Boolean(String(config.opsApiToken || '').trim());
}

export function requireOpsAuth(req, res, next) {
  const expected = String(config.opsApiToken || '').trim();
  if (!expected) return next();

  const provided =
    parseBearerToken(req.headers.authorization)
    || String(req.headers['x-ops-token'] || '').trim()
    || String(req.query.opsToken || '').trim();

  if (!provided) {
    return res.status(401).json({
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Missing ops token',
        details: { hint: 'Use Authorization: Bearer <token> or x-ops-token header' },
      },
    });
  }

  if (provided !== expected) {
    return res.status(403).json({
      error: {
        code: 'AUTH_INVALID',
        message: 'Invalid ops token',
      },
    });
  }

  return next();
}
