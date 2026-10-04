// Public pages already rendered in this document can be revisited until their server deadline.
// Nothing persists across a document reload; list snapshots separately own the reader's position.
import type { ClientLoaderFunctionArgs, ShouldRevalidateFunction } from 'react-router';

const pages = new Map<string, unknown>();
const MAX_PAGES = 16;
const keyOf = (url: URL) => url.pathname + url.search;
const deadlineOf = (value: unknown) => (value as { expiresAt?: number } | null)?.expiresAt ?? 0;

export function hasFreshPage(url: URL): boolean {
  return deadlineOf(pages.get(keyOf(url))) > Date.now();
}

export function cachedLoader<T>() {
  async function clientLoader({ request, serverLoader }: ClientLoaderFunctionArgs) {
    const key = keyOf(new URL(request.url));
    const previous = pages.get(key);
    pages.delete(key);
    if (deadlineOf(previous) > Date.now()) {
      pages.set(key, previous);
      return previous as Awaited<ReturnType<typeof serverLoader<T>>>;
    }
    // On hydration this is the HTML's own result, without another HTTP request.
    const result = await serverLoader<T>();
    if (!request.signal.aborted && deadlineOf(result) > Date.now()) {
      pages.set(key, result);
      if (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value!);
    }
    return result;
  }
  clientLoader.hydrate = true as const;
  return clientLoader;
}

export const shouldRevalidate: ShouldRevalidateFunction = ({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }) => {
  if (formMethod && formMethod.toUpperCase() !== 'GET') pages.clear();
  // Revalidator/retry, or tapping the current page again: ask for its data normally.
  if (defaultShouldRevalidate && keyOf(currentUrl) === keyOf(nextUrl)) pages.delete(keyOf(nextUrl));
  return defaultShouldRevalidate;
};
