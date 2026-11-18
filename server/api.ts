import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { BACKUP_DIR, DB_PATH, getDb, reopenDb, runAtomic } from "./db.ts";
import { dispatchSimulatedNotification, getRecentNotifications } from "./notifications.ts";
import { buildStatementPdf } from "./pdfGenerator.ts";
import {
  centsToDollars,
  createAccessToken,
  generateCsrfToken,
  generateReference,
  hashPassword,
  parseDollarsToCents,
  resolveSafeBackupPath,
  validatePasswordPolicy,
  verifyAccessToken,
  verifyCsrfToken,
  verifyPassword,
} from "./security.ts";

export type AuthUser = {
  id: number;
  email: string;
  username: string;
  roles: string[];
  tokenVersion: number;
  authSource: "bearer" | "cookie";
};

type AuthedRequest = Request & { authUser?: AuthUser };

type RateBucket = { count: number; resetAt: number };
const rateBuckets = new Map<string, RateBucket>();

function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const current = rateBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (current.count >= limit) {
    return false;
  }
  current.count += 1;
  return true;
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket.remoteAddress || "127.0.0.1";
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function getSettingValue(key: string, fallback: string): string {
  const db = getDb();
  const row = db
    .prepare("SELECT setting_value FROM application_settings WHERE setting_key = ?")
    .get(key) as { setting_value: string } | undefined;
  return row ? row.setting_value : fallback;
}

function getSettingNumber(key: string, fallback: number): number {
  const raw = getSettingValue(key, String(fallback));
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getSettingBool(key: string, fallback: boolean): boolean {
  const raw = getSettingValue(key, String(fallback)).toLowerCase();
  return raw === "true" || raw === "1";
}

function logSecurityEvent(
  userId: number | null,
  eventType: string,
  req: Request,
  details: string
): void {
  try {
    const db = getDb();
    db.prepare(
      "INSERT INTO security_logs (user_id, event_type, ip_address, user_agent, details) VALUES (?, ?, ?, ?, ?)"
    ).run(
      userId,
      eventType,
      getClientIp(req),
      String(req.headers["user-agent"] || "").slice(0, 255),
      details
    );
  } catch {
    // Do not break request flow on logging error
  }
}

function logAuditEvent(
  actorUserId: number | null,
  action: string,
  targetEntity: string,
  targetId: string | null,
  previousValue: unknown,
  newValue: unknown,
  req: Request
): void {
  try {
    const db = getDb();
    db.prepare(
      "INSERT INTO audit_logs (actor_user_id, action, target_entity, target_id, previous_value, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      actorUserId,
      action,
      targetEntity,
      targetId,
      previousValue === null || previousValue === undefined ? null : JSON.stringify(previousValue),
      newValue === null || newValue === undefined ? null : JSON.stringify(newValue),
      getClientIp(req)
    );
  } catch {
    // Ignore logging errors
  }
}

function getUserRoles(userId: number): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ? ORDER BY r.name"
    )
    .all(userId) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function generateUniqueAccountNumber(): string {
  const db = getDb();
  for (let i = 0; i < 20; i += 1) {
    const suffix = String(crypto.randomInt(1000000000, 9999999999));
    const candidate = `10${suffix}`;
    const existing = db.prepare("SELECT id FROM accounts WHERE account_number = ?").get(candidate);
    if (!existing) return candidate;
  }
  return `10${Date.now().toString().slice(-10)}`;
}

function setSessionCookie(res: Response, token: string, ttlMinutes: number, req: Request): void {
  const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.cookie("access_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: Boolean(isSecure),
    maxAge: ttlMinutes * 60 * 1000,
    path: "/",
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie("access_token", { path: "/" });
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  let token = "";
  let authSource: "bearer" | "cookie" = "cookie";

  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
    authSource = "bearer";
  } else {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.access_token) {
      token = cookies.access_token;
      authSource = "cookie";
    }
  }

  if (!token) {
    res.status(401).json({ detail: "Authentication required." });
    return;
  }

  const payload = verifyAccessToken(token);
  if (!payload) {
    res.status(401).json({ detail: "Invalid or expired session token." });
    return;
  }

  const userId = Number(payload.sub);
  if (!Number.isSafeInteger(userId)) {
    res.status(401).json({ detail: "Invalid session subject." });
    return;
  }

  const db = getDb();
  const userRow = db
    .prepare("SELECT id, email, username, is_active, locked_until, token_version FROM users WHERE id = ?")
    .get(userId) as
    | {
        id: number;
        email: string;
        username: string;
        is_active: number;
        locked_until: string | null;
        token_version: number;
      }
    | undefined;

  if (!userRow || !userRow.is_active) {
    res.status(401).json({ detail: "Account is inactive or unavailable." });
    return;
  }

  if (userRow.locked_until && new Date(userRow.locked_until).getTime() > Date.now()) {
    res.status(423).json({ detail: "Account is temporarily locked." });
    return;
  }

  if (userRow.token_version !== payload.tv) {
    res.status(401).json({ detail: "Session has been revoked. Please sign in again." });
    return;
  }

  const method = req.method.toUpperCase();
  if (authSource === "cookie" && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    const csrfToken = String(req.headers["x-csrf-token"] || "");
    if (!csrfToken || !verifyCsrfToken(csrfToken, String(userRow.id))) {
      logSecurityEvent(userRow.id, "CSRF_VALIDATION_FAILED", req, `${method} ${req.path}`);
      res.status(403).json({ detail: "Invalid or missing CSRF token." });
      return;
    }
  }

  const roles = getUserRoles(userRow.id);
  req.authUser = {
    id: userRow.id,
    email: userRow.email,
    username: userRow.username,
    roles,
    tokenVersion: userRow.token_version,
    authSource,
  };
  next();
}

function requireRole(...allowedRoles: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const user = req.authUser;
    if (!user) {
      res.status(401).json({ detail: "Authentication required." });
      return;
    }
    const hasAccess = user.roles.some((r) => allowedRoles.includes(r));
    if (!hasAccess) {
      logSecurityEvent(user.id, "RBAC_FORBIDDEN", req, `Required [${allowedRoles.join(", ")}] for ${req.path}`);
      res.status(403).json({ detail: "Insufficient permissions for this operation." });
      return;
    }
    next();
  };
}

function isAdminUser(user: AuthUser): boolean {
  return user.roles.includes("ADMIN") || user.roles.includes("SUPER_ADMIN");
}

