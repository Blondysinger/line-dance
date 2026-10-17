const { neon } = require("@neondatabase/serverless");

let sqlInstance = null;
let schemaReady = null;

function getSql(){
  if(sqlInstance) return sqlInstance;
  const conn = process.env.NEON_DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
  if(!conn) throw new Error("Missing NEON_DATABASE_URL");
  sqlInstance = neon(conn);
  return sqlInstance;
}

// Users, identities (one user can log in with several providers) and the
// user-scoped n-m relation between tags and dances.
const SCHEMA = [
  `create table if not exists app_users (
    id bigserial primary key,
    email text,
    display_name text,
    avatar_url text,
    created_at timestamptz not null default now(),
    last_login_at timestamptz not null default now()
  )`,
  `create unique index if not exists app_users_email_uq on app_users (lower(email)) where email is not null`,
  // Roles stored per user: "user" (default) or "editor" (admin page access).
  // Administrators are not stored: they come from the ADMIN_EMAILS env var.
  `alter table app_users add column if not exists role text not null default 'user'`,
  `do $$ begin
     if not exists (select 1 from pg_constraint where conname = 'app_users_role_chk') then
       alter table app_users add constraint app_users_role_chk check (role in ('user', 'editor'));
     end if;
   end $$`,
  `create table if not exists user_identities (
    provider text not null,
    provider_user_id text not null,
    user_id bigint not null references app_users(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (provider, provider_user_id)
  )`,
  `create index if not exists user_identities_user_idx on user_identities (user_id)`,
  `create table if not exists tags (
    id bigserial primary key,
    user_id bigint not null references app_users(id) on delete cascade,
    name text not null check (char_length(name) between 1 and 40),
    color text not null default '#7aa2ff',
    created_at timestamptz not null default now()
  )`,
  `create unique index if not exists tags_user_name_uq on tags (user_id, lower(name))`,
  `create table if not exists dance_tags (
    tag_id bigint not null references tags(id) on delete cascade,
    dance_id integer not null,
    created_at timestamptz not null default now(),
    primary key (tag_id, dance_id)
  )`,
  `create index if not exists dance_tags_dance_idx on dance_tags (dance_id)`,

  // ---------- Relational catalog (see doc/modello-dati.md) ----------
  // line_dance_data (the legacy JSON document) is left untouched and kept in
  // sync as a mirror; these tables are the source of truth.
  `create table if not exists levels (
    id serial primary key,
    code text not null,
    label text,
    sort_order int not null default 0,
    created_at timestamptz not null default now()
  )`,
  `create unique index if not exists levels_code_uq on levels (lower(code))`,
  `create table if not exists styles (
    id serial primary key,
    name text not null,
    created_at timestamptz not null default now()
  )`,
  `create unique index if not exists styles_name_uq on styles (lower(name))`,
  `create table if not exists choreographers (
    id serial primary key,
    name text not null,
    created_at timestamptz not null default now()
  )`,
  `create unique index if not exists choreographers_name_uq on choreographers (lower(name))`,
  `create table if not exists dances (
    id integer primary key,
    title text not null default '',
    song_title text not null default '',
    level_id int references levels(id) on delete set null,
    style_id int references styles(id) on delete set null,
    details text not null default '',
    notes text not null default '',
    sort_order int not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create index if not exists dances_sort_idx on dances (sort_order, id)`,
  // Optimistic locking: every save of a dance bumps its version.
  `alter table dances add column if not exists version int not null default 1`,
  `create or replace function assert_dance_version(p_id int, p_version int) returns void
   language plpgsql as $f$
   begin
     if not exists (select 1 from dances where id = p_id) then
       raise exception 'DANCE_NOT_FOUND';
     end if;
     if p_version is null or not exists (select 1 from dances where id = p_id and version = p_version) then
       raise exception 'DANCE_VERSION_CONFLICT';
     end if;
   end $f$`,
  // Fingerprint of everything the public catalog shows: dances (version and
  // order), official tags and difficulty levels. Used by bulk writes and by
  // clients polling for changes.
  `create or replace function catalog_revision() returns text
   language sql stable as $f$
     select md5(
       coalesce((select string_agg(id || ':' || version || ':' || sort_order, ',' order by id) from dances), '') || '|' ||
       coalesce((select string_agg(id || ':' || name || ':' || color, ',' order by id) from system_tags), '') || '|' ||
       coalesce((select string_agg(code || ':' || coalesce(label, '') || ':' || sort_order, ',' order by code) from levels), '')
     )
   $f$`,
  `create or replace function assert_catalog_revision(p_rev text) returns void
   language plpgsql as $f$
   begin
     if p_rev is null or p_rev <> catalog_revision() then
       raise exception 'CATALOG_REVISION_CONFLICT';
     end if;
   end $f$`,
  `create index if not exists dances_level_idx on dances (level_id)`,
  `create table if not exists dance_choreographers (
    dance_id int not null references dances(id) on delete cascade,
    choreographer_id int not null references choreographers(id) on delete cascade,
    position int not null default 0,
    primary key (dance_id, choreographer_id)
  )`,
  `create table if not exists media_providers (
    code text primary key check (code ~ '^[a-z][a-z0-9_]*$'),
    label text not null,
    kind text not null check (kind in ('video', 'audio', 'document', 'link')),
    has_title boolean not null default false,
    sort_order int not null default 0
  )`,
  `create table if not exists dance_media (
    id bigserial primary key,
    dance_id int not null references dances(id) on delete cascade,
    provider_code text not null references media_providers(code) on update cascade,
    url text not null,
    title text not null default '',
    position int not null default 0,
    start_seconds int,
    dance_start_seconds int,
    extra jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists dance_media_dance_idx on dance_media (dance_id, provider_code, position)`,
  `create table if not exists property_definitions (
    key text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
    label text not null,
    details_label text,
    data_type text not null default 'text' check (data_type in ('text', 'longtext', 'number', 'boolean', 'url', 'date')),
    sort_order int not null default 0,
    is_public boolean not null default true,
    is_filterable boolean not null default false,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists dance_properties (
    dance_id int not null references dances(id) on delete cascade,
    property_key text not null references property_definitions(key) on update cascade on delete cascade,
    value jsonb not null,
    primary key (dance_id, property_key)
  )`,
  `create index if not exists dance_properties_key_idx on dance_properties (property_key)`,

  // Official ("system") tags: one global set, visible to everyone, written
  // only through the admin catalog save.
  `create table if not exists system_tags (
    id serial primary key,
    name text not null check (char_length(name) between 1 and 40),
    color text not null default '#7aa2ff' check (color ~ '^#[0-9a-f]{6}$'),
    created_at timestamptz not null default now()
  )`,
  `create unique index if not exists system_tags_name_uq on system_tags (lower(name))`,
  `create table if not exists dance_system_tags (
    tag_id int not null references system_tags(id) on delete cascade,
    dance_id int not null references dances(id) on delete cascade,
    position int not null default 0,
    primary key (tag_id, dance_id)
  )`,
  `create index if not exists dance_system_tags_dance_idx on dance_system_tags (dance_id)`,

  // Seed configuration (never overwrites edits made in the DB).
  // Difficulty levels: a configured list (code, label, order), chosen from a
  // dropdown; dances.level_id points here.
  `insert into levels (code, label, sort_order) values
    ('absolute_beginner', 'Absolute Beginner', 10),
    ('beginner', 'Beginner', 20),
    ('high_beginner', 'High Beginner', 30),
    ('easy_improver', 'Easy Improver', 40),
    ('improver', 'Improver', 50),
    ('high_improver', 'High Improver', 60),
    ('easy_intermediate', 'Easy Intermediate', 70),
    ('intermediate', 'Intermediate', 80),
    ('high_intermediate', 'High Intermediate', 90),
    ('advanced', 'Advanced', 100)
   on conflict ((lower(code))) do nothing`,
  `insert into media_providers (code, label, kind, has_title, sort_order) values
    ('youtube', 'YouTube', 'video', true, 10),
    ('spotify', 'Spotify', 'audio', false, 20),
    ('amazon_music', 'Amazon Music', 'audio', false, 30),
    ('stepsheet', 'Stepsheet', 'document', true, 40)
   on conflict (code) do nothing`,
  `insert into property_definitions (key, label, details_label, data_type, sort_order, is_filterable) values
    ('counts', 'Tempi', 'Tempi', 'text', 10, true),
    ('walls', 'Muri', 'Muri', 'text', 20, true),
    ('restarts', 'Restart', 'Restart', 'text', 30, false),
    ('choreo_tags', 'Tag (coreografia)', 'Tag', 'text', 40, false),
    ('sequence', 'Sequenza', 'Sequenza', 'text', 50, false),
    ('final', 'Final', 'Final', 'text', 60, false)
   on conflict (key) do nothing`,
];

// Idempotent, run once per function instance.
function ensureSchema(){
  if(!schemaReady){
    const sql = getSql();
    schemaReady = sql.transaction(SCHEMA.map(s => sql(s))).catch(err => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

module.exports = { getSql, ensureSchema };
