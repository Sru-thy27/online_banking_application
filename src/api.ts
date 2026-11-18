const TOKEN_KEY = "obd_access_token";
const CSRF_KEY = "obd_csrf_token";

export function getStoredToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setSessionTokens(accessToken: string, csrfToken: string): void {
  sessionStorage.setItem(TOKEN_KEY, accessToken);
  sessionStorage.setItem(CSRF_KEY, csrfToken);
}

export function clearSessionTokens(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(CSRF_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
  } = {}
): Promise<T> {
  const method = (options.method || "GET").toUpperCase();
  const headers: Record<string, string> = {};

  const token = getStoredToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const csrf = sessionStorage.getItem(CSRF_KEY);
  if (csrf) {
    headers["X-CSRF-Token"] = csrf;
  }
  if (options.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: "same-origin",
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const parsed = (await res.json()) as { detail?: string };
      if (parsed?.detail) detail = parsed.detail;
    } catch {
      // Ignore parse failure
    }
    throw new ApiError(detail, res.status);
  }

  return (await res.json()) as T;
}

export async function downloadStatementPdf(
  accountId: number,
  startDate: string,
  endDate: string,
  accountNumber: string
): Promise<void> {
  const headers: Record<string, string> = {};
  const token = getStoredToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
  const res = await fetch(`/api/statements/${accountId}/pdf?${params.toString()}`, {
    method: "GET",
    headers,
    credentials: "same-origin",
  });

  if (!res.ok) {
    let detail = `Failed to download PDF (${res.status})`;
    try {
      const parsed = (await res.json()) as { detail?: string };
      if (parsed?.detail) detail = parsed.detail;
    } catch {
      // Ignore
    }
    throw new ApiError(detail, res.status);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `statement_${accountNumber}_${startDate}_${endDate}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
