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
 * cfg: { region, bucket, keyID, secretKey, prefix }
 * opts: { key, method = "GET", contentType = "", expires = 1800, now }
 * Path-style URL: https://s3.<region>.backblazeb2.com/<bucket>/<key>.
 * (A caller-provided cfg.host switches to virtual-host style and the bucket
 * stays out of the path — used by the AWS reference-vector test.)
 * The signature covers host, presign params, and — GET only — content-type.
 * B2 PUT contract (verified against the live endpoint): content-type must
 * NOT be signed for query-auth PUT, though the header itself may be sent.
 */
export async function presignS3(cfg, { key, method = "GET", contentType = "", expires = 1800, now = new Date() }) {
  if (!cfg || !cfg.region || !cfg.keyID || !cfg.secretKey || !key) {
    throw new Error("presignS3: incomplete config");
  }
  // Path-style (B2 endpoint: bucket as first path segment) unless the caller
  // provides a virtual-host style host (the AWS vector's examplebucket host).
  const pathStyle = !cfg.host;
  if (pathStyle && !cfg.bucket) throw new Error("presignS3: incomplete bucket");
  const objectPath = pathStyle ? `${cfg.bucket}/${key}` : key;
  const host = cfg.host || `s3.${cfg.region}.backblazeb2.com`;
  // B2 contract, verified against the live endpoint (2026-10-23): query-auth
  // PUT validates ONLY with host signed — signing content-type (D) or the
  // payload sha (E) yields SignatureDoesNotMatch even though both are legal
  // per the AWS reference. GET validates host-only as the vector shows.
  const signsContentType = contentType && method === "GET";
  const signedHeaders = signsContentType ? "host;content-type" : "host";
  const canonicalHeaders = `host:${host}\n` + (signsContentType ? `content-type:${contentType}\n` : "");

  const amzDate = amzStamp(now);
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${cfg.region}/s3/aws4_request`;

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
    canonicalUri(objectPath),
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

  return `https://${host}/${objectPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
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
    // Browsers report any response lacking CORS headers as "Failed to fetch",
    // and B2 refusals (401/403) come back WITHOUT ACAO — so this catch sees
    // both genuine unreachability and plain auth/capability rejections.
    throw new Error(`network: fetch to https://${host} failed (${err?.message || err}) — network, or B2 refused without CORS headers`);
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
    version: scan.version ?? null, // app version marker (v2.0.16+) — which bundle produced this scan
    uploadedAt: scan.ts,
    device: scan.device || null,
    image: { sha1_16, bytes: scan.blob.size, name: scan.name || null },
    ocr: { text: scan.text },
    parse: { date: scan.parsed?.date, total: scan.parsed?.total, items: scan.parsed?.items, checks: scan.parsed?.checks },
    rescue: scan.rescue, // winner + text of every cascade attempt
    payRescue: {
      amount: scan.payRescue?.amount ?? null, // measured pay-zone re-OCR reading (v2.0.15)
      winner: scan.payRescue?.winner ? { ...scan.payRescue.winner, image: null } : null,
      attempts: scan.payRescue?.attempts ?? null, // strip texts; images stay out of the manifest
    },
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
