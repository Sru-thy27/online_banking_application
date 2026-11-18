export type NotificationRecord = {
  id: string;
  channel: string;
  event: string;
  reference_number: string;
  recipient_masked: string;
  summary: string;
  dispatched_at: string;
};

const recentNotifications: NotificationRecord[] = [];

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

export function dispatchSimulatedNotification(input: {
  event: string;
  referenceNumber: string;
  email: string;
  amount: string;
  currency: string;
  destinationAccountNumber?: string;
}): NotificationRecord {
  const record: NotificationRecord = {
    id: `notif_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    channel: "SIMULATED_EMAIL",
    event: input.event,
    reference_number: input.referenceNumber,
    recipient_masked: maskEmail(input.email),
    summary: input.destinationAccountNumber
      ? `${input.event} of ${input.currency} ${input.amount} (Ref: ${input.referenceNumber}) to ****${input.destinationAccountNumber.slice(-4)}`
      : `${input.event} of ${input.currency} ${input.amount} (Ref: ${input.referenceNumber})`,
    dispatched_at: new Date().toISOString(),
  };

  recentNotifications.unshift(record);
  if (recentNotifications.length > 50) {
    recentNotifications.pop();
  }
  return record;
}

export function getRecentNotifications(): NotificationRecord[] {
  return [...recentNotifications];
}
