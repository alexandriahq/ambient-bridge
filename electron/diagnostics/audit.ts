export type AuditEvent = {
  name: string;
  at: number;
  fields: Record<string, string | number | boolean | null | undefined>;
};

export type AuditSink = {
  record(name: string, fields?: AuditEvent["fields"]): void;
  recent(): AuditEvent[];
};

const REDACTED_FIELD_PATTERN = /(body|prompt|completion|audio|transcript|secret|token|key|password)/i;

export class MemoryAuditSink implements AuditSink {
  private readonly events: AuditEvent[] = [];

  constructor(private readonly limit = 200) {}

  record(name: string, fields: AuditEvent["fields"] = {}): void {
    this.events.push({
      at: Date.now(),
      fields: sanitizeFields(fields),
      name,
    });
    if (this.events.length > this.limit) {
      this.events.shift();
    }
  }

  recent(): AuditEvent[] {
    return [...this.events];
  }
}

export function sanitizeFields(fields: AuditEvent["fields"]): AuditEvent["fields"] {
  const sanitized: AuditEvent["fields"] = {};
  for (const [key, value] of Object.entries(fields)) {
    sanitized[key] = REDACTED_FIELD_PATTERN.test(key) ? "[redacted]" : value;
  }
  return sanitized;
}
