// Relational catalog: dances + lookups (levels, styles, choreographers),
// media links (dance_media / media_providers) and configurable properties
// (dance_properties / property_definitions). See doc/modello-dati.md.
//
// The API keeps exposing the historical item shape (year, dance, videos,
// spotifyUrl, details, ...) so existing clients and the line_dance_data JSON
// mirror keep working; new clients can also use `media`, `properties`,
// `choreographers` and `detailsExtra`.
const { ensureSchema } = require("./db");
const { readCatalog, normalizeItem } = require("./catalog");

const str = (v) => (v ?? "").toString().trim();

function camel(code){
  return code.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());
}

// Legacy field names derived from the provider code: youtube -> videos,
// other video providers -> <code>Videos, everything else -> <code>Url (+Title).
function providerFields(p){
  if(p.kind === "video") return { list: p.code === "youtube" ? "videos" : `${camel(p.code)}Videos` };
  return { url: `${camel(p.code)}Url`, title: p.has_title ? `${camel(p.code)}Title` : null };
}

function intOrNull(v){
  if(v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/* ---------- difficulty levels ---------- */

// Old "anno di corso" codes -> difficulty level codes (null = no difficulty).
const LEGACY_LEVELS = {
  "1": "beginner",
  "2": "easy_improver",
  "3": "improver",
  "3+": "improver",
  "adv": "easy_intermediate",
  "master": "intermediate",
  "event": null,
};

// Accepts a level code ("easy_improver"), its label ("Easy Improver") or an
// old class code ("2"). Unknown values are rejected, never silently dropped.
function resolveLevel(cfg, it){
  const raw = str(it.level) || str(it.year);
  if(!raw) return null;
  const k = raw.toLowerCase();
  const byCode = cfg.levels.find(l => l.code.toLowerCase() === k || str(l.label).toLowerCase() === k);
  if(byCode) return byCode;
  if(k in LEGACY_LEVELS){
    const target = LEGACY_LEVELS[k];
    return target ? cfg.levels.find(l => l.code === target) || null : null;
  }
  throw new CatalogError("INVALID", `Livello di difficoltà sconosciuto: "${raw}"`);
}

/* ---------- choreographers ---------- */

function splitNames(v){
  return [...new Set(str(v).split(/\s*(?:,|;|&|\s+e\s+)\s*/i).map(s => s.trim()).filter(Boolean))];
}

function joinNames(names){
  if(names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
}

/* ---------- properties <-> details text ---------- */

function castValue(def, raw){
  if(raw == null) return null;
  if(def.data_type === "boolean"){
    if(typeof raw === "boolean") return raw;
    const s = str(raw).toLowerCase();
    if(!s) return null;
    return ["1", "true", "si", "sì", "yes", "on"].includes(s);
  }
  const s = str(raw);
  if(!s) return null;
  if(def.data_type === "number"){
    const n = Number(s.replace(",", "."));
    return Number.isFinite(n) ? n : s;
  }
  return s;
}

// "Tempi: 32\nMuri: 4\nnote libere" -> { counts: "32", walls: "4" } + "note libere"
function parseDetails(text, defs){
  const byLabel = new Map(defs.filter(d => d.details_label).map(d => [d.details_label.toLowerCase(), d]));
  const props = {};
  const extra = [];
  String(text || "").split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([^:]{1,40}):\s*(.*)$/);
    const def = m && byLabel.get(m[1].trim().toLowerCase());
    if(def && !(def.key in props)){
      const v = castValue(def, m[2]);
      if(v != null) props[def.key] = v;
      return;
    }
    extra.push(line);
  });
  while(extra.length && !extra[extra.length - 1].trim()) extra.pop();
  while(extra.length && !extra[0].trim()) extra.shift();
  return { props, extra: extra.join("\n") };
}

function composeDetails(props, extra, defs){
  const lines = defs
    .filter(d => d.details_label && props[d.key] != null && props[d.key] !== "")
    .map(d => `${d.details_label}: ${props[d.key]}`);
  if(str(extra)) lines.push(String(extra).trim());
  return lines.join("\n");
}

/* ---------- item (API / legacy JSON) <-> record ---------- */

