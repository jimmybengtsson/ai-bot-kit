import { config } from "./config.js";

const unauthorized = (res) => {
  res.status(401).json({
    ok: false,
    error: "Unauthorized. Provide a valid API key in x-api-key or Authorization: Bearer <key>."
  });
};

export const authMiddleware = (req, res, next) => {
  if (!config.apiPassword) {
    return next();
  }

  const keyFromHeader = req.headers["x-api-key"];
  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const apiKey = keyFromHeader || bearerToken;

  if (!apiKey || apiKey !== config.apiPassword) {
    return unauthorized(res);
  }

  return next();
};
