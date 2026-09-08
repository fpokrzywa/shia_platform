const SECRET_KEY = /(pass(word)?|secret|token|api[_-]?key|authorization|cookie|database(url)?|connection(string)?)/i;
const SENSITIVE_QUERY_KEY = /(pass(word)?|secret|token|api[_-]?key|authorization|cookie)/i;

function sanitize(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    // Keep accidental connection strings and bearer values out of diagnostics.
    return value
      .replace(/(postgres(?:ql)?:\/\/)([^\s/@]+):([^\s/@]+)@/gi, "$1[redacted]@")
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
      .replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match, prefix: string, queryKey: string) =>
        SENSITIVE_QUERY_KEY.test(queryKey) ? `${prefix}${queryKey}=[redacted]` : match
      );
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitize(entryValue, entryKey)])
    );
  }
  return value;
}

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

function write(level: string, message: string, context?: Record<string, unknown>): void {
  const safeContext = context ? sanitize(context) : undefined;
  const suffix = safeContext && Object.keys(safeContext).length > 0 ? ` ${JSON.stringify(safeContext)}` : "";
  process.stdout.write(`${new Date().toISOString()} ${level} ${message}${suffix}\n`);
}

export const logger: Logger = {
  info: (message, context) => write("INFO", message, context),
  warn: (message, context) => write("WARN", message, context),
  error: (message, context) => write("ERROR", message, context)
};

export { sanitize };
