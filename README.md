# Line Dance Catalog (prototype)

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

## Aggiornare i dati
Per ora aggiorni `data.json` facendo commit sul repo.
Se poi vuoi aggiornamento “da browser” con commit automatici:
- soluzione consigliata: **Decap CMS** su Netlify (si aggiunge `/admin` e committa su Git)

