/**
 * SigV4 presigner conformance — locked exactly to the AWS reference vector
 * (docs.aws.amazon.com, "Signing an S3 request" — presigned GET example).
 * Expected signature: aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265987e7123cfd35e84dd9
 * Any change to canonical construction, encoding, or key derivation makes this
 * fail first — that is the fix for "a subtly wrong signer uploads nothing and
 * blames no one".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { presignS3 } from "../src/sync.js";

const CFG = {
  region: "us-east-1",
  keyID: "AKIAIOSFODNN7EXAMPLE",
  secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  // the vector's bucket host
  host: "examplebucket.s3.amazonaws.com",
  prefix: "",
};

const T0 = new Date("2013-05-24T00:00:00Z");

test("presignS3 reproduces the AWS presigned-GET vector byte-for-byte", async () => {
  const url = await presignS3(CFG, { method: "GET", key: "test.txt", expires: 86400, now: T0 });
  assert.ok(
    url.includes(
      "X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
    ),
    "signature does not match the AWS reference vector (canonical hash 3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04)"
  );
  const u = new URL(url);
  assert.equal(u.host, "examplebucket.s3.amazonaws.com");
  assert.equal(u.pathname, "/test.txt");
  assert.equal(u.searchParams.get("X-Amz-Credential"), "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request");
  assert.equal(u.searchParams.get("X-Amz-Date"), "20130524T000000Z");
  assert.equal(u.searchParams.get("X-Amz-Expires"), "86400");
  assert.equal(u.searchParams.get("X-Amz-SignedHeaders"), "host");
});

test("presignS3 is deterministic for identical inputs", async () => {
  const a = await presignS3(CFG, { method: "GET", key: "receipts/S25/x.jpg", now: T0 });
  const b = await presignS3(CFG, { method: "GET", key: "receipts/S25/x.jpg", now: T0 });
  assert.equal(a, b);
});

test("presignS3 encodes the credential scope and sorts query params", async () => {
  const url = await presignS3(CFG, { method: "GET", key: "receipts/S25/x.jpg", now: T0 });
  assert.ok(url.includes("X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request"));
  const algo = url.indexOf("X-Amz-Algorithm");
  const cred = url.indexOf("X-Amz-Credential");
  const amzDate = url.indexOf("X-Amz-Date");
  const exp = url.indexOf("X-Amz-Expires");
  assert.ok(algo < cred && cred < amzDate && amzDate < exp, "query params not sorted");
});

test("presignS3 signs content-type into signed headers when provided", async () => {
  const url = await presignS3(CFG, {
    method: "PUT",
    key: "receipts/S25/x.jpg",
    contentType: "image/jpeg",
    now: T0,
  });
  assert.ok(url.includes("X-Amz-SignedHeaders=host%3Bcontent-type"));
});
