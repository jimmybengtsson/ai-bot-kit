import { config } from "./config.js";

export const createRequestQueue = () => {
  let active = 0;
  const queue = [];

  const startNext = () => {
    if (!config.queueEnabled) {
      return;
    }

    while (active < config.queueConcurrency && queue.length > 0) {
      const task = queue.shift();
      if (!task) {
        break;
      }

      active += 1;
      task.onStart(() => {
        active -= 1;
        startNext();
      });
    }
  };

  const middleware = (req, res, next) => {
    if (!config.queueEnabled) {
      return next();
    }

    if (active >= config.queueConcurrency && queue.length >= config.queueMaxSize) {
      return res.status(429).json({
        ok: false,
        error: "Server is busy. Queue is full.",
        status: 429
      });
    }

    const queueEnteredAt = Date.now();

    const onStart = (release) => {
      let released = false;
      const releaseOnce = () => {
        if (released) {
          return;
        }
        released = true;
        release();
      };

      res.once("finish", releaseOnce);
      res.once("close", releaseOnce);

      req.queueWaitMs = Date.now() - queueEnteredAt;
      next();
    };

    queue.push({ onStart });
    return startNext();
  };

  const stats = () => ({
    enabled: config.queueEnabled,
    concurrency: config.queueConcurrency,
    maxSize: config.queueMaxSize,
    active,
    queued: queue.length
  });

  return { middleware, stats };
};
