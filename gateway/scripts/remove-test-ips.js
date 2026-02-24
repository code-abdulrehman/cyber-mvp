#!/usr/bin/env node
/**
 * Remove test IPs: delete Redis keys (rate-limit + sandbox) for IPs listed in
 * scripts/.test-ips-and-users.json. Safe to run if no test data or Redis is down.
 *
 * Usage: node scripts/remove-test-ips.js [--dry-run]
 */

const { createClient } = require("redis");
const path = require("path");
const fs = require("fs");

const REDIS_KEY_PREFIX = "gateway:";
const DATA_FILE = path.join(__dirname, ".test-ips-and-users.json");

function loadTestIps() {
  if (!fs.existsSync(DATA_FILE)) {
    console.log("No test data file found:", DATA_FILE);
    return [];
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const ips = data.ips || [];
  if (!Array.isArray(ips)) return [];
  return ips;
}

function ipToRedisPattern(ip) {
  const safe = (ip || "").replace(/:/g, "_");
  if (!safe) return null;
  return safe;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const ips = loadTestIps();
  if (ips.length === 0) {
    console.log("Nothing to remove (no test IPs).");
    process.exit(0);
  }

  const redis = createClient({
    url: process.env.REDIS_URL || "redis://localhost:6379",
  });

  try {
    await redis.connect();
  } catch (err) {
    console.warn("Redis connection failed:", err.message);
    process.exit(1);
  }

  let deleted = 0;
  for (const ip of ips) {
    const safe = ipToRedisPattern(ip);
    if (!safe) continue;
    for (const prefix of ["suspicious:", "sandbox:"]) {
      const pattern = REDIS_KEY_PREFIX + prefix + safe + "*";
      const keys = await redis.keys(pattern);
      for (const key of keys) {
        if (dryRun) {
          console.log("[dry-run] would delete:", key);
        } else {
          await redis.del(key);
          console.log("Deleted:", key);
        }
        deleted++;
      }
    }
  }

  if (dryRun && deleted > 0) {
    console.log("[dry-run] would delete", deleted, "key(s). Run without --dry-run to apply.");
  } else if (deleted > 0) {
    console.log("Removed", deleted, "key(s) for test IPs.");
  } else {
    console.log("No Redis keys found for test IPs.");
  }

  await redis.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
