// Public pages already rendered in this document can be revisited until their server deadline.
// Nothing persists across a document reload; list snapshots separately own the reader's position.
import type { ClientLoaderFunctionArgs, ShouldRevalidateFunction } from 'react-router';

const pages = new Map<string, unknown>();
const MAX_PAGES = 16;
const addressOf = (url: URL) => url.pathname + url.search;
const deadlineOf = (value: unknown) => (value as { expiresAt?: number } | null)?.expiresAt ?? 0;

export function hasFreshPage(url: URL): boolean {
  return deadlineOf(pages.get(addressOf(url))) > Date.now();
}

/**
 * A page's client loader and the router hook that goes with it, made together so they agree on `key`.
 * `key` names the result an address reads, as the address that holds it. Addresses with one key share
 * that result (the tabs of a page that reads the same data) and only the first read asks the server.
 * By default every address has its own.
 */
export function pageReuse<T>(key: (url: URL) => string = addressOf) {
  async function clientLoader({ request, serverLoader }: ClientLoaderFunctionArgs) {
    const held = key(new URL(request.url));
    const previous = pages.get(held);
    pages.delete(held);
    if (deadlineOf(previous) > Date.now()) {
      pages.set(held, previous);
      return previous as Awaited<ReturnType<typeof serverLoader<T>>>;
    }
    // On hydration this is the HTML's own result, without another HTTP request.
    const result = await serverLoader<T>();
    if (!request.signal.aborted && deadlineOf(result) > Date.now()) {
      pages.set(held, result);
      if (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value!);
    }
    return result;
  }
  clientLoader.hydrate = true as const;

  const shouldRevalidate: ShouldRevalidateFunction = ({ currentUrl, nextUrl, defaultShouldRevalidate }) => {
    // Revalidator/retry, or tapping the current page again: ask for its data normally.
    if (defaultShouldRevalidate && addressOf(currentUrl) === addressOf(nextUrl)) pages.delete(key(nextUrl));
    // Moving between addresses that share a result still runs the loader, which keeps the result while it is fresh.
    return defaultShouldRevalidate || key(currentUrl) === key(nextUrl);
  };

  return { clientLoader, shouldRevalidate };
}
