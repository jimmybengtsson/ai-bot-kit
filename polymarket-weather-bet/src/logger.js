import winston from 'winston';
import { mkdirSync } from 'fs';
import { config } from './config.js';

mkdirSync('logs', { recursive: true });

const textFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, module }) =>
    `${timestamp} [${level.toUpperCase()}] [${module}] ${message}`
  ),
);

const cache = new Map();

export function createLogger(module) {
  if (cache.has(module)) return cache.get(module);

  const logger = winston.createLogger({
    level: config.logLevel,
    defaultMeta: { module },
    format: textFormat,
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({ filename: `logs/${module}.log`, maxsize: 5_000_000, maxFiles: 3 }),
      new winston.transports.File({ filename: 'logs/combined.log', maxsize: 10_000_000, maxFiles: 5 }),
    ],
  });

  cache.set(module, logger);
  return logger;
}
