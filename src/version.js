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
export const APP_VERSION = "v2.0.23";
