const crypto = require("crypto");
const { json, text, redirect, requestOrigin } = require("../lib/http");
const {
  SESSION_COOKIE, OAUTH_COOKIE, SESSION_TTL,
  sign, verify, parseCookies, serializeCookie, nowSec,
} = require("../lib/session");
const { getProvider, enabledProviders, pkcePair, buildAuthorizeUrl, exchangeCode } = require("../lib/oauth");
const { upsertIdentity, getCurrentUser } = require("../lib/users");

// Routes (all under /.netlify/functions/auth):
//   GET  /login/:provider?return=/path  -> redirect to the provider
//   GET  /callback/:provider            -> OAuth redirect URI
//   GET  /me                            -> { user, providers }
//   POST /logout                        -> clears the session cookie
const BASE = "/.netlify/functions/auth";

function route(event){
  const path = (event.path || "").replace(/\/+$/, "");
  const i = path.indexOf("/auth");
  return path.slice(i + "/auth".length).split("/").filter(Boolean);
}

function safeReturnTo(v){
  const s = String(v || "/");
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
}

function backWithError(returnTo, code, cookies = []){
  const sep = returnTo.includes("?") ? "&" : "?";
  return redirect(`${returnTo}${sep}authError=${encodeURIComponent(code)}`, cookies);
}

exports.handler = async (event, context) => {
  const [action, providerName] = route(event);
  const origin = requestOrigin(event);
  const secure = origin.startsWith("https://");

  try{
    if(action === "me" && event.httpMethod === "GET"){
      const user = await getCurrentUser(event, context);
      return json(200, { user, providers: enabledProviders() });
    }

    if(action === "logout" && event.httpMethod === "POST"){
      return json(200, { ok: true }, {
        cookies: [serializeCookie(SESSION_COOKIE, "", { maxAge: 0, secure })],
      });
    }

    if(action === "login" && event.httpMethod === "GET"){
      const p = getProvider(providerName);
      if(!p) return text(400, `Provider non configurato: ${providerName}`);
      const returnTo = safeReturnTo(event.queryStringParameters && event.queryStringParameters.return);
      const state = crypto.randomBytes(16).toString("base64url");
      const { verifier, challenge } = pkcePair();
      const redirectUri = `${origin}${BASE}/callback/${providerName}`;
      const flow = sign({ s: state, v: verifier, r: returnTo, p: providerName, exp: nowSec() + 600 });
      return redirect(buildAuthorizeUrl(p, { redirectUri, state, challenge }), [
        serializeCookie(OAUTH_COOKIE, flow, { maxAge: 600, path: BASE, secure }),
      ]);
    }

    if(action === "callback" && event.httpMethod === "GET"){
      const clearFlow = serializeCookie(OAUTH_COOKIE, "", { maxAge: 0, path: BASE, secure });
      const q = event.queryStringParameters || {};
      const flow = verify(parseCookies(event)[OAUTH_COOKIE]);
      const returnTo = safeReturnTo(flow && flow.r);
      if(q.error) return backWithError(returnTo, q.error, [clearFlow]);
      if(!flow || flow.p !== providerName || !q.state || q.state !== flow.s){
        return backWithError(returnTo, "invalid_state", [clearFlow]);
      }
      const p = getProvider(providerName);
      if(!p) return backWithError(returnTo, "provider_disabled", [clearFlow]);

      const tokens = await exchangeCode(p, {
        code: q.code,
        redirectUri: `${origin}${BASE}/callback/${providerName}`,
        verifier: flow.v,
      });
      const profile = await p.profile(tokens);
      const user = await upsertIdentity({ provider: providerName, ...profile });
      const session = sign({ uid: String(user.id), p: providerName, exp: nowSec() + SESSION_TTL });
      return redirect(returnTo, [
        clearFlow,
        serializeCookie(SESSION_COOKIE, session, { maxAge: SESSION_TTL, secure }),
      ]);
    }

    return text(404, "Not found");
  }catch(err){
    console.error("auth error:", err);
    if(action === "callback") return backWithError("/", "login_failed");
    return text(500, `Error: ${err && err.message ? err.message : "unknown"}`);
  }
};
