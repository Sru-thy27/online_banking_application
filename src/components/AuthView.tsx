import React, { useEffect, useState } from "react";
import { Building2, KeyRound, Lock, ShieldCheck, UserPlus } from "lucide-react";
import { apiRequest, setSessionTokens } from "../api.ts";
import type { UserProfile } from "../types.ts";

type AuthMode = "customer-login" | "customer-register" | "admin-portal";

type AuthViewProps = {
  onAuthenticated: (user: UserProfile) => void;
};

export const AuthView: React.FC<AuthViewProps> = ({ onAuthenticated }) => {
  const [mode, setMode] = useState<AuthMode>("customer-login");
  const [needsBootstrap, setNeedsBootstrap] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Customer & Admin sign in fields
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");

  // Registration fields
  const [regEmail, setRegEmail] = useState("");
  const [regUsername, setRegUsername] = useState("");
  const [regFirstName, setRegFirstName] = useState("");
  const [regLastName, setRegLastName] = useState("");
  const [regPhone, setRegPhone] = useState("");
  const [regAccountType, setRegAccountType] = useState<"CHECKING" | "SAVINGS">("CHECKING");
  const [regPassword, setRegPassword] = useState("");

  // Admin bootstrap fields
  const [adminEmail, setAdminEmail] = useState("");
  const [adminUsername, setAdminUsername] = useState("");
  const [adminPassword, setAdminPassword] = useState("");

  useEffect(() => {
    if (mode !== "admin-portal") return;
    let active = true;
    apiRequest<{ needs_bootstrap: boolean }>("/auth/admin/bootstrap-status")
      .then((res) => {
        if (active) setNeedsBootstrap(res.needs_bootstrap);
      })
      .catch(() => {
        if (active) setNeedsBootstrap(false);
      });
    return () => {
      active = false;
    };
  }, [mode]);

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setError(null);
  };

  async function handleCustomerLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiRequest<{
        access_token: string;
        csrf_token: string;
        user: UserProfile;
      }>("/auth/login", {
        method: "POST",
        body: { identifier, password },
      });
      setSessionTokens(res.access_token, res.csrf_token);
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiRequest<{
        access_token: string;
        csrf_token: string;
        user: UserProfile;
      }>("/auth/register", {
        method: "POST",
        body: {
          email: regEmail,
          username: regUsername,
          password: regPassword,
          first_name: regFirstName,
          last_name: regLastName,
          phone: regPhone || null,
          account_type: regAccountType,
        },
      });
      setSessionTokens(res.access_token, res.csrf_token);
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleAdminBootstrap(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiRequest<{
        access_token: string;
        csrf_token: string;
        user: UserProfile;
      }>("/auth/admin/bootstrap", {
        method: "POST",
        body: {
          email: adminEmail,
          username: adminUsername,
          password: adminPassword,
        },
      });
      setSessionTokens(res.access_token, res.csrf_token);
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Administrator setup failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleAdminLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiRequest<{
        access_token: string;
        csrf_token: string;
        user: UserProfile;
      }>("/auth/admin/login", {
        method: "POST",
        body: { identifier, password },
      });
      setSessionTokens(res.access_token, res.csrf_token);
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Administrator sign in failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col lg:flex-row">
      {/* Left Brand Panel */}
      <aside className="bg-[#0A2540] text-white lg:w-[420px] xl:w-[460px] shrink-0 p-8 lg:p-12 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-3 mb-10">
            <div className="w-10 h-10 rounded-lg bg-[#2563EB] flex items-center justify-center">
              <Building2 className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="font-semibold text-base tracking-tight">Online Banking Demo</div>
              <div className="text-xs text-[#93C5FD]">Local Demonstration Ledger</div>
            </div>
          </div>

          <h1 className="text-3xl font-semibold tracking-tight leading-snug mb-4">
            Controlled banking ledger and administrative console.
          </h1>
          <p className="text-sm text-slate-300 leading-relaxed mb-8">
            Separate Customer and Administrator portals backed by atomic integer-cent transactions, balanced double-entry ledger records, PDF statements, and role-based access enforcement.
          </p>

          <div className="space-y-4 border-t border-white/10 pt-6 text-sm text-slate-200">
            <div className="flex items-start gap-3">
              <ShieldCheck className="w-4 h-4 text-[#60A5FA] mt-0.5 shrink-0" />
              <span>Exact integer-cent balances with idempotent deposits, withdrawals, and transfers.</span>
            </div>
            <div className="flex items-start gap-3">
              <Lock className="w-4 h-4 text-[#60A5FA] mt-0.5 shrink-0" />
              <span>Zero hardcoded admin credentials; safe first-run Super Admin setup when uninitialized.</span>
            </div>
            <div className="flex items-start gap-3">
              <KeyRound className="w-4 h-4 text-[#60A5FA] mt-0.5 shrink-0" />
              <span>Short-lived tokens, CSRF verification, lockout rules, and downloadable PDF statements.</span>
            </div>
          </div>
        </div>

        <p className="text-xs text-slate-400 mt-10 leading-relaxed">
          Local demonstration environment only. Simulated balances do not represent real currency or external financial institutions.
        </p>
      </aside>

      {/* Right Authentication Workspace */}
      <main className="flex-1 flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-[480px] bg-white border border-slate-200 rounded-xl p-6 sm:p-8 shadow-sm">
          {/* Segmented Portal Switcher */}
          <div className="grid grid-cols-3 gap-1 bg-slate-100 p-1 rounded-lg mb-6 text-xs font-medium">
            <button
              type="button"
              onClick={() => switchMode("customer-login")}
              className={`py-2 px-2 rounded-md transition-colors whitespace-nowrap ${
                mode === "customer-login"
                  ? "bg-white text-[#0A2540] shadow-xs font-semibold"
                  : "text-slate-600 hover:text-[#0A2540]"
              }`}
            >
              Customer Sign In
            </button>
            <button
              type="button"
              onClick={() => switchMode("customer-register")}
              className={`py-2 px-2 rounded-md transition-colors whitespace-nowrap ${
                mode === "customer-register"
                  ? "bg-white text-[#0A2540] shadow-xs font-semibold"
                  : "text-slate-600 hover:text-[#0A2540]"
              }`}
            >
              Open Account
            </button>
            <button
              type="button"
              onClick={() => switchMode("admin-portal")}
              className={`py-2 px-2 rounded-md transition-colors whitespace-nowrap ${
                mode === "admin-portal"
                  ? "bg-[#0A2540] text-white shadow-xs font-semibold"
                  : "text-slate-600 hover:text-[#0A2540]"
              }`}
            >
              Admin Portal
            </button>
          </div>

          {error && (
            <div className="mb-5 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {mode === "customer-login" && (
            <form onSubmit={handleCustomerLogin} className="space-y-4">
              <div>
                <h2 className="text-xl font-semibold text-[#0F172A]">Customer Portal Sign In</h2>
                <p className="text-sm text-slate-500 mt-1">
                  Access checking and savings accounts, transfers, and statements.
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Username or Email
                </label>
                <input
                  type="text"
                  required
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="jane.doe or jane@example.com"
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#2563EB] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Password
                </label>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#2563EB] focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-[#0A2540] hover:bg-[#13385E] disabled:opacity-60 text-white font-medium text-sm py-2.5 transition-colors cursor-pointer"
              >
                {loading ? "Signing in..." : "Sign In to Customer Portal"}
              </button>
              <div className="pt-2 text-xs text-slate-500 flex items-center justify-between">
                <span>New to the demo?</span>
                <button
                  type="button"
                  onClick={() => switchMode("customer-register")}
                  className="text-[#2563EB] hover:underline font-medium cursor-pointer"
                >
                  Open a customer account
                </button>
              </div>
            </form>
          )}

          {mode === "customer-register" && (
            <form onSubmit={handleRegister} className="space-y-4">
              <div>
                <h2 className="text-xl font-semibold text-[#0F172A] flex items-center gap-2">
                  <UserPlus className="w-5 h-5 text-[#2563EB]" />
                  Open Customer Account
                </h2>
                <p className="text-sm text-slate-500 mt-1">
                  Provisions a verified customer profile and an active USD account.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">First Name</label>
                  <input
                    type="text"
                    required
                    value={regFirstName}
                    onChange={(e) => setRegFirstName(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#2563EB] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Last Name</label>
                  <input
                    type="text"
                    required
                    value={regLastName}
                    onChange={(e) => setRegLastName(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#2563EB] focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Email</label>
                  <input
                    type="email"
                    required
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#2563EB] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Username</label>
                  <input
                    type="text"
                    required
                    value={regUsername}
                    onChange={(e) => setRegUsername(e.target.value)}
                    placeholder="3–32 chars"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#2563EB] focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Phone (optional)</label>
                  <input
                    type="text"
                    value={regPhone}
                    onChange={(e) => setRegPhone(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#2563EB] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Initial Account Type</label>
                  <select
                    value={regAccountType}
                    onChange={(e) => setRegAccountType(e.target.value as "CHECKING" | "SAVINGS")}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white focus:border-[#2563EB] focus:outline-none"
                  >
                    <option value="CHECKING">Checking Account</option>
                    <option value="SAVINGS">Savings Account</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Password</label>
                <input
                  type="password"
                  required
                  value={regPassword}
                  onChange={(e) => setRegPassword(e.target.value)}
                  placeholder="Min 10 chars, upper, lower, digit, symbol"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#2563EB] focus:outline-none"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Requires at least 10 characters including uppercase, lowercase, number, and symbol.
                </p>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-60 text-white font-medium text-sm py-2.5 transition-colors cursor-pointer"
              >
                {loading ? "Creating Account..." : "Create Customer Account"}
              </button>
            </form>
          )}

          {mode === "admin-portal" && needsBootstrap === null && (
            <div className="py-8 text-center text-sm text-slate-500">Checking administrator setup status...</div>
          )}

          {mode === "admin-portal" && needsBootstrap === true && (
            <form onSubmit={handleAdminBootstrap} className="space-y-4">
              <div className="rounded-lg bg-[#EBF4FF] border border-blue-200 px-4 py-3 text-xs text-[#0A2540]">
                No administrator exists yet. Complete this one-time setup to provision the initial Super Admin account.
              </div>
              <div>
                <h2 className="text-xl font-semibold text-[#0F172A]">Initial Super Admin Setup</h2>
                <p className="text-sm text-slate-500 mt-1">
                  Establishes privileged access for system health, limits, reversals, and backups.
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Admin Email</label>
                <input
                  type="email"
                  required
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="admin@bankdemo.local"
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-[#2563EB] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Admin Username</label>
                <input
                  type="text"
                  required
                  value={adminUsername}
                  onChange={(e) => setAdminUsername(e.target.value)}
                  placeholder="superadmin"
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-[#2563EB] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Strong Password</label>
                <input
                  type="password"
                  required
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  placeholder="Min 10 chars, upper, lower, digit, symbol"
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-[#2563EB] focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-[#0A2540] hover:bg-[#13385E] disabled:opacity-60 text-white font-medium text-sm py-2.5 transition-colors cursor-pointer"
              >
                {loading ? "Initializing Super Admin..." : "Create Initial Super Admin"}
              </button>
            </form>
          )}

          {mode === "admin-portal" && needsBootstrap === false && (
            <form onSubmit={handleAdminLogin} className="space-y-4">
              <div>
                <h2 className="text-xl font-semibold text-[#0F172A]">Administrator Sign In</h2>
                <p className="text-sm text-slate-500 mt-1">
                  Restricted to users holding ADMIN or SUPER_ADMIN roles.
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Admin Username or Email
                </label>
                <input
                  type="text"
                  required
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:border-[#2563EB] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Password</label>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:border-[#2563EB] focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-[#0A2540] hover:bg-[#13385E] disabled:opacity-60 text-white font-medium text-sm py-2.5 transition-colors cursor-pointer"
              >
                {loading ? "Signing in..." : "Sign In to Admin Console"}
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
};
