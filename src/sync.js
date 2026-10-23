/**
 * Send-to-B2 sync (test channel). Uploads scanned receipts — photo, OCR/parsed
 * JSON, cascade evidence — directly to a user-owned Backblaze B2 bucket via the
 * S3-compatible API using AWS SigV4 presigned URLs computed in the browser.
 *
 * Secret-handling contract:
 *  - The application key (path-scoped, write-only-capable) is entered once on
 *    the device and lives in that device's localStorage only. It is never in
 *    source, the Pages bundle, CI, or the repo.
 *  - The reader key (listFiles/readFiles) is held by the reviewing agent;
 *    it is likewise never shipped in any bundle.
 *
 * Signing conformance is pinned by tests/sync.test.js against the AWS SigV4
 * presigned-URL reference vector.
 */

const CFG_KEY = "ocrSyncCfg";
const enc = new TextEncoder();

export function loadSyncCfg() {
  try {
    return JSON.parse(localStorage.getItem(CFG_KEY) || "null") || null;
  } catch {
    return null;
  }
}

export function saveSyncCfg(cfg) {
  const clean = {};
  for (const [k, v] of Object.entries(cfg)) clean[k] = String(v ?? "").trim();
  if (!clean.prefix.endsWith("/")) clean.prefix += "/";
  localStorage.setItem(CFG_KEY, JSON.stringify(clean));
}

export function clearSyncCfg() {
  localStorage.removeItem(CFG_KEY);
}

/** RFC3986 percent-encoding per the AWS SigV4 spec (uppercase hex, ~ stays raw). */
function awsUriEncode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/** Canonical URI: every path segment individually encoded, slashes kept, leading slash included. */
function canonicalUri(key) {
  return "/" + key.split("/").map(awsUriEncode).join("/");
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(keyBytes, msgBytes) {
  const k = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, msgBytes));
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return toHex(new Uint8Array(digest));
}

function amzStamp(now) {
  const d = now ?? new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    "T" + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + "Z"
  );
}

/**
 * Compose a presigned S3 URL (PUT or GET) for a user-scoped B2 app key.
 * cfg: { region, keyID, secretKey, prefix }
 * opts: { key, method = "GET", contentType = "", expires = 1800, now }
 * The URL is single-use in signing terms only: signature covers host,
 * content-type (when given) and presign params; passes within expiry.
 */
export async function presignS3(cfg, { key, method = "GET", contentType = "", expires = 1800, now = new Date() }) {
  if (!cfg || !cfg.region || !cfg.keyID || !cfg.secretKey || !key) {
    throw new Error("presignS3: incomplete config");
  }
  const host = cfg.host || `s3.${cfg.region}.backblazeb2.com`;
  const amzDate = amzStamp(now);
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const signedHeaders = contentType ? "host;content-type" : "host";
  const canonicalHeaders = `host:${host}\n` + (contentType ? `content-type:${contentType}\n` : "");

  const params = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${cfg.keyID}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expires)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ].sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const canonicalQuery = params
    .map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`)
    .join("&");

  const canonicalRequest = [
    method,
    canonicalUri(key),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmac(enc.encode("AWS4" + cfg.secretKey), enc.encode(date));
  const kRegion = await hmac(kDate, enc.encode(cfg.region));
  const kService = await hmac(kRegion, enc.encode("s3"));
  const kSigning = await hmac(kService, enc.encode("aws4_request"));
  const signature = toHex(await hmac(kSigning, enc.encode(stringToSign)));

  return `https://${host}/${key}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function sha1Hex(buf) {
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return toHex(new Uint8Array(digest)).slice(0, 16);
}

async function putObject(cfg, key, blob, contentType) {
  const host = `s3.${cfg.region}.backblazeb2.com`;
  const url = await presignS3(cfg, { key, method: "PUT", contentType, expires: 1800 });
  let res;
  try {
    res = await fetch(url, {
      method: "PUT",
      body: blob,
      headers: { "Content-Type": contentType },
    });
  } catch (err) {
    // Browsers give this the opaque name "Failed to fetch"; the host is the
    // actionable part — a DNS- dead region (typo) looks exactly like a CORS
    // refusal from in-page diagnostics that only see this exception.
    throw new Error(`network: cannot reach https://${host} (${err?.message || err})`);
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 160);
    throw new Error(`B2 upload failed (HTTP ${res.status}): ${detail}`);
  }
}

/**
 * Upload one scan: photo + JSON manifest (+ strips when the cascade produced
 * them). Returns object keys. Strips are data-bearing for the reviewing agent,
 * so they ride in a sibling file keyed like the manifest.
 */
export async function uploadScan(cfg, scan) {
  if (!cfg) throw new Error("uploadScan: no sync config");
  const sha1_16 = await sha1Hex(await scan.blob.arrayBuffer());
  const base = `${cfg.prefix}${scan.ts}-${scan.device || "d"}-${sha1_16}`;
  const photoKey = base + ".jpg";
  const jsonKey = base + ".json";
  await putObject(cfg, photoKey, scan.blob, scan.blob.type || "image/jpeg");

  const manifest = {
    v: 1,
    uploadedAt: scan.ts,
    device: scan.device || null,
    image: { sha1_16, bytes: scan.blob.size, name: scan.name || null },
    ocr: { text: scan.text },
    parse: { date: scan.parsed?.date, total: scan.parsed?.total, items: scan.parsed?.items, checks: scan.parsed?.checks },
    rescue: scan.rescue, // winner + text of every cascade attempt
    corrections: scan.corrections,
    timings: { totalMs: scan.ms ?? null },
    ua: scan.ua ?? null,
  };
  await putObject(
    cfg,
    jsonKey,
    new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }),
    "application/json"
  );
  return { photoKey, jsonKey };
}
