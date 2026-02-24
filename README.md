# Cyber-deception MVP

Gateway redirects suspicious traffic (by IP + sensitive route + rate) to sandbox containers. Normal traffic hits real routes.

---

## Requirements

- Node.js 18+
- Docker (optional, for sandbox)
- Redis

---

## Run (step-by-step)

1. **Start Redis**
   ```bash
   docker run -d -p 6379:6379 --name redis redis:alpine
   ```

2. **Gateway**
   ```bash
   cd gateway
   npm install
   node index.js
   ```
   Listens on port **3001**.

3. **Sandbox image (optional)**
   ```bash
   cd sandbox
   docker build -t sandbox-image .
   ```
   When rate limit is exceeded on sensitive routes, gateway spawns containers from this image.

---

## Endpoints

| Route       | Behavior                          |
|------------|------------------------------------|
| `/health`  | Always real response               |
| `/api/users` | Real response; rate-limited, then redirect to sandbox |
| `/admin`   | Real response; rate-limited, then redirect to sandbox |

---

## Example

```bash
# Real response (under limit)
curl http://localhost:3001/api/users

# Health (never limited)
curl http://localhost:3001/health
```

---

## Project layout

- **gateway/** – Express app, rate limit, Redis, sandbox redirect
- **sandbox/** – Docker app served in isolation (`/admin`, `/api/users`)
- **gateway/scripts/** – Create test IPs/users, remove test IPs from Redis
