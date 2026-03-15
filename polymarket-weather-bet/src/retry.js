import { createLogger } from './logger.js';

const log = createLogger('retry');

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
      if (!shouldRetry(err)) throw err;
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        log.warn(`${label ? `${label}: ` : ''}Attempt ${attempt + 1}/${maxRetries + 1} failed: ${err.message} — retrying in ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

export function shouldRetryNetworkError(err) {
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('400') || msg.includes('401') || msg.includes('403') || msg.includes('404')) return false;
  if (msg.includes('invalid api key')) return false;
  return true;
}
