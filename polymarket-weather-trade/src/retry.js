// src/retry.js — Generic retry with exponential backoff
import { createLogger, logDetailedError } from './logger.js';

const log = createLogger('retry');

/**
 * Retry an async function with exponential backoff.
 *
 * @param {Function} fn - Async function to call (no arguments — use closures / .bind())
 * @param {object} [opts]
 * @param {number} [opts.maxRetries=3] - Maximum retry attempts (total calls = maxRetries + 1)
 * @param {number} [opts.baseDelayMs=1000] - Base delay before first retry (doubled each attempt)
 * @param {number} [opts.maxDelayMs=15000] - Maximum delay cap
 * @param {string} [opts.label=''] - Label for log messages
 * @param {Function} [opts.shouldRetry] - Optional predicate: (error) => boolean. Return false to abort retries early.
 * @returns {Promise<*>} Result of fn()
 */
export async function retryWithBackoff(fn, opts = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 15000,
    label = '',
    shouldRetry = () => true,
  } = opts;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Don't retry if shouldRetry says no (e.g. 4xx client errors)
      if (!shouldRetry(err)) {
        log.warn(`${label ? label + ': ' : ''}Not retrying (shouldRetry=false): ${err.message}`);
        throw err;
      }

      if (attempt < maxRetries) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        // Add 10-30% jitter to avoid thundering herd
        const jitter = delay * (0.1 + Math.random() * 0.2);
        const totalDelay = Math.round(delay + jitter);
        log.warn(`${label ? label + ': ' : ''}Attempt ${attempt + 1}/${maxRetries + 1} failed: ${err.message} — retrying in ${totalDelay}ms`);
        await new Promise(r => setTimeout(r, totalDelay));
      }
    }
  }

  logDetailedError(log, `${label ? label + ': ' : ''}All ${maxRetries + 1} attempts failed`, lastError, {
    retries: maxRetries,
    totalAttempts: maxRetries + 1,
    label,
  });
  throw lastError;
}

/**
 * Predicate: don't retry on HTTP 4xx client errors (bad request, auth, not found).
 * Retry on 5xx, network errors, timeouts.
 */
export function shouldRetryNetworkError(err) {
  const msg = (err.message || '').toLowerCase();

  // Don't retry on explicit client errors
  if (msg.includes('400') || msg.includes('401') || msg.includes('403') || msg.includes('404') || msg.includes('422')) return false;
  if (msg.includes('bad request') || msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('unprocessable entity')) return false;
  if (msg.includes('invalid') && msg.includes('api key')) return false;

  // Retry on everything else (503, 502, ECONNRESET, timeout, etc.)
  return true;
}
