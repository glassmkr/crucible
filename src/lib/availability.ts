export interface CollectorAvailability {
  available: boolean;
  error?: string;
  last_success_at?: string;
  data_age_seconds?: number;
}

export type CollectionStatusMap = Record<string, CollectorAvailability>;

export interface CollectOptionalOptions {
  nullMeansAbsent?: boolean;
}

const lastErrorLogAt = new Map<string, number>();
const ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function availabilityFromValue(value: unknown): CollectorAvailability {
  if (value === null || value === undefined) {
    return { available: false, error: "collector returned no data" };
  }
  if (typeof value === "object" && "available" in value && (value as { available?: unknown }).available === false) {
    const result = value as { error?: unknown; reason?: unknown };
    return {
      available: false,
      error: String(result.error ?? result.reason ?? "collector reported unavailable"),
    };
  }
  return { available: true };
}

export async function collectOptional<T>(
  name: string,
  collect: () => T | Promise<T>,
  statuses: CollectionStatusMap,
  log: (message: string) => void = (message) => console.error(message),
  now = Date.now(),
  options: CollectOptionalOptions = {},
): Promise<T | undefined> {
  try {
    const value = await collect();
    if ((value === null || value === undefined) && options.nullMeansAbsent) {
      delete statuses[name];
      return undefined;
    }
    statuses[name] = availabilityFromValue(value);
    return value ?? undefined;
  } catch (error) {
    const message = errorMessage(error);
    statuses[name] = { available: false, error: message };
    const lastLog = lastErrorLogAt.get(name) ?? 0;
    if (now - lastLog >= ERROR_LOG_INTERVAL_MS) {
      lastErrorLogAt.set(name, now);
      log(`[${name}] Collection unavailable: ${message}`);
    }
    return undefined;
  }
}

export function staleAvailability<T extends object>(
  value: T,
  error: unknown,
  lastSuccessAt: Date,
  now = new Date(),
): T & CollectorAvailability {
  return {
    ...value,
    available: false,
    error: errorMessage(error),
    last_success_at: lastSuccessAt.toISOString(),
    data_age_seconds: Math.max(0, Math.floor((now.getTime() - lastSuccessAt.getTime()) / 1000)),
  };
}

export function __resetAvailabilityLogsForTests(): void {
  lastErrorLogAt.clear();
}
