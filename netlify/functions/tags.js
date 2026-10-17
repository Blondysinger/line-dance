const { json, text, parseJsonBody } = require("../lib/http");
const { getSql, ensureSchema } = require("../lib/db");
const { getCurrentUser } = require("../lib/users");
const { danceTitles } = require("../lib/catalog-store");

// User-scoped tags on dances.
//   GET                   -> { tags, danceTags }
//   GET  ?action=export[&tags=1,2] -> export document (all tags or a subset)
//   PUT  {danceId, tags}  -> replace the tags of one dance -> state
//   POST ?action=import   -> merge an export document      -> state
//   PATCH {id, name, merge?} -> rename a tag on every dance  -> state
//         (409 if another tag already has that name, unless merge=true)
const MAX_TAGS_PER_DANCE = 30;
const MAX_IMPORT_TAGS = 1000;
const PALETTE = ["#7aa2ff", "#34d399", "#f472b6", "#fbbf24", "#a78bfa", "#38bdf8", "#fb923c", "#f87171", "#4ade80", "#e879f9"];

function cleanName(v){
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
}

function defaultColor(name){
  let h = 0;
  for(const ch of name.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function validColor(v){
  const s = String(v || "").trim();
  return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : null;
}

// Dedupes by case-insensitive name, keeping the first occurrence.
function normalizeTags(list, limit){
  const seen = new Map();
  (Array.isArray(list) ? list : []).forEach(t => {
    const raw = typeof t === "string" ? { name: t } : (t || {});
    const name = cleanName(raw.name);
    if(!name || seen.has(name.toLowerCase())) return;
    seen.set(name.toLowerCase(), { name, color: validColor(raw.color), dances: raw.dances, danceIds: raw.danceIds });
  });
  return [...seen.values()].slice(0, limit);
}

async function loadState(sql, uid){
  const tags = await sql`select id, name, color from tags where user_id = ${uid} order by lower(name)`;
  const links = await sql`
    select dt.dance_id, dt.tag_id from dance_tags dt
    join tags t on t.id = dt.tag_id
    where t.user_id = ${uid}`;
  const danceTags = {};
  links.forEach(l => {
    (danceTags[l.dance_id] = danceTags[l.dance_id] || []).push(String(l.tag_id));
  });
  return { tags: tags.map(t => ({ id: String(t.id), name: t.name, color: t.color })), danceTags };
}

// A tag exists only while it is attached to at least one dance.
async function deleteOrphans(sql, uid){
  await sql`
    delete from tags t where t.user_id = ${uid}
    and not exists (select 1 from dance_tags dt where dt.tag_id = t.id)`;
}

async function setDanceTags(sql, uid, body){
  const danceId = Number(body && body.danceId);
  if(!Number.isInteger(danceId)) return text(400, "danceId non valido");
  const tags = normalizeTags(body.tags, MAX_TAGS_PER_DANCE);

  // Tags sent without a color keep their current one (or get a default).
  const current = await sql`select lower(name) as key, color from tags where user_id = ${uid}`;
  const colorByKey = new Map(current.map(r => [r.key, r.color]));
  tags.forEach(t => {
    t.color = t.color || colorByKey.get(t.name.toLowerCase()) || defaultColor(t.name);
  });

  let ids = [];
  if(tags.length){
    const rows = await sql`
      insert into tags (user_id, name, color)
      select ${uid}, n, c from unnest(${tags.map(t => t.name)}::text[], ${tags.map(t => t.color)}::text[]) as x(n, c)
      on conflict (user_id, lower(name)) do update set color = excluded.color
      returning id`;
    ids = rows.map(r => String(r.id));
  }
  await sql.transaction([
    sql`
      delete from dance_tags dt using tags t
      where t.id = dt.tag_id and t.user_id = ${uid} and dt.dance_id = ${danceId}
      and not (dt.tag_id = any(${ids}::bigint[]))`,
    sql`
      insert into dance_tags (tag_id, dance_id)
      select unnest(${ids}::bigint[]), ${danceId}
      on conflict do nothing`,
  ]);
  await deleteOrphans(sql, uid);
  return json(200, await loadState(sql, uid));
}

// The tag is a single row linked to n dances, so renaming it renames it on
// all of them. Renaming onto another existing tag merges the two.
async function renameTag(sql, uid, body){
  const id = String((body && body.id) || "");
  const name = cleanName(body && body.name);
  if(!/^\d+$/.test(id)) return text(400, "id non valido");
  if(!name) return text(400, "Nome non valido");

  const own = await sql`select id, name from tags where id = ${id} and user_id = ${uid}`;
  if(!own[0]) return text(404, "Tag non trovato");

  const clash = await sql`
    select id, name from tags
    where user_id = ${uid} and lower(name) = lower(${name}) and id <> ${id}`;
  if(clash[0]){
    if(!body.merge){
      return json(409, { conflict: { id: String(clash[0].id), name: clash[0].name } });
    }
    const target = clash[0].id;
    await sql.transaction([
      sql`
        insert into dance_tags (tag_id, dance_id)
        select ${target}, dance_id from dance_tags where tag_id = ${id}
        on conflict do nothing`,
      sql`delete from tags where id = ${id} and user_id = ${uid}`,
    ]);
    return json(200, { ...(await loadState(sql, uid)), renamed: { id: String(target), merged: true } });
  }

  await sql`update tags set name = ${name} where id = ${id} and user_id = ${uid}`;
  return json(200, { ...(await loadState(sql, uid)), renamed: { id, merged: false } });
}

async function exportTags(sql, uid, user, only){
  const titles = await danceTitles(sql);
  const state = await loadState(sql, uid);
  const { danceTags } = state;
  // Ids that are not the caller's own tags simply match nothing.
  const tags = only ? state.tags.filter(t => only.has(t.id)) : state.tags;
  const byTag = new Map(tags.map(t => [t.id, []]));
  Object.entries(danceTags).forEach(([danceId, tagIds]) => {
    tagIds.forEach(tid => byTag.get(tid) && byTag.get(tid).push(Number(danceId)));
  });
  return json(200, {
    format: "line-dance-tags",
    version: 1,
    exportedAt: new Date().toISOString(),
    owner: user.email || user.name,
    tags: tags.map(t => ({
      name: t.name,
      color: t.color,
      dances: byTag.get(t.id).sort((a, b) => a - b).map(id => ({ id, dance: titles.get(id) || "" })),
    })),
  });
}

// Merge: existing tags keep their color, links are added, nothing is removed.
async function importTags(sql, uid, body){
  if(!body || !Array.isArray(body.tags)) return text(400, "File non valido: serve { tags: [...] }");
  const known = new Set((await danceTitles(sql)).keys());
  let ignored = 0;

  const tags = normalizeTags(body.tags, MAX_IMPORT_TAGS)
    .map(t => {
      t.color = t.color || defaultColor(t.name);
      const raw = Array.isArray(t.danceIds) ? t.danceIds : (Array.isArray(t.dances) ? t.dances.map(d => d && d.id) : []);
      const ids = [...new Set(raw.map(Number).filter(Number.isInteger))];
      const valid = ids.filter(id => known.has(id));
      ignored += ids.length - valid.length;
      return { ...t, ids: valid };
    })
    .filter(t => t.ids.length);

  let links = 0;
  if(tags.length){
    const rows = await sql`
      insert into tags (user_id, name, color)
      select ${uid}, n, c from unnest(${tags.map(t => t.name)}::text[], ${tags.map(t => t.color)}::text[]) as x(n, c)
      on conflict (user_id, lower(name)) do update set name = tags.name
      returning id, lower(name) as key`;
    const idByKey = new Map(rows.map(r => [r.key, String(r.id)]));
    const pairTag = [];
    const pairDance = [];
    tags.forEach(t => t.ids.forEach(d => {
      pairTag.push(idByKey.get(t.name.toLowerCase()));
      pairDance.push(d);
    }));
    const ins = await sql`
      insert into dance_tags (tag_id, dance_id)
      select * from unnest(${pairTag}::bigint[], ${pairDance}::int[])
      on conflict do nothing
      returning tag_id`;
    links = ins.length;
  }
  const state = await loadState(sql, uid);
  return json(200, { ...state, imported: { tags: tags.length, links, ignoredDances: ignored } });
}

exports.handler = async (event, context) => {
  try{
    const user = await getCurrentUser(event, context);
    if(!user) return text(401, "Unauthorized");
    await ensureSchema();
    const sql = getSql();
    const action = (event.queryStringParameters || {}).action || "";

    if(event.httpMethod === "GET" && action === "export"){
      const raw = (event.queryStringParameters || {}).tags;
      const only = raw ? new Set(raw.split(",").map(s => s.trim()).filter(Boolean)) : null;
      return await exportTags(sql, user.id, user, only);
    }
    if(event.httpMethod === "GET") return json(200, await loadState(sql, user.id));
    if(event.httpMethod === "PUT") return await setDanceTags(sql, user.id, parseJsonBody(event));
    if(event.httpMethod === "PATCH") return await renameTag(sql, user.id, parseJsonBody(event));
    if(event.httpMethod === "POST" && action === "import") return await importTags(sql, user.id, parseJsonBody(event));
    return text(405, "Method not allowed");
  }catch(err){
    console.error("tags error:", err);
    return text(500, `Error: ${err && err.message ? err.message : "unknown"}`);
  }
};
