import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DATA_DIR = path.resolve(process.cwd(), "data");
export const BACKUP_DIR = path.resolve(process.cwd(), "backups");
export const DB_PATH = path.join(DATA_DIR, "banking_demo.db");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

let dbInstance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(DB_PATH);
    initializeSchema(dbInstance);
  }
  return dbInstance;
}

export function reopenDb(): DatabaseSync {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // Ignore close error on reopen
    }
    dbInstance = null;
  }
  return getDb();
}

export function runAtomic<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback error if not in transaction
    }
    throw err;
  }
}

export function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT NULL,
      last_login_at TEXT NULL,
      token_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      user_id INTEGER NOT NULL,
      role_id INTEGER NOT NULL,
      assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (user_id, role_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS customer_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      phone TEXT NULL,
      address_line1 TEXT NULL,
      address_line2 TEXT NULL,
      city TEXT NULL,
      state_province TEXT NULL,
      postal_code TEXT NULL,
      country TEXT NULL,
      date_of_birth TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      account_number TEXT NOT NULL UNIQUE,
      account_type TEXT NOT NULL DEFAULT 'CHECKING' CHECK (account_type IN ('CHECKING', 'SAVINGS')),
      currency TEXT NOT NULL DEFAULT 'USD',
      balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'FROZEN', 'CLOSED')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS beneficiaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      beneficiary_name TEXT NOT NULL,
      account_number TEXT NOT NULL,
      nickname TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (user_id, account_number),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reference_number TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NULL UNIQUE,
      transaction_type TEXT NOT NULL CHECK (transaction_type IN ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'REVERSAL')),
      source_account_id INTEGER NULL,
      destination_account_id INTEGER NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED', 'REVERSED')),
      description TEXT NULL,
      initiated_by_user_id INTEGER NOT NULL,
      related_transaction_id INTEGER NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (source_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
      FOREIGN KEY (destination_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
      FOREIGN KEY (initiated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
      FOREIGN KEY (related_transaction_id) REFERENCES transactions(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS transaction_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      entry_type TEXT NOT NULL CHECK (entry_type IN ('DEBIT', 'CREDIT')),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      balance_before_cents INTEGER NOT NULL CHECK (balance_before_cents >= 0),
      balance_after_cents INTEGER NOT NULL CHECK (balance_after_cents >= 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE RESTRICT,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS application_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      setting_key TEXT NOT NULL UNIQUE,
      setting_value TEXT NOT NULL,
      value_type TEXT NOT NULL CHECK (value_type IN ('DECIMAL', 'INT', 'BOOL', 'STRING')),
      description TEXT NULL,
      updated_by INTEGER NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS system_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL CHECK (level IN ('INFO', 'WARNING', 'ERROR')),
      service_name TEXT NOT NULL,
      endpoint TEXT NULL,
      http_method TEXT NULL,
      status_code INTEGER NULL,
      response_time_ms REAL NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS security_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NULL,
      event_type TEXT NOT NULL,
      ip_address TEXT NULL,
      user_agent TEXT NULL,
      details TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS backup_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      operation_type TEXT NOT NULL CHECK (operation_type IN ('BACKUP', 'RESTORE')),
      status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILED')),
      file_size_bytes INTEGER NULL,
      initiated_by INTEGER NOT NULL,
      notes TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (initiated_by) REFERENCES users(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER NULL,
      action TEXT NOT NULL,
      target_entity TEXT NOT NULL,
      target_id TEXT NULL,
      previous_value TEXT NULL,
      new_value TEXT NULL,
      ip_address TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
    CREATE INDEX IF NOT EXISTS idx_tx_src ON transactions(source_account_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tx_dst ON transactions(destination_account_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ledger_acct ON transaction_ledger(account_id, created_at);
  `);

  const insertRole = db.prepare("INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?)");
  insertRole.run("CUSTOMER", "Standard retail banking demo customer");
  insertRole.run("ADMIN", "Operations administrator for monitoring, settings, and support");
  insertRole.run("SUPER_ADMIN", "Privileged administrator for backups, restores, and security policies");

  const insertSetting = db.prepare(
    "INSERT OR IGNORE INTO application_settings (setting_key, setting_value, value_type, description) VALUES (?, ?, ?, ?)"
  );
  const defaults: Array<[string, string, string, string]> = [
    ["daily_transfer_limit", "10000.00", "DECIMAL", "Maximum cumulative daily transfer amount per account"],
    ["max_single_deposit", "25000.00", "DECIMAL", "Maximum single deposit amount"],
    ["max_single_withdrawal", "5000.00", "DECIMAL", "Maximum single withdrawal amount"],
    ["max_single_transfer", "10000.00", "DECIMAL", "Maximum single transfer amount"],
    ["min_password_length", "10", "INT", "Minimum required password length"],
    ["require_password_complexity", "true", "BOOL", "Require uppercase, lowercase, digit, and special character"],
    ["session_timeout_minutes", "15", "INT", "Access token lifetime in minutes"],
    ["max_failed_login_attempts", "5", "INT", "Consecutive failed logins before temporary lockout"],
    ["account_lockout_minutes", "15", "INT", "Temporary account lockout duration in minutes"],
  ];
  for (const row of defaults) {
    insertSetting.run(...row);
  }
}
