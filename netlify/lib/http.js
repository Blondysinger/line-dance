function json(statusCode, body, extra = {}){
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(extra.headers || {}),
    },
    ...(extra.cookies && extra.cookies.length ? { multiValueHeaders: { "set-cookie": extra.cookies } } : {}),
    body: JSON.stringify(body),
  };
}

function text(statusCode, body){
  return {
    statusCode,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    body,
  };
}

function redirect(location, cookies = []){
  return {
    statusCode: 302,
    headers: { location, "cache-control": "no-store" },
    ...(cookies.length ? { multiValueHeaders: { "set-cookie": cookies } } : {}),
    body: "",
  };
}

function parseJsonBody(event){
  if(!event.body) return null;
  try{
    const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    return JSON.parse(raw);
  }catch{
    return null;
  }
}

// Public origin of the site (used to build OAuth redirect URIs).
function requestOrigin(event){
  if(process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  try{
    if(event.rawUrl) return new URL(event.rawUrl).origin;
  }catch{}
  const h = event.headers || {};
  const proto = h["x-forwarded-proto"] || "https";
  return `${proto}://${h["x-forwarded-host"] || h.host}`;
}

module.exports = { json, text, redirect, parseJsonBody, requestOrigin };
