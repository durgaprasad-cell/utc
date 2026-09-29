const test = require("node:test");
const assert = require("node:assert/strict");
const { addPolicyEmail, listPolicyEmails, onRequestGet } = require("../functions/api/admin/users");
const { isAdminEmail, verifyAccessIdentity } = require("../functions/_shared/access");
const { onRequest: protectPages } = require("../functions/_middleware");

const teamDomain = "https://utc-team.cloudflareaccess.com";
const audience = "utc-pages-access-audience";
const accountId = "a".repeat(32);
const policyId = "12345678-1234-1234-1234-123456789abc";

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createAccessToken({ keyPair, kid, tokenAudience = audience, now = Date.now() }) {
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid })));
  const claims = base64Url(new TextEncoder().encode(JSON.stringify({
    iss: teamDomain,
    aud: tokenAudience,
    sub: "access-subject-1",
    email: "admin@utc.example",
    exp: Math.floor(now / 1000) + 300
  })));
  const input = `${header}.${claims}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(input));
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

test("Cloudflare Access JWT signature, issuer, and audience are validated", async () => {
  const keyPair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  publicJwk.kid = "test-access-key";
  publicJwk.alg = "RS256";
  const fetchImpl = async () => ({ ok: true, json: async () => ({ keys: [publicJwk] }) });
  const now = Date.now();
  const env = { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: audience };
  const token = await createAccessToken({ keyPair, kid: publicJwk.kid, now });
  const identity = await verifyAccessIdentity(new Request("https://utc.example", {
    headers: { "cf-access-jwt-assertion": token }
  }), env, { fetchImpl, now: () => now });

  assert.strictEqual(identity.email, "admin@utc.example");
  assert.strictEqual(isAdminEmail(identity.email, { ADMIN_EMAILS: "other@utc.example, ADMIN@UTC.EXAMPLE " }), true);

  const wrongAudience = await createAccessToken({ keyPair, kid: publicJwk.kid, tokenAudience: "wrong", now });
  await assert.rejects(
    verifyAccessIdentity(new Request("https://utc.example", {
      headers: { "cf-access-jwt-assertion": wrongAudience }
    }), env, { fetchImpl, now: () => now }),
    { code: "INVALID_ACCESS_TOKEN", status: 401 }
  );
});

test("production Access verification fails closed when identity configuration or token is missing", async () => {
  await assert.rejects(
    verifyAccessIdentity(new Request("https://utc.example"), {}, { fetchImpl: async () => { throw new Error("must not fetch"); } }),
    { code: "ACCESS_NOT_CONFIGURED", status: 503 }
  );
  await assert.rejects(
    verifyAccessIdentity(new Request("https://utc.example"), {
      ACCESS_TEAM_DOMAIN: teamDomain,
      ACCESS_AUD: audience
    }, { fetchImpl: async () => { throw new Error("must not fetch"); } }),
    { code: "LOGIN_REQUIRED", status: 401 }
  );
});

test("site middleware permits the explicit local bypass only on the local Pages branch", async () => {
  const localContext = {
    request: new Request("http://localhost:8788/"),
    env: { CF_PAGES_BRANCH: "local", LOCAL_AUTH_BYPASS: "true", LOCAL_ADMIN_EMAIL: "admin@utc.example" },
    data: {},
    next: async () => new Response("local page")
  };
  const localResponse = await protectPages(localContext);
  assert.strictEqual(localResponse.status, 200);
  assert.strictEqual(localContext.data.identity.email, "admin@utc.example");
  assert.strictEqual(localContext.data.isAdmin, true);

  const productionContext = {
    request: new Request("https://utc.example/"),
    env: { CF_PAGES_BRANCH: "main", LOCAL_AUTH_BYPASS: "true" },
    data: {},
    next: async () => new Response("must not continue")
  };
  const productionResponse = await protectPages(productionContext);
  assert.strictEqual(productionResponse.status, 503);
});

test("non-admin Access identities are denied by the user-management API", async () => {
  const response = await onRequestGet({
    data: {
      identity: { email: "member@utc.example" },
      isAdmin: false
    },
    env: {}
  });

  assert.strictEqual(response.status, 403);
  assert.strictEqual((await response.json()).error.code, "ADMIN_REQUIRED");
});

test("admin-created email is appended to the existing allow policy without replacing current rules", async () => {
  const env = {
    CF_ACCESS_API_TOKEN: "test-token",
    CF_ACCESS_ACCOUNT_ID: accountId,
    CF_ACCESS_POLICY_ID: policyId
  };
  const currentPolicy = {
    decision: "allow",
    name: "UTC all-site access",
    include: [{ email: { email: "admin@utc.example" } }],
    exclude: [{ email: { email: "blocked@utc.example" } }],
    require: [],
    session_duration: "12h"
  };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    return {
      ok: true,
      json: async () => ({
        success: true,
        result: options.method === "PUT"
          ? { ...currentPolicy, ...JSON.parse(options.body) }
          : currentPolicy
      })
    };
  };

  assert.deepStrictEqual(listPolicyEmails(currentPolicy), ["admin@utc.example"]);
  const created = await addPolicyEmail(env, "new.user@utc.example", fetchImpl);
  assert.deepStrictEqual(created, { email: "new.user@utc.example", created: true });
  assert.strictEqual(requests.length, 2);
  assert.strictEqual(requests[0].options.method, "GET");
  assert.strictEqual(requests[1].options.method, "PUT");
  const update = JSON.parse(requests[1].options.body);
  assert.deepStrictEqual(update.include, [
    { email: { email: "admin@utc.example" } },
    { email: { email: "new.user@utc.example" } }
  ]);
  assert.deepStrictEqual(update.exclude, currentPolicy.exclude);
  assert.strictEqual(update.session_duration, "12h");
  assert.strictEqual(requests[0].options.headers.Authorization, "Bearer test-token");
});

test("admin-created duplicate email does not rewrite the Access policy", async () => {
  const env = {
    CF_ACCESS_API_TOKEN: "test-token",
    CF_ACCESS_ACCOUNT_ID: accountId,
    CF_ACCESS_POLICY_ID: policyId
  };
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount++;
    return {
      ok: true,
      json: async () => ({
        success: true,
        result: {
          decision: "allow",
          include: [{ email: { email: "member@utc.example" } }]
        }
      })
    };
  };

  const result = await addPolicyEmail(env, "member@utc.example", fetchImpl);
  assert.deepStrictEqual(result, { email: "member@utc.example", created: false });
  assert.strictEqual(requestCount, 1);
});

test("user provisioning refuses a broad Access policy", async () => {
  const env = {
    CF_ACCESS_API_TOKEN: "test-token",
    CF_ACCESS_ACCOUNT_ID: accountId,
    CF_ACCESS_POLICY_ID: policyId
  };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      success: true,
      result: { decision: "allow", include: [{ everyone: {} }] }
    })
  });

  await assert.rejects(
    addPolicyEmail(env, "new.user@utc.example", fetchImpl),
    { code: "ACCESS_POLICY_MUST_BE_EMAIL_ONLY", status: 409 }
  );
});