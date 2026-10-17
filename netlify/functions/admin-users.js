const { json, text, parseJsonBody } = require("../lib/http");
const { getSql, ensureSchema } = require("../lib/db");
const { requireRole, effectiveRole, isConfiguredAdmin } = require("../lib/users");

// User management, administrators only (ADMIN_EMAILS).
//   GET                    -> { users: [...] }
//   PATCH {id, role}       -> role "user" | "editor"
// Administrators themselves are configured on the server and cannot be
// changed from here.
async function listUsers(sql){
  const rows = await sql`
    select u.id, u.email, u.display_name, u.avatar_url, u.role, u.created_at, u.last_login_at,
      coalesce(array_agg(distinct i.provider) filter (where i.provider is not null), '{}') as providers,
      (select count(*)::int from tags t where t.user_id = u.id) as tags
    from app_users u
    left join user_identities i on i.user_id = u.id
    group by u.id
    order by u.last_login_at desc nulls last, u.id`;
  return rows.map(r => {
    const providers = r.providers || [];
    // A Netlify Identity account is an editor by itself (invite-only).
    const role = effectiveRole(r, providers.includes("netlify") ? "netlify" : "");
    return {
      id: String(r.id),
      email: r.email || "",
      name: r.display_name || r.email || "Utente",
      avatarUrl: r.avatar_url || "",
      providers,
      tags: r.tags,
      role,
      storedRole: r.role,
      locked: isConfiguredAdmin(r),
      viaNetlify: providers.includes("netlify"),
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
    };
  });
}

exports.handler = async (event, context) => {
  try{
    const auth = await requireRole(event, context, "admin");
    if(!auth.user) return text(auth.status, auth.message);
    await ensureSchema();
    const sql = getSql();

    if(event.httpMethod === "GET") return json(200, { users: await listUsers(sql) });

    if(event.httpMethod === "PATCH"){
      const body = parseJsonBody(event) || {};
      if(!/^\d+$/.test(String(body.id ?? ""))) return text(400, "id non valido");
      if(!["user", "editor"].includes(body.role)) return text(400, "Ruolo non valido");
      const [row] = await sql`select id, email from app_users where id = ${body.id}`;
      if(!row) return text(404, "Utente non trovato");
      if(isConfiguredAdmin(row)) return text(409, "Gli amministratori si configurano sul server (ADMIN_EMAILS)");
      await sql`update app_users set role = ${body.role} where id = ${body.id}`;
      return json(200, { users: await listUsers(sql) });
    }
    return text(405, "Method not allowed");
  }catch(err){
    console.error("admin-users error:", err);
    return text(500, `Error: ${err && err.message ? err.message : "unknown"}`);
  }
};
