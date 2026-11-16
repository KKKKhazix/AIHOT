// Resolve abroad for outbound proxy traffic, then CONNECT to the checked address. Local getaddrinfo
// can spend 20 s on a blocked name and occupy the lookup pool for unrelated images. Letting the proxy
// resolve an unchecked name instead would allow DNS rebinding into this host or its private network.
import net from "node:net";
import { Client, ProxyAgent, request, type Agent, type Dispatcher } from "undici";
import { isBlockedAddress } from "./url.ts";

// HTTP/2 idle-socket cleanup can emit an unhandled stream error after a request has finished.
// Apply the same protocol restriction to destinations, DNS-over-HTTPS and TLS proxy connections.
export const OUTBOUND_HTTP_OPTIONS = { allowH2: false } as const;

type Resolve = (hostname: string) => Promise<string[]>;
type ConnectOptions<T> = Omit<Dispatcher.ConnectOptions<T>, "origin">;
type ConnectCallback<T> = (error: Error | null, data: Dispatcher.ConnectData<T>) => void;

class PinnedProxyClient extends Client {
  private readonly resolve: Resolve;
  private readonly pin: boolean;
  constructor(origin: URL, options: object, resolve: Resolve, pin: boolean) {
    super(origin, options);
    this.resolve = resolve;
    this.pin = pin;
  }

  override connect<T = null>(options: ConnectOptions<T>): Promise<Dispatcher.ConnectData<T>>;
  override connect<T = null>(options: ConnectOptions<T>, callback: ConnectCallback<T>): void;
  override connect<T = null>(options: ConnectOptions<T>, callback?: ConnectCallback<T>): Promise<Dispatcher.ConnectData<T>> | void {
    const work = this.connectPublic(options);
    if (!callback) return work;
    void work.then((data) => callback(null, data), (error: Error) => callback(error, undefined as never));
  }

  private async connectPublic<T>(options: ConnectOptions<T>): Promise<Dispatcher.ConnectData<T>> {
    const target = new URL(`http://${options.path}`);
    const host = target.hostname.replace(/^\[|\]$/g, "");
    // The address check always runs (the resolve is the same DoH that guardedFetch's SSRF guard uses).
    // With pinning on, the CONNECT authority is the checked address. Some rule-based proxies cannot
    // tunnel to an IP literal at all — they route it outside the domain rules and the connection is
    // reset — so EGRESS_PIN_DNS=false leaves the authority as the hostname. The proxy then resolves it
    // again: the check here stops names that resolve internal now, not one that answers differently the
    // second time, which is why pinning stays the default.
    const addresses = net.isIP(host) ? [host] : await this.resolve(host);
    if (!addresses.length || addresses.some(isBlockedAddress)) throw new Error(`Blocked proxy address for ${host}`);
    if (!this.pin) return super.connect(options);
    const address = addresses.find((a) => net.isIP(a) === 4) ?? addresses[0]!;
    // Only the CONNECT authority changes: ProxyAgent still uses the original host for TLS/SNI and
    // the HTTP Host header. The proxy never resolves the untrusted hostname a second time.
    const authority = `${net.isIP(address) === 6 ? `[${address}]` : address}:${target.port || 80}`;
    return super.connect({ ...options, path: authority, headers: { ...options.headers, host: authority } });
  }
}

export function createEgressProxy(proxyUrl: string, resolve: Resolve, factory?: Agent.Options["factory"], pinDns = true): ProxyAgent {
  return new ProxyAgent({ uri: proxyUrl, ...OUTBOUND_HTTP_OPTIONS, proxyTls: OUTBOUND_HTTP_OPTIONS,
    proxyTunnel: true, factory, clientFactory: (origin, options) => new PinnedProxyClient(origin, options, resolve, pinDns) });
}

/**
 * The fixed DNS services are reached through the same outbound proxy, never the system resolver.
 * Upstreams are tried in order (config.egressDnsUpstreams, EGRESS_DNS_UPSTREAMS): one deployment's
 * proxy stopped reaching cloudflare-dns.com at all (TLS reset on every CONNECT, 2026-11-12..16,
 * all proxied collection failed at this one step), while dns.google through the same proxy worked.
 */
export function createEgressResolver(proxyUrl: string, upstreams: string[] = ["https://cloudflare-dns.com/dns-query"]): Resolve {
  const dns = new ProxyAgent({ uri: proxyUrl, ...OUTBOUND_HTTP_OPTIONS, proxyTls: OUTBOUND_HTTP_OPTIONS, maxResponseSize: 64 * 1024 });
  const cache = new Map<string, { addresses: string[]; until: number }>();
  const pending = new Map<string, Promise<string[]>>();
  return (host) => {
    const cached = cache.get(host);
    if (cached && cached.until > Date.now()) return Promise.resolve(cached.addresses);
    let work = pending.get(host);
    if (!work) {
      work = (async () => {
        const types = ["A", "AAAA"];
        let records: Array<{ type: number; data: string; TTL: number }> | null = null;
        let lastError: unknown;
        for (const upstream of upstreams) {
          const settled = await Promise.allSettled(types.map(async (type) => {
            const url = new URL(upstream);
            url.search = new URLSearchParams({ name: host, type }).toString();
            const res = await request(url, { dispatcher: dns, signal: AbortSignal.timeout(5_000), headers: { accept: "application/dns-json" } });
            if (res.statusCode !== 200) { await res.body.dump(); throw new Error(`DNS upstream ${res.statusCode}`); }
            const data = await res.body.json() as { Status?: number; Answer?: Array<{ type: number; data: string; TTL: number }> };
            if (data.Status !== 0) throw new Error(`DNS lookup failed for ${host}`);
            return (data.Answer ?? []).filter((a) => a.type === 1 || a.type === 28);
          }));
          const answered = settled.flatMap((r) => r.status === "fulfilled" ? r.value : []);
          // An internal answer ends the lookup even when the other query failed: the next upstream never outvotes it.
          if (answered.some((a) => isBlockedAddress(a.data))) throw new Error(`Blocked proxy address for ${host}`);
          const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
          if (!failed) { records = answered; break; }
          lastError = failed.reason;
        }
        if (!records) throw lastError;
        const addresses = records.map((r) => r.data);
        if (!addresses.length || addresses.some(isBlockedAddress)) throw new Error(`Blocked proxy address for ${host}`);
        cache.delete(host);
        if (cache.size >= 256) cache.delete(cache.keys().next().value!);
        cache.set(host, { addresses, until: Date.now() + Math.max(0, Math.min(60, ...records.map((r) => r.TTL || 0))) * 1000 });
        return addresses;
      })().finally(() => pending.delete(host));
      pending.set(host, work);
    }
    return work;
  };
}
