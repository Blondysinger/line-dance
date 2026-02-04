# Line Dance Catalog

Static SPA (HTML/CSS/JS) basata su un dataset JSON generato dal CSV.

## Struttura
- `index.html` – UI master–detail + ricerca
- `styles.css` – stile
- `app.js` – logica (carica `data.json`, filtra, seleziona, render)
- `data.json` – dataset (generato dal tuo CSV)

## Funzionalità
- Elenco a sinistra (master)
- Ricerca full-text (ballo, brano, dettagli, note, coreografo)
- Filtro per anno
- Dettaglio a destra/sotto (detail)
  - YouTube: embed via **ricerca** (non serve API key)
  - Spotify: embed **solo se** nel dataset c’è un link/URI Spotify (altrimenti link alla ricerca)

## Deploy su Netlify (collegato a GitHub)
1. Crea un repository su GitHub (es. `line-dance-catalog`)
2. Copia questi file nel repo (root).
3. Fai commit + push su `main`.
4. Netlify:
   - **Add new site** → **Import from Git**
   - Seleziona GitHub e poi il repo
   - **Build command**: *(vuoto)*
   - **Publish directory**: `/` (root)
5. Deploy. Avrai un URL tipo `https://<nome>.netlify.app`

### SPA routing
Questa SPA usa solo un’unica pagina e non richiede redirect speciali.

## Aggiornare i dati via browser (Admin custom)
La sezione `/admin` ora usa un editor custom con Netlify Identity
che salva direttamente nel DB (Neon) tramite una function serverless.

### Setup su Netlify (Identity + Git Gateway)
1. **Deploy** come sopra (build vuoto, publish `/`).
2. In Netlify: **Site settings → Identity → Enable Identity**.
3. In Netlify: **Identity → Settings → Enable Git Gateway**.
4. (Consigliato) In Identity: **Registration → Invite only**.
5. Vai su `https://<tuo-sito>.netlify.app/admin` e fai login.
6. Una volta dentro, modifica e salva: i dati vengono salvati su Neon.

### Note
- Nessun token nel frontend.
- Se non vedi l’editor, verifica che Identity e Git Gateway siano abilitati.

## Lettura dati da Neon (serverless)
Se vuoi leggere i dati da Neon in produzione, usa la Function Netlify:
- Endpoint: `/.netlify/functions/dances`
- La SPA usa l’endpoint remoto in produzione.

### Setup rapido
1. In Netlify → **Site settings → Environment variables** aggiungi **una** delle seguenti:
   - `NEON_DATABASE_URL` = connection string Neon (con `sslmode=require`)
   - `NETLIFY_DATABASE_URL` = connection string Neon (se già creata automaticamente)
2. Aggiungi:
   - `DANCES_SQL` = query che ritorna un solo record con il JSON
   - `DANCES_SQL_WRITE` = query di update per il salvataggio

Esempio query:
```
select data as payload from line_dance_data limit 1;
```
Esempio write:
```
update line_dance_data set data = $1::jsonb
```

### Struttura suggerita nel DB
Una tabella con una singola riga che contiene l’intero JSON:
```
create table line_dance_data (
  id serial primary key,
  data jsonb not null
);
```