function serializeAccount(row: {
  id: number;
  user_id: number;
  account_number: string;
  account_type: string;
  currency: string;
  balance_cents: number;
  status: string;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: row.id,
    user_id: row.user_id,
    account_number: row.account_number,
    account_type: row.account_type,
    currency: row.currency,
    balance_cents: row.balance_cents,
    balance: centsToDollars(row.balance_cents),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function serializeTransaction(row: {
  id: number;
  reference_number: string;
  idempotency_key: string | null;
  transaction_type: string;
  source_account_id: number | null;
  destination_account_id: number | null;
  amount_cents: number;
  currency: string;
  status: string;
  description: string | null;
  initiated_by_user_id: number;
  related_transaction_id: number | null;
  created_at: string;
  source_account_number?: string | null;
  destination_account_number?: string | null;
}) {
  return {
    id: row.id,
    reference_number: row.reference_number,
    idempotency_key: row.idempotency_key,
    transaction_type: row.transaction_type,
    source_account_id: row.source_account_id,
    destination_account_id: row.destination_account_id,
    source_account_number: row.source_account_number ?? null,
    destination_account_number: row.destination_account_number ?? null,
    amount_cents: row.amount_cents,
    amount: centsToDollars(row.amount_cents),
    currency: row.currency,
    status: row.status,
    description: row.description,
    initiated_by_user_id: row.initiated_by_user_id,
    related_transaction_id: row.related_transaction_id,
    created_at: row.created_at,
  };
}

export function createApiRouter(): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "256kb" }));

  // Request latency & rate-limiting middleware
  router.use((req: Request, res: Response, next: NextFunction) => {
    const ip = getClientIp(req);
    const isAuthRoute = req.path.startsWith("/auth/");
    const allowed = checkRateLimit(
      `${isAuthRoute ? "auth" : "api"}:${ip}`,
      isAuthRoute ? 60 : 240,
      60_000
    );
    if (!allowed) {
      res.status(429).json({ detail: "Too many requests. Please slow down and try again shortly." });
      return;
    }

    const startHr = process.hrtime.bigint();
    res.on("finish", () => {
      if (req.path === "/health") return;
      const elapsedMs = Number(process.hrtime.bigint() - startHr) / 1_000_000;
      try {
        const db = getDb();
        const level = res.statusCode >= 500 ? "ERROR" : res.statusCode >= 400 ? "WARNING" : "INFO";
        db.prepare(
          "INSERT INTO system_logs (level, service_name, endpoint, http_method, status_code, response_time_ms, message) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(
          level,
          "banking-api",
          `/api${req.path}`,
          req.method,
          res.statusCode,
          Number(elapsedMs.toFixed(2)),
          `${req.method} /api${req.path} -> ${res.statusCode}`
        );
      } catch {
        // Ignore logging errors
      }
    });
    next();
  });

  // 1. Health Check
  router.get("/health", (_req: Request, res: Response) => {
    try {
      const db = getDb();
      db.prepare("SELECT 1").get();
      res.json({
        status: "ok",
        database: "connected",
        service: "online-banking-demo",
        timestamp: new Date().toISOString(),
      });
    } catch {
      res.status(503).json({ status: "error", database: "unavailable" });
    }
  });

  // 2. Admin Bootstrap Status & Safe First-Run Bootstrap
  router.get("/auth/admin/bootstrap-status", (_req: Request, res: Response) => {
    const db = getDb();
    const row = db
      .prepare(
        "SELECT COUNT(DISTINCT ur.user_id) AS cnt FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')"
      )
      .get() as { cnt: number };
    res.json({ needs_bootstrap: row.cnt === 0 });
  });

  router.post("/auth/admin/bootstrap", (req: Request, res: Response) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ detail: "Please enter a valid administrator email address." });
      return;
    }
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
      res.status(400).json({ detail: "Username must be 3–32 characters (letters, numbers, _, ., -)." });
      return;
    }

    const minLen = Math.max(10, getSettingNumber("min_password_length", 10));
    const requireComplexity = getSettingBool("require_password_complexity", true);
    const pwErrors = validatePasswordPolicy(password, minLen, requireComplexity);
    if (pwErrors.length > 0) {
      res.status(400).json({ detail: pwErrors[0], errors: pwErrors });
      return;
    }

    const db = getDb();
    const existingAdmin = db
      .prepare(
        "SELECT COUNT(DISTINCT ur.user_id) AS cnt FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')"
      )
      .get() as { cnt: number };

    if (existingAdmin.cnt > 0) {
      res.status(409).json({ detail: "An administrator account already exists. Use Admin Sign In." });
      return;
    }

    const dup = db
      .prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)")
      .get(email, username);
    if (dup) {
      res.status(409).json({ detail: "Email or username is already registered." });
      return;
    }

    const passwordHash = hashPassword(password);
    const userId = runAtomic(db, () => {
      const insertUser = db
        .prepare("INSERT INTO users (email, username, password_hash, last_login_at) VALUES (?, ?, ?, ?)")
        .run(email, username, passwordHash, new Date().toISOString());
      const newUserId = Number(insertUser.lastInsertRowid);

      const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'ADMIN'").get() as { id: number };
      const superRole = db.prepare("SELECT id FROM roles WHERE name = 'SUPER_ADMIN'").get() as { id: number };
      db.prepare("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)").run(newUserId, adminRole.id);
      db.prepare("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)").run(newUserId, superRole.id);
      return newUserId;
    });

    const roles = ["ADMIN", "SUPER_ADMIN"];
    const ttlMinutes = getSettingNumber("session_timeout_minutes", 15);
    const { token, expiresAt } = createAccessToken(userId, username, roles, 1, ttlMinutes);
    const csrfToken = generateCsrfToken(String(userId));
    setSessionCookie(res, token, ttlMinutes, req);

    logSecurityEvent(userId, "ADMIN_BOOTSTRAP", req, `Initial SUPER_ADMIN account created: ${username}`);
    logAuditEvent(userId, "ADMIN_BOOTSTRAP", "USER", String(userId), null, { email, username, roles }, req);

    res.status(201).json({
      access_token: token,
      csrf_token: csrfToken,
      expires_at: expiresAt,
      user: { id: userId, email, username, roles, is_active: true },
    });
  });

  // 3. Customer Registration
  router.post("/auth/register", (req: Request, res: Response) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const firstName = String(req.body?.first_name || "").trim();
    const lastName = String(req.body?.last_name || "").trim();
    const phone = String(req.body?.phone || "").trim() || null;
    const accountTypeRaw = String(req.body?.account_type || "CHECKING").toUpperCase();
    const accountType = accountTypeRaw === "SAVINGS" ? "SAVINGS" : "CHECKING";

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ detail: "Please provide a valid email address." });
      return;
    }
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
      res.status(400).json({ detail: "Username must be 3–32 characters (letters, numbers, _, ., -)." });
      return;
    }
    if (!firstName || !lastName) {
      res.status(400).json({ detail: "First name and last name are required." });
      return;
    }

    const minLen = getSettingNumber("min_password_length", 10);
    const requireComplexity = getSettingBool("require_password_complexity", true);
    const pwErrors = validatePasswordPolicy(password, minLen, requireComplexity);
    if (pwErrors.length > 0) {
      res.status(400).json({ detail: pwErrors[0], errors: pwErrors });
      return;
    }

    const db = getDb();
    const dup = db
      .prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)")
      .get(email, username);
    if (dup) {
      res.status(409).json({ detail: "Email or username is already registered." });
      return;
    }

    const passwordHash = hashPassword(password);
    const accountNumber = generateUniqueAccountNumber();

    const created = runAtomic(db, () => {
      const userRes = db
        .prepare("INSERT INTO users (email, username, password_hash, last_login_at) VALUES (?, ?, ?, ?)")
        .run(email, username, passwordHash, new Date().toISOString());
      const userId = Number(userRes.lastInsertRowid);

      const custRole = db.prepare("SELECT id FROM roles WHERE name = 'CUSTOMER'").get() as { id: number };
      db.prepare("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)").run(userId, custRole.id);
      db.prepare(
        "INSERT INTO customer_details (user_id, first_name, last_name, phone) VALUES (?, ?, ?, ?)"
      ).run(userId, firstName, lastName, phone);

      const acctRes = db
        .prepare(
          "INSERT INTO accounts (user_id, account_number, account_type, currency, balance_cents, status) VALUES (?, ?, ?, 'USD', 0, 'ACTIVE')"
        )
        .run(userId, accountNumber, accountType);

      return { userId, accountId: Number(acctRes.lastInsertRowid) };
    });

    const roles = ["CUSTOMER"];
    const ttlMinutes = getSettingNumber("session_timeout_minutes", 15);
    const { token, expiresAt } = createAccessToken(created.userId, username, roles, 1, ttlMinutes);
    const csrfToken = generateCsrfToken(String(created.userId));
    setSessionCookie(res, token, ttlMinutes, req);

    logSecurityEvent(created.userId, "CUSTOMER_REGISTERED", req, `Opened ${accountType} account ${accountNumber}`);
    logAuditEvent(
      created.userId,
      "ACCOUNT_OPENED",
      "ACCOUNT",
      String(created.accountId),
      null,
      { account_number: accountNumber, account_type: accountType },
      req
    );

    res.status(201).json({
      access_token: token,
      csrf_token: csrfToken,
      expires_at: expiresAt,
      user: { id: created.userId, email, username, roles, is_active: true },
      initial_account_number: accountNumber,
    });
  });

  // 4. Customer Login & Admin Login (Separate Portals)
  function handleLogin(portal: "CUSTOMER" | "ADMIN") {
    return (req: Request, res: Response): void => {
      const identifier = String(req.body?.identifier || req.body?.username || req.body?.email || "").trim();
      const password = String(req.body?.password || "");

      if (!identifier || !password) {
        res.status(400).json({ detail: "Username/email and password are required." });
        return;
      }

      const db = getDb();
      const userRow = db
        .prepare(
          "SELECT id, email, username, password_hash, is_active, failed_login_attempts, locked_until, token_version FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)"
        )
        .get(identifier, identifier) as
        | {
            id: number;
            email: string;
            username: string;
            password_hash: string;
            is_active: number;
            failed_login_attempts: number;
            locked_until: string | null;
            token_version: number;
          }
        | undefined;

      if (!userRow) {
        logSecurityEvent(null, "LOGIN_FAILED_UNKNOWN_USER", req, `Portal=${portal}, identifier=${identifier}`);
        res.status(401).json({ detail: "Invalid credentials." });
        return;
      }

      if (!userRow.is_active) {
        logSecurityEvent(userRow.id, "LOGIN_BLOCKED_INACTIVE", req, `Portal=${portal}`);
        res.status(403).json({ detail: "Account is deactivated. Contact an administrator." });
        return;
      }

      if (userRow.locked_until && new Date(userRow.locked_until).getTime() > Date.now()) {
        logSecurityEvent(userRow.id, "LOGIN_BLOCKED_LOCKED", req, `Locked until ${userRow.locked_until}`);
        res.status(423).json({
          detail: `Account temporarily locked due to failed logins. Try again after ${new Date(
            userRow.locked_until
          ).toLocaleTimeString()}.`,
        });
        return;
      }

      if (!verifyPassword(password, userRow.password_hash)) {
        const maxAttempts = getSettingNumber("max_failed_login_attempts", 5);
        const lockMinutes = getSettingNumber("account_lockout_minutes", 15);
        const nextAttempts = userRow.failed_login_attempts + 1;
        const lockUntil =
          nextAttempts >= maxAttempts ? new Date(Date.now() + lockMinutes * 60_000).toISOString() : null;

        db.prepare(
          "UPDATE users SET failed_login_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?"
        ).run(nextAttempts, lockUntil, new Date().toISOString(), userRow.id);

        logSecurityEvent(
          userRow.id,
          lockUntil ? "ACCOUNT_LOCKED" : "LOGIN_FAILED",
          req,
          `Portal=${portal}, attempt=${nextAttempts}/${maxAttempts}`
        );

        if (lockUntil) {
          res.status(423).json({
            detail: `Too many failed attempts. Account locked for ${lockMinutes} minutes.`,
          });
          return;
        }
        res.status(401).json({ detail: "Invalid credentials." });
        return;
      }

      const roles = getUserRoles(userRow.id);
      if (portal === "ADMIN" && !roles.includes("ADMIN") && !roles.includes("SUPER_ADMIN")) {
        logSecurityEvent(userRow.id, "ADMIN_PORTAL_ACCESS_DENIED", req, "Customer attempted admin login");
        res.status(403).json({ detail: "Administrator privileges are required for this portal." });
        return;
      }
      if (portal === "CUSTOMER" && !roles.includes("CUSTOMER")) {
        logSecurityEvent(userRow.id, "CUSTOMER_PORTAL_ADMIN_REDIRECT", req, "Admin attempted customer portal login");
        res.status(403).json({ detail: "Please sign in through the Administrator Portal." });
        return;
      }

      const nowIso = new Date().toISOString();
      db.prepare(
        "UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?"
      ).run(nowIso, nowIso, userRow.id);

      const ttlMinutes = getSettingNumber("session_timeout_minutes", 15);
      const { token, expiresAt } = createAccessToken(
        userRow.id,
        userRow.username,
        roles,
        userRow.token_version,
        ttlMinutes
      );
      const csrfToken = generateCsrfToken(String(userRow.id));
      setSessionCookie(res, token, ttlMinutes, req);

      logSecurityEvent(userRow.id, `${portal}_LOGIN_SUCCESS`, req, `Roles=[${roles.join(", ")}]`);

      res.json({
        access_token: token,
        csrf_token: csrfToken,
        expires_at: expiresAt,
        user: {
          id: userRow.id,
          email: userRow.email,
          username: userRow.username,
          roles,
          is_active: true,
          last_login_at: nowIso,
        },
      });
    };
  }

  router.post("/auth/login", handleLogin("CUSTOMER"));
  router.post("/auth/admin/login", handleLogin("ADMIN"));

  router.post("/auth/logout", requireAuth, (req: AuthedRequest, res: Response) => {
    const user = req.authUser!;
    const db = getDb();
    db.prepare("UPDATE users SET token_version = token_version + 1, updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      user.id
    );
    clearSessionCookie(res);
    logSecurityEvent(user.id, "LOGOUT", req, "Session terminated and token version incremented");
    res.json({ status: "logged_out" });
  });

  router.get("/auth/me", requireAuth, (req: AuthedRequest, res: Response) => {
    const user = req.authUser!;
    const db = getDb();
    const userRow = db
      .prepare("SELECT id, email, username, is_active, last_login_at, created_at FROM users WHERE id = ?")
      .get(user.id) as {
      id: number;
      email: string;
      username: string;
      is_active: number;
      last_login_at: string | null;
      created_at: string;
    };
    const details = db.prepare("SELECT * FROM customer_details WHERE user_id = ?").get(user.id) || null;
    res.json({
      user: {
        id: userRow.id,
        email: userRow.email,
        username: userRow.username,
        roles: user.roles,
        is_active: Boolean(userRow.is_active),
        last_login_at: userRow.last_login_at,
        created_at: userRow.created_at,
      },
      customer_details: details,
      csrf_token: generateCsrfToken(String(user.id)),
    });
  });

  router.post("/auth/change-password", requireAuth, (req: AuthedRequest, res: Response) => {
    const user = req.authUser!;
    const currentPassword = String(req.body?.current_password || "");
    const newPassword = String(req.body?.new_password || "");

    const db = getDb();
    const row = db
      .prepare("SELECT password_hash, token_version FROM users WHERE id = ?")
      .get(user.id) as { password_hash: string; token_version: number };

    if (!verifyPassword(currentPassword, row.password_hash)) {
      logSecurityEvent(user.id, "PASSWORD_CHANGE_FAILED", req, "Incorrect current password");
      res.status(400).json({ detail: "Current password is incorrect." });
      return;
    }

    const minLen = getSettingNumber("min_password_length", 10);
    const requireComplexity = getSettingBool("require_password_complexity", true);
    const pwErrors = validatePasswordPolicy(newPassword, minLen, requireComplexity);
    if (pwErrors.length > 0) {
      res.status(400).json({ detail: pwErrors[0], errors: pwErrors });
      return;
    }

    const newHash = hashPassword(newPassword);
    const nextVersion = row.token_version + 1;
    db.prepare("UPDATE users SET password_hash = ?, token_version = ?, updated_at = ? WHERE id = ?").run(
      newHash,
      nextVersion,
      new Date().toISOString(),
      user.id
    );

    const ttlMinutes = getSettingNumber("session_timeout_minutes", 15);
    const { token, expiresAt } = createAccessToken(user.id, user.username, user.roles, nextVersion, ttlMinutes);
    const csrfToken = generateCsrfToken(String(user.id));
    setSessionCookie(res, token, ttlMinutes, req);

    logSecurityEvent(user.id, "PASSWORD_CHANGED", req, "User rotated password and invalidated prior tokens");
    res.json({
      status: "updated",
      access_token: token,
      csrf_token: csrfToken,
      expires_at: expiresAt,
    });
  });

  // 5. Customer Profile
  router.get("/customers/profile", requireAuth, (req: AuthedRequest, res: Response) => {
    const user = req.authUser!;
    const db = getDb();
    const profile = db.prepare("SELECT * FROM customer_details WHERE user_id = ?").get(user.id);
    if (!profile) {
      res.status(404).json({ detail: "Customer profile not found." });
      return;
    }
    res.json({ profile });
  });

  router.put("/customers/profile", requireAuth, (req: AuthedRequest, res: Response) => {
    const user = req.authUser!;
    const db = getDb();
    const existing = db.prepare("SELECT * FROM customer_details WHERE user_id = ?").get(user.id) as
      | Record<string, unknown>
      | undefined;

    const firstName = String(req.body?.first_name ?? existing?.first_name ?? "").trim();
    const lastName = String(req.body?.last_name ?? existing?.last_name ?? "").trim();
    if (!firstName || !lastName) {
      res.status(400).json({ detail: "First name and last name cannot be empty." });
      return;
    }

    const phone = req.body?.phone !== undefined ? String(req.body.phone || "").trim() || null : (existing?.phone as string | null) ?? null;
    const address1 =
      req.body?.address_line1 !== undefined
        ? String(req.body.address_line1 || "").trim() || null
        : (existing?.address_line1 as string | null) ?? null;
    const address2 =
      req.body?.address_line2 !== undefined
        ? String(req.body.address_line2 || "").trim() || null
        : (existing?.address_line2 as string | null) ?? null;
    const city = req.body?.city !== undefined ? String(req.body.city || "").trim() || null : (existing?.city as string | null) ?? null;
    const state =
      req.body?.state_province !== undefined
        ? String(req.body.state_province || "").trim() || null
        : (existing?.state_province as string | null) ?? null;
    const postal =
      req.body?.postal_code !== undefined
        ? String(req.body.postal_code || "").trim() || null
        : (existing?.postal_code as string | null) ?? null;
    const country =
      req.body?.country !== undefined ? String(req.body.country || "").trim() || null : (existing?.country as string | null) ?? null;
    const dob =
      req.body?.date_of_birth !== undefined
        ? String(req.body.date_of_birth || "").trim() || null
        : (existing?.date_of_birth as string | null) ?? null;

    const nowIso = new Date().toISOString();
    if (!existing) {
      db.prepare(
        "INSERT INTO customer_details (user_id, first_name, last_name, phone, address_line1, address_line2, city, state_province, postal_code, country, date_of_birth, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(user.id, firstName, lastName, phone, address1, address2, city, state, postal, country, dob, nowIso);
    } else {
      db.prepare(
        "UPDATE customer_details SET first_name = ?, last_name = ?, phone = ?, address_line1 = ?, address_line2 = ?, city = ?, state_province = ?, postal_code = ?, country = ?, date_of_birth = ?, updated_at = ? WHERE user_id = ?"
      ).run(firstName, lastName, phone, address1, address2, city, state, postal, country, dob, nowIso, user.id);
    }

    const updated = db.prepare("SELECT * FROM customer_details WHERE user_id = ?").get(user.id);
    logAuditEvent(user.id, "PROFILE_UPDATED", "CUSTOMER_DETAILS", String(user.id), null, { firstName, lastName }, req);
    res.json({ profile: updated });
  });

  // 6. Accounts & Ledger Reconciliation
  router.get("/accounts", requireAuth, (req: AuthedRequest, res: Response) => {
    const user = req.authUser!;
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM accounts WHERE user_id = ? ORDER BY id ASC")
      .all(user.id) as Array<Parameters<typeof serializeAccount>[0]>;
    res.json({ accounts: rows.map(serializeAccount) });
  });

  router.post("/accounts", requireAuth, requireRole("CUSTOMER"), (req: AuthedRequest, res: Response) => {
    const user = req.authUser!;
    const typeRaw = String(req.body?.account_type || "SAVINGS").toUpperCase();
    if (typeRaw !== "CHECKING" && typeRaw !== "SAVINGS") {
      res.status(400).json({ detail: "Account type must be CHECKING or SAVINGS." });
      return;
    }

    const db = getDb();
    const countRow = db
      .prepare("SELECT COUNT(*) AS cnt FROM accounts WHERE user_id = ?")
      .get(user.id) as { cnt: number };
    if (countRow.cnt >= 5) {
      res.status(400).json({ detail: "Maximum of 5 demo accounts per customer reached." });
      return;
    }

    const accountNumber = generateUniqueAccountNumber();
    const insert = db
      .prepare(
        "INSERT INTO accounts (user_id, account_number, account_type, currency, balance_cents, status) VALUES (?, ?, ?, 'USD', 0, 'ACTIVE')"
      )
      .run(user.id, accountNumber, typeRaw);

    const created = db
      .prepare("SELECT * FROM accounts WHERE id = ?")
      .get(Number(insert.lastInsertRowid)) as Parameters<typeof serializeAccount>[0];

    logAuditEvent(
      user.id,
      "ACCOUNT_OPENED",
      "ACCOUNT",
      String(created.id),
      null,
      { account_number: created.account_number, account_type: created.account_type },
      req
    );
    res.status(201).json({ account: serializeAccount(created) });
  });

  router.get("/accounts/:id/balance", requireAuth, (req: AuthedRequest, res: Response) => {
    const user = req.authUser!;
    const accountId = Number(req.params.id);
    if (!Number.isSafeInteger(accountId)) {
      res.status(400).json({ detail: "Invalid account id." });
      return;
    }

    const db = getDb();
    const acct = db
      .prepare("SELECT * FROM accounts WHERE id = ?")
      .get(accountId) as Parameters<typeof serializeAccount>[0] | undefined;

    if (!acct) {
      res.status(404).json({ detail: "Account not found." });
      return;
    }
    if (acct.user_id !== user.id && !isAdminUser(user)) {
      res.status(403).json({ detail: "You do not have permission to view this account." });
      return;
    }
    res.json({ account: serializeAccount(acct) });
  });

  router.get("/accounts/:id/reconcile", requireAuth, (req: AuthedRequest, res: Response) => {
    const user = req.authUser!;
    const accountId = Number(req.params.id);
    if (!Number.isSafeInteger(accountId)) {
      res.status(400).json({ detail: "Invalid account id." });
      return;
    }

    const db = getDb();
    const acct = db
      .prepare("SELECT * FROM accounts WHERE id = ?")
      .get(accountId) as Parameters<typeof serializeAccount>[0] | undefined;

    if (!acct) {
      res.status(404).json({ detail: "Account not found." });
      return;
    }
    if (acct.user_id !== user.id && !isAdminUser(user)) {
      res.status(403).json({ detail: "You do not have permission to reconcile this account." });
      return;
    }

    const agg = db
      .prepare(
        "SELECT COUNT(*) AS entry_count, COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount_cents ELSE -amount_cents END), 0) AS ledger_net_cents FROM transaction_ledger WHERE account_id = ?"
      )
      .get(accountId) as { entry_count: number; ledger_net_cents: number };

    const diffCents = acct.balance_cents - agg.ledger_net_cents;
    res.json({
      account_id: acct.id,
      account_number: acct.account_number,
      account_balance: centsToDollars(acct.balance_cents),
      ledger_net_balance: centsToDollars(agg.ledger_net_cents),
      difference: centsToDollars(diffCents),
      is_balanced: diffCents === 0,
      entry_count: agg.entry_count,
    });
  });

  // 7. Beneficiaries
  router.get("/beneficiaries", requireAuth, (req: AuthedRequest, res: Response) => {
    const user = req.authUser!;
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM beneficiaries WHERE user_id = ? ORDER BY id DESC")
      .all(user.id);
    res.json({ beneficiaries: rows });
  });

  router.post("/beneficiaries", requireAuth, (req: AuthedRequest, res: Response) => {
    const user = req.authUser!;
    const name = String(req.body?.beneficiary_name || "").trim();
    const accountNumber = String(req.body?.account_number || "").trim();
    const nickname = String(req.body?.nickname || "").trim() || null;

    if (!name || !accountNumber) {
      res.status(400).json({ detail: "Beneficiary name and account number are required." });
      return;
    }

    const db = getDb();
    const targetAcct = db
      .prepare("SELECT id, user_id, status FROM accounts WHERE account_number = ?")
      .get(accountNumber) as { id: number; user_id: number; status: string } | undefined;

    if (!targetAcct) {
      res.status(404).json({ detail: "Destination demo account number does not exist." });
      return;
    }
    if (targetAcct.status !== "ACTIVE") {
      res.status(400).json({ detail: "Destination account is not active." });
      return;
    }

    const dup = db
      .prepare("SELECT id FROM beneficiaries WHERE user_id = ? AND account_number = ?")
      .get(user.id, accountNumber);
    if (dup) {
      res.status(409).json({ detail: "This beneficiary account is already saved." });
      return;
    }

    const insert = db
      .prepare(
        "INSERT INTO beneficiaries (user_id, beneficiary_name, account_number, nickname) VALUES (?, ?, ?, ?)"
      )
      .run(user.id, name, accountNumber, nickname);
    const created = db
      .prepare("SELECT * FROM beneficiaries WHERE id = ?")
      .get(Number(insert.lastInsertRowid));

    res.status(201).json({ beneficiary: created });
  });

  router.delete("/beneficiaries/:id", requireAuth, (req: AuthedRequest, res: Response) => {
    const user = req.authUser!;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) {
      res.status(400).json({ detail: "Invalid beneficiary id." });
      return;
    }

    const db = getDb();
    const row = db
      .prepare("SELECT id, user_id FROM beneficiaries WHERE id = ?")
      .get(id) as { id: number; user_id: number } | undefined;
    if (!row) {
      res.status(404).json({ detail: "Beneficiary not found." });
      return;
    }
    if (row.user_id !== user.id) {
      res.status(403).json({ detail: "You cannot delete another customer's beneficiary." });
      return;
    }

    db.prepare("DELETE FROM beneficiaries WHERE id = ?").run(id);
    res.json({ status: "deleted", id });
  });

  // 8. Atomic Financial Transactions (Deposit, Withdraw, Transfer)
  function checkIdempotencyReplay(
    idempotencyKey: string | null,
    userId: number,
    expectedType: string
  ) {
    if (!idempotencyKey) return null;
    const db = getDb();
    const existing = db
      .prepare(
        "SELECT t.*, sa.account_number AS source_account_number, da.account_number AS destination_account_number FROM transactions t LEFT JOIN accounts sa ON sa.id = t.source_account_id LEFT JOIN accounts da ON da.id = t.destination_account_id WHERE t.idempotency_key = ?"
      )
      .get(idempotencyKey) as Parameters<typeof serializeTransaction>[0] | undefined;

    if (!existing) return null;
    if (existing.initiated_by_user_id !== userId || existing.transaction_type !== expectedType) {
      throw Object.assign(new Error("Idempotency-Key was already used for a different request."), {
        statusCode: 409,
      });
    }
    return existing;
  }

  router.post("/transactions/deposit", requireAuth, (req: AuthedRequest, res: Response) => {
    const user = req.authUser!;
    const accountId = Number(req.body?.account_id);
    const amountCents = parseDollarsToCents(req.body?.amount);
    const description = String(req.body?.description || "Demo Deposit").trim().slice(0, 200);
    const idempotencyKey =
      String(req.headers["idempotency-key"] || req.body?.idempotency_key || "").trim() || null;

    if (!Number.isSafeInteger(accountId) || amountCents === null) {
      res.status(400).json({ detail: "Valid account_id and positive dollar amount (up to 2 decimals) are required." });
      return;
    }

    try {
      const replay = checkIdempotencyReplay(idempotencyKey, user.id, "DEPOSIT");
      if (replay) {
        res.json({ transaction: serializeTransaction(replay), idempotent_replay: true });
        return;
      }

      const maxDepositDollars = getSettingNumber("max_single_deposit", 25000);
      const maxDepositCents = Math.round(maxDepositDollars * 100);
      if (amountCents > maxDepositCents) {
        res.status(400).json({ detail: `Single deposit exceeds limit of $${centsToDollars(maxDepositCents)}.` });
        return;
      }

      const db = getDb();
      const result = runAtomic(db, () => {
        const acct = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as
          | {
              id: number;
              user_id: number;
              account_number: string;
              currency: string;
              balance_cents: number;
              status: string;
            }
          | undefined;

        if (!acct) {
          throw Object.assign(new Error("Account not found."), { statusCode: 404 });
        }
        if (acct.user_id !== user.id && !isAdminUser(user)) {
          throw Object.assign(new Error("You do not own this account."), { statusCode: 403 });
        }
        if (acct.status !== "ACTIVE") {
          throw Object.assign(new Error(`Account is ${acct.status} and cannot accept deposits.`), {
            statusCode: 400,
          });
        }

        const beforeCents = acct.balance_cents;
        const afterCents = beforeCents + amountCents;
        const nowIso = new Date().toISOString();
        const ref = generateReference("DEP");

        db.prepare("UPDATE accounts SET balance_cents = ?, updated_at = ? WHERE id = ?").run(
          afterCents,
          nowIso,
          acct.id
        );

        const txInsert = db
          .prepare(
            "INSERT INTO transactions (reference_number, idempotency_key, transaction_type, source_account_id, destination_account_id, amount_cents, currency, status, description, initiated_by_user_id) VALUES (?, ?, 'DEPOSIT', NULL, ?, ?, ?, 'COMPLETED', ?, ?)"
          )
          .run(ref, idempotencyKey, acct.id, amountCents, acct.currency, description, user.id);

        const txId = Number(txInsert.lastInsertRowid);
        db.prepare(
          "INSERT INTO transaction_ledger (transaction_id, account_id, entry_type, amount_cents, balance_before_cents, balance_after_cents) VALUES (?, ?, 'CREDIT', ?, ?, ?)"
        ).run(txId, acct.id, amountCents, beforeCents, afterCents);

        const txRow = db
          .prepare(
            "SELECT t.*, NULL AS source_account_number, da.account_number AS destination_account_number FROM transactions t LEFT JOIN accounts da ON da.id = t.destination_account_id WHERE t.id = ?"
          )
          .get(txId) as Parameters<typeof serializeTransaction>[0];

        return { txRow, acct };
      });

      const notif = dispatchSimulatedNotification({
        event: "DEPOSIT_COMPLETED",
        referenceNumber: result.txRow.reference_number,
        email: user.email,
        amount: centsToDollars(amountCents),
        currency: result.acct.currency,
      });

      res.status(201).json({
        transaction: serializeTransaction(result.txRow),
        notification: notif,
      });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({ detail: err instanceof Error ? err.message : "Deposit failed." });
    }
  });

  router.post("/transactions/withdraw", requireAuth, (req: AuthedRequest, res: Response) => {
    const user = req.authUser!;
    const accountId = Number(req.body?.account_id);
    const amountCents = parseDollarsToCents(req.body?.amount);
    const description = String(req.body?.description || "Demo Withdrawal").trim().slice(0, 200);
    const idempotencyKey =
      String(req.headers["idempotency-key"] || req.body?.idempotency_key || "").trim() || null;

    if (!Number.isSafeInteger(accountId) || amountCents === null) {
      res.status(400).json({ detail: "Valid account_id and positive dollar amount (up to 2 decimals) are required." });
      return;
    }

    try {
      const replay = checkIdempotencyReplay(idempotencyKey, user.id, "WITHDRAWAL");
      if (replay) {
        res.json({ transaction: serializeTransaction(replay), idempotent_replay: true });
        return;
      }

      const maxWithdrawDollars = getSettingNumber("max_single_withdrawal", 5000);
      const maxWithdrawCents = Math.round(maxWithdrawDollars * 100);
      if (amountCents > maxWithdrawCents) {
        res.status(400).json({ detail: `Single withdrawal exceeds limit of $${centsToDollars(maxWithdrawCents)}.` });
        return;
      }

      const db = getDb();
      const result = runAtomic(db, () => {
        const acct = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as
          | {
              id: number;
              user_id: number;
              account_number: string;
              currency: string;
              balance_cents: number;
              status: string;
            }
          | undefined;

        if (!acct) {
          throw Object.assign(new Error("Account not found."), { statusCode: 404 });
        }
        if (acct.user_id !== user.id && !isAdminUser(user)) {
          throw Object.assign(new Error("You do not own this account."), { statusCode: 403 });
        }
        if (acct.status !== "ACTIVE") {
          throw Object.assign(new Error(`Account is ${acct.status} and cannot process withdrawals.`), {
            statusCode: 400,
          });
        }
        if (acct.balance_cents < amountCents) {
          throw Object.assign(new Error("Insufficient funds for withdrawal."), { statusCode: 400 });
        }

        const beforeCents = acct.balance_cents;
        const afterCents = beforeCents - amountCents;
        const nowIso = new Date().toISOString();
        const ref = generateReference("WDR");

        db.prepare("UPDATE accounts SET balance_cents = ?, updated_at = ? WHERE id = ?").run(
          afterCents,
          nowIso,
          acct.id
        );

        const txInsert = db
          .prepare(
            "INSERT INTO transactions (reference_number, idempotency_key, transaction_type, source_account_id, destination_account_id, amount_cents, currency, status, description, initiated_by_user_id) VALUES (?, ?, 'WITHDRAWAL', ?, NULL, ?, ?, 'COMPLETED', ?, ?)"
          )
          .run(ref, idempotencyKey, acct.id, amountCents, acct.currency, description, user.id);

        const txId = Number(txInsert.lastInsertRowid);
        db.prepare(
          "INSERT INTO transaction_ledger (transaction_id, account_id, entry_type, amount_cents, balance_before_cents, balance_after_cents) VALUES (?, ?, 'DEBIT', ?, ?, ?)"
        ).run(txId, acct.id, amountCents, beforeCents, afterCents);

        const txRow = db
          .prepare(
            "SELECT t.*, sa.account_number AS source_account_number, NULL AS destination_account_number FROM transactions t LEFT JOIN accounts sa ON sa.id = t.source_account_id WHERE t.id = ?"
          )
          .get(txId) as Parameters<typeof serializeTransaction>[0];

        return { txRow, acct };
      });

      const notif = dispatchSimulatedNotification({
        event: "WITHDRAWAL_COMPLETED",
        referenceNumber: result.txRow.reference_number,
        email: user.email,
        amount: centsToDollars(amountCents),
        currency: result.acct.currency,
      });

      res.status(201).json({
        transaction: serializeTransaction(result.txRow),
        notification: notif,
      });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({ detail: err instanceof Error ? err.message : "Withdrawal failed." });
    }
  });

  router.post("/transactions/transfer", requireAuth, (req: AuthedRequest, res: Response) => {
    const user = req.authUser!;
    const sourceAccountId = Number(req.body?.source_account_id);
    const destAccountNumber = String(req.body?.destination_account_number || "").trim();
    const destAccountIdRaw = req.body?.destination_account_id ? Number(req.body.destination_account_id) : null;
    const amountCents = parseDollarsToCents(req.body?.amount);
    const description = String(req.body?.description || "Funds Transfer").trim().slice(0, 200);
    const idempotencyKey =
      String(req.headers["idempotency-key"] || req.body?.idempotency_key || "").trim() || null;

    if (!Number.isSafeInteger(sourceAccountId) || amountCents === null || (!destAccountNumber && !destAccountIdRaw)) {
      res.status(400).json({
        detail: "Valid source_account_id, destination account, and positive dollar amount are required.",
      });
      return;
    }

    try {
      const replay = checkIdempotencyReplay(idempotencyKey, user.id, "TRANSFER");
      if (replay) {
        res.json({ transaction: serializeTransaction(replay), idempotent_replay: true });
        return;
      }

      const maxSingleCents = Math.round(getSettingNumber("max_single_transfer", 10000) * 100);
      const dailyLimitCents = Math.round(getSettingNumber("daily_transfer_limit", 10000) * 100);
      if (amountCents > maxSingleCents) {
        res.status(400).json({ detail: `Single transfer exceeds limit of $${centsToDollars(maxSingleCents)}.` });
        return;
      }

      const db = getDb();
      const result = runAtomic(db, () => {
        const src = db.prepare("SELECT * FROM accounts WHERE id = ?").get(sourceAccountId) as
          | {
              id: number;
              user_id: number;
              account_number: string;
              currency: string;
              balance_cents: number;
              status: string;
            }
          | undefined;

        if (!src) {
          throw Object.assign(new Error("Source account not found."), { statusCode: 404 });
        }
        if (src.user_id !== user.id && !isAdminUser(user)) {
          throw Object.assign(new Error("You do not own the source account."), { statusCode: 403 });
        }
        if (src.status !== "ACTIVE") {
          throw Object.assign(new Error(`Source account is ${src.status}.`), { statusCode: 400 });
        }

        const dst = (
          destAccountNumber
            ? db.prepare("SELECT * FROM accounts WHERE account_number = ?").get(destAccountNumber)
            : db.prepare("SELECT * FROM accounts WHERE id = ?").get(destAccountIdRaw)
        ) as
          | {
              id: number;
              user_id: number;
              account_number: string;
              currency: string;
              balance_cents: number;
              status: string;
            }
          | undefined;

        if (!dst) {
          throw Object.assign(new Error("Destination account not found."), { statusCode: 404 });
        }
        if (dst.id === src.id) {
          throw Object.assign(new Error("Source and destination accounts must be different."), { statusCode: 400 });
        }
        if (dst.status !== "ACTIVE") {
          throw Object.assign(new Error(`Destination account is ${dst.status}.`), { statusCode: 400 });
        }
        if (src.balance_cents < amountCents) {
          throw Object.assign(new Error("Insufficient funds in source account."), { statusCode: 400 });
        }

        const utcDayPrefix = new Date().toISOString().slice(0, 10);
        const dailySumRow = db
          .prepare(
            "SELECT COALESCE(SUM(amount_cents), 0) AS total_cents FROM transactions WHERE source_account_id = ? AND transaction_type = 'TRANSFER' AND status = 'COMPLETED' AND created_at >= ?"
          )
          .get(src.id, `${utcDayPrefix}T00:00:00.000Z`) as { total_cents: number };

        if (dailySumRow.total_cents + amountCents > dailyLimitCents) {
          throw Object.assign(
            new Error(`Daily transfer limit of $${centsToDollars(dailyLimitCents)} exceeded.`),
            { statusCode: 400 }
          );
        }

        const srcBefore = src.balance_cents;
        const srcAfter = srcBefore - amountCents;
        const dstBefore = dst.balance_cents;
        const dstAfter = dstBefore + amountCents;
        const nowIso = new Date().toISOString();
        const ref = generateReference("TRF");

        db.prepare("UPDATE accounts SET balance_cents = ?, updated_at = ? WHERE id = ?").run(
          srcAfter,
          nowIso,
          src.id
        );
        db.prepare("UPDATE accounts SET balance_cents = ?, updated_at = ? WHERE id = ?").run(
          dstAfter,
          nowIso,
          dst.id
        );

        const txInsert = db
          .prepare(
            "INSERT INTO transactions (reference_number, idempotency_key, transaction_type, source_account_id, destination_account_id, amount_cents, currency, status, description, initiated_by_user_id) VALUES (?, ?, 'TRANSFER', ?, ?, ?, ?, 'COMPLETED', ?, ?)"
          )
          .run(ref, idempotencyKey, src.id, dst.id, amountCents, src.currency, description, user.id);

        const txId = Number(txInsert.lastInsertRowid);
        db.prepare(
          "INSERT INTO transaction_ledger (transaction_id, account_id, entry_type, amount_cents, balance_before_cents, balance_after_cents) VALUES (?, ?, 'DEBIT', ?, ?, ?)"
        ).run(txId, src.id, amountCents, srcBefore, srcAfter);
        db.prepare(
          "INSERT INTO transaction_ledger (transaction_id, account_id, entry_type, amount_cents, balance_before_cents, balance_after_cents) VALUES (?, ?, 'CREDIT', ?, ?, ?)"
        ).run(txId, dst.id, amountCents, dstBefore, dstAfter);

        const txRow = db
          .prepare(
            "SELECT t.*, sa.account_number AS source_account_number, da.account_number AS destination_account_number FROM transactions t LEFT JOIN accounts sa ON sa.id = t.source_account_id LEFT JOIN accounts da ON da.id = t.destination_account_id WHERE t.id = ?"
          )
          .get(txId) as Parameters<typeof serializeTransaction>[0];

        return { txRow, src, dst };
      });

      const notif = dispatchSimulatedNotification({
        event: "TRANSFER_COMPLETED",
        referenceNumber: result.txRow.reference_number,
        email: user.email,
        amount: centsToDollars(amountCents),
        currency: result.src.currency,
        destinationAccountNumber: result.dst.account_number,
      });

      res.status(201).json({
        transaction: serializeTransaction(result.txRow),
        notification: notif,
      });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({ detail: err instanceof Error ? err.message : "Transfer failed." });
    }
  });

  // 9. Transaction History & Admin Reversal
  router.get("/transactions", requireAuth, (req: AuthedRequest, res: Response) => {
    const user = req.authUser!;
    const db = getDb();
    const accountIdParam = req.query.account_id ? Number(req.query.account_id) : null;
    const typeParam = req.query.transaction_type ? String(req.query.transaction_type).toUpperCase() : null;
    const statusParam = req.query.status ? String(req.query.status).toUpperCase() : null;
    const startDate = req.query.start_date ? String(req.query.start_date).trim() : null;
    const endDate = req.query.end_date ? String(req.query.end_date).trim() : null;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (!isAdminUser(user)) {
      const owned = db
        .prepare("SELECT id FROM accounts WHERE user_id = ?")
        .all(user.id) as Array<{ id: number }>;
      const ownedIds = owned.map((a) => a.id);
      if (ownedIds.length === 0) {
        res.json({ transactions: [] });
        return;
      }
      if (accountIdParam !== null) {
        if (!ownedIds.includes(accountIdParam)) {
          res.status(403).json({ detail: "You do not own the requested account." });
          return;
        }
        clauses.push("(t.source_account_id = ? OR t.destination_account_id = ?)");
        params.push(accountIdParam, accountIdParam);
      } else {
        const placeholders = ownedIds.map(() => "?").join(", ");
        clauses.push(`(t.source_account_id IN (${placeholders}) OR t.destination_account_id IN (${placeholders}))`);
        params.push(...ownedIds, ...ownedIds);
      }
    } else if (accountIdParam !== null && Number.isSafeInteger(accountIdParam)) {
      clauses.push("(t.source_account_id = ? OR t.destination_account_id = ?)");
      params.push(accountIdParam, accountIdParam);
    }

    if (typeParam && ["DEPOSIT", "WITHDRAWAL", "TRANSFER", "REVERSAL"].includes(typeParam)) {
      clauses.push("t.transaction_type = ?");
      params.push(typeParam);
    }
    if (statusParam && ["PENDING", "COMPLETED", "FAILED", "REVERSED"].includes(statusParam)) {
      clauses.push("t.status = ?");
      params.push(statusParam);
    }
    if (startDate) {
      clauses.push("t.created_at >= ?");
      params.push(`${startDate}T00:00:00.000Z`);
    }
    if (endDate) {
      clauses.push("t.created_at <= ?");
      params.push(`${endDate}T23:59:59.999Z`);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT t.*, sa.account_number AS source_account_number, da.account_number AS destination_account_number FROM transactions t LEFT JOIN accounts sa ON sa.id = t.source_account_id LEFT JOIN accounts da ON da.id = t.destination_account_id ${whereSql} ORDER BY t.id DESC LIMIT ?`
      )
      .all(...params, limit) as Array<Parameters<typeof serializeTransaction>[0]>;

    res.json({ transactions: rows.map(serializeTransaction) });
  });

  router.post(
    "/transactions/:id/reverse",
    requireAuth,
    requireRole("ADMIN", "SUPER_ADMIN"),
    (req: AuthedRequest, res: Response) => {
      const adminUser = req.authUser!;
      const txId = Number(req.params.id);
      const reason = String(req.body?.reason || "Administrator reversal").trim().slice(0, 200);

      if (!Number.isSafeInteger(txId)) {
        res.status(400).json({ detail: "Invalid transaction id." });
        return;
      }

      const db = getDb();
      try {
        const reversalTx = runAtomic(db, () => {
          const orig = db.prepare("SELECT * FROM transactions WHERE id = ?").get(txId) as
            | {
                id: number;
                reference_number: string;
                transaction_type: string;
                source_account_id: number | null;
                destination_account_id: number | null;
                amount_cents: number;
                currency: string;
                status: string;
              }
            | undefined;

          if (!orig) {
            throw Object.assign(new Error("Transaction not found."), { statusCode: 404 });
          }
          if (orig.transaction_type === "REVERSAL") {
            throw Object.assign(new Error("Cannot reverse a reversal transaction."), { statusCode: 400 });
          }
          if (orig.status !== "COMPLETED") {
            throw Object.assign(new Error(`Transaction is ${orig.status} and cannot be reversed.`), {
              statusCode: 400,
            });
          }

          const nowIso = new Date().toISOString();
          const revRef = generateReference("REV");
          const revInsert = db
            .prepare(
              "INSERT INTO transactions (reference_number, transaction_type, source_account_id, destination_account_id, amount_cents, currency, status, description, initiated_by_user_id, related_transaction_id) VALUES (?, 'REVERSAL', ?, ?, ?, ?, 'COMPLETED', ?, ?, ?)"
            )
            .run(
              revRef,
              orig.destination_account_id,
              orig.source_account_id,
              orig.amount_cents,
              orig.currency,
              `Reversal of ${orig.reference_number}: ${reason}`,
              adminUser.id,
              orig.id
            );
          const revId = Number(revInsert.lastInsertRowid);

          if (orig.destination_account_id) {
            const dstAcct = db
              .prepare("SELECT id, balance_cents FROM accounts WHERE id = ?")
              .get(orig.destination_account_id) as { id: number; balance_cents: number };
            if (dstAcct.balance_cents < orig.amount_cents) {
              throw Object.assign(
                new Error("Destination account has insufficient balance to complete reversal."),
                { statusCode: 400 }
              );
            }
            const after = dstAcct.balance_cents - orig.amount_cents;
            db.prepare("UPDATE accounts SET balance_cents = ?, updated_at = ? WHERE id = ?").run(
              after,
              nowIso,
              dstAcct.id
            );
            db.prepare(
              "INSERT INTO transaction_ledger (transaction_id, account_id, entry_type, amount_cents, balance_before_cents, balance_after_cents) VALUES (?, ?, 'DEBIT', ?, ?, ?)"
            ).run(revId, dstAcct.id, orig.amount_cents, dstAcct.balance_cents, after);
          }

          if (orig.source_account_id) {
            const srcAcct = db
              .prepare("SELECT id, balance_cents FROM accounts WHERE id = ?")
              .get(orig.source_account_id) as { id: number; balance_cents: number };
            const after = srcAcct.balance_cents + orig.amount_cents;
            db.prepare("UPDATE accounts SET balance_cents = ?, updated_at = ? WHERE id = ?").run(
              after,
              nowIso,
              srcAcct.id
            );
            db.prepare(
              "INSERT INTO transaction_ledger (transaction_id, account_id, entry_type, amount_cents, balance_before_cents, balance_after_cents) VALUES (?, ?, 'CREDIT', ?, ?, ?)"
            ).run(revId, srcAcct.id, orig.amount_cents, srcAcct.balance_cents, after);
          }

          db.prepare("UPDATE transactions SET status = 'REVERSED' WHERE id = ?").run(orig.id);

          return db
            .prepare(
              "SELECT t.*, sa.account_number AS source_account_number, da.account_number AS destination_account_number FROM transactions t LEFT JOIN accounts sa ON sa.id = t.source_account_id LEFT JOIN accounts da ON da.id = t.destination_account_id WHERE t.id = ?"
            )
            .get(revId) as Parameters<typeof serializeTransaction>[0];
        });

        logAuditEvent(
          adminUser.id,
          "TRANSACTION_REVERSED",
          "TRANSACTION",
          String(txId),
          { status: "COMPLETED" },
          { status: "REVERSED", reversal_reference: reversalTx.reference_number, reason },
          req
        );
        logSecurityEvent(
          adminUser.id,
          "ADMIN_REVERSAL_EXECUTED",
          req,
          `Reversed tx=${txId} via ${reversalTx.reference_number}`
        );

        res.status(201).json({ reversal: serializeTransaction(reversalTx) });
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode || 500;
        res.status(status).json({ detail: err instanceof Error ? err.message : "Reversal failed." });
      }
    }
  );

  // 10. Account Statements (JSON Summary + Real %PDF-1.4 Binary Download)
  function computeStatement(user: AuthUser, accountId: number, startDateStr: string, endDateStr: string) {
    const db = getDb();
    const acct = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as
      | {
          id: number;
          user_id: number;
          account_number: string;
          account_type: string;
          currency: string;
          balance_cents: number;
          status: string;
        }
      | undefined;

    if (!acct) {
      throw Object.assign(new Error("Account not found."), { statusCode: 404 });
    }
    if (acct.user_id !== user.id && !isAdminUser(user)) {
      throw Object.assign(new Error("You do not have permission to access this statement."), { statusCode: 403 });
    }

    const owner = db.prepare("SELECT email, username FROM users WHERE id = ?").get(acct.user_id) as {
      email: string;
      username: string;
    };
    const details = db.prepare("SELECT * FROM customer_details WHERE user_id = ?").get(acct.user_id) as
      | {
          first_name: string;
          last_name: string;
          address_line1: string | null;
          city: string | null;
          state_province: string | null;
          postal_code: string | null;
          country: string | null;
        }
      | undefined;

    const startIso = `${startDateStr}T00:00:00.000Z`;
    const endIso = `${endDateStr}T23:59:59.999Z`;

    const priorAgg = db
      .prepare(
        "SELECT COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount_cents ELSE -amount_cents END), 0) AS opening_cents FROM transaction_ledger WHERE account_id = ? AND created_at < ?"
      )
      .get(acct.id, startIso) as { opening_cents: number };

    const periodRows = db
      .prepare(
        "SELECT l.entry_type, l.amount_cents, l.balance_after_cents, l.created_at, t.reference_number, t.transaction_type, t.description FROM transaction_ledger l JOIN transactions t ON t.id = l.transaction_id WHERE l.account_id = ? AND l.created_at >= ? AND l.created_at <= ? ORDER BY l.id ASC"
      )
      .all(acct.id, startIso, endIso) as Array<{
      entry_type: string;
      amount_cents: number;
      balance_after_cents: number;
      created_at: string;
      reference_number: string;
      transaction_type: string;
      description: string | null;
    }>;

    let totalCreditsCents = 0;
    let totalDebitsCents = 0;
    const entries = periodRows.map((row) => {
      if (row.entry_type === "CREDIT") totalCreditsCents += row.amount_cents;
      else totalDebitsCents += row.amount_cents;
      return {
        date: row.created_at,
        reference_number: row.reference_number,
        transaction_type: row.transaction_type,
        entry_type: row.entry_type,
        description: row.description || "-",
        amount: centsToDollars(row.amount_cents),
        balance_after: centsToDollars(row.balance_after_cents),
      };
    });

    const closingCents = priorAgg.opening_cents + totalCreditsCents - totalDebitsCents;
    const customerName = details ? `${details.first_name} ${details.last_name}` : owner.username;
    const addressParts = details
      ? [details.address_line1, details.city, details.state_province, details.postal_code, details.country].filter(
          Boolean
        )
      : [];

    return {
      customerName,
      customerEmail: owner.email,
      customerAddress: addressParts.join(", "),
      accountNumber: acct.account_number,
      accountType: acct.account_type,
      accountStatus: acct.status,
      currency: acct.currency,
      startDate: startDateStr,
      endDate: endDateStr,
      openingBalance: centsToDollars(priorAgg.opening_cents),
      totalCredits: centsToDollars(totalCreditsCents),
      totalDebits: centsToDollars(totalDebitsCents),
      closingBalance: centsToDollars(closingCents),
      entries,
    };
  }

  function resolveStatementDates(req: Request): { startDate: string; endDate: string } {
    const today = new Date();
    const thirtyAgo = new Date(today.getTime() - 30 * 86_400_000);
    const startRaw = String(req.query.start_date || thirtyAgo.toISOString().slice(0, 10)).trim();
    const endRaw = String(req.query.end_date || today.toISOString().slice(0, 10)).trim();
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRe.test(startRaw) || !dateRe.test(endRaw) || startRaw > endRaw) {
      throw Object.assign(new Error("Invalid date range. Use YYYY-MM-DD with start_date <= end_date."), {
        statusCode: 400,
      });
    }
    return { startDate: startRaw, endDate: endRaw };
  }

  router.get("/statements/:id/summary", requireAuth, (req: AuthedRequest, res: Response) => {
    try {
      const accountId = Number(req.params.id);
      if (!Number.isSafeInteger(accountId)) {
        res.status(400).json({ detail: "Invalid account id." });
        return;
      }
      const { startDate, endDate } = resolveStatementDates(req);
      const summary = computeStatement(req.authUser!, accountId, startDate, endDate);
      res.json({ statement: summary });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({ detail: err instanceof Error ? err.message : "Failed to load statement." });
    }
  });

  router.get("/statements/:id/pdf", requireAuth, (req: AuthedRequest, res: Response) => {
    try {
      const accountId = Number(req.params.id);
      if (!Number.isSafeInteger(accountId)) {
        res.status(400).json({ detail: "Invalid account id." });
        return;
      }
      const { startDate, endDate } = resolveStatementDates(req);
      const summary = computeStatement(req.authUser!, accountId, startDate, endDate);
      const pdfBuffer = buildStatementPdf(summary);

      logAuditEvent(
        req.authUser!.id,
        "STATEMENT_PDF_DOWNLOADED",
        "ACCOUNT",
        String(accountId),
        null,
        { startDate, endDate, entries: summary.entries.length },
        req
      );

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="statement_${summary.accountNumber}_${startDate}_${endDate}.pdf"`
      );
      res.send(pdfBuffer);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({ detail: err instanceof Error ? err.message : "Failed to generate PDF." });
    }
  });

  // 11. Administrator Operations, Security, Logs & Backups
  router.get("/admin/health", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), (_req: AuthedRequest, res: Response) => {
    const db = getDb();
    db.prepare("SELECT 1").get();
    const logStats = db
      .prepare(
        "SELECT COUNT(*) AS total_requests, COALESCE(AVG(response_time_ms), 0) AS avg_latency_ms, COALESCE(MAX(response_time_ms), 0) AS max_latency_ms, COALESCE(SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END), 0) AS error_count FROM system_logs"
      )
      .get() as {
      total_requests: number;
      avg_latency_ms: number;
      max_latency_ms: number;
      error_count: number;
    };

    const userCount = (db.prepare("SELECT COUNT(*) AS cnt FROM users").get() as { cnt: number }).cnt;
    const accountStats = db
      .prepare(
        "SELECT COUNT(*) AS total_accounts, COALESCE(SUM(balance_cents), 0) AS total_deposits_cents FROM accounts"
      )
      .get() as { total_accounts: number; total_deposits_cents: number };
    const txCount = (db.prepare("SELECT COUNT(*) AS cnt FROM transactions").get() as { cnt: number }).cnt;

    res.json({
      database: "connected",
      metrics: {
        total_requests: logStats.total_requests,
        avg_latency_ms: Number(logStats.avg_latency_ms.toFixed(2)),
        max_latency_ms: Number(logStats.max_latency_ms.toFixed(2)),
        error_count: logStats.error_count,
        total_users: userCount,
        total_accounts: accountStats.total_accounts,
        total_balance_dollars: centsToDollars(accountStats.total_deposits_cents),
        total_transactions: txCount,
      },
      recent_notifications: getRecentNotifications(),
      timestamp: new Date().toISOString(),
    });
  });

  router.get("/admin/logs/system", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 80)));
    const rows = db.prepare("SELECT * FROM system_logs ORDER BY id DESC LIMIT ?").all(limit);
    res.json({ logs: rows });
  });

  router.get("/admin/logs/security", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 80)));
    const rows = db
      .prepare(
        "SELECT s.*, u.username FROM security_logs s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.id DESC LIMIT ?"
      )
      .all(limit);
    res.json({ logs: rows });
  });

  router.get("/admin/logs/audit", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 80)));
    const rows = db
      .prepare(
        "SELECT a.*, u.username AS actor_username FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id ORDER BY a.id DESC LIMIT ?"
      )
      .all(limit);
    res.json({ logs: rows });
  });

  const OPERATIONAL_SETTING_KEYS = [
    "daily_transfer_limit",
    "max_single_deposit",
    "max_single_withdrawal",
    "max_single_transfer",
  ];
  const SECURITY_POLICY_KEYS = [
    "min_password_length",
    "require_password_complexity",
    "session_timeout_minutes",
    "max_failed_login_attempts",
    "account_lockout_minutes",
  ];

  router.get("/admin/settings", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), (_req: AuthedRequest, res: Response) => {
    const db = getDb();
    const placeholders = OPERATIONAL_SETTING_KEYS.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT * FROM application_settings WHERE setting_key IN (${placeholders}) ORDER BY id ASC`)
      .all(...OPERATIONAL_SETTING_KEYS);
    res.json({ settings: rows });
  });

  router.put("/admin/settings/:key", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), (req: AuthedRequest, res: Response) => {
    const key = String(req.params.key || "");
    if (!OPERATIONAL_SETTING_KEYS.includes(key)) {
      res.status(400).json({ detail: "Unsupported operational setting key." });
      return;
    }

    const cents = parseDollarsToCents(req.body?.setting_value);
    if (cents === null) {
      res.status(400).json({ detail: "Setting value must be a positive dollar amount." });
      return;
    }

    const formatted = centsToDollars(cents);
    const db = getDb();
    const prev = db
      .prepare("SELECT setting_value FROM application_settings WHERE setting_key = ?")
      .get(key) as { setting_value: string } | undefined;

    db.prepare(
      "UPDATE application_settings SET setting_value = ?, updated_by = ?, updated_at = ? WHERE setting_key = ?"
    ).run(formatted, req.authUser!.id, new Date().toISOString(), key);

    logAuditEvent(req.authUser!.id, "SETTING_UPDATED", "APPLICATION_SETTINGS", key, prev?.setting_value, formatted, req);
    const updated = db.prepare("SELECT * FROM application_settings WHERE setting_key = ?").get(key);
    res.json({ setting: updated });
  });

  router.get(
    "/admin/security/policies",
    requireAuth,
    requireRole("ADMIN", "SUPER_ADMIN"),
    (_req: AuthedRequest, res: Response) => {
      const db = getDb();
      const placeholders = SECURITY_POLICY_KEYS.map(() => "?").join(", ");
      const rows = db
        .prepare(`SELECT * FROM application_settings WHERE setting_key IN (${placeholders}) ORDER BY id ASC`)
        .all(...SECURITY_POLICY_KEYS);
      res.json({ policies: rows });
    }
  );

  router.put(
    "/admin/security/policies",
    requireAuth,
    requireRole("SUPER_ADMIN"),
    (req: AuthedRequest, res: Response) => {
      const updates: Record<string, string> = {};
      const body = req.body || {};

      if (body.min_password_length !== undefined) {
        const val = Number(body.min_password_length);
        if (!Number.isInteger(val) || val < 8 || val > 64) {
          res.status(400).json({ detail: "min_password_length must be an integer between 8 and 64." });
          return;
        }
        updates.min_password_length = String(val);
      }
      if (body.require_password_complexity !== undefined) {
        updates.require_password_complexity = Boolean(
          body.require_password_complexity === true || body.require_password_complexity === "true"
        )
          ? "true"
          : "false";
      }
      if (body.session_timeout_minutes !== undefined) {
        const val = Number(body.session_timeout_minutes);
        if (!Number.isInteger(val) || val < 5 || val > 1440) {
          res.status(400).json({ detail: "session_timeout_minutes must be between 5 and 1440." });
          return;
        }
        updates.session_timeout_minutes = String(val);
      }
      if (body.max_failed_login_attempts !== undefined) {
        const val = Number(body.max_failed_login_attempts);
        if (!Number.isInteger(val) || val < 3 || val > 20) {
          res.status(400).json({ detail: "max_failed_login_attempts must be between 3 and 20." });
          return;
        }
        updates.max_failed_login_attempts = String(val);
      }
      if (body.account_lockout_minutes !== undefined) {
        const val = Number(body.account_lockout_minutes);
        if (!Number.isInteger(val) || val < 1 || val > 1440) {
          res.status(400).json({ detail: "account_lockout_minutes must be between 1 and 1440." });
          return;
        }
        updates.account_lockout_minutes = String(val);
      }

      if (Object.keys(updates).length === 0) {
        res.status(400).json({ detail: "No valid security policy fields provided." });
        return;
      }

      const db = getDb();
      const nowIso = new Date().toISOString();
      runAtomic(db, () => {
        for (const [k, v] of Object.entries(updates)) {
          db.prepare(
            "UPDATE application_settings SET setting_value = ?, updated_by = ?, updated_at = ? WHERE setting_key = ?"
          ).run(v, req.authUser!.id, nowIso, k);
        }
      });

      logAuditEvent(req.authUser!.id, "SECURITY_POLICIES_UPDATED", "APPLICATION_SETTINGS", "security", null, updates, req);
      logSecurityEvent(req.authUser!.id, "SECURITY_POLICY_CHANGED", req, JSON.stringify(updates));

      const placeholders = SECURITY_POLICY_KEYS.map(() => "?").join(", ");
      const rows = db
        .prepare(`SELECT * FROM application_settings WHERE setting_key IN (${placeholders}) ORDER BY id ASC`)
        .all(...SECURITY_POLICY_KEYS);
      res.json({ policies: rows });
    }
  );

  router.get("/admin/users", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), (_req: AuthedRequest, res: Response) => {
    const db = getDb();
    const users = db
      .prepare(
        "SELECT u.id, u.email, u.username, u.is_active, u.failed_login_attempts, u.locked_until, u.last_login_at, u.created_at, GROUP_CONCAT(r.name) AS roles_csv FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id GROUP BY u.id ORDER BY u.id ASC"
      )
      .all() as Array<{
      id: number;
      email: string;
      username: string;
      is_active: number;
      failed_login_attempts: number;
      locked_until: string | null;
      last_login_at: string | null;
      created_at: string;
      roles_csv: string | null;
    }>;

    res.json({
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        username: u.username,
        is_active: Boolean(u.is_active),
        failed_login_attempts: u.failed_login_attempts,
        locked_until: u.locked_until,
        last_login_at: u.last_login_at,
        created_at: u.created_at,
        roles: u.roles_csv ? u.roles_csv.split(",") : [],
      })),
    });
  });

  router.patch(
    "/admin/users/:id/status",
    requireAuth,
    requireRole("ADMIN", "SUPER_ADMIN"),
    (req: AuthedRequest, res: Response) => {
      const targetId = Number(req.params.id);
      if (!Number.isSafeInteger(targetId)) {
        res.status(400).json({ detail: "Invalid user id." });
        return;
      }
      if (targetId === req.authUser!.id) {
        res.status(400).json({ detail: "Administrators cannot deactivate or lock their own account." });
        return;
      }

      const db = getDb();
      const target = db
        .prepare("SELECT id, is_active, locked_until FROM users WHERE id = ?")
        .get(targetId) as { id: number; is_active: number; locked_until: string | null } | undefined;
      if (!target) {
        res.status(404).json({ detail: "User not found." });
        return;
      }

      const isActive = req.body?.is_active !== undefined ? Boolean(req.body.is_active) : Boolean(target.is_active);
      const unlock = Boolean(req.body?.unlock);
      const nowIso = new Date().toISOString();

      if (!unlock) {
        db.prepare(
          "UPDATE users SET is_active = ?, token_version = token_version + ?, updated_at = ? WHERE id = ?"
        ).run(isActive ? 1 : 0, isActive ? 0 : 1, nowIso, targetId);
      } else {
        db.prepare(
          "UPDATE users SET is_active = ?, failed_login_attempts = 0, locked_until = NULL, token_version = token_version + ?, updated_at = ? WHERE id = ?"
        ).run(isActive ? 1 : 0, isActive ? 0 : 1, nowIso, targetId);
      }

      logAuditEvent(
        req.authUser!.id,
        "USER_STATUS_UPDATED",
        "USER",
        String(targetId),
        { is_active: Boolean(target.is_active), locked_until: target.locked_until },
        { is_active: isActive, unlock },
        req
      );
      logSecurityEvent(
        req.authUser!.id,
        "ADMIN_USER_STATUS_CHANGE",
        req,
        `Target user=${targetId}, is_active=${isActive}, unlock=${unlock}`
      );

      res.json({ status: "updated", id: targetId, is_active: isActive });
    }
  );

  router.get("/admin/accounts", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), (_req: AuthedRequest, res: Response) => {
    const db = getDb();
    const rows = db
      .prepare(
        "SELECT a.*, u.username, u.email FROM accounts a JOIN users u ON u.id = a.user_id ORDER BY a.id ASC"
      )
      .all() as Array<Parameters<typeof serializeAccount>[0] & { username: string; email: string }>;

    res.json({
      accounts: rows.map((row) => ({
        ...serializeAccount(row),
        username: row.username,
        email: row.email,
      })),
    });
  });

  router.patch(
    "/admin/accounts/:id/status",
    requireAuth,
    requireRole("ADMIN", "SUPER_ADMIN"),
    (req: AuthedRequest, res: Response) => {
      const accountId = Number(req.params.id);
      const nextStatus = String(req.body?.status || "").toUpperCase();
      if (!Number.isSafeInteger(accountId) || !["ACTIVE", "FROZEN", "CLOSED"].includes(nextStatus)) {
        res.status(400).json({ detail: "Valid account id and status (ACTIVE, FROZEN, CLOSED) are required." });
        return;
      }

      const db = getDb();
      const acct = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as
        | Parameters<typeof serializeAccount>[0]
        | undefined;
      if (!acct) {
        res.status(404).json({ detail: "Account not found." });
        return;
      }

      db.prepare("UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?").run(
        nextStatus,
        new Date().toISOString(),
        accountId
      );

      logAuditEvent(
        req.authUser!.id,
        "ACCOUNT_STATUS_CHANGED",
        "ACCOUNT",
        String(accountId),
        { status: acct.status },
        { status: nextStatus },
        req
      );
      logSecurityEvent(
        req.authUser!.id,
        "ACCOUNT_STATUS_ADMIN_OVERRIDE",
        req,
        `Account ${acct.account_number}: ${acct.status} -> ${nextStatus}`
      );

      const updated = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as Parameters<
        typeof serializeAccount
      >[0];
      res.json({ account: serializeAccount(updated) });
    }
  );

  // 12. SQLite Database Backup & Restore (with path-traversal guard)
  router.get("/admin/backups", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), (_req: AuthedRequest, res: Response) => {
    const db = getDb();
    const history = db
      .prepare(
        "SELECT b.*, u.username AS initiated_by_username FROM backup_history b JOIN users u ON u.id = b.initiated_by ORDER BY b.id DESC LIMIT 50"
      )
      .all();

    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((name) => name.endsWith(".db"))
      .map((name) => {
        const full = path.join(BACKUP_DIR, name);
        const stat = fs.statSync(full);
        return {
          filename: name,
          size_bytes: stat.size,
          modified_at: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.modified_at.localeCompare(a.modified_at));

    res.json({ history, files });
  });

  router.post("/admin/backups", requireAuth, requireRole("SUPER_ADMIN"), (req: AuthedRequest, res: Response) => {
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const filename = `banking_backup_${stamp}.db`;
    const notes = String(req.body?.notes || "Manual administrator backup").trim().slice(0, 200);

    try {
      const safePath = resolveSafeBackupPath(BACKUP_DIR, filename);
      const db = getDb();
      db.exec(`VACUUM INTO '${safePath.replaceAll("'", "''")}'`);
      const stat = fs.statSync(safePath);

      db.prepare(
        "INSERT INTO backup_history (filename, operation_type, status, file_size_bytes, initiated_by, notes) VALUES (?, 'BACKUP', 'SUCCESS', ?, ?, ?)"
      ).run(filename, stat.size, req.authUser!.id, notes);

      logAuditEvent(
        req.authUser!.id,
        "DATABASE_BACKUP_CREATED",
        "BACKUP",
        filename,
        null,
        { size_bytes: stat.size },
        req
      );

      res.status(201).json({
        filename,
        size_bytes: stat.size,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ detail: err instanceof Error ? err.message : "Backup failed." });
    }
  });

  router.post(
    "/admin/backups/restore",
    requireAuth,
    requireRole("SUPER_ADMIN"),
    (req: AuthedRequest, res: Response) => {
      const filename = String(req.body?.filename || "").trim();
      const confirmRestore = Boolean(req.body?.confirm_restore);
      if (!confirmRestore) {
        res.status(400).json({ detail: "confirm_restore: true is required to execute a database restore." });
        return;
      }

      try {
        const safePath = resolveSafeBackupPath(BACKUP_DIR, filename);
        if (!fs.existsSync(safePath)) {
          res.status(404).json({ detail: "Backup file not found." });
          return;
        }

        const fd = fs.openSync(safePath, "r");
        const headerBuf = Buffer.alloc(16);
        fs.readSync(fd, headerBuf, 0, 16, 0);
        fs.closeSync(fd);
        if (!headerBuf.toString("utf8", 0, 15).startsWith("SQLite format 3")) {
          res.status(400).json({ detail: "Selected file is not a valid SQLite database backup." });
          return;
        }

        const currentDb = getDb();
        try {
          currentDb.close();
        } catch {
          // Ignore
        }

        for (const sidecar of [`${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
          if (fs.existsSync(sidecar)) {
            fs.rmSync(sidecar, { force: true });
          }
        }
        fs.copyFileSync(safePath, DB_PATH);
        const restoredDb = reopenDb();
        const stat = fs.statSync(safePath);

        restoredDb
          .prepare(
            "INSERT INTO backup_history (filename, operation_type, status, file_size_bytes, initiated_by, notes) VALUES (?, 'RESTORE', 'SUCCESS', ?, ?, ?)"
          )
          .run(filename, stat.size, req.authUser!.id, "Restored from Admin Console");

        logAuditEvent(req.authUser!.id, "DATABASE_RESTORED", "BACKUP", filename, null, { filename }, req);
        logSecurityEvent(req.authUser!.id, "DATABASE_RESTORED", req, `Restored snapshot: ${filename}`);

        res.json({ status: "restored", filename, restored_at: new Date().toISOString() });
      } catch (err) {
        res.status(400).json({ detail: err instanceof Error ? err.message : "Restore failed." });
      }
    }
  );

  return router;
}
