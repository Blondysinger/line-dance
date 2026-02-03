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

## Aggiornare i dati via browser (Decap CMS)
Questa repo include la sezione `/admin` per modificare `data.json` tramite Decap CMS.
Quando salvi dal CMS, `data.json` viene salvato come oggetto con chiave `items`.
La SPA gestisce sia il formato a lista che quello con `items`.

### Setup su Netlify (Identity + Git Gateway)
1. **Deploy** come sopra (build vuoto, publish `/`).
2. In Netlify: **Site settings → Identity → Enable Identity**.
3. In Netlify: **Identity → Settings → Enable Git Gateway**.
4. (Consigliato) In Identity: **Registration → Invite only**.
5. Vai su `https://<tuo-sito>.netlify.app/admin` e fai login.
6. Una volta dentro, modifica e salva: il CMS fa commit su GitHub e Netlify redeploya.

### Note
- Nessun token GitHub nel frontend: si usa Git Gateway di Netlify.
- Se non vedi l’editor, verifica che Identity e Git Gateway siano abilitati.