// A record is the relational view of one dance, shared by reads and writes.
function itemToRecord(raw, cfg, index){
  const it = normalizeItem(raw);
  const id = Number(it.id);
  if(!Number.isInteger(id)) throw new Error(`id non valido: ${it.id}`);

  // `properties` present = new clients (details is derived); otherwise parse details.
  let props = {};
  let extra = "";
  if(it.properties && typeof it.properties === "object" && !Array.isArray(it.properties)){
    cfg.defs.forEach(d => {
      const v = castValue(d, it.properties[d.key]);
      if(v != null) props[d.key] = v;
    });
    extra = str(it.detailsExtra);
  } else {
    ({ props, extra } = parseDetails(it.details, cfg.defs));
  }

  const media = [];
  cfg.providers.forEach(p => {
    const f = providerFields(p);
    if(f.list){
      (Array.isArray(it[f.list]) ? it[f.list] : []).forEach(v => {
        if(!v || !str(v.url)) return;
        media.push({
          provider: p.code,
          url: str(v.url),
          title: str(v.title),
          startSeconds: intOrNull(v.startSeconds),
          danceStartSeconds: intOrNull(v.danceStartSeconds),
        });
      });
    } else if(str(it[f.url])){
      media.push({ provider: p.code, url: str(it[f.url]), title: f.title ? str(it[f.title]) : "", startSeconds: null, danceStartSeconds: null });
    }
  });

  const level = resolveLevel(cfg, it);
  return {
    id,
    title: str(it.dance),
    songTitle: str(it.songTitle),
    levelId: level ? level.id : null,
    level: level ? level.code : "",
    levelLabel: level ? (level.label || level.code) : "",
    style: str(it.style),
    choreographers: Array.isArray(it.choreographers) ? it.choreographers.map(str).filter(Boolean) : splitNames(it.choreographer),
    notes: String(it.notes ?? ""),
    detailsExtra: extra,
    properties: props,
    media,
    systemTags: normalizeSystemTags(it.systemTags),
    sortOrder: index,
  };
}

const PALETTE = ["#7aa2ff", "#34d399", "#f472b6", "#fbbf24", "#a78bfa", "#38bdf8", "#fb923c", "#f87171", "#4ade80", "#e879f9"];

