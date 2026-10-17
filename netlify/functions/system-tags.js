const { json, text, parseJsonBody } = require("../lib/http");
const { getSql } = require("../lib/db");
const { updateSystemTag, CatalogError } = require("../lib/catalog-store");
const { requireRole } = require("../lib/users");

// Official tags, tag-level operations for the admin page (editors and administrators).
//   PATCH {id, name?, color?, merge?} -> rename / recolor on every dance.
//         409 {conflict} when the name is taken, unless merge: true.
// Assigning tags to a dance is part of the dance save (see dance.js).
exports.handler = async (event, context) => {
  const auth = await requireRole(event, context, "editor");
  if(!auth.user) return text(auth.status, auth.message);
  if(event.httpMethod !== "PATCH") return text(405, "Method not allowed");
  const body = parseJsonBody(event) || {};
  if(!/^\d+$/.test(String(body.id ?? ""))) return text(400, "id non valido");
  try{
    const res = await updateSystemTag(getSql(), body);
    return json(res.conflict ? 409 : 200, res);
  }catch(err){
    if(err instanceof CatalogError) return text(err.code === "TAG_NOT_FOUND" ? 404 : 400, err.message);
    console.error("system-tags error:", err);
    return text(500, `Error: ${err && err.message ? err.message : "unknown"}`);
  }
};
