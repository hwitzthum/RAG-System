import type { Role } from "@/lib/auth/types";

export type AuditEvent = {
  action: string;
  actorId: string | null;
  actorRole: Role | "anonymous";
  outcome: "success" | "failure";
  resource: string;
  ipAddress: string;
  metadata?: Record<string, unknown>;
};

export function logAuditEvent(event: AuditEvent): void {
  const payload = {
    timestamp: new Date().toISOString(),
    eventType: "audit",
    ...event,
  };

  console.info(JSON.stringify(payload));
}
