// Resolve abroad for outbound proxy traffic, then CONNECT to the checked address. Local getaddrinfo
// can spend 20 s on a blocked name and occupy the lookup pool for unrelated images. Letting the proxy
// resolve an unchecked name instead would allow DNS rebinding into this host or its private network.
import net from "node:net";
import { Client, ProxyAgent, request, type Dispatcher } from "undici";
import { isBlockedAddress } from "./url.ts";

type Resolve = (hostname: string) => Promise<string[]>;
type ConnectOptions<T> = Omit<Dispatcher.ConnectOptions<T>, "origin">;
type ConnectCallback<T> = (error: Error | null, data: Dispatcher.ConnectData<T>) => void;

class PinnedProxyClient extends Client {
  private readonly resolve: Resolve;
  constructor(origin: URL, options: object, resolve: Resolve) {
    super(origin, options);
    this.resolve = resolve;
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
    const addresses = net.isIP(host) ? [host] : await this.resolve(host);
    if (!addresses.length || addresses.some(isBlockedAddress)) throw new Error(`Blocked proxy address for ${host}`);
    const address = addresses.find((a) => net.isIP(a) === 4) ?? addresses[0]!;
    // Only the CONNECT authority changes: ProxyAgent still uses the original host for TLS/SNI and
    // the HTTP Host header. The proxy never resolves the untrusted hostname a second time.
    const authority = `${net.isIP(address) === 6 ? `[${address}]` : address}:${target.port || 80}`;
    return super.connect({ ...options, path: authority, headers: { ...options.headers, host: authority } });
  }
}

export function createEgressProxy(proxyUrl: string, resolve: Resolve): ProxyAgent {
  return new ProxyAgent({ uri: proxyUrl, proxyTunnel: true, clientFactory: (origin, options) => new PinnedProxyClient(origin, options, resolve) });
}

/** The fixed DNS service is reached through the same outbound proxy, never the system resolver. */
export function createEgressResolver(proxyUrl: string): Resolve {
  const dns = new ProxyAgent({ uri: proxyUrl, maxResponseSize: 64 * 1024 });
  const cache = new Map<string, { addresses: string[]; until: number }>();
  const pending = new Map<string, Promise<string[]>>();
  return (host) => {
    const cached = cache.get(host);
    if (cached && cached.until > Date.now()) return Promise.resolve(cached.addresses);
    let work = pending.get(host);
    if (!work) {
      work = (async () => {
        const signal = AbortSignal.timeout(5_000);
        const records = (await Promise.all(["A", "AAAA"].map(async (type) => {
          const url = new URL("https://cloudflare-dns.com/dns-query");
          url.search = new URLSearchParams({ name: host, type }).toString();
          const res = await request(url, { dispatcher: dns, signal, headers: { accept: "application/dns-json" } });
          if (res.statusCode !== 200) { await res.body.dump(); throw new Error(`DNS upstream ${res.statusCode}`); }
          const data = await res.body.json() as { Status?: number; Answer?: Array<{ type: number; data: string; TTL: number }> };
          if (data.Status !== 0) throw new Error(`DNS lookup failed for ${host}`);
          return (data.Answer ?? []).filter((a) => a.type === 1 || a.type === 28);
        }))).flat();
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
