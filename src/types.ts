export type UserProfile = {
  id: number;
  email: string;
  username: string;
  roles: string[];
  is_active: boolean;
  last_login_at?: string | null;
  created_at?: string;
};

export type CustomerDetails = {
  id: number;
  user_id: number;
  first_name: string;
  last_name: string;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state_province: string | null;
  postal_code: string | null;
  country: string | null;
  date_of_birth: string | null;
};

export type BankAccount = {
  id: number;
  user_id: number;
  account_number: string;
  account_type: "CHECKING" | "SAVINGS";
  currency: string;
  balance_cents: number;
  balance: string;
  status: "ACTIVE" | "FROZEN" | "CLOSED";
  created_at: string;
  updated_at: string;
  username?: string;
  email?: string;
};

export type ReconcileResult = {
  account_id: number;
  account_number: string;
  account_balance: string;
  ledger_net_balance: string;
  difference: string;
  is_balanced: boolean;
  entry_count: number;
};

export type BankTransaction = {
  id: number;
  reference_number: string;
  idempotency_key: string | null;
  transaction_type: "DEPOSIT" | "WITHDRAWAL" | "TRANSFER" | "REVERSAL";
  source_account_id: number | null;
  destination_account_id: number | null;
  source_account_number: string | null;
  destination_account_number: string | null;
  amount_cents: number;
  amount: string;
  currency: string;
  status: "PENDING" | "COMPLETED" | "FAILED" | "REVERSED";
  description: string | null;
  initiated_by_user_id: number;
  related_transaction_id: number | null;
  created_at: string;
};

export type Beneficiary = {
  id: number;
  user_id: number;
  beneficiary_name: string;
  account_number: string;
  nickname: string | null;
  created_at: string;
};

export type StatementSummary = {
  customerName: string;
  customerEmail: string;
  customerAddress: string;
  accountNumber: string;
  accountType: string;
  accountStatus: string;
  currency: string;
  startDate: string;
  endDate: string;
  openingBalance: string;
  totalCredits: string;
  totalDebits: string;
  closingBalance: string;
  entries: Array<{
    date: string;
    reference_number: string;
    transaction_type: string;
    entry_type: string;
    description: string;
    amount: string;
    balance_after: string;
  }>;
};

export type NotificationRecord = {
  id: string;
  channel: string;
  event: string;
  reference_number: string;
  recipient_masked: string;
  summary: string;
  dispatched_at: string;
};

export type AdminHealthResponse = {
  database: string;
  metrics: {
    total_requests: number;
    avg_latency_ms: number;
    max_latency_ms: number;
    error_count: number;
    total_users: number;
    total_accounts: number;
    total_balance_dollars: string;
    total_transactions: number;
  };
  recent_notifications: NotificationRecord[];
  timestamp: string;
};

export type AppSetting = {
  id: number;
  setting_key: string;
  setting_value: string;
  value_type: "DECIMAL" | "INT" | "BOOL" | "STRING";
  description: string | null;
  updated_at: string;
};

export type AdminUserRecord = {
  id: number;
  email: string;
  username: string;
  is_active: boolean;
  failed_login_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
  roles: string[];
};

export type SystemLog = {
  id: number;
  level: string;
  service_name: string;
  endpoint: string | null;
  http_method: string | null;
  status_code: number | null;
  response_time_ms: number | null;
  message: string;
  created_at: string;
};

export type SecurityLog = {
  id: number;
  user_id: number | null;
  username: string | null;
  event_type: string;
  ip_address: string | null;
  user_agent: string | null;
  details: string | null;
  created_at: string;
};

export type AuditLog = {
  id: number;
  actor_user_id: number | null;
  actor_username: string | null;
  action: string;
  target_entity: string;
  target_id: string | null;
  previous_value: string | null;
  new_value: string | null;
  ip_address: string | null;
  created_at: string;
};

export type BackupFile = {
  filename: string;
  size_bytes: number;
  modified_at: string;
};

export type BackupHistoryRow = {
  id: number;
  filename: string;
  operation_type: "BACKUP" | "RESTORE";
  status: string;
  file_size_bytes: number | null;
  initiated_by: number;
  initiated_by_username: string;
  notes: string | null;
  created_at: string;
};
