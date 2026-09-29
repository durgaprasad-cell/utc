const ACCESS_JWKS_CACHE_MS = 15 * 60 * 1000;
let cachedJwks;

function authError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parseJwtPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

async function loadAccessJwks(teamDomain, fetchImpl, now, forceRefresh = false) {
  if (!forceRefresh && cachedJwks && cachedJwks.expiresAt > now()) return cachedJwks.keys;

  let response;
  try {
    response = await fetchImpl(`${teamDomain}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    throw authError(503, "ACCESS_KEYS_UNAVAILABLE", "Login verification is temporarily unavailable.");
  }

  if (!response.ok) {
    throw authError(503, "ACCESS_KEYS_UNAVAILABLE", "Login verification is temporarily unavailable.");
  }

  const keySet = await response.json();
  if (!Array.isArray(keySet.keys) || keySet.keys.length === 0) {
    throw authError(503, "ACCESS_KEYS_UNAVAILABLE", "Login verification is temporarily unavailable.");
  }

  cachedJwks = { keys: keySet.keys, expiresAt: now() + ACCESS_JWKS_CACHE_MS };
  return cachedJwks.keys;
}

export async function verifyAccessIdentity(request, env, options = {}) {
  const { fetchImpl = fetch, now = Date.now } = options;
  if (env.CF_PAGES_BRANCH === "local" && env.LOCAL_AUTH_BYPASS === "true") {
    const email = (env.LOCAL_ADMIN_EMAIL || "local-admin@example.invalid").trim().toLowerCase();
    return { email, subject: "local-development", local: true };
  }

  const teamDomain = (env.ACCESS_TEAM_DOMAIN || "").replace(/\/$/, "");
  const audience = env.ACCESS_AUD || "";
  if (!teamDomain.startsWith("https://") || !teamDomain.endsWith(".cloudflareaccess.com") || !audience) {
    throw authError(503, "ACCESS_NOT_CONFIGURED", "Cloudflare Access login is not configured.");
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw authError(401, "LOGIN_REQUIRED", "Sign in through Cloudflare Access to continue.");

  const parts = token.split(".");
  if (parts.length !== 3) throw authError(401, "INVALID_ACCESS_TOKEN", "Your login session is invalid or expired.");

  let header;
  let claims;
  try {
    header = parseJwtPart(parts[0]);
    claims = parseJwtPart(parts[1]);
  } catch {
    throw authError(401, "INVALID_ACCESS_TOKEN", "Your login session is invalid or expired.");
  }

  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw authError(401, "INVALID_ACCESS_TOKEN", "Your login session is invalid or expired.");
  }

  let keys = await loadAccessJwks(teamDomain, fetchImpl, now);
  let jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA" && key.alg === "RS256");
  if (!jwk) {
    keys = await loadAccessJwks(teamDomain, fetchImpl, now, true);
    jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA" && key.alg === "RS256");
  }
  if (!jwk) throw authError(401, "INVALID_ACCESS_TOKEN", "Your login session is invalid or expired.");

  let validSignature = false;
  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    validSignature = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      decodeBase64Url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
  } catch {
    throw authError(401, "INVALID_ACCESS_TOKEN", "Your login session is invalid or expired.");
  }

  const currentTime = Math.floor(now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!validSignature || claims.iss !== teamDomain || !audiences.includes(audience) ||
      !Number.isFinite(claims.exp) || claims.exp <= currentTime ||
      (Number.isFinite(claims.nbf) && claims.nbf > currentTime + 60) ||
      typeof claims.sub !== "string" || typeof claims.email !== "string") {
    throw authError(401, "INVALID_ACCESS_TOKEN", "Your login session is invalid or expired.");
  }

  return { email: claims.email.trim().toLowerCase(), subject: claims.sub, local: false };
}

export function isAdminEmail(email, env) {
  const allowed = (env.ADMIN_EMAILS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.toLowerCase());
}

export function authResponse(error, wantsJson) {
  const status = error.status || 503;
  if (wantsJson) {
    return Response.json({ error: { code: error.code || "AUTH_UNAVAILABLE", message: error.message } }, {
      status,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
    });
  }

  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>UTC sign-in required</title><style>body{margin:0;background:#080b10;color:#f5f1e4;font:16px/1.5 system-ui;display:grid;min-height:100vh;place-items:center}main{max-width:32rem;padding:2rem;border:1px solid #b58a32;background:#101720}h1{color:#f2c85e;font-size:1.4rem}a{color:#5fe0ee}</style><main><h1>UTC · United Trading Company</h1><p>${error.message}</p><p>Sign in through your organization’s Cloudflare Access login to continue.</p></main>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });
}