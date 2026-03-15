import express from "express";
import { authMiddleware } from "./auth.js";
import { config } from "./config.js";
import { createRequestQueue } from "./requestQueue.js";
import { registerRoutes } from "./routes.js";

const app = express();
const requestQueue = createRequestQueue();

app.use(express.json({ limit: "1mb" }));

if (config.logRequests) {
  app.use((req, _res, next) => {
    const now = new Date().toISOString();
    console.log(`[${now}] ${req.method} ${req.originalUrl}`);
    next();
  });
}

app.use(requestQueue.middleware);
app.use(authMiddleware);
registerRoutes(app, requestQueue);

app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Route not found: ${req.method} ${req.originalUrl}` });
});

app.use((error, _req, res, _next) => {
  const status = error?.status || 500;
  const message = error?.message || "Unexpected server error";

  res.status(status).json({
    ok: false,
    error: message,
    status
  });
});

const server = app.listen(config.port, config.host, () => {
  const authInfo = config.apiPassword ? "enabled" : "disabled (open mode)";
  console.log(`cloak-scraper listening on http://${config.host}:${config.port}`);
  console.log(`API password: ${authInfo}`);
  console.log(
    `Request queue: ${config.queueEnabled ? "enabled" : "disabled"} (concurrency=${config.queueConcurrency}, max=${config.queueMaxSize})`
  );
});

server.requestTimeout = config.requestTimeoutMs;
