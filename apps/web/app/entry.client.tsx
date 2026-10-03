// React Router's default bootstrap, with one recovery path for obsolete public documents.
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { createRenderErrorHandler } from "./lib/render-recovery";

// Capture once before hydration: the build this document was rendered from (its route manifest file).
// The development server has no build to replace.
const documentManifest = import.meta.env.DEV ? null : (window as { __reactRouterManifest?: { url?: string } }).__reactRouterManifest?.url ?? null;
const onError = createRenderErrorHandler(documentManifest);

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter onError={onError} />
    </StrictMode>,
  );
});
