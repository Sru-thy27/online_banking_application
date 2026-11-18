import React, { useCallback, useEffect, useState } from "react";
import { apiRequest, clearSessionTokens, getStoredToken, setSessionTokens } from "./api.ts";
import { AdminDashboard } from "./components/AdminDashboard.tsx";
import { AuthView } from "./components/AuthView.tsx";
import { CustomerDashboard } from "./components/CustomerDashboard.tsx";
import type { CustomerDetails, UserProfile } from "./types.ts";

export function App() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [customerDetails, setCustomerDetails] = useState<CustomerDetails | null>(null);
  const [initializing, setInitializing] = useState(true);

  const hydrateSession = useCallback(async () => {
    const token = getStoredToken();
    if (!token) {
      setInitializing(false);
      return;
    }
    try {
      const res = await apiRequest<{
        user: UserProfile;
        customer_details: CustomerDetails | null;
        csrf_token: string;
      }>("/auth/me");
      setSessionTokens(token, res.csrf_token);
      setUser(res.user);
      setCustomerDetails(res.customer_details);
    } catch {
      clearSessionTokens();
      setUser(null);
      setCustomerDetails(null);
    } finally {
      setInitializing(false);
    }
  }, []);

  useEffect(() => {
    hydrateSession();
  }, [hydrateSession]);

  async function handleAuthenticated(authenticatedUser: UserProfile) {
    setUser(authenticatedUser);
    try {
      const res = await apiRequest<{
        user: UserProfile;
        customer_details: CustomerDetails | null;
      }>("/auth/me");
      setCustomerDetails(res.customer_details);
    } catch {
      // Optional customer_details for admin accounts
    }
  }

  async function handleLogout() {
    try {
      await apiRequest("/auth/logout", { method: "POST" });
    } catch {
      // Proceed with local session clear even if token already expired
    }
    clearSessionTokens();
    setUser(null);
    setCustomerDetails(null);
  }

  if (initializing) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center text-sm text-slate-500">
        Initializing Online Banking Demo...
      </div>
    );
  }

  if (!user) {
    return <AuthView onAuthenticated={handleAuthenticated} />;
  }

  const isAdmin = user.roles.includes("ADMIN") || user.roles.includes("SUPER_ADMIN");
  if (isAdmin) {
    return <AdminDashboard user={user} onLogout={handleLogout} />;
  }

  return (
    <CustomerDashboard
      user={user}
      initialProfile={customerDetails}
      onLogout={handleLogout}
    />
  );
}

export default App;
