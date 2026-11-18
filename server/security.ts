import crypto from "node:crypto";
import path from "node:path";

const EPHEMERAL_JWT_SECRET = crypto.randomBytes(32).toString("hex");
const EPHEMERAL_CSRF_SECRET = crypto.randomBytes(32).toString("hex");

function getJwtSecret(): string {
  return process.env.JWT_SECRET_KEY || EPHEMERAL_JWT_SECRET;
}

function getCsrfSecret(): string {
  return process.env.CSRF_SECRET_KEY || EPHEMERAL_CSRF_SECRET;
}

export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(plain, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(plain: string, storedHash: string): boolean {
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  const derived = crypto.scryptSync(plain, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function validatePasswordPolicy(
  password: string,
  minLength: number,
  requireComplexity: boolean
): string[] {
  const errors: string[] = [];
  if (password.length < minLength) {
    errors.push(`Password must be at least ${minLength} characters long.`);
  }
  if (password.length > 128) {
    errors.push("Password must not exceed 128 characters.");
  }
  if (requireComplexity) {
    if (!/[A-Z]/.test(password)) errors.push("Password must contain an uppercase letter.");
    if (!/[a-z]/.test(password)) errors.push("Password must contain a lowercase letter.");
    if (!/[0-9]/.test(password)) errors.push("Password must contain a digit.");
    if (!/[^A-Za-z0-9]/.test(password)) errors.push("Password must contain a special character.");
  }
  return errors;
}

export type TokenPayload = {
  sub: string;
  username: string;
  roles: string[];
  tv: number;
  jti: string;
  iat: number;
  exp: number;
};

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(input: string): string {
  const padded = input.replaceAll("-", "+").replaceAll("_", "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLen), "base64").toString("utf8");
}

export function createAccessToken(
  userId: number,
  username: string,
  roles: string[],
  tokenVersion: number,
  ttlMinutes: number
): { token: string; expiresAt: string } {
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + ttlMinutes * 60;
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payloadObj: TokenPayload = {
    sub: String(userId),
    username,
    roles,
    tv: tokenVersion,
    jti: crypto.randomUUID(),
    iat: nowSec,
    exp: expSec,
  };
  const payload = base64UrlEncode(JSON.stringify(payloadObj));
  const sig = base64UrlEncode(
    crypto.createHmac("sha256", getJwtSecret()).update(`${header}.${payload}`).digest()
  );
  return {
    token: `${header}.${payload}.${sig}`,
    expiresAt: new Date(expSec * 1000).toISOString(),
  };
}

export function verifyAccessToken(token: string): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, providedSig] = parts;
  if (!header || !payload || !providedSig) return null;

  const expectedSig = base64UrlEncode(
    crypto.createHmac("sha256", getJwtSecret()).update(`${header}.${payload}`).digest()
  );

  const providedBuf = Buffer.from(providedSig, "utf8");
  const expectedBuf = Buffer.from(expectedSig, "utf8");
  if (
    providedBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(providedBuf, expectedBuf)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as TokenPayload;
    const nowSec = Math.floor(Date.now() / 1000);
    if (!parsed.sub || !Array.isArray(parsed.roles) || typeof parsed.tv !== "number" || parsed.exp < nowSec) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function generateCsrfToken(subject: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("hex");
  const sig = crypto
    .createHmac("sha256", getCsrfSecret())
    .update(`${subject}:${issuedAt}:${nonce}`)
    .digest("hex");
  return `${issuedAt}.${nonce}.${sig}`;
}

export function verifyCsrfToken(token: string, subject: string, maxAgeSeconds = 7200): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [issuedAtStr, nonce, providedSig] = parts;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt) || !nonce || !providedSig) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - issuedAt > maxAgeSeconds || issuedAt > nowSec + 60) {
    return false;
  }

  const expectedSig = crypto
    .createHmac("sha256", getCsrfSecret())
    .update(`${subject}:${issuedAtStr}:${nonce}`)
    .digest("hex");

  const providedBuf = Buffer.from(providedSig, "utf8");
  const expectedBuf = Buffer.from(expectedSig, "utf8");
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

export function parseDollarsToCents(raw: string | number): number | null {
  const text = typeof raw === "number" ? raw.toFixed(2) : String(raw).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return null;
  }
  const [wholePart, fracPart = ""] = text.split(".");
  const paddedFrac = (fracPart + "00").slice(0, 2);
  const cents = Number(wholePart) * 100 + Number(paddedFrac);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    return null;
  }
  return cents;
}

export function centsToDollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}

export function generateReference(prefix: string): string {
  const stamp = new Date().toISOString().replaceAll(/[-:TZ.]/g, "").slice(0, 14);
  const rand = crypto.randomBytes(5).toString("hex").toUpperCase();
  return `${prefix}-${stamp}-${rand}`;
}

const SAFE_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;

export function resolveSafeBackupPath(baseDir: string, filename: string): string {
  if (!filename || filename.includes("\0") || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    throw new Error("Directory traversal characters are not permitted.");
  }
  if (!SAFE_FILENAME_RE.test(filename) || !filename.toLowerCase().endsWith(".db")) {
    throw new Error("Backup filename must match safe pattern and end with .db.");
  }
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, filename);
  if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error("Resolved backup path escapes allowed directory.");
  }
  return resolvedTarget;
}
