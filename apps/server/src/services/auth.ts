import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export const hashPassword = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
};

export const verifyPassword = (password: string, storedHash: string) => {
  const [salt, digest] = storedHash.split(":");

  if (!salt || !digest) {
    return false;
  }

  const derived = scryptSync(password, salt, 64);
  const expected = Buffer.from(digest, "hex");

  if (derived.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(derived, expected);
};

export const createSessionToken = () => randomBytes(32).toString("hex");

export const hashSessionToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export const createSessionExpiry = () =>
  new Date(Date.now() + SESSION_TTL_MS).toISOString();
