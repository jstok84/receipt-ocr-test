/**
 * Single source of truth for the app version marker (2026-10-24, user
 * request: "make a version marker on the site so that we are on the same
 * version — no more disputes"). Shown in the header status line, exposed as
 * window.__APP_VERSION, and written into every sync manifest as `version`.
 *
 * RULE: bump this string on EVERY release commit (the v2.x.x in the commit
 * is the same number). The header chip is what the user compares against
 * when a scan misbehaves — "deployed bundle is stale" disputes end here.
 */
export const APP_VERSION = "v2.0.46";

/**
 * Parser version — moved here from inside parseReceipt() on 2026-10-25 so all
 * version strings live in one file (cleanup branch chore/cleanup-2026-10-25).
 * Returned in every parse result as `version` and logged at parse time.
 *
 * Bump RULE differs from APP_VERSION: bump PARSER_VERSION when PARSER LOGIC
 * changes (new patterns, new guards, new arithmetic), not on every release.
 * The two numbers move independently on purpose.
 */
export const PARSER_VERSION = "v1.9.0";
