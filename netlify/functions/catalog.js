const { json, text } = require("../lib/http");
const { getSql } = require("../lib/db");
const { getCurrentUser } = require("../lib/users");
const { listDances, getMeta, catalogRevision } = require("../lib/catalog-store");

// Relational catalog API.
//   GET ?view=meta                       -> levels, property definitions, media providers, total
//   GET ?view=revision                   -> { revision }: cheap change check for polling clients
//   GET ?offset=0&limit=25[&q=]          -> one page (infinite scroll)
//   GET ?level=ADV | ?tags=1,2 | ?stags=3 | ?all=1 -> every match, no paging
//       tags = the caller's personal tags, stags = official (system) tags
// Tag filtering (and tag names in the search) use the caller's own tags.
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

exports.handler = async (event, context) => {
  if(event.httpMethod !== "GET") return text(405, "Method not allowed");
  try{
    const sql = getSql();
    const p = event.queryStringParameters || {};

    if(p.view === "meta") return json(200, await getMeta(sql));
    if(p.view === "revision") return json(200, { revision: await catalogRevision(sql) });

    const level = (p.level || "").trim() || null;
    const q = (p.q || "").trim().slice(0, 100) || null;
    const ids = (v) => (v || "").split(",").map(s => s.trim()).filter(s => /^\d+$/.test(s));
    const tagIds = ids(p.tags);
    const systemTagIds = ids(p.stags);

    let uid = null;
    if(tagIds.length || q){
      const user = await getCurrentUser(event, context);
      if(tagIds.length && !user) return text(401, "Unauthorized");
      uid = user ? user.id : null;
    }

    // A level or tag filter returns the whole (small) result set at once.
    const everything = p.all === "1" || !!level || tagIds.length > 0 || systemTagIds.length > 0;
    const limit = everything ? null : Math.min(Math.max(parseInt(p.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = everything ? 0 : Math.max(parseInt(p.offset, 10) || 0, 0);

    return json(200, await listDances(sql, { offset, limit, level, tagIds, systemTagIds, q, uid }));
  }catch(err){
    console.error("catalog error:", err);
    return text(500, `Error: ${err && err.message ? err.message : "unknown"}`);
  }
};
