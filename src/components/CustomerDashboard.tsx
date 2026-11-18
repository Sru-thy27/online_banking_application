import React, { useCallback, useEffect, useState } from "react";
import {
  ArrowLeftRight,
  Building2,
  CheckCircle2,
  FileDown,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  UserCog,
  Users,
  X,
} from "lucide-react";
import { apiRequest, downloadStatementPdf, setSessionTokens } from "../api.ts";
import type {
  BankAccount,
  BankTransaction,
  Beneficiary,
  CustomerDetails,
  ReconcileResult,
  StatementSummary,
  UserProfile,
} from "../types.ts";

type CustomerTab = "overview" | "transfers" | "beneficiaries" | "statements" | "profile";

type CustomerDashboardProps = {
  user: UserProfile;
  initialProfile: CustomerDetails | null;
  onLogout: () => void;
};

export const CustomerDashboard: React.FC<CustomerDashboardProps> = ({
  user,
  initialProfile,
  onLogout,
}) => {
  const [tab, setTab] = useState<CustomerTab>("overview");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([]);
  const [profile, setProfile] = useState<CustomerDetails | null>(initialProfile);

  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [reconcileResult, setReconcileResult] = useState<ReconcileResult | null>(null);

  // Transaction form state
  const [txMode, setTxMode] = useState<"TRANSFER" | "DEPOSIT" | "WITHDRAWAL">("TRANSFER");
  const [selectedAccountId, setSelectedAccountId] = useState<number | "">("");
  const [destAccountNumber, setDestAccountNumber] = useState("");
  const [txAmount, setTxAmount] = useState("");
  const [txDescription, setTxDescription] = useState("");
  const [txSubmitting, setTxSubmitting] = useState(false);

  // Transaction filters
  const [filterType, setFilterType] = useState("");
  const [filterStart, setFilterStart] = useState("");
  const [filterEnd, setFilterEnd] = useState("");

  // Beneficiary form
  const [benName, setBenName] = useState("");
  const [benAccountNum, setBenAccountNum] = useState("");
  const [benNickname, setBenNickname] = useState("");

  // Statement state
  const todayStr = new Date().toISOString().slice(0, 10);
  const thirtyAgoStr = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const [stmtAccountId, setStmtAccountId] = useState<number | "">("");
  const [stmtStart, setStmtStart] = useState(thirtyAgoStr);
  const [stmtEnd, setStmtEnd] = useState(todayStr);
  const [statementSummary, setStatementSummary] = useState<StatementSummary | null>(null);
  const [stmtLoading, setStmtLoading] = useState(false);

  // Profile & password state
  const [firstName, setFirstName] = useState(initialProfile?.first_name || "");
  const [lastName, setLastName] = useState(initialProfile?.last_name || "");
  const [phone, setPhone] = useState(initialProfile?.phone || "");
  const [address1, setAddress1] = useState(initialProfile?.address_line1 || "");
  const [city, setCity] = useState(initialProfile?.city || "");
  const [stateProv, setStateProv] = useState(initialProfile?.state_province || "");
  const [postalCode, setPostalCode] = useState(initialProfile?.postal_code || "");
  const [country, setCountry] = useState(initialProfile?.country || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const loadWorkspaceData = useCallback(async () => {
    setLoading(true);
    try {
      const [acctRes, benRes, txRes] = await Promise.all([
        apiRequest<{ accounts: BankAccount[] }>("/accounts"),
        apiRequest<{ beneficiaries: Beneficiary[] }>("/beneficiaries"),
        apiRequest<{ transactions: BankTransaction[] }>("/transactions?limit=50"),
      ]);
      setAccounts(acctRes.accounts);
      setBeneficiaries(benRes.beneficiaries);
      setTransactions(txRes.transactions);
      if (acctRes.accounts.length > 0) {
        setSelectedAccountId((prev) => (prev === "" ? acctRes.accounts[0].id : prev));
        setStmtAccountId((prev) => (prev === "" ? acctRes.accounts[0].id : prev));
      }
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to load account data.",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWorkspaceData();
  }, [loadWorkspaceData]);

  const loadFilteredTransactions = useCallback(async () => {
    const params = new URLSearchParams({ limit: "80" });
    if (filterType) params.set("transaction_type", filterType);
    if (filterStart) params.set("start_date", filterStart);
    if (filterEnd) params.set("end_date", filterEnd);
    try {
      const res = await apiRequest<{ transactions: BankTransaction[] }>(
        `/transactions?${params.toString()}`
      );
      setTransactions(res.transactions);
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to filter transactions.",
      });
    }
  }, [filterType, filterStart, filterEnd]);

  const totalBalanceCents = accounts.reduce((sum, a) => sum + a.balance_cents, 0);
  const formatCents = (cents: number) =>
    `$${(cents / 100).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  async function handleOpenAccount(accountType: "CHECKING" | "SAVINGS") {
    setBanner(null);
    try {
      const res = await apiRequest<{ account: BankAccount }>("/accounts", {
        method: "POST",
        body: { account_type: accountType },
      });
      setBanner({
        kind: "success",
        text: `Opened new ${res.account.account_type} account #${res.account.account_number}.`,
      });
      await loadWorkspaceData();
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Could not open account.",
      });
    }
  }

  async function handleReconcile(accountId: number) {
    setBanner(null);
    try {
      const res = await apiRequest<ReconcileResult>(`/accounts/${accountId}/reconcile`);
      setReconcileResult(res);
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Reconciliation failed.",
      });
    }
  }

  async function handleTransactionSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (selectedAccountId === "") return;
    setBanner(null);
    setTxSubmitting(true);
    const idempotencyKey = crypto.randomUUID();
    try {
      if (txMode === "DEPOSIT") {
        const res = await apiRequest<{ transaction: BankTransaction }>("/transactions/deposit", {
          method: "POST",
          idempotencyKey,
          body: {
            account_id: selectedAccountId,
            amount: txAmount,
            description: txDescription || "Customer Deposit",
          },
        });
        setBanner({
          kind: "success",
          text: `Deposit completed (${res.transaction.reference_number}) for $${res.transaction.amount}.`,
        });
      } else if (txMode === "WITHDRAWAL") {
        const res = await apiRequest<{ transaction: BankTransaction }>("/transactions/withdraw", {
          method: "POST",
          idempotencyKey,
          body: {
            account_id: selectedAccountId,
            amount: txAmount,
            description: txDescription || "Customer Withdrawal",
          },
        });
        setBanner({
          kind: "success",
          text: `Withdrawal completed (${res.transaction.reference_number}) for $${res.transaction.amount}.`,
        });
      } else {
        const res = await apiRequest<{ transaction: BankTransaction }>("/transactions/transfer", {
          method: "POST",
          idempotencyKey,
          body: {
            source_account_id: selectedAccountId,
            destination_account_number: destAccountNumber.trim(),
            amount: txAmount,
            description: txDescription || "Funds Transfer",
          },
        });
        setBanner({
          kind: "success",
          text: `Transfer completed (${res.transaction.reference_number}) for $${res.transaction.amount}.`,
        });
      }
      setTxAmount("");
      setTxDescription("");
      await loadWorkspaceData();
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Transaction failed.",
      });
    } finally {
      setTxSubmitting(false);
    }
  }

  async function handleAddBeneficiary(e: React.FormEvent) {
    e.preventDefault();
    setBanner(null);
    try {
      await apiRequest<{ beneficiary: Beneficiary }>("/beneficiaries", {
        method: "POST",
        body: {
          beneficiary_name: benName,
          account_number: benAccountNum,
          nickname: benNickname || null,
        },
      });
      setBenName("");
      setBenAccountNum("");
      setBenNickname("");
      setBanner({ kind: "success", text: "Beneficiary saved." });
      await loadWorkspaceData();
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to save beneficiary.",
      });
    }
  }

  async function handleDeleteBeneficiary(id: number) {
    setBanner(null);
    try {
      await apiRequest(`/beneficiaries/${id}`, { method: "DELETE" });
      setBanner({ kind: "success", text: "Beneficiary removed." });
      await loadWorkspaceData();
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to delete beneficiary.",
      });
    }
  }

  async function handlePreviewStatement(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (stmtAccountId === "") return;
    setStmtLoading(true);
    setBanner(null);
    try {
      const params = new URLSearchParams({ start_date: stmtStart, end_date: stmtEnd });
      const res = await apiRequest<{ statement: StatementSummary }>(
        `/statements/${stmtAccountId}/summary?${params.toString()}`
      );
      setStatementSummary(res.statement);
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to generate statement summary.",
      });
    } finally {
      setStmtLoading(false);
    }
  }

  async function handleDownloadPdf() {
    if (stmtAccountId === "") return;
    const acct = accounts.find((a) => a.id === stmtAccountId);
    if (!acct) return;
    setBanner(null);
    try {
      await downloadStatementPdf(acct.id, stmtStart, stmtEnd, acct.account_number);
      setBanner({ kind: "success", text: "PDF statement downloaded." });
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "PDF download failed.",
      });
    }
  }

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setBanner(null);
    try {
      const res = await apiRequest<{ profile: CustomerDetails }>("/customers/profile", {
        method: "PUT",
        body: {
          first_name: firstName,
          last_name: lastName,
          phone,
          address_line1: address1,
          city,
          state_province: stateProv,
          postal_code: postalCode,
          country,
        },
      });
      setProfile(res.profile);
      setBanner({ kind: "success", text: "Customer profile updated." });
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to update profile.",
      });
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setBanner(null);
    try {
      const res = await apiRequest<{ access_token: string; csrf_token: string }>(
        "/auth/change-password",
        {
          method: "POST",
          body: {
            current_password: currentPassword,
            new_password: newPassword,
          },
        }
      );
      setSessionTokens(res.access_token, res.csrf_token);
      setCurrentPassword("");
      setNewPassword("");
      setBanner({ kind: "success", text: "Password updated and prior session tokens invalidated." });
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Password change failed.",
      });
    }
  }

  const navItems: Array<{ id: CustomerTab; label: string; icon: React.ReactNode }> = [
    { id: "overview", label: "Overview", icon: <LayoutDashboard className="w-4 h-4" /> },
    { id: "transfers", label: "Transfers & Funds", icon: <ArrowLeftRight className="w-4 h-4" /> },
    { id: "beneficiaries", label: "Beneficiaries", icon: <Users className="w-4 h-4" /> },
    { id: "statements", label: "Statements (PDF)", icon: <FileDown className="w-4 h-4" /> },
    { id: "profile", label: "Profile & Security", icon: <UserCog className="w-4 h-4" /> },
  ];

  const displayName = profile ? `${profile.first_name} ${profile.last_name}` : user.username;

  const sidebarContent = (
    <div className="flex flex-col h-full bg-[#0A2540] text-white">
      <div className="px-6 py-5 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#2563EB] flex items-center justify-center shrink-0">
            <Building2 className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">Online Banking Demo</div>
            <div className="text-[11px] text-[#93C5FD]">Customer Portal</div>
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
        <div className="font-medium text-white truncate">{displayName}</div>
        <div className="text-slate-400 truncate">{user.email}</div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-[260px] shrink-0">{sidebarContent}</aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div className="w-[260px] h-full shadow-xl">{sidebarContent}</div>
          <div
            className="flex-1 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
          />
        </div>
      )}

      {/* Main Content */}
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
                Signed in as {user.username} · Simulated USD Ledger
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={loadWorkspaceData}
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

        <main className="flex-1 p-5 sm:p-8 max-w-[1280px] w-full mx-auto space-y-6">
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
              Loading banking workspace...
            </div>
          ) : (
            <>
              {tab === "overview" && (
                <div className="space-y-6">
                  {/* Top Summary Strip */}
                  <div className="bg-[#EBF4FF] border border-blue-200 rounded-xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wider text-[#1E3A8A]">
                        Combined Available Balance
                      </div>
                      <div className="text-3xl font-semibold text-[#0A2540] font-mono tabular-nums mt-1">
                        {formatCents(totalBalanceCents)}
                      </div>
                      <div className="text-xs text-slate-600 mt-1">
                        Across {accounts.length} active demo {accounts.length === 1 ? "account" : "accounts"}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleOpenAccount("CHECKING")}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-white border border-blue-200 text-xs font-medium text-[#0A2540] hover:bg-blue-50 cursor-pointer whitespace-nowrap"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Open Checking
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOpenAccount("SAVINGS")}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#0A2540] text-xs font-medium text-white hover:bg-[#13385E] cursor-pointer whitespace-nowrap"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Open Savings
                      </button>
                    </div>
                  </div>

                  {/* Account Cards */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {accounts.map((acct) => (
                      <div
                        key={acct.id}
                        className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-xs font-semibold tracking-wide text-slate-500">
                              {acct.account_type} ·{" "}
                              <span
                                className={
                                  acct.status === "ACTIVE"
                                    ? "text-emerald-700"
                                    : acct.status === "FROZEN"
                                      ? "text-amber-700"
                                      : "text-red-700"
                                }
                              >
                                {acct.status}
                              </span>
                            </div>
                            <div className="font-mono text-sm text-slate-800 mt-1">
                              #{acct.account_number}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-xs text-slate-500">Balance ({acct.currency})</div>
                            <div className="text-2xl font-semibold text-[#0F172A] font-mono tabular-nums">
                              ${Number(acct.balance).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                            </div>
                          </div>
                        </div>

                        <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => handleReconcile(acct.id)}
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-[#2563EB] hover:underline cursor-pointer"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Verify Ledger
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedAccountId(acct.id);
                              setTab("transfers");
                            }}
                            className="text-xs font-medium text-slate-700 hover:text-[#0A2540] cursor-pointer"
                          >
                            Move Funds →
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {reconcileResult && (
                    <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="space-y-1">
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Ledger Reconciliation · #{reconcileResult.account_number}
                        </div>
                        <div className="text-sm text-slate-800">
                          Account Balance:{" "}
                          <span className="font-mono font-semibold">${reconcileResult.account_balance}</span>{" "}
                          | Ledger Net:{" "}
                          <span className="font-mono font-semibold">${reconcileResult.ledger_net_balance}</span>{" "}
                          | Entries:{" "}
                          <span className="font-mono">{reconcileResult.entry_count}</span>
                        </div>
                      </div>
                      <div
                        className={`text-xs font-semibold ${
                          reconcileResult.is_balanced ? "text-emerald-700" : "text-red-700"
                        }`}
                      >
                        {reconcileResult.is_balanced
                          ? "BALANCED (DIFF $0.00)"
                          : `DISCREPANCY ($${reconcileResult.difference})`}
                      </div>
                    </div>
                  )}

                  {/* Recent Transactions */}
                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                    <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
                      <h2 className="text-sm font-semibold text-[#0F172A]">Recent Ledger Activity</h2>
                      <button
                        type="button"
                        onClick={() => setTab("transfers")}
                        className="text-xs font-medium text-[#2563EB] hover:underline cursor-pointer"
                      >
                        View all & filter
                      </button>
                    </div>
                    {transactions.length === 0 ? (
                      <div className="p-6 text-sm text-slate-500">
                        No transactions recorded yet. Use Transfers & Funds to make a deposit or transfer.
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                            <tr>
                              <th className="py-3 px-4 font-semibold">Date (UTC)</th>
                              <th className="py-3 px-4 font-semibold">Reference</th>
                              <th className="py-3 px-4 font-semibold">Type</th>
                              <th className="py-3 px-4 font-semibold">Accounts</th>
                              <th className="py-3 px-4 font-semibold">Description</th>
                              <th className="py-3 px-4 font-semibold text-right">Amount</th>
                              <th className="py-3 px-4 font-semibold">Status</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {transactions.slice(0, 10).map((tx) => (
                              <tr key={tx.id} className="hover:bg-slate-50/70">
                                <td className="py-3 px-4 font-mono text-slate-600 whitespace-nowrap">
                                  {tx.created_at.slice(0, 16).replace("T", " ")}
                                </td>
                                <td className="py-3 px-4 font-mono text-slate-800 whitespace-nowrap">
                                  {tx.reference_number}
                                </td>
                                <td className="py-3 px-4 font-medium text-slate-800">
                                  {tx.transaction_type}
                                </td>
                                <td className="py-3 px-4 font-mono text-slate-600 whitespace-nowrap">
                                  {tx.source_account_number ? `#${tx.source_account_number}` : "External"} →{" "}
                                  {tx.destination_account_number ? `#${tx.destination_account_number}` : "External"}
                                </td>
                                <td className="py-3 px-4 text-slate-600 max-w-[220px] truncate">
                                  {tx.description || "-"}
                                </td>
                                <td className="py-3 px-4 font-mono font-semibold text-right text-slate-900 whitespace-nowrap">
                                  ${tx.amount}
                                </td>
                                <td className="py-3 px-4 font-semibold whitespace-nowrap">
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
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {tab === "transfers" && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                  {/* Left: Atomic Transaction Form */}
                  <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-5 self-start">
                    <div>
                      <h2 className="text-base font-semibold text-[#0F172A]">Execute Transaction</h2>
                      <p className="text-xs text-slate-500 mt-1">
                        Protected by exact integer-cent math, daily limits, and idempotency keys.
                      </p>
                    </div>

                    <div className="grid grid-cols-3 gap-1 bg-slate-100 p-1 rounded-lg text-xs font-medium">
                      {(["TRANSFER", "DEPOSIT", "WITHDRAWAL"] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setTxMode(m)}
                          className={`py-2 rounded-md transition-colors cursor-pointer ${
                            txMode === m
                              ? "bg-[#0A2540] text-white font-semibold"
                              : "text-slate-600 hover:text-[#0A2540]"
                          }`}
                        >
                          {m === "TRANSFER" ? "Transfer" : m === "DEPOSIT" ? "Deposit" : "Withdraw"}
                        </button>
                      ))}
                    </div>

                    <form onSubmit={handleTransactionSubmit} className="space-y-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          {txMode === "DEPOSIT" ? "Destination Account" : "Source Account"}
                        </label>
                        <select
                          value={selectedAccountId}
                          onChange={(e) => setSelectedAccountId(Number(e.target.value))}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white focus:border-[#2563EB] focus:outline-none"
                        >
                          {accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              #{a.account_number} ({a.account_type}) — ${a.balance}
                            </option>
                          ))}
                        </select>
                      </div>

                      {txMode === "TRANSFER" && (
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Recipient Account Number
                          </label>
                          <input
                            type="text"
                            required
                            value={destAccountNumber}
                            onChange={(e) => setDestAccountNumber(e.target.value)}
                            placeholder="10XXXXXXXXXX"
                            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-[#2563EB] focus:outline-none"
                          />
                          {beneficiaries.length > 0 && (
                            <div className="mt-2">
                              <span className="text-[11px] text-slate-500 block mb-1">
                                Quick-select saved beneficiary:
                              </span>
                              <select
                                value=""
                                onChange={(e) => {
                                  if (e.target.value) setDestAccountNumber(e.target.value);
                                }}
                                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700"
                              >
                                <option value="">Choose saved recipient...</option>
                                {beneficiaries.map((b) => (
                                  <option key={b.id} value={b.account_number}>
                                    {b.beneficiary_name} — #{b.account_number}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}
                        </div>
                      )}

                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Amount (USD)
                        </label>
                        <input
                          type="text"
                          required
                          value={txAmount}
                          onChange={(e) => setTxAmount(e.target.value)}
                          placeholder="250.00"
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-[#2563EB] focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Memo / Description
                        </label>
                        <input
                          type="text"
                          value={txDescription}
                          onChange={(e) => setTxDescription(e.target.value)}
                          placeholder="Optional note"
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#2563EB] focus:outline-none"
                        />
                      </div>

                      <button
                        type="submit"
                        disabled={txSubmitting || accounts.length === 0}
                        className="w-full rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-60 text-white font-medium text-sm py-2.5 transition-colors cursor-pointer"
                      >
                        {txSubmitting
                          ? "Processing..."
                          : txMode === "TRANSFER"
                            ? "Submit Transfer"
                            : txMode === "DEPOSIT"
                              ? "Submit Deposit"
                              : "Submit Withdrawal"}
                      </button>
                    </form>
                  </div>

                  {/* Right: Filterable Transaction History */}
                  <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden self-start">
                    <div className="p-5 border-b border-slate-200 space-y-3">
                      <h2 className="text-base font-semibold text-[#0F172A]">Transaction History</h2>
                      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                        <select
                          value={filterType}
                          onChange={(e) => setFilterType(e.target.value)}
                          className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs bg-white"
                        >
                          <option value="">All Types</option>
                          <option value="DEPOSIT">Deposit</option>
                          <option value="WITHDRAWAL">Withdrawal</option>
                          <option value="TRANSFER">Transfer</option>
                          <option value="REVERSAL">Reversal</option>
                        </select>
                        <input
                          type="date"
                          value={filterStart}
                          onChange={(e) => setFilterStart(e.target.value)}
                          className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                        />
                        <input
                          type="date"
                          value={filterEnd}
                          onChange={(e) => setFilterEnd(e.target.value)}
                          className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                        />
                        <button
                          type="button"
                          onClick={loadFilteredTransactions}
                          className="rounded-lg bg-[#0A2540] text-white text-xs font-medium py-1.5 px-3 hover:bg-[#13385E] cursor-pointer"
                        >
                          Apply Filter
                        </button>
                      </div>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                          <tr>
                            <th className="py-3 px-4 font-semibold">Date</th>
                            <th className="py-3 px-4 font-semibold">Reference</th>
                            <th className="py-3 px-4 font-semibold">Type</th>
                            <th className="py-3 px-4 font-semibold text-right">Amount</th>
                            <th className="py-3 px-4 font-semibold">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {transactions.length === 0 ? (
                            <tr>
                              <td colSpan={5} className="py-6 px-4 text-slate-500 text-center">
                                No transactions match the selected filters.
                              </td>
                            </tr>
                          ) : (
                            transactions.map((tx) => (
                              <tr key={tx.id}>
                                <td className="py-3 px-4 font-mono text-slate-600 whitespace-nowrap">
                                  {tx.created_at.slice(0, 10)}
                                </td>
                                <td className="py-3 px-4 font-mono text-slate-800 whitespace-nowrap">
                                  {tx.reference_number}
                                </td>
                                <td className="py-3 px-4 text-slate-800">{tx.transaction_type}</td>
                                <td className="py-3 px-4 font-mono font-semibold text-right">
                                  ${tx.amount}
                                </td>
                                <td className="py-3 px-4 font-semibold">
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
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {tab === "beneficiaries" && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                  <form
                    onSubmit={handleAddBeneficiary}
                    className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-4 self-start"
                  >
                    <div>
                      <h2 className="text-base font-semibold text-[#0F172A]">Add Beneficiary</h2>
                      <p className="text-xs text-slate-500 mt-1">
                        Save an existing active demo account number for quick transfers.
                      </p>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Recipient Full Name
                      </label>
                      <input
                        type="text"
                        required
                        value={benName}
                        onChange={(e) => setBenName(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#2563EB] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Account Number
                      </label>
                      <input
                        type="text"
                        required
                        value={benAccountNum}
                        onChange={(e) => setBenAccountNum(e.target.value)}
                        placeholder="10XXXXXXXXXX"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-[#2563EB] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Nickname (optional)
                      </label>
                      <input
                        type="text"
                        value={benNickname}
                        onChange={(e) => setBenNickname(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#2563EB] focus:outline-none"
                      />
                    </div>
                    <button
                      type="submit"
                      className="w-full rounded-lg bg-[#0A2540] hover:bg-[#13385E] text-white font-medium text-sm py-2.5 cursor-pointer"
                    >
                      Save Beneficiary
                    </button>
                  </form>

                  <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden self-start">
                    <div className="px-5 py-4 border-b border-slate-200">
                      <h2 className="text-base font-semibold text-[#0F172A]">Saved Beneficiaries</h2>
                    </div>
                    {beneficiaries.length === 0 ? (
                      <div className="p-6 text-sm text-slate-500">No beneficiaries saved yet.</div>
                    ) : (
                      <div className="divide-y divide-slate-100">
                        {beneficiaries.map((b) => (
                          <div key={b.id} className="px-5 py-4 flex items-center justify-between gap-4">
                            <div>
                              <div className="text-sm font-semibold text-slate-900">
                                {b.beneficiary_name}
                                {b.nickname ? ` (${b.nickname})` : ""}
                              </div>
                              <div className="text-xs font-mono text-slate-500 mt-0.5">
                                Account #{b.account_number}
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              <button
                                type="button"
                                onClick={() => {
                                  setDestAccountNumber(b.account_number);
                                  setTxMode("TRANSFER");
                                  setTab("transfers");
                                }}
                                className="text-xs font-medium text-[#2563EB] hover:underline cursor-pointer"
                              >
                                Send Funds
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteBeneficiary(b.id)}
                                className="p-1.5 text-slate-400 hover:text-red-600 cursor-pointer"
                                aria-label="Delete beneficiary"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {tab === "statements" && (
                <div className="space-y-6">
                  <form
                    onSubmit={handlePreviewStatement}
                    className="bg-white border border-slate-200 rounded-xl p-6 grid grid-cols-1 sm:grid-cols-4 gap-4 items-end"
                  >
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Account</label>
                      <select
                        value={stmtAccountId}
                        onChange={(e) => setStmtAccountId(Number(e.target.value))}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
                      >
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            #{a.account_number} ({a.account_type})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Start Date</label>
                      <input
                        type="date"
                        required
                        value={stmtStart}
                        onChange={(e) => setStmtStart(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">End Date</label>
                      <input
                        type="date"
                        required
                        value={stmtEnd}
                        onChange={(e) => setStmtEnd(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="submit"
                        disabled={stmtLoading}
                        className="flex-1 rounded-lg bg-[#0A2540] hover:bg-[#13385E] text-white text-xs font-medium py-2.5 px-3 cursor-pointer whitespace-nowrap"
                      >
                        {stmtLoading ? "Loading..." : "Preview"}
                      </button>
                      <button
                        type="button"
                        onClick={handleDownloadPdf}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-medium py-2.5 px-3 cursor-pointer whitespace-nowrap"
                      >
                        <FileDown className="w-3.5 h-3.5" />
                        PDF
                      </button>
                    </div>
                  </form>

                  {statementSummary && (
                    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                      <div className="p-6 bg-[#EBF4FF] border-b border-blue-200 grid grid-cols-2 sm:grid-cols-4 gap-4">
                        <div>
                          <div className="text-xs text-slate-600">Opening Balance</div>
                          <div className="text-lg font-semibold font-mono text-[#0A2540]">
                            ${statementSummary.openingBalance}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-600">Total Credits</div>
                          <div className="text-lg font-semibold font-mono text-emerald-700">
                            +${statementSummary.totalCredits}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-600">Total Debits</div>
                          <div className="text-lg font-semibold font-mono text-red-700">
                            -${statementSummary.totalDebits}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-600">Closing Balance</div>
                          <div className="text-lg font-semibold font-mono text-[#0A2540]">
                            ${statementSummary.closingBalance}
                          </div>
                        </div>
                      </div>

                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                            <tr>
                              <th className="py-3 px-4 font-semibold">Date (UTC)</th>
                              <th className="py-3 px-4 font-semibold">Reference</th>
                              <th className="py-3 px-4 font-semibold">Type</th>
                              <th className="py-3 px-4 font-semibold">Description</th>
                              <th className="py-3 px-4 font-semibold text-right">Amount</th>
                              <th className="py-3 px-4 font-semibold text-right">Balance After</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {statementSummary.entries.length === 0 ? (
                              <tr>
                                <td colSpan={6} className="py-6 px-4 text-slate-500 text-center">
                                  No ledger entries recorded during this statement window.
                                </td>
                              </tr>
                            ) : (
                              statementSummary.entries.map((entry, idx) => (
                                <tr key={`${entry.reference_number}-${idx}`}>
                                  <td className="py-3 px-4 font-mono text-slate-600 whitespace-nowrap">
                                    {entry.date.slice(0, 16).replace("T", " ")}
                                  </td>
                                  <td className="py-3 px-4 font-mono text-slate-800 whitespace-nowrap">
                                    {entry.reference_number}
                                  </td>
                                  <td className="py-3 px-4 text-slate-700">{entry.transaction_type}</td>
                                  <td className="py-3 px-4 text-slate-600">{entry.description}</td>
                                  <td
                                    className={`py-3 px-4 font-mono font-semibold text-right whitespace-nowrap ${
                                      entry.entry_type === "CREDIT" ? "text-emerald-700" : "text-red-700"
                                    }`}
                                  >
                                    {entry.entry_type === "CREDIT" ? "+" : "-"}${entry.amount}
                                  </td>
                                  <td className="py-3 px-4 font-mono text-right text-slate-900 whitespace-nowrap">
                                    ${entry.balance_after}
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {tab === "profile" && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <form
                    onSubmit={handleSaveProfile}
                    className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
                  >
                    <h2 className="text-base font-semibold text-[#0F172A]">Customer Details</h2>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">First Name</label>
                        <input
                          type="text"
                          required
                          value={firstName}
                          onChange={(e) => setFirstName(e.target.value)}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">Last Name</label>
                        <input
                          type="text"
                          required
                          value={lastName}
                          onChange={(e) => setLastName(e.target.value)}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Phone</label>
                      <input
                        type="text"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Address Line 1</label>
                      <input
                        type="text"
                        value={address1}
                        onChange={(e) => setAddress1(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">City</label>
                        <input
                          type="text"
                          value={city}
                          onChange={(e) => setCity(e.target.value)}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">State / Province</label>
                        <input
                          type="text"
                          value={stateProv}
                          onChange={(e) => setStateProv(e.target.value)}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">Postal Code</label>
                        <input
                          type="text"
                          value={postalCode}
                          onChange={(e) => setPostalCode(e.target.value)}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">Country</label>
                        <input
                          type="text"
                          value={country}
                          onChange={(e) => setCountry(e.target.value)}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        />
                      </div>
                    </div>
                    <button
                      type="submit"
                      className="rounded-lg bg-[#0A2540] hover:bg-[#13385E] text-white text-sm font-medium px-5 py-2.5 cursor-pointer"
                    >
                      Save Profile
                    </button>
                  </form>

                  <form
                    onSubmit={handleChangePassword}
                    className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 self-start"
                  >
                    <h2 className="text-base font-semibold text-[#0F172A] flex items-center gap-2">
                      <Shield className="w-4 h-4 text-[#2563EB]" />
                      Rotate Password
                    </h2>
                    <p className="text-xs text-slate-500">
                      Changing your password revokes all previously issued tokens across other sessions.
                    </p>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Current Password
                      </label>
                      <input
                        type="password"
                        required
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        New Password
                      </label>
                      <input
                        type="password"
                        required
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                    <button
                      type="submit"
                      className="rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-sm font-medium px-5 py-2.5 cursor-pointer"
                    >
                      Update Password
                    </button>
                  </form>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
};
