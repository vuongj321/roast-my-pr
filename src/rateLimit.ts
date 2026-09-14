import type { Env } from "./types.js";

const UTC_DAY = () => new Date().toISOString().slice(0, 10);

/**
 * Soft per-installation daily cap stored in Cloudflare KV.
 * Returns true if the roast is allowed (and increments the counter).
 */
export async function consumeRoastSlot(
  env: Env,
  installationId: number,
): Promise<{ allowed: boolean; used: number; limit: number }> {
  const limit = Math.max(1, Number.parseInt(env.DAILY_ROAST_LIMIT || "20", 10) || 20);
  const key = `roast:${installationId}:${UTC_DAY()}`;
  const current = Number.parseInt((await env.RATE_LIMIT.get(key)) || "0", 10) || 0;

  if (current >= limit) {
    return { allowed: false, used: current, limit };
  }

  const next = current + 1;
  // Expire a bit over 48h so keys clean up after the UTC day rolls.
  await env.RATE_LIMIT.put(key, String(next), { expirationTtl: 60 * 60 * 50 });
  return { allowed: true, used: next, limit };
}
