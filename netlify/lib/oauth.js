const crypto = require("crypto");

function decodeJwtPayload(token){
  const part = String(token || "").split(".")[1];
  if(!part) throw new Error("id_token non valido");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

// Each provider is enabled only when its credentials are set in the env.
const PROVIDERS = {
  google: {
    label: "Google",
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    pkce: true,
    authParams: { prompt: "select_account" },
    // The id_token comes straight from Google's token endpoint over TLS, so
    // checking the claims is enough (OpenID Connect Core §3.1.3.7).
    async profile(tokens){
      const c = decodeJwtPayload(tokens.id_token);
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if(!["accounts.google.com", "https://accounts.google.com"].includes(c.iss)) throw new Error("issuer non valido");
      if(c.aud !== clientId) throw new Error("audience non valida");
      if(!c.exp || c.exp * 1000 < Date.now()) throw new Error("id_token scaduto");
      return {
        providerUserId: String(c.sub),
        email: c.email || null,
        emailVerified: c.email_verified === true || c.email_verified === "true",
        name: c.name || null,
        avatarUrl: c.picture || null,
      };
    },
  },
  facebook: {
    label: "Facebook",
    clientId: () => process.env.FACEBOOK_APP_ID,
    clientSecret: () => process.env.FACEBOOK_APP_SECRET,
    authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
    scope: "email,public_profile",
    pkce: false,
    authParams: {},
    async profile(tokens){
      const u = new URL("https://graph.facebook.com/v21.0/me");
      u.searchParams.set("fields", "id,name,email,picture.type(normal)");
      u.searchParams.set("access_token", tokens.access_token);
      const res = await fetch(u);
      if(!res.ok) throw new Error(`profilo Facebook non disponibile (${res.status})`);
      const p = await res.json();
      return {
        providerUserId: String(p.id),
        email: p.email || null,
        emailVerified: !!p.email,
        name: p.name || null,
        avatarUrl: (p.picture && p.picture.data && p.picture.data.url) || null,
      };
    },
  },
};

function getProvider(name){
  const p = PROVIDERS[name];
  if(!p || !p.clientId() || !p.clientSecret()) return null;
  return p;
}

function enabledProviders(){
  return Object.fromEntries(Object.keys(PROVIDERS).map(k => [k, !!getProvider(k)]));
}

function pkcePair(){
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function buildAuthorizeUrl(p, { redirectUri, state, challenge }){
  const u = new URL(p.authorizeUrl);
  u.searchParams.set("client_id", p.clientId());
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", p.scope);
  u.searchParams.set("state", state);
  if(p.pkce){
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
  }
  Object.entries(p.authParams).forEach(([k, v]) => u.searchParams.set(k, v));
  return u.toString();
}

async function exchangeCode(p, { code, redirectUri, verifier }){
  const body = new URLSearchParams({
    client_id: p.clientId(),
    client_secret: p.clientSecret(),
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  if(p.pkce) body.set("code_verifier", verifier);
  const res = await fetch(p.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if(!res.ok) throw new Error(`token exchange fallito (${res.status}) ${data.error || ""}`.trim());
  return data;
}

module.exports = { getProvider, enabledProviders, pkcePair, buildAuthorizeUrl, exchangeCode };
