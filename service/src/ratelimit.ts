/** Used when no IP_HASH_SALT secret is set, as in local development. */
export const DEV_SALT = "wowget-dev-salt";

let warned = false;

/**
 * A salted SHA-256 of the client address that changes every UTC day, so rate-limit keys
 * cannot be joined across days or turned back into addresses without the salt.
 */
export async function ipHash(ip: string, salt: string | undefined, now: Date = new Date()): Promise<string> {
  if (!salt && !warned) {
    warned = true;
    console.warn("IP_HASH_SALT is not set; rate-limit keys use the public development salt.");
  }
  const day = now.toISOString().slice(0, 10);
  const data = new TextEncoder().encode(`${salt || DEV_SALT}\n${day}\n${ip}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
