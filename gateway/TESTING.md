# Gateway testing guide

## Prerequisites

- Node.js 16+
- Redis: `docker run -d -p 6379:6379 redis` (or `REDIS_URL=redis://...`)
- (Optional, for sandbox redirect) Docker + built `sandbox-image`

## Start the gateway

```bash
cd gateway
npm install
node index.js
```

## Safe high-load tests

### 1. Normal high load (should never redirect)

Hammer a **non-sensitive** route. All requests must get real responses (200).

```bash
# 100 requests to /health – no rate limit, no redirect
for i in $(seq 1 100); do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/health; done
# Expect: all 200
```

Concurrent normal traffic:

```bash
# 50 concurrent requests to /health
seq 1 50 | xargs -P 50 -I {} curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/health
# Expect: all 200
```

### 2. Sensitive route under limit (real response)

Stay **under** 20 requests per minute per IP per route; you get real responses.

```bash
# 10 requests to /api/users – under limit
for i in $(seq 1 10); do curl -s http://localhost:3001/api/users | head -c 80; echo; done
# Expect: real JSON each time (no redirect)
```

### 3. Suspicious behavior (redirect to sandbox)

Exceed the limit on a **sensitive** route from one IP; next request should redirect to sandbox (302) and then sandbox response (if Docker is running).

```bash
# 21 requests: first 20 get real response, 21st triggers redirect (if sandbox available)
for i in $(seq 1 21); do
  curl -s -w "\n%{http_code}" http://localhost:3001/api/users
done
# Expect: first 20 → 200 + real JSON; 21st → 302 to /sandbox/... or 200 if sandbox spawn failed
```

### 4. Per-route isolation

Limit is **per IP + per route**. So:

- High load on `/api/users` can trigger redirect for that route only.
- Same IP hitting `/admin` has a separate counter; it is not redirected just because `/api/users` was heavy.

```bash
# Many /api/users (may eventually redirect)
for i in $(seq 1 25); do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/api/users; done

# /admin still gets its own counter; first 20 get real response
for i in $(seq 1 10); do curl -s -o /dev/null http://localhost:3001/admin; done
```

### 5. Sandbox preserves original path

After redirect, the request to the sandbox should be for the **same path** (e.g. `/api/users` or `/admin`).

```bash
# Trigger redirect, then follow redirect and check response
curl -sL -w "\nFinal URL: %{url_effective}\n" "http://localhost:3001/api/users"
# After redirect, body should be sandbox’s /api/users response; URL contains /sandbox/.../api/users
```

## Without Docker (sandbox disabled)

If `sandbox-image` is not built or Docker is not running, the gateway still runs. When the limit is exceeded, `spawnSandbox` fails and the handler calls `_next()`, so the user receives the **real** route response instead of a redirect. No crash; safe for local testing without sandbox.

## Redis down

If Redis is not running, the gateway exits at startup with a clear error. Start Redis first.
