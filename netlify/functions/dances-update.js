const { getSql } = require("../lib/db");
const { syncCatalog, CatalogError } = require("../lib/catalog-store");
const { requireRole } = require("../lib/users");

function parseBody(event){
  if(!event.body) return null;
  try{
    return JSON.parse(event.body);
  }catch{
    return null;
  }
}

// BULK write: replaces the whole catalog. The admin saves dance by dance
// (dance.js); this endpoint is kept for explicit bulk tools and refuses to
// run unless the caller proves it read the current catalog:
//   POST { items, replaceAll: true, revision: "<catalog?view=meta revision>" }
exports.handler = async (event, context) => {
  if(event.httpMethod !== "POST"){
    return { statusCode: 405, body: "Method not allowed" };
  }
  const auth = await requireRole(event, context, "editor");
  if(!auth.user) return { statusCode: auth.status, body: auth.message };

  const data = parseBody(event);
  if(!data || !Array.isArray(data.items)){
    return { statusCode: 400, body: "Invalid payload" };
  }
  if(data.replaceAll !== true || !data.revision){
    return { statusCode: 400, body: "Salvataggio dell'intero catalogo: servono replaceAll: true e la revision corrente" };
  }

  try{
    const result = await syncCatalog(getSql(), data.items, { mirror: true, expectedRevision: data.revision });
    return {
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: true, ...result }),
    };
  }catch(err){
    if(err instanceof CatalogError && err.code === "CATALOG_REVISION_CONFLICT"){
      return { statusCode: 409, body: "Il catalogo è stato modificato nel frattempo: ricarica prima del salvataggio bulk" };
    }
    return { statusCode: 500, body: `Error: ${err && err.message ? err.message : "unknown"}` };
  }
};
