#!/usr/bin/env node
// Creates the relational catalog tables and fills them from the legacy
// line_dance_data JSON. Idempotent: it only seeds an empty catalog, unless
// --resync is given. The legacy JSON is read, never modified.
//
//   npm run db:migrate             # create + seed if empty, then verify
//   npm run db:migrate -- --resync # reload the relational tables from the JSON
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const envFile = path.join(root, ".env");
if(fs.existsSync(envFile)){
  fs.readFileSync(envFile, "utf8").split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if(m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  });
}

const { getSql, ensureSchema } = require("../netlify/lib/db");
const { readCatalog, normalizeItem } = require("../netlify/lib/catalog");
const { syncCatalog, listDances, migrateLegacyLevels } = require("../netlify/lib/catalog-store");

(async () => {
  const sql = getSql();
  const resync = process.argv.includes("--resync");

  await ensureSchema();
  console.log("Schema OK");

  const legacy = await readCatalog(sql);
  const items = legacy.items || [];
  const [{ n }] = await sql`select count(*)::int as n from dances`;
  if(n === 0 || resync){
    const r = await syncCatalog(sql, items, { mirror: false });
    console.log(`Importati dal JSON: ${r.dances} balli, ${r.media} link media, ${r.properties} proprietà, ${r.choreographers} coreografi associati`);
  } else {
    console.log(`Catalogo relazionale già popolato (${n} balli): nessun import (usa --resync per ricaricare dal JSON)`);
  }

  const moved = await migrateLegacyLevels(sql);
  if(moved) console.log(`Classi convertite in livelli di difficoltà: ${moved} balli`);

  // Verify: the relational catalog, re-exported in the legacy shape, matches the JSON.
  const { items: back } = await listDances(sql, { limit: null });
  const byId = new Map(back.map(it => [it.id, it]));
  const fields = ["dance", "year", "style", "songTitle", "notes", "details", "choreographer",
    "videos", "spotifyUrl", "amazonMusicUrl", "stepsheetUrl", "stepsheetTitle"];
  const diffs = [];
  items.map(normalizeItem).forEach(it => {
    const b = byId.get(Number(it.id));
    if(!b){ diffs.push(`${it.id}: mancante`); return; }
    fields.forEach(f => {
      if(JSON.stringify(it[f] ?? "") !== JSON.stringify(b[f] ?? "")) diffs.push(`${it.id} ${f}: ${JSON.stringify(it[f])} -> ${JSON.stringify(b[f])}`);
    });
  });
  const order = items.map(it => Number(it.id)).join(",") === back.map(it => it.id).join(",");
  console.log(`Verifica: ${back.length}/${items.length} balli, ordine ${order ? "identico" : "DIVERSO"}, ${diffs.length} differenze di normalizzazione`);
  diffs.forEach(d => console.log("  - " + d));
})().catch(err => {
  console.error(err);
  process.exit(1);
});
