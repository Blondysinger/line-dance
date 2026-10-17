const { danceTitles } = require("./catalog-store");

// Merges [{ name, color, ids: [danceId] }] into the personal tags of `uid`:
// existing tags (same name, any case) keep their color, links are added,
// nothing is removed. Dance ids that no longer exist are ignored.
async function mergeTags(sql, uid, tags){
  const known = new Set((await danceTitles(sql)).keys());
  let ignored = 0;
  const list = tags
    .map(t => {
      const ids = [...new Set((t.ids || []).map(Number).filter(Number.isInteger))];
      const valid = ids.filter(id => known.has(id));
      ignored += ids.length - valid.length;
      return { ...t, ids: valid };
    })
    .filter(t => t.ids.length);

  let links = 0;
  if(list.length){
    const rows = await sql`
      insert into tags (user_id, name, color)
      select ${uid}, n, c from unnest(${list.map(t => t.name)}::text[], ${list.map(t => t.color)}::text[]) as x(n, c)
      on conflict (user_id, lower(name)) do update set name = tags.name
      returning id, lower(name) as key`;
    const idByKey = new Map(rows.map(r => [r.key, String(r.id)]));
    const pairTag = [];
    const pairDance = [];
    list.forEach(t => t.ids.forEach(d => {
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
  return { tags: list.length, links, ignoredDances: ignored };
}

module.exports = { mergeTags };
