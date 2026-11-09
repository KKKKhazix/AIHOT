// A press a page wants counted, such as which deal's 去领 was followed: handed to the modules that count
// (WebModule.onClick). A site without one counts nothing.
import { webModules } from "../site-modules";

/** `target` says what was pressed in a few words, and nothing about the reader: "go:<deal id>". */
export function reportClick(target: string): void {
  for (const m of webModules()) m.onClick?.(target);
}
