const { getSql, ensureSchema } = require("./db");
const { readSession } = require("./session");

// Administrators (can manage users) are configured on the server, never in
// the DB, so nobody can promote themselves from the UI.
function adminEmails(){
  return (process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function isConfiguredAdmin(row){
  return !!(row && row.email && adminEmails().includes(String(row.email).toLowerCase()));
}

// admin  -> admin page + user management (ADMIN_EMAILS)
// editor -> admin page (role column, or an invite-only Netlify Identity account)
// user   -> public site and personal tags
function effectiveRole(row, provider){
  if(isConfiguredAdmin(row)) return "admin";
  if(row.role === "editor") return "editor";
  if(provider === "netlify") return "editor";
  return "user";
}

function publicUser(row, provider){
  if(!row) return null;
  const role = effectiveRole(row, provider);
  return {
    id: String(row.id),
    email: row.email || "",
    name: row.display_name || row.email || "Utente",
    avatarUrl: row.avatar_url || "",
    provider: provider || "",
    role,
    canEdit: role === "editor" || role === "admin",
    isAdmin: role === "admin",
  };
}

// Finds or creates the app user behind an external identity. Identities with
// the same verified email are linked to the same user, so tags follow the
// person across Google / Facebook / Netlify logins.
async function upsertIdentity({ provider, providerUserId, email, emailVerified, name, avatarUrl }){
  await ensureSchema();
  const sql = getSql();
  const cleanEmail = emailVerified && email ? String(email).trim() : null;

  const found = await sql`
    select u.* from user_identities i join app_users u on u.id = i.user_id
    where i.provider = ${provider} and i.provider_user_id = ${providerUserId}`;
  let user = found[0];

  if(!user && cleanEmail){
    const byEmail = await sql`select * from app_users where lower(email) = lower(${cleanEmail})`;
    user = byEmail[0];
  }
  if(!user){
    const ins = await sql`
      insert into app_users (email, display_name, avatar_url)
      values (${cleanEmail}, ${name || null}, ${avatarUrl || null})
      returning *`;
    user = ins[0];
  }
  await sql`
    insert into user_identities (provider, provider_user_id, user_id)
    values (${provider}, ${providerUserId}, ${user.id})
    on conflict (provider, provider_user_id) do nothing`;
  const upd = await sql`
    update app_users set
      last_login_at = now(),
      display_name = coalesce(${name || null}, display_name),
      avatar_url = coalesce(${avatarUrl || null}, avatar_url)
    where id = ${user.id}
    returning *`;
  return upd[0];
}

// Resolves the caller from our own session cookie (Google/Facebook OAuth) or,
// failing that, from a Netlify Identity JWT (the admin account).
async function getCurrentUser(event, context){
  const nu = context && context.clientContext && context.clientContext.user;
  const session = readSession(event);
  if(session && session.uid){
    await ensureSchema();
    const rows = await getSql()`select * from app_users where id = ${session.uid}`;
    const fromSession = rows[0] ? publicUser(rows[0], session.p) : null;
    // A plain session user who is also signed in to the admin with Netlify
    // Identity in the same browser gets the higher of the two accesses.
    if(fromSession && (fromSession.canEdit || !(nu && nu.sub))) return fromSession;
  }

  if(nu && nu.sub){
    const meta = nu.user_metadata || {};
    const row = await upsertIdentity({
      provider: "netlify",
      providerUserId: String(nu.sub),
      email: nu.email,
      emailVerified: true,
      name: meta.full_name || null,
      avatarUrl: meta.avatar_url || null,
    });
    return publicUser(row, "netlify");
  }
  return null;
}

// For write endpoints: { user } when allowed, otherwise { status, message }.
async function requireRole(event, context, level){
  const user = await getCurrentUser(event, context);
  if(!user) return { status: 401, message: "Unauthorized" };
  const ok = level === "admin" ? user.isAdmin : user.canEdit;
  if(!ok) return { status: 403, message: level === "admin" ? "Serve un amministratore" : "Serve il ruolo di editor" };
  return { user };
}

module.exports = { upsertIdentity, getCurrentUser, publicUser, requireRole, effectiveRole, isConfiguredAdmin };
