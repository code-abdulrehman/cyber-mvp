const express = require("express");
const rateLimit = require("express-rate-limit");
const { createClient } = require("redis");
const { exec } = require("child_process");
const { promisify } = require("util");
const { createProxyMiddleware } = require("http-proxy-middleware");

const execAsync = promisify(exec);

const app = express();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SENSITIVE_ROUTES = ["/admin", "/api/users"];
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_PER_ROUTE = 20;    // max requests per IP per sensitive route per window
const SANDBOX_SESSION_TTL_SEC = 3600;   // 1 hour; sandbox session expiry in Redis
const REDIS_KEY_PREFIX = "gateway:";

// ---------------------------------------------------------------------------
// Redis client (with safe defaults for local testing)
// ---------------------------------------------------------------------------
const redis = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});
redis.on("error", (err) => console.warn("Redis client error:", err.message));

// ---------------------------------------------------------------------------
// Helpers: sensitive route detection and key normalization
// ---------------------------------------------------------------------------
function isSensitiveRoute(path) {
  const normalized = path.replace(/\?.*$/, "").replace(/\/+$/, "") || "/";
  return SENSITIVE_ROUTES.some(
    (route) => normalized === route || normalized.startsWith(route + "/")
  );
}

function normalizeRateLimitKey(ip, path) {
  const safeIp = (ip || "unknown").replace(/:/g, "_");
  const pathOnly = (path || "/").replace(/\?.*$/, "").replace(/\/+$/, "") || "/";
  const safePath = pathOnly.replace(/\//g, "_");
  return `${safeIp}:${safePath}`;
}

function toSessionId(ip, path) {
  return normalizeRateLimitKey(ip, path);
}

function sanitizeContainerName(sessionId) {
  return `sandbox_${sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 50)}`;
}

// ---------------------------------------------------------------------------
// Redis-backed store for per-IP, per-route rate limiting
// ---------------------------------------------------------------------------
function createRedisRateLimitStore(redisClient, windowMs, prefix = "rl:") {
  const windowSec = Math.ceil(windowMs / 1000);
  const fullPrefix = REDIS_KEY_PREFIX + prefix;

  return {
    prefix: fullPrefix,
    localKeys: false,

    async increment(key) {
      const fullKey = fullPrefix + key;
      const count = await redisClient.incr(fullKey);
      let ttlMs = await redisClient.pTTL(fullKey);
      if (ttlMs === -1) {
        await redisClient.expire(fullKey, windowSec);
        ttlMs = windowMs;
      } else if (ttlMs === -2) {
        ttlMs = windowMs;
      }
      return {
        totalHits: count,
        resetTime: new Date(Date.now() + ttlMs),
      };
    },

    async decrement(key) {
      const fullKey = fullPrefix + key;
      const v = await redisClient.decr(fullKey);
      if (v <= 0) await redisClient.del(fullKey);
    },

    async resetKey(key) {
      await redisClient.del(fullPrefix + key);
    },
  };
}

// ---------------------------------------------------------------------------
// Sandbox spawn and proxy
// ---------------------------------------------------------------------------
async function spawnSandbox(sessionId) {
  const redisKey = REDIS_KEY_PREFIX + "sandbox:" + sessionId;
  const existing = await redis.get(redisKey);
  if (existing) return existing;

  const port = Math.floor(Math.random() * 2000) + 5000;
  const containerName = sanitizeContainerName(sessionId);

  try {
    await execAsync(
      `docker run -d -p ${port}:4000 --name ${containerName} sandbox-image`,
      { timeout: 15000 }
    );
  } catch (err) {
    console.error("Sandbox spawn failed:", err.message);
    throw new Error("Sandbox unavailable");
  }

  await redis.setEx(redisKey, SANDBOX_SESSION_TTL_SEC, String(port));
  console.log(`[sandbox] spawned ${containerName} -> port ${port} (session ${sessionId})`);
  return String(port);
}

// ---------------------------------------------------------------------------
// Rate limiter: only for sensitive routes, per-IP + per-route, Redis-backed
// ---------------------------------------------------------------------------
function createSuspiciousLimiter(redisClient) {
  const redisStore = createRedisRateLimitStore(
    redisClient,
    RATE_LIMIT_WINDOW_MS,
    "suspicious:"
  );

  return rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: RATE_LIMIT_MAX_PER_ROUTE,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => !isSensitiveRoute(req.path),
    keyGenerator: (req) => normalizeRateLimitKey(req.ip, req.path),
    store: redisStore,
    handler: async (req, res, _next) => {
      const sessionId = toSessionId(req.ip, req.path);
      try {
        const port = await spawnSandbox(sessionId);
        const redirectPath = `/sandbox/${encodeURIComponent(sessionId)}${req.originalUrl}`;
        console.log(`[redirect] suspicious ${req.ip} ${req.path} -> sandbox port ${port}`);
        res.redirect(302, redirectPath);
      } catch (err) {
        console.error("[redirect] sandbox spawn failed, serving real route:", err.message);
        _next();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Middleware: sandbox proxy (must be before generic route handlers)
// ---------------------------------------------------------------------------
app.use("/sandbox/:sessionId", async (req, res, next) => {
  const sessionId = decodeURIComponent(req.params.sessionId);
  const redisKey = REDIS_KEY_PREFIX + "sandbox:" + sessionId;
  const port = await redis.get(redisKey);
  if (!port) {
    return res.status(404).send("Sandbox session not found or expired");
  }

  createProxyMiddleware({
    target: `http://127.0.0.1:${port}`,
    changeOrigin: true,
    pathRewrite: (path) => {
      const rewritten = path.replace(/^\/sandbox\/[^/]+/, "") || "/";
      return rewritten;
    },
    onError: (err, req, res) => {
      console.error("[proxy]", err.message);
      res.status(502).send("Sandbox proxy error");
    },
  })(req, res, next);
});

// ---------------------------------------------------------------------------
// Suspicious rate limiter (set in start() after Redis connects)
// ---------------------------------------------------------------------------
let suspiciousLimiter;

// Apply limiter only to non-sandbox routes; must run before route handlers
app.use((req, res, next) => {
  if (req.path.startsWith("/sandbox/")) return next();
  if (!suspiciousLimiter) return next();
  suspiciousLimiter(req, res, next);
});

// ---------------------------------------------------------------------------
// Real (legitimate) routes – never rate-limited for redirect; high load is OK
// ---------------------------------------------------------------------------
app.get("/api/users", (req, res) => {
  res.json([{ id: 1, name: "Real User", email: "realuser@example.com", role: "user", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
});

app.get("/admin", (req, res) => {
  res.json({
    name: "Admin Panel",
    email: "admin@example.com",
    role: "admin",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
});

// Health / normal traffic – not sensitive, never triggers sandbox
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "gateway" });
});

// ---------------------------------------------------------------------------
// Start server (connect Redis first, then create limiter)
// ---------------------------------------------------------------------------
async function start() {
  try {
    await redis.connect();
  } catch (err) {
    console.error("Redis connection failed:", err.message);
    console.error("Start Redis (e.g. docker run -p 6379:6379 redis) and retry.");
    process.exit(1);
  }

  suspiciousLimiter = createSuspiciousLimiter(redis);

  app.listen(3001, () => {
    console.log("Gateway running on port 3001");
    console.log("Sensitive routes (rate-limited for redirect):", SENSITIVE_ROUTES);
  });
}

start();
