// src/logger.js — Per-module Winston loggers (each module gets its own log file)
// Improvement 5.1: Adds structured JSON log transport alongside human-readable console output.
import winston from 'winston';
import { mkdirSync } from 'fs';
import { config } from './config.js';

mkdirSync('logs', { recursive: true });

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, module }) =>
    `${timestamp} [${level.toUpperCase()}] [${module}] ${message}`
  ),
);

// Structured JSON format for machine-parseable logs (improvement 5.1)
const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json(),
);

const cache = new Map();

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function truncateText(text, maxLen = 3000) {
  const s = String(text || '');
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}...<truncated ${s.length - maxLen} chars>`;
}

/**
 * Build a structured diagnostic payload from an unknown error value.
 */
export function describeError(error) {
  if (!error) return { message: 'unknown error' };
  if (typeof error === 'string') return { message: error };
  if (typeof error !== 'object') return { message: String(error) };

  const err = error;
  const responseData = err?.response?.data;

  return {
    name: err?.name,
    message: err?.message || 'unknown error',
    code: err?.code,
    status: err?.status || err?.response?.status,
    statusText: err?.statusText || err?.response?.statusText,
    method: err?.config?.method,
    url: err?.config?.url,
    syscall: err?.syscall,
    errno: err?.errno,
    address: err?.address,
    port: err?.port,
    cause: err?.cause?.message || (typeof err?.cause === 'string' ? err.cause : undefined),
    responseError: responseData?.error || responseData?.errorMsg || responseData?.message,
    responseData: responseData,
    stack: err?.stack,
  };
}

/**
 * Emit a detailed error description while keeping a compact first line.
 */
export function logDetailedError(logger, context, error, extra = null) {
  const details = describeError(error);
  logger.error(`${context}: ${details.message || 'unknown error'}`);

  const payload = {
    ...details,
    ...(extra && typeof extra === 'object' ? extra : {}),
  };

  const stackText = payload.stack;
  delete payload.stack;
  logger.error(`${context} details: ${truncateText(safeStringify(payload))}`);

  if (stackText) {
    logger.error(`${context} stack: ${truncateText(stackText, 8000)}`);
  }
}

/**
 * Create (or retrieve) a named logger.
 * Each module gets:
 *   - console output with the module tag
 *   - its own log file: logs/<module>.log  (5 MB rotation, 3 files)
 *   - a shared combined file: logs/combined.log
 *   - a structured JSON file: logs/structured.jsonl (improvement 5.1)
 *
 * Usage:  const log = createLogger('scheduler');
 */
export function createLogger(module) {
  if (cache.has(module)) return cache.get(module);

  const logger = winston.createLogger({
    level: config.logLevel,
    defaultMeta: { module },
    format: logFormat,
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({
        filename: `logs/${module}.log`,
        maxsize: 5_000_000,
        maxFiles: 3,
      }),
      new winston.transports.File({
        filename: 'logs/combined.log',
        maxsize: 10_000_000,
        maxFiles: 5,
      }),
      new winston.transports.File({
        filename: 'logs/structured.jsonl',
        maxsize: 10_000_000,
        maxFiles: 5,
        format: jsonFormat,
      }),
    ],
  });

  cache.set(module, logger);
  return logger;
}

/**
 * Emit a structured event log entry (improvement 5.1).
 * Machine-readable — goes to both the module logger and the JSON log. E.g.:
 *   emitEvent('scheduler', 'scan_complete', { matchesFound: 5, betsPlaced: 1 })
 *
 * @param {string} module - Logger module name
 * @param {string} event - Event type identifier (snake_case)
 * @param {object} [data={}] - Structured key-value fields for the event
 */
export function emitEvent(module, event, data = {}) {
  const logger = createLogger(module);
  logger.info({ message: event, event, ...data });
}
