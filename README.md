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

## Catalogo relazionale
I balli sono salvati in tabelle relazionali (`dances`, `levels`, `styles`, `choreographers`,
`dance_media`, `dance_properties`, ...). La tabella storica `line_dance_data` (JSON) resta invariata
e viene riscritta come copia a ogni salvataggio, per compatibilità.
Modello ER, scelte progettuali, API e come aggiungere proprietà o provider: [doc/modello-dati.md](doc/modello-dati.md).

```
npm run db:migrate   # crea le tabelle e le popola dal JSON (idempotente)
```

L'admin salva **un ballo alla volta**, solo quelli modificati, con controllo di versione: un ballo cambiato
altrove nel frattempo non viene sovrascritto (vedi [doc/modello-dati.md](doc/modello-dati.md#salvataggio-un-ballo-alla-volta)).

Il sito carica i balli 25 alla volta mentre si scorre la lista; filtrando per difficoltà o per tag
arrivano subito tutti i risultati.

## Tema chiaro / scuro
Il sito e l'admin seguono il tema del sistema operativo ("Automatico") oppure la scelta
dell'utente: dal menu in alto a destra (voce **Tema**) nel sito, dal pulsante "Tema" nell'admin.
La scelta è salvata nel browser e vale per entrambe le pagine. I colori sono variabili in `theme.css`
(scuro = aspetto originale, chiaro = stesse variabili ridefinite); `theme.js` applica il tema prima
del primo disegno della pagina.

## Dati di un ballo
Oltre ai campi esistenti, ogni ballo supporta:
- `videos`: lista di video YouTube `{ url, title, startSeconds, danceStartSeconds }`.
  Sul sito ogni video ha la sua card con toolbar (inizio, parte ballata, espandi).
  I vecchi campi `youtubeUrl`, `videoTitle`, `youtubeStartSeconds`, `youtubeDanceStartSeconds`
  restano allineati al primo video (compatibilità).
- `amazonMusicUrl`: link di condivisione Amazon Music (brano/album/playlist) oppure il codice
  "Incorpora". Mostra l'anteprima e il link "Apri in Amazon Music", come per Spotify.

## Tag personali e login utenti
Ogni utente autenticato può assegnare tag liberi ai balli, filtrare per tag (chip colorate),
esportare e importare i propri tag in JSON (menu utente in alto a destra). L'export permette di
scegliere tutti i tag, una parte o uno solo; l'import unisce, non cancella nulla.
I **tag ufficiali** sono visibili a tutti, anche senza login, e hanno una grafica a colore pieno
con badge ✓. Si gestiscono solo dall'admin, nella sezione "Tag ufficiali" della scheda del ballo, e non
rientrano in export/import. Dettagli in [doc/modello-dati.md](doc/modello-dati.md#tag-ufficiali-di-sistema).

Nella modale dei tag, toccando il pallino di un tag se ne cambiano nome e colore: la rinomina
vale subito su tutti i balli che hanno quel tag (se il nuovo nome esiste già, i due tag vengono uniti
dopo conferma).

Login supportati:
- **Google** (OAuth2, implementato nelle function `auth`)
- **Facebook** (stesso flusso; si attiva impostando `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET`)
- **Account del sito** (Netlify Identity, lo stesso dell'admin)

Account con la stessa email verificata vengono uniti: i tag seguono la persona.

### Tabelle (create automaticamente al primo utilizzo)
- `app_users` – utenti
- `user_identities` – collegamento provider (google/facebook/netlify) → utente
- `tags` – tag per utente (nome univoco per utente, colore)
- `dance_tags` – relazione n-m tag ↔ ballo (`dance_id` = `id` del ballo nel JSON)

### Endpoint
- `GET /.netlify/functions/auth/me` – utente corrente e provider attivi
- `GET /.netlify/functions/auth/login/google` → redirect a Google
- `GET /.netlify/functions/auth/callback/google` – redirect URI OAuth
- `POST /.netlify/functions/auth/logout`
- `GET|PUT /.netlify/functions/tags`, `POST ?action=import`
- `PATCH /.netlify/functions/tags` `{id, name, merge?}` – rinomina un tag su tutti i balli;
  se il nome esiste già risponde 409 e, con `merge: true`, unisce i due tag
- `GET /.netlify/functions/tags?action=export` (tutti) oppure `&tags=<id>,<id>` (solo quelli scelti)

### Stelle e condivisione
- **Stelle (0–5)**: ogni utente autenticato vota un ballo; tutti vedono media e numero di voti, nel dettaglio e nella lista.
- **Condivisione**: come l'esportazione, si inviano a un altro utente tutti i propri tag, una parte o uno solo (menu
  "Condividi tag con un utente…" oppure dalla finestra di esportazione); il destinatario li trova in "Messaggi" e
  aggiunge ai suoi tutti quelli ricevuti, solo alcuni, o rifiuta. Dettagli in [doc/modello-dati.md](doc/modello-dati.md).

### Ruoli e accesso all'admin
| Ruolo | Cosa può fare | Come si ottiene |
|---|---|---|
| Utente | sito pubblico, tag personali | qualsiasi login (Google, account del sito) |
| Editor | pagina `/admin`: balli e tag ufficiali | promosso da un amministratore (pulsante **Utenti** nell'admin); gli account Netlify Identity (su invito) sono editor |
| Amministratore | come editor + gestione utenti | email elencate in `ADMIN_EMAILS` (configurazione del server, non modificabile dall'interfaccia) |

All'admin si accede con Google o con l'account del sito. Le API di scrittura (`dance`, `system-tags`,
`dances-update`) richiedono il ruolo di editor; `admin-users` (elenco utenti e cambio ruolo) solo amministratori.

### Variabili d'ambiente
- `SESSION_SECRET` – stringa casuale ≥ 32 caratteri (`openssl rand -base64 48`)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `ADMIN_EMAILS` – email degli amministratori, separate da virgola (es. `f.colucci@accadi.it`)
- opzionali: `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `PUBLIC_BASE_URL`

### Creare l'app Google (gratuita)
Il login con Google (OAuth2 / OpenID Connect) non ha costi né quote da pagare.
1. Vai su https://console.cloud.google.com/ e crea un progetto (es. `line-dance`).
2. **API e servizi → Schermata consenso OAuth** (Google Auth Platform):
   - Tipo utente: **Esterno**
   - Nome app, email di supporto, email sviluppatore
   - Ambiti: `openid`, `email`, `profile` (non richiedono verifica Google)
   - Finché l'app è in **Test**, aggiungi gli account autorizzati in "Utenti di test";
     quando vuoi aprirla a tutti premi **Pubblica app** (con questi ambiti non serve revisione).
3. **API e servizi → Credenziali → Crea credenziali → ID client OAuth**:
   - Tipo: **Applicazione web**
   - Origini JavaScript autorizzate: `http://localhost:8888`, `https://<tuo-sito>.netlify.app`
   - URI di reindirizzamento autorizzati:
     - `http://localhost:8888/.netlify/functions/auth/callback/google`
     - `https://<tuo-sito>.netlify.app/.netlify/functions/auth/callback/google`
     - (eventuale dominio personalizzato con lo stesso percorso)
4. Copia Client ID e Client secret:
   - in locale nel file `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`)
   - su Netlify in **Site settings → Environment variables**, insieme a `SESSION_SECRET`.

## Sviluppo locale
```
./dev.sh start      # Netlify Dev su http://localhost:8888 (DB remoto)
./dev.sh stop
```
`dev.sh` usa `netlify-cli@27.11.2`: la 27.12.1 va in crash su ogni richiesta senza
`Content-Type`. Attenzione: in locale le function usano lo **stesso DB di produzione**.
