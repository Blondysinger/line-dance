const { json, text, parseJsonBody } = require("../lib/http");
const { getSql, ensureSchema } = require("../lib/db");
const { getCurrentUser } = require("../lib/users");
const { mergeTags } = require("../lib/tags-store");

// Sharing personal tags between users, like an export sent to someone: the
// sender picks all, some or one of their tags and sends a COPY (names, colors,
// dances). The recipient finds it in their inbox and adds all or some of those
// tags to their own (merged, like an import) or declines.
//   GET                                        -> { received, sent, pending }
//   GET  ?view=count                           -> { pending }   (cheap, for polling)
//   GET  ?view=users&q=…                       -> users to share with (name + masked email)
//   POST {toUserId, tagIds, message}           -> send
//   POST ?action=respond {id, accept, names?}  -> accept (all, or only `names`) / decline
const MAX_PENDING_PER_PAIR = 20;

function maskEmail(email){
  const [local, domain] = String(email || "").split("@");
  if(!domain) return "";
  return `${local.slice(0, Math.min(3, Math.max(1, local.length - 1)))}•••@${domain}`;
}

const MAX_TAGS_PER_SHARE = 500;

function shareRow(r, side){
  return {
    id: String(r.id),
    tags: (r.tags || []).map(t => ({ name: t.name, color: t.color, dances: (t.dance_ids || []).length })),
    message: r.message,
    status: r.status,
    acceptedCount: r.accepted_count,
    createdAt: r.created_at,
    respondedAt: r.responded_at,
    [side]: { id: String(r.other_id), name: r.other_name || maskEmail(r.other_email) || "Utente", email: maskEmail(r.other_email), avatarUrl: r.other_avatar || "" },
  };
}

exports.handler = async (event, context) => {
  try{
    const user = await getCurrentUser(event, context);
    if(!user) return text(401, "Unauthorized");
    await ensureSchema();
    const sql = getSql();
    const uid = user.id;
    const q = event.queryStringParameters || {};

    if(event.httpMethod === "GET" && q.view === "count"){
      const [c] = await sql`select count(*)::int as n from tag_shares where to_user_id = ${uid} and status = 'pending'`;
      return json(200, { pending: c.n });
    }

    if(event.httpMethod === "GET" && q.view === "users"){
      const term = String(q.q || "").trim().toLowerCase();
      if(term.length < 2) return json(200, { users: [] });
      const like = `%${term.replace(/[\\%_]/g, c => `\\${c}`)}%`;
      const rows = await sql`
        select id, display_name, email, avatar_url from app_users
        where id <> ${uid} and (lower(coalesce(display_name, '')) like ${like} or lower(coalesce(email, '')) like ${like})
        order by last_login_at desc nulls last limit 10`;
      return json(200, { users: rows.map(r => ({ id: String(r.id), name: r.display_name || maskEmail(r.email) || "Utente", email: maskEmail(r.email), avatarUrl: r.avatar_url || "" })) });
    }

    if(event.httpMethod === "GET"){
      const received = await sql`
        select s.*, u.id as other_id, u.display_name as other_name, u.email as other_email, u.avatar_url as other_avatar
        from tag_shares s join app_users u on u.id = s.from_user_id
        where s.to_user_id = ${uid} and (s.status = 'pending' or s.created_at > now() - interval '60 days')
        order by (s.status = 'pending') desc, s.created_at desc limit 100`;
      const sent = await sql`
        select s.*, u.id as other_id, u.display_name as other_name, u.email as other_email, u.avatar_url as other_avatar
        from tag_shares s join app_users u on u.id = s.to_user_id
        where s.from_user_id = ${uid} and s.created_at > now() - interval '60 days'
        order by s.created_at desc limit 100`;
      return json(200, {
        received: received.map(r => shareRow(r, "from")),
        sent: sent.map(r => shareRow(r, "to")),
        pending: received.filter(r => r.status === "pending").length,
      });
    }

    const body = parseJsonBody(event) || {};

    if(event.httpMethod === "POST" && q.action === "respond"){
      if(!/^\d+$/.test(String(body.id ?? ""))) return text(400, "id non valido");
      const [s] = await sql`select * from tag_shares where id = ${body.id} and to_user_id = ${uid}`;
      if(!s) return text(404, "Condivisione non trovata");
      if(s.status !== "pending") return text(409, "Condivisione già gestita");
      let imported = null;
      let chosen = [];
      if(body.accept){
        // Accept all the tags, or only those named in `names`.
        const wanted = Array.isArray(body.names) ? new Set(body.names.map(n => String(n).toLowerCase())) : null;
        chosen = (s.tags || []).filter(t => !wanted || wanted.has(String(t.name).toLowerCase()));
        if(!chosen.length) return text(400, "Nessun tag selezionato");
        imported = await mergeTags(sql, uid, chosen.map(t => ({ name: t.name, color: t.color, ids: t.dance_ids })));
      }
      await sql`
        update tag_shares set status = ${body.accept ? "accepted" : "declined"},
          accepted_count = ${body.accept ? chosen.length : 0}, responded_at = now()
        where id = ${s.id}`;
      return json(200, { ok: true, status: body.accept ? "accepted" : "declined", imported });
    }

    if(event.httpMethod === "POST"){
      if(!/^\d+$/.test(String(body.toUserId ?? ""))) return text(400, "Destinatario non valido");
      if(String(body.toUserId) === String(uid)) return text(400, "Non puoi condividere con te stesso");
      const tagIds = (Array.isArray(body.tagIds) ? body.tagIds : [body.tagId]).map(String).filter(v => /^\d+$/.test(v));
      if(!tagIds.length) return text(400, "Nessun tag selezionato");
      if(tagIds.length > MAX_TAGS_PER_SHARE) return text(400, "Troppi tag in un solo invio");
      const [to] = await sql`select id from app_users where id = ${body.toUserId}`;
      if(!to) return text(404, "Destinatario non trovato");
      // Snapshot of the sender's own tags only: ids of other users' tags match nothing.
      const rows = await sql`
        select t.name, t.color, coalesce(array_agg(dt.dance_id order by dt.dance_id) filter (where dt.dance_id is not null), '{}') as dance_ids
        from tags t left join dance_tags dt on dt.tag_id = t.id
        where t.user_id = ${uid} and t.id = any(${tagIds}::bigint[])
        group by t.id order by lower(t.name)`;
      const snapshot = rows.filter(r => r.dance_ids.length).map(r => ({ name: r.name, color: r.color, dance_ids: r.dance_ids }));
      if(!snapshot.length) return text(404, "Tag non trovati");
      const [p] = await sql`select count(*)::int as n from tag_shares where from_user_id = ${uid} and to_user_id = ${to.id} and status = 'pending'`;
      if(p.n >= MAX_PENDING_PER_PAIR) return text(429, "Troppe condivisioni in attesa per questo utente");
      const message = String(body.message || "").trim().slice(0, 500);
      const [row] = await sql`
        insert into tag_shares (from_user_id, to_user_id, tags, message)
        values (${uid}, ${to.id}, ${JSON.stringify(snapshot)}::jsonb, ${message})
        returning id`;
      return json(201, { id: String(row.id), tags: snapshot.length });
    }

    return text(405, "Method not allowed");
  }catch(err){
    console.error("shares error:", err);
    return text(500, `Error: ${err && err.message ? err.message : "unknown"}`);
  }
};
