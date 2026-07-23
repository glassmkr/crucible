import { isIP, type LookupFunction } from "node:net";
import { lookup } from "node:dns/promises";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

// Node's global and package undici Request classes have different type-only
// overloads. Pinned callers pass URL values, so bridge that declaration gap
// once while keeping fetch and Agent from the same package instance.
export const undiciFetchImpl = undiciFetch as unknown as typeof fetch;

export interface EndpointPolicy {
  allowInsecure: boolean;
  allowedOrigins: string[];
}

export function normalizeAllowedOrigins(values: string[] = []): string[] {
  return values.map((value) => {
    const url = new URL(value);
    if (url.username || url.password) throw new Error(`endpoint origin must not contain credentials: ${value}`);
    if (url.pathname !== "/" || url.search || url.hash) throw new Error(`endpoint allowlist entries must be origins: ${value}`);
    return url.origin;
  });
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function ipv6Words(hostname: string): number[] | null {
  let host = hostname;
  const dottedMatch = host.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedMatch) {
    const octets = dottedMatch[2].split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    host = `${dottedMatch[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = host.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right].map((word) => Number.parseInt(word || "0", 16));
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return null;
  return words;
}

function ipv4FromMappedIpv6(hostname: string): string | null {
  const words = ipv6Words(hostname);
  if (!words || !words.slice(0, 5).every((word) => word === 0) || words[5] !== 0xffff) return null;
  return `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
}

export function isPrivateAddress(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname).toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;

  const family = isIP(host);
  if (family === 4) {
    const parts = host.split(".").map(Number);
    const [a, b] = parts;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || a >= 224;
  }
  if (family === 6) {
    const words = ipv6Words(host);
    if (!words) return true;
    const mapped = ipv4FromMappedIpv6(host);
    if (mapped) return isPrivateAddress(mapped);
    if (words.slice(0, 6).every((word) => word === 0)) return true;
    if (/^f[cd]/.test(host) || /^fe[89a-f]/.test(host)) return true;
  }
  return false;
}

function originIsExplicitlyAllowed(origin: string, policy: EndpointPolicy): boolean {
  return policy.allowedOrigins.includes(origin);
}

export function validateEndpoint(
  raw: string,
  policy: EndpointPolicy,
  requiredOrigin?: string,
): URL {
  const url = new URL(raw);
  if (url.username || url.password) throw new Error("endpoint URLs must not contain credentials");
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`unsupported endpoint protocol: ${url.protocol}`);
  }
  const explicitlyAllowed = originIsExplicitlyAllowed(url.origin, policy);
  if (url.protocol !== "https:" && !policy.allowInsecure && !explicitlyAllowed) {
    throw new Error("endpoint must use HTTPS unless explicitly allowed");
  }
  if (isPrivateAddress(url.hostname) && !policy.allowInsecure && !explicitlyAllowed) {
    throw new Error("private, loopback, and link-local endpoints require explicit opt-in");
  }
  if (requiredOrigin && url.origin !== requiredOrigin && !explicitlyAllowed) {
    throw new Error(`cross-origin endpoint is not allowlisted: ${url.origin}`);
  }
  return url;
}

export interface ResolvedEndpointAddress {
  address: string;
  family: 4 | 6;
}

export async function assertEndpointResolution(
  url: URL,
  policy: EndpointPolicy,
  resolve: typeof lookup = lookup,
): Promise<ResolvedEndpointAddress[]> {
  const literalFamily = isIP(stripIpv6Brackets(url.hostname));
  if (literalFamily) {
    return [{ address: stripIpv6Brackets(url.hostname), family: literalFamily as 4 | 6 }];
  }
  const addresses = await resolve(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error(`endpoint hostname did not resolve: ${url.hostname}`);
  if (!policy.allowInsecure && !originIsExplicitlyAllowed(url.origin, policy) && addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error(`endpoint resolved to a private, loopback, or link-local address: ${url.hostname}`);
  }
  return addresses.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
}

type AddressSelector = (addresses: ResolvedEndpointAddress[]) => ResolvedEndpointAddress;

export function selectPinnedAddress(
  url: URL,
  validatedAddresses: ResolvedEndpointAddress[],
  policy: EndpointPolicy,
  family: number = 0,
  select: AddressSelector = (addresses) => addresses[0],
): ResolvedEndpointAddress {
  const candidates = family === 4 || family === 6
    ? validatedAddresses.filter((entry) => entry.family === family)
    : validatedAddresses;
  if (candidates.length === 0) throw new Error(`no validated address matches family ${family} for ${url.hostname}`);
  const selected = select(candidates);
  if (!policy.allowInsecure && !originIsExplicitlyAllowed(url.origin, policy) && isPrivateAddress(selected.address)) {
    throw new Error(`refusing private address selected for endpoint connection: ${selected.address}`);
  }
  if (!candidates.some((entry) => entry.address === selected.address && entry.family === selected.family)) {
    throw new Error(`endpoint connection address was not in the validated DNS result: ${selected.address}`);
  }
  return selected;
}

export function createPinnedDispatcher(
  url: URL,
  validatedAddresses: ResolvedEndpointAddress[],
  policy: EndpointPolicy,
  select?: AddressSelector,
): Agent {
  const lookup: LookupFunction = ((
    _hostname: string,
    options: Parameters<LookupFunction>[1],
    callback: (...args: any[]) => void,
  ) => {
    try {
      const opts = typeof options === "number" ? { family: options, all: false } : options;
      const family = opts?.family === "IPv4" ? 4 : opts?.family === "IPv6" ? 6 : (opts?.family ?? 0);
      if (opts?.all) {
        const candidates = family === 4 || family === 6
          ? validatedAddresses.filter((entry) => entry.family === family)
          : validatedAddresses;
        for (const entry of candidates) selectPinnedAddress(url, validatedAddresses, policy, entry.family, () => entry);
        callback(null, candidates);
        return;
      }
      const selected = selectPinnedAddress(url, validatedAddresses, policy, family, select);
      callback(null, selected.address, selected.family);
    } catch (err) {
      callback(err);
    }
  }) as LookupFunction;

  const hostname = stripIpv6Brackets(url.hostname);
  return new Agent({
    connect: {
      lookup,
      ...(isIP(hostname) ? {} : { servername: hostname }),
    },
  });
}

export interface PinnedFetchResult {
  response: Response;
  dispatcher: Dispatcher;
}

export async function fetchPinnedEndpoint(
  url: URL,
  init: RequestInit,
  policy: EndpointPolicy,
  fetchImpl: typeof fetch = undiciFetchImpl,
  resolveEndpoint: typeof assertEndpointResolution = assertEndpointResolution,
): Promise<PinnedFetchResult> {
  const addresses = await resolveEndpoint(url, policy);
  const dispatcher = createPinnedDispatcher(url, addresses, policy);
  try {
    const response = await fetchImpl(url, { ...init, dispatcher } as RequestInit);
    return { response, dispatcher };
  } catch (err) {
    await dispatcher.close();
    throw err;
  }
}
