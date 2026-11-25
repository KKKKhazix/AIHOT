/**
 * Copies text; in-app browsers without the async clipboard (WeChat and the like) fall back to a selection
 * copy. Rejects when neither copies.
 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The stand-in box is fixed at the top and off to the side, read-only, at 16px, and takes focus without
    // scrolling: in-app browsers otherwise scrolled the page to it, zoomed in or brought up the keyboard.
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.readOnly = true;
    ta.setAttribute("aria-hidden", "true");
    Object.assign(ta.style, { position: "fixed", top: "0", left: "-9999px", margin: "0", padding: "0", border: "0", fontSize: "var(--text-ui-body-lg)" });
    document.body.appendChild(ta);
    let copied = false;
    try {
      ta.focus({ preventScroll: true });
      ta.select();
      ta.setSelectionRange(0, text.length);
      copied = document.execCommand("copy");
    } finally {
      ta.remove();
      focused?.focus({ preventScroll: true });
    }
    if (!copied) throw new Error("copy failed");
  }
}
