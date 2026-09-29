const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function jsonError(status, code, message) {
  return Response.json({ error: { code, message } }, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });
}

function requireAdmin(context) {
  if (!context.data.identity) return jsonError(401, "LOGIN_REQUIRED", "Sign in through Cloudflare Access.");
  if (!context.data.isAdmin) return jsonError(403, "ADMIN_REQUIRED", "Administrator access is required.");
  return null;
}

function getAccessConfig(env) {
  const { CF_ACCESS_API_TOKEN, CF_ACCESS_ACCOUNT_ID, CF_ACCESS_POLICY_ID } = env;
  if (!CF_ACCESS_API_TOKEN || !CF_ACCESS_ACCOUNT_ID || !CF_ACCESS_POLICY_ID) {
    throw new Error("The Cloudflare Access user-management API is not configured.");
  }
  if (!/^[a-f0-9]{32}$/i.test(CF_ACCESS_ACCOUNT_ID) || !/^[\w-]{36}$/.test(CF_ACCESS_POLICY_ID)) {
    throw new Error("The Cloudflare Access account or policy identifier is invalid.");
  }

  return {
    token: CF_ACCESS_API_TOKEN,
    url: `https://api.cloudflare.com/client/v4/accounts/${CF_ACCESS_ACCOUNT_ID}/access/policies/${CF_ACCESS_POLICY_ID}`
  };
}

async function callAccessPolicy(env, method, body, fetchImpl = fetch) {
  let config;
  try {
    config = getAccessConfig(env);
  } catch (error) {
    throw Object.assign(error, { status: 503, code: "ACCESS_USER_MANAGEMENT_NOT_CONFIGURED" });
  }

  let response;
  try {
    response = await fetchImpl(config.url, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    throw Object.assign(new Error("Cloudflare Access could not be reached."), {
      status: 502,
      code: "ACCESS_PROVIDER_UNAVAILABLE"
    });
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw Object.assign(new Error("Cloudflare Access returned an invalid response."), {
      status: 502,
      code: "ACCESS_PROVIDER_INVALID_RESPONSE"
    });
  }

  if (!response.ok || !result.success || !result.result) {
    throw Object.assign(new Error("Cloudflare Access could not update the user policy."), {
      status: 502,
      code: "ACCESS_POLICY_UPDATE_FAILED"
    });
  }

  return result.result;
}

export function listPolicyEmails(policy) {
  return (policy.include || [])
    .map((rule) => rule.email?.email?.trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

export async function addPolicyEmail(env, email, fetchImpl = fetch) {
  const policy = await callAccessPolicy(env, "GET", undefined, fetchImpl);
  if (policy.decision !== "allow") {
    throw Object.assign(new Error("The configured Access policy is not an allow policy."), {
      status: 409,
      code: "ACCESS_POLICY_NOT_ALLOW"
    });
  }
  if (!Array.isArray(policy.include) || policy.include.length === 0 ||
      policy.include.some((rule) => typeof rule.email?.email !== "string")) {
    throw Object.assign(new Error("Configure a dedicated email-only Allow policy for this site before managing users."), {
      status: 409,
      code: "ACCESS_POLICY_MUST_BE_EMAIL_ONLY"
    });
  }

  const existing = listPolicyEmails(policy);
  if (existing.includes(email)) return { email, created: false };

  const update = {
    decision: policy.decision,
    include: [...(policy.include || []), { email: { email } }],
    name: policy.name || "UTC site users",
    exclude: policy.exclude || [],
    require: policy.require || []
  };
  for (const property of ["session_duration", "mfa_config", "approval_required", "approval_groups", "purpose_justification_required", "purpose_justification_prompt", "isolation_required", "connection_rules"]) {
    if (policy[property] !== undefined) update[property] = policy[property];
  }

  await callAccessPolicy(env, "PUT", update, fetchImpl);
  return { email, created: true };
}

export async function onRequestGet(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;

  try {
    const policy = await callAccessPolicy(context.env, "GET");
    return Response.json({ users: listPolicyEmails(policy) }, {
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
    });
  } catch (error) {
    return jsonError(error.status || 502, error.code || "ACCESS_POLICY_READ_FAILED", error.message);
  }
}

export async function onRequestPost(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;

  const origin = context.request.headers.get("origin");
  if (!origin || origin !== new URL(context.request.url).origin) {
    return jsonError(403, "ORIGIN_NOT_ALLOWED", "This request origin is not allowed.");
  }
  if (!context.request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return jsonError(415, "JSON_REQUIRED", "Send a JSON request body.");
  }

  let body;
  try {
    const rawBody = await context.request.text();
    if (rawBody.length > 4096) return jsonError(413, "REQUEST_TOO_LARGE", "The request is too large.");
    body = JSON.parse(rawBody);
  } catch {
    return jsonError(400, "INVALID_JSON", "The request body is invalid.");
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !emailPattern.test(email)) {
    return jsonError(400, "INVALID_EMAIL", "Enter a valid email address.");
  }

  try {
    const result = await addPolicyEmail(context.env, email);
    return Response.json(result, {
      status: result.created ? 201 : 200,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
    });
  } catch (error) {
    return jsonError(error.status || 502, error.code || "ACCESS_POLICY_UPDATE_FAILED", error.message);
  }
}