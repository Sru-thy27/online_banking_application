import React, { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Building2,
  DatabaseBackup,
  FileSearch,
  LogOut,
  Menu,
  RefreshCw,
  RotateCcw,
  Sliders,
  X,
} from "lucide-react";
import { apiRequest } from "../api.ts";
import type {
  AdminHealthResponse,
  AdminUserRecord,
  AppSetting,
  AuditLog,
  BackupFile,
  BackupHistoryRow,
  BankAccount,
  BankTransaction,
  SecurityLog,
  SystemLog,
  UserProfile,
} from "../types.ts";

type AdminTab = "operations" | "policies" | "logs" | "backups";
type LogSubTab = "security" | "audit" | "system";

type AdminDashboardProps = {
  user: UserProfile;
  onLogout: () => void;
};

export const AdminDashboard: React.FC<AdminDashboardProps> = ({ user, onLogout }) => {
  const [tab, setTab] = useState<AdminTab>("operations");
  const [logSubTab, setLogSubTab] = useState<LogSubTab>("security");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [health, setHealth] = useState<AdminHealthResponse | null>(null);
  const [users, setUsers] = useState<AdminUserRecord[]>([]);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [settings, setSettings] = useState<AppSetting[]>([]);
  const [policies, setPolicies] = useState<AppSetting[]>([]);
  const [securityLogs, setSecurityLogs] = useState<SecurityLog[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [systemLogs, setSystemLogs] = useState<SystemLog[]>([]);
  const [backupFiles, setBackupFiles] = useState<BackupFile[]>([]);
  const [backupHistory, setBackupHistory] = useState<BackupHistoryRow[]>([]);

  const [settingDrafts, setSettingDrafts] = useState<Record<string, string>>({});
  const [policyDrafts, setPolicyDrafts] = useState<Record<string, string>>({});

  const [reverseTxId, setReverseTxId] = useState("");
  const [reverseReason, setReverseReason] = useState("");
  const [backupNotes, setBackupNotes] = useState("");
  const [restoreConfirmTarget, setRestoreConfirmTarget] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const isSuperAdmin = user.roles.includes("SUPER_ADMIN");

  const loadAdminData = useCallback(async () => {
    setLoading(true);
    try {
      const [h, u, a, tx, s, p, sec, aud, sys, bkp] = await Promise.all([
        apiRequest<AdminHealthResponse>("/admin/health"),
        apiRequest<{ users: AdminUserRecord[] }>("/admin/users"),
        apiRequest<{ accounts: BankAccount[] }>("/admin/accounts"),
        apiRequest<{ transactions: BankTransaction[] }>("/transactions?limit=30"),
        apiRequest<{ settings: AppSetting[] }>("/admin/settings"),
        apiRequest<{ policies: AppSetting[] }>("/admin/security/policies"),
        apiRequest<{ logs: SecurityLog[] }>("/admin/logs/security?limit=60"),
        apiRequest<{ logs: AuditLog[] }>("/admin/logs/audit?limit=60"),
        apiRequest<{ logs: SystemLog[] }>("/admin/logs/system?limit=60"),
        apiRequest<{ files: BackupFile[]; history: BackupHistoryRow[] }>("/admin/backups"),
      ]);
      setHealth(h);
      setUsers(u.users);
      setAccounts(a.accounts);
      setTransactions(tx.transactions);
      setSettings(s.settings);
      setPolicies(p.policies);
      setSecurityLogs(sec.logs);
      setAuditLogs(aud.logs);
      setSystemLogs(sys.logs);
      setBackupFiles(bkp.files);
      setBackupHistory(bkp.history);

      const sDraft: Record<string, string> = {};
      for (const item of s.settings) sDraft[item.setting_key] = item.setting_value;
      setSettingDrafts(sDraft);

      const pDraft: Record<string, string> = {};
      for (const item of p.policies) pDraft[item.setting_key] = item.setting_value;
      setPolicyDrafts(pDraft);
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to load admin console data.",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAdminData();
  }, [loadAdminData]);

  async function handleUserAction(targetId: number, payload: { is_active?: boolean; unlock?: boolean }) {
    setBanner(null);
    try {
      await apiRequest(`/admin/users/${targetId}/status`, {
        method: "PATCH",
        body: payload,
      });
      setBanner({ kind: "success", text: `Updated user #${targetId} status.` });
      await loadAdminData();
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to update user.",
      });
    }
  }

  async function handleAccountStatus(accountId: number, status: "ACTIVE" | "FROZEN" | "CLOSED") {
    setBanner(null);
    try {
      await apiRequest(`/admin/accounts/${accountId}/status`, {
        method: "PATCH",
        body: { status },
      });
      setBanner({ kind: "success", text: `Account #${accountId} marked ${status}.` });
      await loadAdminData();
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to change account status.",
      });
    }
  }

  async function handleReverseTransaction(e: React.FormEvent) {
    e.preventDefault();
    setBanner(null);
    const id = Number(reverseTxId);
    if (!Number.isSafeInteger(id)) {
      setBanner({ kind: "error", text: "Enter a valid numeric transaction ID." });
      return;
    }
    try {
      const res = await apiRequest<{ reversal: BankTransaction }>(`/transactions/${id}/reverse`, {
        method: "POST",
        body: { reason: reverseReason || "Administrator reversal" },
      });
      setReverseTxId("");
      setReverseReason("");
      setBanner({
        kind: "success",
        text: `Transaction #${id} reversed (${res.reversal.reference_number}).`,
      });
      await loadAdminData();
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Reversal failed.",
      });
    }
  }

  async function handleSaveSetting(key: string) {
    setBanner(null);
    try {
      await apiRequest(`/admin/settings/${key}`, {
        method: "PUT",
        body: { setting_value: settingDrafts[key] },
      });
      setBanner({ kind: "success", text: `Updated limit ${key}.` });
      await loadAdminData();
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to save setting.",
      });
    }
  }

  async function handleSaveSecurityPolicies(e: React.FormEvent) {
    e.preventDefault();
    setBanner(null);
    try {
      await apiRequest("/admin/security/policies", {
        method: "PUT",
        body: {
          min_password_length: Number(policyDrafts.min_password_length),
          require_password_complexity: policyDrafts.require_password_complexity === "true",
          session_timeout_minutes: Number(policyDrafts.session_timeout_minutes),
          max_failed_login_attempts: Number(policyDrafts.max_failed_login_attempts),
          account_lockout_minutes: Number(policyDrafts.account_lockout_minutes),
        },
      });
      setBanner({ kind: "success", text: "Security policies updated." });
      await loadAdminData();
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to update security policies.",
      });
    }
  }

  async function handleCreateBackup(e: React.FormEvent) {
    e.preventDefault();
    setBanner(null);
    try {
      const res = await apiRequest<{ filename: string; size_bytes: number }>("/admin/backups", {
        method: "POST",
        body: { notes: backupNotes || "Manual administrator snapshot" },
      });
      setBackupNotes("");
      setBanner({
        kind: "success",
        text: `Backup created: ${res.filename} (${res.size_bytes.toLocaleString()} bytes).`,
      });
      await loadAdminData();
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Backup failed.",
      });
    }
  }

  async function handleConfirmRestore() {
    if (!restoreConfirmTarget) return;
    const filename = restoreConfirmTarget;
    setRestoreConfirmTarget(null);
    setBanner(null);
    try {
      await apiRequest("/admin/backups/restore", {
        method: "POST",
        body: { filename, confirm_restore: true },
      });
      setBanner({ kind: "success", text: `Database restored from ${filename}.` });
      await loadAdminData();
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Restore failed.",
      });
    }
  }

  const navItems: Array<{ id: AdminTab; label: string; icon: React.ReactNode }> = [
    { id: "operations", label: "Operations & Health", icon: <Activity className="w-4 h-4" /> },
    { id: "policies", label: "Limits & Security", icon: <Sliders className="w-4 h-4" /> },
    { id: "logs", label: "Audit & Logs", icon: <FileSearch className="w-4 h-4" /> },
    { id: "backups", label: "Backups & Restore", icon: <DatabaseBackup className="w-4 h-4" /> },
  ];

  const sidebarContent = (
    <div className="flex flex-col h-full bg-[#0A2540] text-white">
      <div className="px-6 py-5 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#2563EB] flex items-center justify-center shrink-0">
            <Building2 className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">Online Banking Demo</div>
            <div className="text-[11px] text-[#93C5FD]">Administrator Console</div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setMobileMenuOpen(false)}
          className="lg:hidden text-slate-300 hover:text-white cursor-pointer"
          aria-label="Close navigation"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <nav className="flex-1 px-3 py-5 space-y-1">
        {navItems.map((item) => {
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setTab(item.id);
                setMobileMenuOpen(false);
                setBanner(null);
              }}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer whitespace-nowrap ${
                active
                  ? "bg-[#2563EB] text-white"
                  : "text-slate-300 hover:bg-white/10 hover:text-white"
              }`}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="p-4 border-t border-white/10 text-xs text-slate-300 space-y-1">
        <div className="font-medium text-white truncate">{user.username}</div>
        <div className="text-[#93C5FD] text-[11px] font-mono">{user.roles.join(" · ")}</div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex">
      <aside className="hidden lg:block w-[260px] shrink-0">{sidebarContent}</aside>

      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div className="w-[260px] h-full shadow-xl">{sidebarContent}</div>
          <div className="flex-1 bg-slate-900/40" onClick={() => setMobileMenuOpen(false)} />
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="bg-white border-b border-slate-200 px-5 sm:px-8 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-1.5 rounded-md border border-slate-200 text-slate-700 cursor-pointer"
              aria-label="Open navigation"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-lg font-semibold text-[#0F172A]">
                {navItems.find((n) => n.id === tab)?.label}
              </h1>
              <p className="text-xs text-slate-500">
                Privileged Operations · {user.roles.join(", ")}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={loadAdminData}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#0A2540] hover:bg-[#13385E] text-white text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign Out
            </button>
          </div>
        </header>

        <main className="flex-1 p-5 sm:p-8 max-w-[1320px] w-full mx-auto space-y-6">
          {banner && (
            <div
              className={`rounded-lg px-4 py-3 text-sm border ${
                banner.kind === "success"
                  ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                  : "bg-red-50 border-red-200 text-red-700"
              }`}
            >
              {banner.text}
            </div>
          )}

          {loading ? (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-sm text-slate-500">
              Loading administrator console...
            </div>
          ) : (
            <>
              {tab === "operations" && health && (
                <div className="space-y-6">
                  {/* KPI Summary Row */}
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <div className="bg-white border border-slate-200 rounded-xl p-5">
                      <div className="text-xs text-slate-500">Database Status</div>
                      <div className="text-lg font-semibold text-emerald-700 mt-1 uppercase">
                        {health.database}
                      </div>
                      <div className="text-xs font-mono text-slate-500 mt-1">
                        Avg Latency {health.metrics.avg_latency_ms} ms
                      </div>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-xl p-5">
                      <div className="text-xs text-slate-500">Total Ledger Balances</div>
                      <div className="text-lg font-semibold font-mono text-[#0A2540] mt-1">
                        ${Number(health.metrics.total_balance_dollars).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                      </div>
                      <div className="text-xs font-mono text-slate-500 mt-1">
                        {health.metrics.total_accounts} accounts
                      </div>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-xl p-5">
                      <div className="text-xs text-slate-500">Users & Transactions</div>
                      <div className="text-lg font-semibold font-mono text-[#0F172A] mt-1">
                        {health.metrics.total_users} / {health.metrics.total_transactions}
                      </div>
                      <div className="text-xs font-mono text-slate-500 mt-1">
                        {health.metrics.total_requests} API requests logged
                      </div>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-xl p-5">
                      <div className="text-xs text-slate-500">Server Errors (5xx)</div>
                      <div
                        className={`text-lg font-semibold font-mono mt-1 ${
                          health.metrics.error_count > 0 ? "text-red-700" : "text-emerald-700"
                        }`}
                      >
                        {health.metrics.error_count}
                      </div>
                      <div className="text-xs font-mono text-slate-500 mt-1">
                        Max Latency {health.metrics.max_latency_ms} ms
                      </div>
                    </div>
                  </div>

                  {/* Authorized Transaction Reversal + Recent Transactions */}
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                    <form
                      onSubmit={handleReverseTransaction}
                      className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-4 self-start"
                    >
                      <div>
                        <h2 className="text-sm font-semibold text-[#0F172A] flex items-center gap-2">
                          <RotateCcw className="w-4 h-4 text-[#2563EB]" />
                          Transaction Reversal
                        </h2>
                        <p className="text-xs text-slate-500 mt-1">
                          Creates an offsetting REVERSAL entry and marks the original COMPLETED transaction REVERSED.
                        </p>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Transaction ID
                        </label>
                        <input
                          type="number"
                          required
                          value={reverseTxId}
                          onChange={(e) => setReverseTxId(e.target.value)}
                          placeholder="e.g. 1"
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Audit Reason
                        </label>
                        <input
                          type="text"
                          required
                          value={reverseReason}
                          onChange={(e) => setReverseReason(e.target.value)}
                          placeholder="Duplicate or disputed entry"
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        />
                      </div>
                      <button
                        type="submit"
                        className="w-full rounded-lg bg-[#0A2540] hover:bg-[#13385E] text-white text-xs font-medium py-2.5 cursor-pointer"
                      >
                        Execute Authorized Reversal
                      </button>
                    </form>

                    <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden self-start">
                      <div className="px-5 py-4 border-b border-slate-200">
                        <h2 className="text-sm font-semibold text-[#0F172A]">
                          Recent System Transactions
                        </h2>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                            <tr>
                              <th className="py-2.5 px-4 font-semibold">ID</th>
                              <th className="py-2.5 px-4 font-semibold">Reference</th>
                              <th className="py-2.5 px-4 font-semibold">Type</th>
                              <th className="py-2.5 px-4 font-semibold text-right">Amount</th>
                              <th className="py-2.5 px-4 font-semibold">Status</th>
                              <th className="py-2.5 px-4 font-semibold">Action</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {transactions.length === 0 ? (
                              <tr>
                                <td colSpan={6} className="py-6 px-4 text-slate-500 text-center">
                                  No transactions recorded yet.
                                </td>
                              </tr>
                            ) : (
                              transactions.slice(0, 12).map((tx) => (
                                <tr key={tx.id}>
                                  <td className="py-2.5 px-4 font-mono text-slate-600">{tx.id}</td>
                                  <td className="py-2.5 px-4 font-mono text-slate-800 whitespace-nowrap">
                                    {tx.reference_number}
                                  </td>
                                  <td className="py-2.5 px-4 text-slate-800">{tx.transaction_type}</td>
                                  <td className="py-2.5 px-4 font-mono font-semibold text-right">
                                    ${tx.amount}
                                  </td>
                                  <td className="py-2.5 px-4 font-semibold">
                                    <span
                                      className={
                                        tx.status === "COMPLETED"
                                          ? "text-emerald-700"
                                          : tx.status === "REVERSED"
                                            ? "text-amber-700"
                                            : "text-red-700"
                                      }
                                    >
                                      {tx.status}
                                    </span>
                                  </td>
                                  <td className="py-2.5 px-4">
                                    {tx.status === "COMPLETED" && tx.transaction_type !== "REVERSAL" ? (
                                      <button
                                        type="button"
                                        onClick={() => setReverseTxId(String(tx.id))}
                                        className="text-[#2563EB] hover:underline font-medium cursor-pointer"
                                      >
                                        Select
                                      </button>
                                    ) : (
                                      <span className="text-slate-400">—</span>
                                    )}
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>

                  {/* Accounts Control */}
                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                    <div className="px-5 py-4 border-b border-slate-200">
                      <h2 className="text-sm font-semibold text-[#0F172A]">Customer Accounts Control</h2>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                          <tr>
                            <th className="py-3 px-4 font-semibold">Account #</th>
                            <th className="py-3 px-4 font-semibold">Owner</th>
                            <th className="py-3 px-4 font-semibold">Type</th>
                            <th className="py-3 px-4 font-semibold text-right">Balance</th>
                            <th className="py-3 px-4 font-semibold">Status</th>
                            <th className="py-3 px-4 font-semibold">Controls</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {accounts.length === 0 ? (
                            <tr>
                              <td colSpan={6} className="py-6 px-4 text-slate-500 text-center">
                                No customer accounts opened yet.
                              </td>
                            </tr>
                          ) : (
                            accounts.map((a) => (
                              <tr key={a.id}>
                                <td className="py-3 px-4 font-mono text-slate-900">#{a.account_number}</td>
                                <td className="py-3 px-4 text-slate-700">
                                  {a.username} ({a.email})
                                </td>
                                <td className="py-3 px-4 text-slate-700">{a.account_type}</td>
                                <td className="py-3 px-4 font-mono font-semibold text-right">
                                  ${a.balance}
                                </td>
                                <td className="py-3 px-4 font-semibold">
                                  <span
                                    className={
                                      a.status === "ACTIVE"
                                        ? "text-emerald-700"
                                        : a.status === "FROZEN"
                                          ? "text-amber-700"
                                          : "text-red-700"
                                    }
                                  >
                                    {a.status}
                                  </span>
                                </td>
                                <td className="py-3 px-4 space-x-2 whitespace-nowrap">
                                  {a.status !== "ACTIVE" && (
                                    <button
                                      type="button"
                                      onClick={() => handleAccountStatus(a.id, "ACTIVE")}
                                      className="text-emerald-700 hover:underline font-medium cursor-pointer"
                                    >
                                      Activate
                                    </button>
                                  )}
                                  {a.status !== "FROZEN" && (
                                    <button
                                      type="button"
                                      onClick={() => handleAccountStatus(a.id, "FROZEN")}
                                      className="text-amber-700 hover:underline font-medium cursor-pointer"
                                    >
                                      Freeze
                                    </button>
                                  )}
                                  {a.status !== "CLOSED" && (
                                    <button
                                      type="button"
                                      onClick={() => handleAccountStatus(a.id, "CLOSED")}
                                      className="text-red-700 hover:underline font-medium cursor-pointer"
                                    >
                                      Close
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Users Control */}
                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                    <div className="px-5 py-4 border-b border-slate-200">
                      <h2 className="text-sm font-semibold text-[#0F172A]">User Accounts & Lockout Control</h2>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                          <tr>
                            <th className="py-3 px-4 font-semibold">ID</th>
                            <th className="py-3 px-4 font-semibold">Username</th>
                            <th className="py-3 px-4 font-semibold">Email</th>
                            <th className="py-3 px-4 font-semibold">Roles</th>
                            <th className="py-3 px-4 font-semibold">Status</th>
                            <th className="py-3 px-4 font-semibold">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {users.map((u) => {
                            const isLocked =
                              Boolean(u.locked_until) &&
                              new Date(u.locked_until!).getTime() > Date.now();
                            return (
                              <tr key={u.id}>
                                <td className="py-3 px-4 font-mono">{u.id}</td>
                                <td className="py-3 px-4 font-medium text-slate-900">{u.username}</td>
                                <td className="py-3 px-4 text-slate-600">{u.email}</td>
                                <td className="py-3 px-4 font-mono text-slate-700">{u.roles.join(", ")}</td>
                                <td className="py-3 px-4 font-semibold">
                                  {!u.is_active ? (
                                    <span className="text-red-700">DISABLED</span>
                                  ) : isLocked ? (
                                    <span className="text-amber-700">LOCKED</span>
                                  ) : (
                                    <span className="text-emerald-700">ACTIVE</span>
                                  )}
                                </td>
                                <td className="py-3 px-4 space-x-3 whitespace-nowrap">
                                  {u.id !== user.id && (
                                    <button
                                      type="button"
                                      onClick={() => handleUserAction(u.id, { is_active: !u.is_active })}
                                      className="text-[#2563EB] hover:underline font-medium cursor-pointer"
                                    >
                                      {u.is_active ? "Disable" : "Enable"}
                                    </button>
                                  )}
                                  {(isLocked || u.failed_login_attempts > 0) && (
                                    <button
                                      type="button"
                                      onClick={() => handleUserAction(u.id, { is_active: true, unlock: true })}
                                      className="text-emerald-700 hover:underline font-medium cursor-pointer"
                                    >
                                      Unlock
                                    </button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Auxiliary Simulated Notifications */}
                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                    <div className="px-5 py-4 border-b border-slate-200">
                      <h2 className="text-sm font-semibold text-[#0F172A]">
                        Simulated Auxiliary Notifications (Non-Authoritative)
                      </h2>
                    </div>
                    {health.recent_notifications.length === 0 ? (
                      <div className="p-5 text-xs text-slate-500">
                        No simulated notifications dispatched in this server session yet.
                      </div>
                    ) : (
                      <div className="divide-y divide-slate-100 text-xs">
                        {health.recent_notifications.slice(0, 10).map((n) => (
                          <div key={n.id} className="px-5 py-3 flex items-center justify-between gap-4">
                            <div>
                              <span className="font-mono font-semibold text-[#0A2540]">{n.event}</span>{" "}
                              <span className="text-slate-700">· {n.summary}</span>
                            </div>
                            <div className="font-mono text-slate-500 whitespace-nowrap">
                              {n.recipient_masked}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {tab === "policies" && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Operational Transaction Limits */}
                  <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                    <div>
                      <h2 className="text-base font-semibold text-[#0F172A]">
                        Operational Transaction Limits (USD)
                      </h2>
                      <p className="text-xs text-slate-500 mt-1">
                        Enforced immediately on deposits, withdrawals, and transfers.
                      </p>
                    </div>
                    <div className="space-y-4">
                      {settings.map((s) => (
                        <div key={s.setting_key} className="border-b border-slate-100 pb-4 last:border-0 last:pb-0">
                          <div className="text-xs font-semibold text-slate-800 font-mono">
                            {s.setting_key}
                          </div>
                          <div className="text-xs text-slate-500 mb-2">{s.description}</div>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={settingDrafts[s.setting_key] ?? ""}
                              onChange={(e) =>
                                setSettingDrafts((prev) => ({
                                  ...prev,
                                  [s.setting_key]: e.target.value,
                                }))
                              }
                              className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                            />
                            <button
                              type="button"
                              onClick={() => handleSaveSetting(s.setting_key)}
                              className="rounded-lg bg-[#0A2540] hover:bg-[#13385E] text-white text-xs font-medium px-4 py-1.5 cursor-pointer"
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Security Policies (SUPER_ADMIN editable) */}
                  <form
                    onSubmit={handleSaveSecurityPolicies}
                    className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 self-start"
                  >
                    <div>
                      <h2 className="text-base font-semibold text-[#0F172A]">Security Policies</h2>
                      <p className="text-xs text-slate-500 mt-1">
                        {isSuperAdmin
                          ? "Manage password complexity, session TTL, and failed-login lockout thresholds."
                          : "Read-only view. SUPER_ADMIN role required to update security policies."}
                      </p>
                    </div>

                    <div className="space-y-3">
                      {policies.map((p) => (
                        <div key={p.setting_key}>
                          <label className="block text-xs font-semibold font-mono text-slate-800 mb-1">
                            {p.setting_key}
                          </label>
                          <p className="text-[11px] text-slate-500 mb-1">{p.description}</p>
                          {p.value_type === "BOOL" ? (
                            <select
                              disabled={!isSuperAdmin}
                              value={policyDrafts[p.setting_key] ?? "true"}
                              onChange={(e) =>
                                setPolicyDrafts((prev) => ({
                                  ...prev,
                                  [p.setting_key]: e.target.value,
                                }))
                              }
                              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white disabled:bg-slate-100"
                            >
                              <option value="true">Enabled (true)</option>
                              <option value="false">Disabled (false)</option>
                            </select>
                          ) : (
                            <input
                              type="number"
                              disabled={!isSuperAdmin}
                              value={policyDrafts[p.setting_key] ?? ""}
                              onChange={(e) =>
                                setPolicyDrafts((prev) => ({
                                  ...prev,
                                  [p.setting_key]: e.target.value,
                                }))
                              }
                              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono disabled:bg-slate-100"
                            />
                          )}
                        </div>
                      ))}
                    </div>

                    {isSuperAdmin && (
                      <button
                        type="submit"
                        className="w-full rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-sm font-medium py-2.5 cursor-pointer"
                      >
                        Update Security Policies
                      </button>
                    )}
                  </form>
                </div>
              )}

              {tab === "logs" && (
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex gap-1 bg-slate-100 p-1 rounded-lg text-xs font-medium">
                      {(["security", "audit", "system"] as const).map((sub) => (
                        <button
                          key={sub}
                          type="button"
                          onClick={() => setLogSubTab(sub)}
                          className={`px-3 py-1.5 rounded-md capitalize cursor-pointer ${
                            logSubTab === sub
                              ? "bg-[#0A2540] text-white font-semibold"
                              : "text-slate-600 hover:text-[#0A2540]"
                          }`}
                        >
                          {sub} Logs
                        </button>
                      ))}
                    </div>
                  </div>

                  {logSubTab === "security" && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                          <tr>
                            <th className="py-3 px-4 font-semibold">Timestamp</th>
                            <th className="py-3 px-4 font-semibold">Event</th>
                            <th className="py-3 px-4 font-semibold">User</th>
                            <th className="py-3 px-4 font-semibold">IP</th>
                            <th className="py-3 px-4 font-semibold">Details</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {securityLogs.map((l) => (
                            <tr key={l.id}>
                              <td className="py-2.5 px-4 font-mono text-slate-600 whitespace-nowrap">
                                {l.created_at.slice(0, 19).replace("T", " ")}
                              </td>
                              <td className="py-2.5 px-4 font-mono font-semibold text-[#0A2540]">
                                {l.event_type}
                              </td>
                              <td className="py-2.5 px-4 text-slate-700">{l.username || "-"}</td>
                              <td className="py-2.5 px-4 font-mono text-slate-600">{l.ip_address}</td>
                              <td className="py-2.5 px-4 text-slate-600">{l.details}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {logSubTab === "audit" && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                          <tr>
                            <th className="py-3 px-4 font-semibold">Timestamp</th>
                            <th className="py-3 px-4 font-semibold">Actor</th>
                            <th className="py-3 px-4 font-semibold">Action</th>
                            <th className="py-3 px-4 font-semibold">Target</th>
                            <th className="py-3 px-4 font-semibold">New Value</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {auditLogs.map((l) => (
                            <tr key={l.id}>
                              <td className="py-2.5 px-4 font-mono text-slate-600 whitespace-nowrap">
                                {l.created_at.slice(0, 19).replace("T", " ")}
                              </td>
                              <td className="py-2.5 px-4 text-slate-800">{l.actor_username || "-"}</td>
                              <td className="py-2.5 px-4 font-mono font-semibold text-[#0A2540]">
                                {l.action}
                              </td>
                              <td className="py-2.5 px-4 font-mono text-slate-700">
                                {l.target_entity} #{l.target_id}
                              </td>
                              <td className="py-2.5 px-4 font-mono text-slate-600 max-w-[320px] truncate">
                                {l.new_value || "-"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {logSubTab === "system" && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                          <tr>
                            <th className="py-3 px-4 font-semibold">Timestamp</th>
                            <th className="py-3 px-4 font-semibold">Level</th>
                            <th className="py-3 px-4 font-semibold">Method & Endpoint</th>
                            <th className="py-3 px-4 font-semibold">Status</th>
                            <th className="py-3 px-4 font-semibold text-right">Latency</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {systemLogs.map((l) => (
                            <tr key={l.id}>
                              <td className="py-2.5 px-4 font-mono text-slate-600 whitespace-nowrap">
                                {l.created_at.slice(0, 19).replace("T", " ")}
                              </td>
                              <td className="py-2.5 px-4 font-semibold">
                                <span
                                  className={
                                    l.level === "ERROR"
                                      ? "text-red-700"
                                      : l.level === "WARNING"
                                        ? "text-amber-700"
                                        : "text-slate-700"
                                  }
                                >
                                  {l.level}
                                </span>
                              </td>
                              <td className="py-2.5 px-4 font-mono text-slate-800">
                                {l.http_method} {l.endpoint}
                              </td>
                              <td className="py-2.5 px-4 font-mono">{l.status_code}</td>
                              <td className="py-2.5 px-4 font-mono text-right">
                                {l.response_time_ms} ms
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {tab === "backups" && (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                    <form
                      onSubmit={handleCreateBackup}
                      className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-6 space-y-4 self-start"
                    >
                      <div>
                        <h2 className="text-base font-semibold text-[#0F172A]">Create Snapshot</h2>
                        <p className="text-xs text-slate-500 mt-1">
                          Creates a consistent SQLite snapshot inside <span className="font-mono">backups/</span>.
                        </p>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">Notes</label>
                        <input
                          type="text"
                          value={backupNotes}
                          onChange={(e) => setBackupNotes(e.target.value)}
                          placeholder="Pre-change checkpoint"
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={!isSuperAdmin}
                        className="w-full rounded-lg bg-[#0A2540] hover:bg-[#13385E] disabled:opacity-50 text-white text-sm font-medium py-2.5 cursor-pointer"
                      >
                        {isSuperAdmin ? "Create Database Backup" : "SUPER_ADMIN Required"}
                      </button>
                    </form>

                    <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden self-start">
                      <div className="px-5 py-4 border-b border-slate-200">
                        <h2 className="text-sm font-semibold text-[#0F172A]">Available Backup Snapshots</h2>
                      </div>
                      {backupFiles.length === 0 ? (
                        <div className="p-6 text-sm text-slate-500">
                          No backup files created yet.
                        </div>
                      ) : (
                        <div className="divide-y divide-slate-100 text-xs">
                          {backupFiles.map((f) => (
                            <div key={f.filename} className="px-5 py-3.5 flex items-center justify-between gap-4">
                              <div>
                                <div className="font-mono font-semibold text-slate-900">{f.filename}</div>
                                <div className="font-mono text-slate-500 mt-0.5">
                                  {(f.size_bytes / 1024).toFixed(1)} KB · {f.modified_at.slice(0, 19).replace("T", " ")} UTC
                                </div>
                              </div>
                              {isSuperAdmin && (
                                <button
                                  type="button"
                                  onClick={() => setRestoreConfirmTarget(f.filename)}
                                  className="px-3 py-1.5 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 font-medium cursor-pointer"
                                >
                                  Restore
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                    <div className="px-5 py-4 border-b border-slate-200">
                      <h2 className="text-sm font-semibold text-[#0F172A]">Backup & Restore Audit History</h2>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                          <tr>
                            <th className="py-3 px-4 font-semibold">Timestamp</th>
                            <th className="py-3 px-4 font-semibold">Operation</th>
                            <th className="py-3 px-4 font-semibold">Filename</th>
                            <th className="py-3 px-4 font-semibold">Actor</th>
                            <th className="py-3 px-4 font-semibold">Notes</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {backupHistory.length === 0 ? (
                            <tr>
                              <td colSpan={5} className="py-6 px-4 text-slate-500 text-center">
                                No backup or restore operations recorded yet.
                              </td>
                            </tr>
                          ) : (
                            backupHistory.map((h) => (
                              <tr key={h.id}>
                                <td className="py-2.5 px-4 font-mono text-slate-600">
                                  {h.created_at.slice(0, 19).replace("T", " ")}
                                </td>
                                <td className="py-2.5 px-4 font-semibold text-[#0A2540]">
                                  {h.operation_type} · {h.status}
                                </td>
                                <td className="py-2.5 px-4 font-mono text-slate-800">{h.filename}</td>
                                <td className="py-2.5 px-4 text-slate-700">{h.initiated_by_username}</td>
                                <td className="py-2.5 px-4 text-slate-600">{h.notes || "-"}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {/* Restore Confirmation Modal */}
      {restoreConfirmTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6 space-y-4 shadow-xl">
            <h3 className="text-base font-semibold text-[#0F172A]">Confirm Database Restore</h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              Restoring snapshot{" "}
              <span className="font-mono font-semibold text-slate-900">{restoreConfirmTarget}</span>{" "}
              replaces the active SQLite database state with the selected snapshot.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setRestoreConfirmTarget(null)}
                className="px-4 py-2 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmRestore}
                className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-medium cursor-pointer"
              >
                Confirm Restore
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
