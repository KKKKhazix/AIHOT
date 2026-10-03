// Route module types for the modules' pages (modules/<name>/web/), which React Router's typegen leaves out:
// it types the files under app/ only.
import type { LoaderFunctionArgs, MetaFunction } from "react-router";

export type LoaderArgs = LoaderFunctionArgs;
export type { MetaFunction };

/** What a page component receives: its loader's data. */
export interface ComponentProps<Loader extends (...args: never[]) => unknown> {
  loaderData: Awaited<ReturnType<Loader>>;
}
