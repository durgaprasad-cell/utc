import { authResponse, isAdminEmail, verifyAccessIdentity } from "./_shared/access.js";

export async function onRequest(context) {
  try {
    const identity = await verifyAccessIdentity(context.request, context.env);
    context.data.identity = identity;
    context.data.isAdmin = identity.local || isAdminEmail(identity.email, context.env);
    return context.next();
  } catch (error) {
    const wantsJson = new URL(context.request.url).pathname.startsWith("/api/");
    return authResponse(error, wantsJson);
  }
}