function defaultColor(name){
  let h = 0;
  for(const ch of name.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// [{name, color}] or ["name"] -> deduped [{name, color}] (case-insensitive)
function normalizeSystemTags(list){
  const seen = new Map();
  (Array.isArray(list) ? list : []).forEach(t => {
    const raw = typeof t === "string" ? { name: t } : (t || {});
    const name = str(raw.name).replace(/\s+/g, " ").slice(0, 40);
    if(!name || seen.has(name.toLowerCase())) return;
    const color = /^#[0-9a-f]{6}$/i.test(str(raw.color)) ? str(raw.color).toLowerCase() : defaultColor(name);
    const id = /^\d+$/.test(String(raw.id ?? "")) ? Number(raw.id) : null;
    seen.set(name.toLowerCase(), { id, name, color });
  });
  return [...seen.values()];
}

function recordToItem(r, cfg){
  const item = {
    id: r.id,
    // `year` keeps its historical name for older clients: it is the label of
    // the difficulty level; `level` is the level code.
    year: r.levelLabel || "",
    level: r.level || "",
    dance: r.title,
    style: r.style || "",
    songTitle: r.songTitle,
    choreographer: joinNames(r.choreographers),
    choreographers: r.choreographers,
    details: composeDetails(r.properties, r.detailsExtra, cfg.defs),
    detailsExtra: r.detailsExtra,
    notes: r.notes,
    properties: r.properties,
    media: r.media,
    systemTags: r.systemTags || [],
    version: r.version,
  };
  cfg.providers.forEach(p => {
    const f = providerFields(p);
    const rows = r.media.filter(m => m.provider === p.code);
    if(f.list){
      item[f.list] = rows.map(m => ({
        url: m.url,
        title: m.title,
        startSeconds: m.startSeconds ?? "",
        danceStartSeconds: m.danceStartSeconds ?? "",
      }));
    } else {
      item[f.url] = rows[0] ? rows[0].url : "";
      if(f.title) item[f.title] = rows[0] ? rows[0].title : "";
    }
  });
  // Mirrors videos[0] into youtubeUrl/videoTitle/... for older clients.
  return normalizeItem(item);
}

/* ---------- config ---------- */

async function loadConfig(sql){
  const [defs, providers, levels] = await Promise.all([
    sql`select key, label, details_label, data_type, sort_order, is_public, is_filterable
        from property_definitions order by sort_order, key`,
    sql`select code, label, kind, has_title, sort_order from media_providers order by sort_order, code`,
    sql`select id, code, label, sort_order from levels order by sort_order, code`,
  ]);
  return { defs, providers, levels };
}

/* ---------- writes ---------- */

// Case-insensitive upsert of lookup names; returns lower(name) -> id.
// `table` / `col` are constants from this module, never user input.
async function upsertLookup(sql, table, col, values){
  const uniq = [...new Map(values.filter(Boolean).map(v => [v.toLowerCase(), v])).values()];
  if(!uniq.length) return new Map();
  await sql(`insert into ${table} (${col}) select unnest($1::text[]) on conflict ((lower(${col}))) do nothing`, [uniq]);
  const rows = await sql(`select id, lower(${col}) as k from ${table} where lower(${col}) = any($1::text[])`, [uniq.map(v => v.toLowerCase())]);
  return new Map(rows.map(r => [r.k, r.id]));
}

// Styles and choreographers are free text (created on demand); difficulty
// levels are a configured list resolved in itemToRecord.
async function resolveLookups(sql, recs){
  const styleIds = await upsertLookup(sql, "styles", "name", recs.map(r => r.style));
  const choreoIds = await upsertLookup(sql, "choreographers", "name", recs.flatMap(r => r.choreographers));
  return { styleIds, choreoIds };
}

// Rows of the child tables (choreographers, media, properties, system tags).
function childRows(recs, choreoIds, sysIdOf){
  const dc = { d: [], c: [], p: [] };
  const dm = { d: [], prov: [], url: [], title: [], pos: [], start: [], dance: [] };
  const dp = { d: [], k: [], v: [] };
  const ds = { t: [], d: [], p: [] };
  recs.forEach(r => {
    r.choreographers.forEach((name, i) => { dc.d.push(r.id); dc.c.push(choreoIds.get(name.toLowerCase())); dc.p.push(i); });
    const pos = {};
    r.media.forEach(m => {
      pos[m.provider] = (pos[m.provider] ?? -1) + 1;
      dm.d.push(r.id); dm.prov.push(m.provider); dm.url.push(m.url); dm.title.push(m.title);
      dm.pos.push(pos[m.provider]); dm.start.push(m.startSeconds); dm.dance.push(m.danceStartSeconds);
    });
    Object.entries(r.properties).forEach(([k, v]) => { dp.d.push(r.id); dp.k.push(k); dp.v.push(JSON.stringify(v)); });
    const seen = new Set();
    r.systemTags.forEach(t => {
      const id = sysIdOf(t);
      if(id == null || seen.has(id)) return;
      seen.add(id);
      ds.t.push(id); ds.d.push(r.id); ds.p.push(seen.size - 1);
    });
  });
  return { dc, dm, dp, ds };
}

// Replace the child rows of the dances `ids`.
function childStatements(sql, ids, { dc, dm, dp, ds }){
  return [
    sql`delete from dance_choreographers where dance_id = any(${ids}::int[])`,
    sql`
      insert into dance_choreographers (dance_id, choreographer_id, position)
      select * from unnest(${dc.d}::int[], ${dc.c}::int[], ${dc.p}::int[])`,
    sql`delete from dance_media where dance_id = any(${ids}::int[])`,
    sql`
      insert into dance_media (dance_id, provider_code, url, title, position, start_seconds, dance_start_seconds)
      select * from unnest(${dm.d}::int[], ${dm.prov}::text[], ${dm.url}::text[], ${dm.title}::text[],
        ${dm.pos}::int[], ${dm.start}::int[], ${dm.dance}::int[])`,
    sql`delete from dance_properties where dance_id = any(${ids}::int[])`,
    sql`
      insert into dance_properties (dance_id, property_key, value)
      select d, k, v::jsonb from unnest(${dp.d}::int[], ${dp.k}::text[], ${dp.v}::text[]) as x(d, k, v)`,
    sql`delete from dance_system_tags where dance_id = any(${ids}::int[])`,
    sql`
      insert into dance_system_tags (tag_id, dance_id, position)
      select * from unnest(${ds.t}::int[], ${ds.d}::int[], ${ds.p}::int[])`,
  ];
}

// Lookup rows and system tags nobody uses anymore (difficulty levels are
// configuration and stay even when unused).
function cleanupStatements(sql){
  return [
    sql`delete from styles s where not exists (select 1 from dances d where d.style_id = s.id)`,
    sql`delete from choreographers c where not exists (select 1 from dance_choreographers dc where dc.choreographer_id = c.id)`,
    // Like personal tags, a system tag exists while at least one dance uses it.
    sql`delete from system_tags s where not exists (select 1 from dance_system_tags x where x.tag_id = s.id)`,
  ];
}

function mirrorStatement(sql, legacyJson, hasRow){
  if(!hasRow) return sql`insert into line_dance_data (data) values (${legacyJson}::jsonb)`;
  const write = process.env.DANCES_SQL_WRITE || "update line_dance_data set data = $1::jsonb";
  return sql(write, [legacyJson]);
}

// Rewrites the legacy JSON copy from the relational tables (after a commit).
async function rebuildMirror(sql){
  const { items } = await listDances(sql, { limit: null });
  const [{ n }] = await sql`select count(*)::int as n from line_dance_data`;
  await mirrorStatement(sql, JSON.stringify({ items }), n > 0);
}

async function catalogRevision(sql){
  const [{ rev }] = await sql`select catalog_revision() as rev`;
  return rev;
}

class CatalogError extends Error{
  constructor(code, message){
    super(message || code);
    this.code = code;
  }
}

// Postgres guard functions raise these codes: map them to CatalogError.
function mapDbError(err){
  const m = String(err && err.message || "").match(/(DANCE_NOT_FOUND|DANCE_VERSION_CONFLICT|CATALOG_REVISION_CONFLICT)/);
  return m ? new CatalogError(m[1]) : err;
}

function ensureTagFkStatement(sql){
  // Tags follow their dance: deleting a dance removes its tag links.
  return sql`
    do $$ begin
      if not exists (select 1 from pg_constraint where conname = 'dance_tags_dance_fk') then
        alter table dance_tags add constraint dance_tags_dance_fk
          foreign key (dance_id) references dances(id) on delete cascade not valid;
      end if;
    end $$`;
}

/* ---------- bulk write (migration / future bulk tools) ---------- */

// Replaces the whole catalog with `items`. With `expectedRevision` the write
// is refused if any dance changed since that revision was read.
async function syncCatalog(sql, items, { mirror = true, expectedRevision = null } = {}){
  await ensureSchema();
  if(!Array.isArray(items) || !items.length) throw new Error("Catalogo vuoto: salvataggio rifiutato");
  const cfg = await loadConfig(sql);
  const recs = items.map((it, i) => itemToRecord(it, cfg, i));
  const ids = recs.map(r => r.id);
  if(new Set(ids).size !== ids.length) throw new Error("id duplicati nel catalogo");

  const { styleIds, choreoIds } = await resolveLookups(sql, recs);
  // Bulk: system tags matched by name; name and color come from the payload.
  const sysTags = new Map();
  recs.forEach(r => r.systemTags.forEach(t => {
    if(!sysTags.has(t.name.toLowerCase())) sysTags.set(t.name.toLowerCase(), t);
  }));
  const sysIds = new Map();
  if(sysTags.size){
    const list = [...sysTags.values()];
    const rows = await sql`
      insert into system_tags (name, color)
      select * from unnest(${list.map(t => t.name)}::text[], ${list.map(t => t.color)}::text[])
      on conflict ((lower(name))) do update set name = excluded.name, color = excluded.color
      returning id, lower(name) as k`;
    rows.forEach(r => sysIds.set(r.k, r.id));
  }
  const rows = childRows(recs, choreoIds, t => sysIds.get(t.name.toLowerCase()));

  const queries = [];
  if(expectedRevision) queries.push(sql`select assert_catalog_revision(${expectedRevision})`);
  queries.push(
    sql`
      insert into dances (id, title, song_title, level_id, style_id, details, notes, sort_order)
      select * from unnest(
        ${ids}::int[], ${recs.map(r => r.title)}::text[], ${recs.map(r => r.songTitle)}::text[],
        ${recs.map(r => r.levelId)}::int[],
        ${recs.map(r => styleIds.get(r.style.toLowerCase()) ?? null)}::int[],
        ${recs.map(r => r.detailsExtra)}::text[], ${recs.map(r => r.notes)}::text[],
        ${recs.map(r => r.sortOrder)}::int[])
      on conflict (id) do update set
        title = excluded.title, song_title = excluded.song_title, level_id = excluded.level_id,
        style_id = excluded.style_id, details = excluded.details, notes = excluded.notes,
        sort_order = excluded.sort_order, version = dances.version + 1, updated_at = now()
      where (dances.title, dances.song_title, dances.level_id, dances.style_id, dances.details, dances.notes, dances.sort_order)
        is distinct from (excluded.title, excluded.song_title, excluded.level_id, excluded.style_id, excluded.details, excluded.notes, excluded.sort_order)`,
    ensureTagFkStatement(sql),
    sql`delete from dances where not (id = any(${ids}::int[]))`,
    ...childStatements(sql, ids, rows),
    ...cleanupStatements(sql),
  );
  if(mirror){
    const [{ n }] = await sql`select count(*)::int as n from line_dance_data`;
    queries.push(mirrorStatement(sql, JSON.stringify({ items: recs.map(r => recordToItem(r, cfg)) }), n > 0));
  }

  try{
    await sql.transaction(queries);
  }catch(err){
    throw mapDbError(err);
  }
  // Added NOT VALID (dance_tags may predate the dances table): validate once no
  // orphan rows are left. A failure only means the check is still pending.
  try{
    const [fk] = await sql`select convalidated from pg_constraint where conname = 'dance_tags_dance_fk'`;
    if(fk && !fk.convalidated) await sql`alter table dance_tags validate constraint dance_tags_dance_fk`;
  }catch(err){
    console.warn("dance_tags_dance_fk non ancora validabile:", err.message);
  }
  return { dances: recs.length, media: rows.dm.d.length, properties: rows.dp.d.length, choreographers: rows.dc.d.length };
}

/* ---------- single-dance writes (admin) ---------- */

// System tags of one dance: entries with a known id are linked as they are
// (renaming/recoloring is a tag-level operation); new names are created.
async function resolveSystemTagsForDance(sql, tags){
  const byKey = new Map();
  const ids = tags.map(t => t.id).filter(id => id != null);
  if(ids.length){
    const rows = await sql`select id, lower(name) as k from system_tags where id = any(${ids}::int[])`;
    rows.forEach(r => byKey.set(`id:${r.id}`, r.id));
  }
  const fresh = tags.filter(t => t.id == null || !byKey.has(`id:${t.id}`));
  if(fresh.length){
    await sql`
      insert into system_tags (name, color)
      select * from unnest(${fresh.map(t => t.name)}::text[], ${fresh.map(t => t.color)}::text[])
      on conflict ((lower(name))) do nothing`;
    const rows = await sql`select id, lower(name) as k from system_tags where lower(name) = any(${fresh.map(t => t.name.toLowerCase())}::text[])`;
    rows.forEach(r => byKey.set(`name:${r.k}`, r.id));
  }
  return (t) => byKey.get(`id:${t.id}`) ?? byKey.get(`name:${t.name.toLowerCase()}`) ?? null;
}

async function getDance(sql, id){
  const { items } = await listDances(sql, { limit: null, ids: [Number(id)] });
  return items[0] || null;
}

// Creates (create: true, server-assigned id, appended at the end) or updates
// one dance. Updates require the version the client read: a dance changed in
// the meantime is rejected with DANCE_VERSION_CONFLICT instead of overwritten.
async function saveDance(sql, item, { create = false, expectedVersion = null } = {}){
  await ensureSeeded(sql);
  const cfg = await loadConfig(sql);

  for(let attempt = 0; attempt < 3; attempt++){
    let id, sortOrder;
    if(create){
      const [n] = await sql`select coalesce(max(id), 0) + 1 as id, coalesce(max(sort_order), -1) + 1 as sort from dances`;
      id = n.id;
      sortOrder = n.sort;
    } else {
      id = Number(item.id);
      const [cur] = await sql`select sort_order from dances where id = ${id}`;
      if(!cur) throw new CatalogError("DANCE_NOT_FOUND");
      sortOrder = cur.sort_order;
    }
    const rec = itemToRecord({ ...item, id }, cfg, sortOrder);
    const { styleIds, choreoIds } = await resolveLookups(sql, [rec]);
    const sysIdOf = await resolveSystemTagsForDance(sql, rec.systemTags);
    const rows = childRows([rec], choreoIds, sysIdOf);
    const levelId = rec.levelId;
    const styleId = styleIds.get(rec.style.toLowerCase()) ?? null;

    const queries = create
      ? [sql`
          insert into dances (id, title, song_title, level_id, style_id, details, notes, sort_order)
          values (${id}, ${rec.title}, ${rec.songTitle}, ${levelId}, ${styleId}, ${rec.detailsExtra}, ${rec.notes}, ${sortOrder})`]
      : [
          sql`select assert_dance_version(${id}::int, ${expectedVersion}::int)`,
          sql`
            update dances set title = ${rec.title}, song_title = ${rec.songTitle}, level_id = ${levelId},
              style_id = ${styleId}, details = ${rec.detailsExtra}, notes = ${rec.notes},
              version = version + 1, updated_at = now()
            where id = ${id}`,
        ];
    queries.push(...childStatements(sql, [id], rows), ...cleanupStatements(sql));

    try{
      await sql.transaction(queries);
    }catch(err){
      // Two admins creating at once may pick the same id: retry with a new one.
      if(create && /dances_pkey|duplicate key/.test(String(err && err.message))) continue;
      throw mapDbError(err);
    }
    await rebuildMirror(sql);
    return getDance(sql, id);
  }
  throw new Error("Impossibile assegnare un id al nuovo ballo");
}

async function deleteDance(sql, id, expectedVersion){
  await ensureSeeded(sql);
  try{
    await sql.transaction([
      sql`select assert_dance_version(${Number(id)}::int, ${expectedVersion}::int)`,
      sql`delete from dances where id = ${Number(id)}`,
      ...cleanupStatements(sql),
    ]);
  }catch(err){
    throw mapDbError(err);
  }
  await rebuildMirror(sql);
}

// Saves only the order (sort_order); content and versions are untouched.
// `ids` must list exactly the current dances.
async function reorderDances(sql, ids){
  await ensureSeeded(sql);
  const list = ids.map(Number);
  const current = (await sql`select id from dances`).map(r => r.id);
  const same = list.length === current.length && new Set(list).size === list.length && current.every(id => list.includes(id));
  if(!same) throw new CatalogError("CATALOG_REVISION_CONFLICT", "L'elenco dei balli è cambiato: ricarica prima di riordinare");
  await sql`
    update dances d set sort_order = x.pos
    from unnest(${list}::int[], ${list.map((_v, i) => i)}::int[]) as x(id, pos)
    where d.id = x.id and d.sort_order is distinct from x.pos`;
  await rebuildMirror(sql);
}

// Rename / recolor an official tag everywhere. Renaming onto another tag's
// name merges the two (only with merge: true).
async function updateSystemTag(sql, { id, name, color, merge = false }){
  await ensureSeeded(sql);
  const tagId = Number(id);
  const [cur] = await sql`select id, name, color from system_tags where id = ${tagId}`;
  if(!cur) throw new CatalogError("TAG_NOT_FOUND");
  const newName = name == null ? cur.name : str(name).replace(/\s+/g, " ").slice(0, 40);
  const newColor = color == null ? cur.color : str(color).toLowerCase();
  if(!newName) throw new CatalogError("INVALID", "Nome non valido");
  if(!/^#[0-9a-f]{6}$/.test(newColor)) throw new CatalogError("INVALID", "Colore non valido");

  const [clash] = await sql`select id, name, color from system_tags where lower(name) = lower(${newName}) and id <> ${tagId}`;
  if(clash && !merge) return { conflict: { id: String(clash.id), name: clash.name } };
  if(clash){
    await sql.transaction([
      sql`
        insert into dance_system_tags (tag_id, dance_id, position)
        select ${clash.id}, dance_id, position from dance_system_tags where tag_id = ${tagId}
        on conflict do nothing`,
      sql`delete from system_tags where id = ${tagId}`,
    ]);
  } else {
    await sql`update system_tags set name = ${newName}, color = ${newColor} where id = ${tagId}`;
  }
  await rebuildMirror(sql);
  return { tag: { id: String(clash ? clash.id : tagId), name: clash ? clash.name : newName, color: clash ? clash.color : newColor }, merged: !!clash };
}

// First use: copy the legacy JSON into the relational tables (no mirror write).
let seeded = null;
function ensureSeeded(sql){
  if(!seeded){
    seeded = (async () => {
      await ensureSchema();
      const [{ n }] = await sql`select count(*)::int as n from dances`;
      if(n > 0) return;
      const legacy = await readCatalog(sql);
      if(legacy.items && legacy.items.length) await syncCatalog(sql, legacy.items, { mirror: false });
    })().catch(err => {
      seeded = null;
      throw err;
    });
  }
  return seeded;
}

/* ---------- reads ---------- */

function escapeLike(s){
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Page of dances in catalog order. `limit: null` returns every match.
// `tagIds` are matched only among the caller's own tags (AND semantics).
async function listDances(sql, { offset = 0, limit = 25, level = null, tagIds = null, systemTagIds = null, q = null, uid = null, ids = null } = {}){
  await ensureSeeded(sql);
  const cfg = await loadConfig(sql);
  const pattern = q ? `%${escapeLike(q)}%` : null;
  const tags = tagIds && tagIds.length ? tagIds : null;
  const stags = systemTagIds && systemTagIds.length ? systemTagIds : null;

  const rows = await sql`
    with base as (
      select d.*, l.code as level_code, coalesce(l.label, l.code) as level_label, s.name as style_name
      from dances d
      left join levels l on l.id = d.level_id
      left join styles s on s.id = d.style_id
    ), filtered as (
      select b.* from base b
      where (${ids}::int[] is null or b.id = any(${ids}::int[]))
        and (${level}::text is null or lower(b.level_code) = lower(${level}::text) or lower(b.level_label) = lower(${level}::text))
        and (${tags}::bigint[] is null or (
          select count(distinct dt.tag_id) from dance_tags dt
          join tags t on t.id = dt.tag_id and t.user_id = ${uid}::bigint
          where dt.dance_id = b.id and dt.tag_id = any(${tags}::bigint[])
        ) = cardinality(${tags}::bigint[]))
        and (${stags}::int[] is null or (
          select count(distinct x.tag_id) from dance_system_tags x
          where x.dance_id = b.id and x.tag_id = any(${stags}::int[])
        ) = cardinality(${stags}::int[]))
        and (${pattern}::text is null or concat_ws(' ',
          b.title, b.song_title, b.level_label, b.style_name, b.details, b.notes,
          (select string_agg(st.name, ' ') from dance_system_tags x
             join system_tags st on st.id = x.tag_id where x.dance_id = b.id),
          (select string_agg(c.name, ' ') from dance_choreographers dc
             join choreographers c on c.id = dc.choreographer_id where dc.dance_id = b.id),
          (select string_agg(p.value #>> '{}', ' ') from dance_properties p where p.dance_id = b.id),
          (select string_agg(t.name, ' ') from dance_tags dt
             join tags t on t.id = dt.tag_id where dt.dance_id = b.id and t.user_id = ${uid}::bigint)
        ) ilike ${pattern}::text)
    )
    select f.id, f.title, f.song_title, f.level_code, f.level_label, f.style_name, f.details, f.notes, f.version,
      count(*) over() as total,
      coalesce((select json_agg(c.name order by dc.position) from dance_choreographers dc
                join choreographers c on c.id = dc.choreographer_id where dc.dance_id = f.id), '[]') as choreographers,
      coalesce((select json_agg(json_build_object(
                  'provider', m.provider_code, 'url', m.url, 'title', m.title,
                  'startSeconds', m.start_seconds, 'danceStartSeconds', m.dance_start_seconds)
                order by mp.sort_order, m.position)
                from dance_media m join media_providers mp on mp.code = m.provider_code
                where m.dance_id = f.id), '[]') as media,
      coalesce((select jsonb_object_agg(p.property_key, p.value) from dance_properties p
                where p.dance_id = f.id), '{}') as properties,
      coalesce((select json_agg(json_build_object('id', st.id, 'name', st.name, 'color', st.color) order by x.position)
                from dance_system_tags x join system_tags st on st.id = x.tag_id
                where x.dance_id = f.id), '[]') as system_tags
    from filtered f
    order by f.sort_order, f.id
    limit ${limit}::int offset ${offset}::int`;

  const items = rows.map(r => recordToItem({
    id: r.id,
    title: r.title,
    songTitle: r.song_title,
    level: r.level_code || "",
    levelLabel: r.level_label || "",
    style: r.style_name || "",
    choreographers: r.choreographers,
    notes: r.notes,
    detailsExtra: r.details,
    properties: r.properties,
    media: r.media,
    systemTags: r.system_tags,
    version: r.version,
  }, cfg));
  const total = rows.length ? Number(rows[0].total) : (offset === 0 ? 0 : null);
  const next = limit != null && total != null && offset + rows.length < total ? offset + rows.length : null;
  return { items, total, offset, limit, nextOffset: next };
}

async function getMeta(sql){
  await ensureSeeded(sql);
  const cfg = await loadConfig(sql);
  const [levels, [{ total }], systemTags] = await Promise.all([
    sql`select l.code, coalesce(l.label, l.code) as label,
          (select count(*)::int from dances d where d.level_id = l.id) as dances
        from levels l order by l.sort_order, l.code`,
    sql`select count(*)::int as total from dances`,
    sql`select s.id, s.name, s.color, (select count(*)::int from dance_system_tags x where x.tag_id = s.id) as dances
        from system_tags s order by lower(s.name)`,
  ]);
  return {
    total,
    revision: await catalogRevision(sql),
    levels,
    systemTags,
    propertyDefinitions: cfg.defs.map(d => ({
      key: d.key, label: d.label, detailsLabel: d.details_label, dataType: d.data_type,
      isPublic: d.is_public, isFilterable: d.is_filterable,
    })),
    mediaProviders: cfg.providers.map(p => ({
      code: p.code, label: p.label, kind: p.kind, hasTitle: p.has_title, fields: providerFields(p),
    })),
  };
}

// One-time conversion of the old class codes (1, 2, 3, 3+, ADV, EVENT,
// Master) to difficulty levels; bumps the version of every dance it changes.
async function migrateLegacyLevels(sql){
  await ensureSchema();
  const src = Object.keys(LEGACY_LEVELS);
  const dst = src.map(k => LEGACY_LEVELS[k] ?? "");
  const [changed] = await sql.transaction([
    sql`
      update dances d set
        level_id = (select t.id from levels t where t.code = nullif(x.dst, '')),
        version = d.version + 1, updated_at = now()
      from levels l, unnest(${src}::text[], ${dst}::text[]) as x(src, dst)
      where d.level_id = l.id and lower(l.code) = x.src
      returning d.id`,
    sql`delete from levels l where lower(l.code) = any(${src}::text[])
        and not exists (select 1 from dances d where d.level_id = l.id)`,
  ]);
  if(changed.length) await rebuildMirror(sql);
  return changed.length;
}

async function danceTitles(sql){
  await ensureSeeded(sql);
  const rows = await sql`select id, title from dances`;
  return new Map(rows.map(r => [Number(r.id), r.title]));
}

module.exports = {
  syncCatalog, ensureSeeded, listDances, getMeta, danceTitles,
  saveDance, deleteDance, reorderDances, updateSystemTag, getDance, rebuildMirror, catalogRevision, CatalogError,
  migrateLegacyLevels,
  // exported for tests / scripts
  itemToRecord, recordToItem, loadConfig, parseDetails, composeDetails, splitNames, joinNames,
};
