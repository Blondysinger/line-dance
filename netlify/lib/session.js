const crypto = require("crypto");

const SESSION_COOKIE = "ld_session";
const OAUTH_COOKIE = "ld_oauth";
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 giorni

function secret(){
  const s = process.env.SESSION_SECRET || "";
  if(s.length < 32) throw new Error("SESSION_SECRET mancante o troppo corto (min 32 caratteri)");
  return s;
}

function mac(body){
  return crypto.createHmac("sha256", secret()).update(body).digest("base64url");
}

// Signed, tamper-proof token: base64url(json).hmac
function sign(payload){
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(body)}`;
}

function verify(token){
  if(typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const a = Buffer.from(sig || "");
  const b = Buffer.from(mac(body));
  if(a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try{
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if(!p || typeof p.exp !== "number" || p.exp < Date.now() / 1000) return null;
    return p;
  }catch{
    return null;
  }
}

function parseCookies(event){
  const h = event.headers || {};
  const raw = h.cookie || h.Cookie || "";
  const out = {};
  raw.split(";").forEach(part => {
    const i = part.indexOf("=");
    if(i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if(k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function serializeCookie(name, value, { maxAge, path = "/", secure = true, sameSite = "Lax" } = {}){
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, "HttpOnly", `SameSite=${sameSite}`];
  if(secure) parts.push("Secure");
  if(maxAge != null) parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}

function nowSec(){ return Math.floor(Date.now() / 1000); }

function readSession(event){
  const token = parseCookies(event)[SESSION_COOKIE];
  if(!token) return null;
  try{
    return verify(token);
  }catch{
    return null;
  }
}

module.exports = {
  SESSION_COOKIE,
  OAUTH_COOKIE,
  SESSION_TTL,
  sign,
  verify,
  parseCookies,
  serializeCookie,
  readSession,
  nowSec,
};
