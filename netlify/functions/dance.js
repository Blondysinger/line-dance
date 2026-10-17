const { json, text, parseJsonBody } = require("../lib/http");
const { getSql } = require("../lib/db");
const { saveDance, deleteDance, reorderDances, getDance, CatalogError } = require("../lib/catalog-store");
const { requireRole } = require("../lib/users");

// Single-dance writes for the admin page (editors and administrators).
//   POST   {item}                      -> create (id assigned by the server)  -> {item}
//   PUT    {item, version}             -> update one dance                     -> {item}
//   DELETE ?id=12&version=4            -> delete one dance                     -> {ok}
//   POST   ?action=order {ids:[...]}   -> save the catalog order only          -> {ok}
// A stale `version` answers 409 with the current dance, never overwrites it.
exports.handler = async (event, context) => {
  const auth = await requireRole(event, context, "editor");
  if(!auth.user) return text(auth.status, auth.message);
  const sql = getSql();
  const q = event.queryStringParameters || {};
  const body = parseJsonBody(event) || {};

  try{
    if(event.httpMethod === "POST" && q.action === "order"){
      if(!Array.isArray(body.ids)) return text(400, "ids mancanti");
      await reorderDances(sql, body.ids);
      return json(200, { ok: true });
    }
    if(event.httpMethod === "POST"){
      if(!body.item) return text(400, "item mancante");
      return json(201, { item: await saveDance(sql, body.item, { create: true }) });
    }
    if(event.httpMethod === "PUT"){
      if(!body.item || body.item.id == null) return text(400, "item mancante");
      return json(200, { item: await saveDance(sql, body.item, { expectedVersion: body.version ?? body.item.version }) });
    }
    if(event.httpMethod === "DELETE"){
      if(!/^\d+$/.test(q.id || "")) return text(400, "id non valido");
      await deleteDance(sql, q.id, q.version != null ? Number(q.version) : null);
      return json(200, { ok: true });
    }
    return text(405, "Method not allowed");
  }catch(err){
    if(err instanceof CatalogError){
      const id = (body.item && body.item.id) ?? q.id;
      if(err.code === "DANCE_VERSION_CONFLICT"){
        return json(409, { error: err.code, current: id != null ? await getDance(sql, id) : null });
      }
      if(err.code === "DANCE_NOT_FOUND") return json(404, { error: err.code });
      if(err.code === "CATALOG_REVISION_CONFLICT") return json(409, { error: err.code, message: err.message });
    }
    console.error("dance error:", err);
    return text(500, `Error: ${err && err.message ? err.message : "unknown"}`);
  }
};
