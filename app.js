/* Line Dance Catalog - Static SPA
 * Data source: /.netlify/functions/catalog (relational tables, paged) or
 * ./data.json in local mode
 * - Master list with infinite scroll, search, year filter, per-user tag filter
 * - Detail view with one YouTube card per video, Spotify and Amazon Music
 * - Per-user tags (login via Google/Facebook OAuth or Netlify Identity)
 */

const state = {
  items: [],
  filtered: [],
  selectedId: null,
  cursorIndex: -1,
  stepsheetUrl: "",
};

const tagState = {
  user: null,
  providers: {},
  tags: new Map(),        // tagId -> {id, name, color}
  danceTags: new Map(),   // danceId (string) -> Set(tagId)
  filter: new Set(),      // selected personal tagIds (AND)
  sysFilter: new Set(),   // selected official (system) tagIds (AND)
};

// Official tags come from the catalog meta: same for everyone, read-only here.
function systemTagList(){
  return ((catalog.meta && catalog.meta.systemTags) || []).map(t => ({ ...t, id: String(t.id), system: true }));
}
function systemTagById(id){
  return systemTagList().find(t => t.id === String(id)) || null;
}
function systemTagsOf(it){
  return ((it && it.systemTags) || []).map(t => ({ ...t, id: String(t.id), system: true }));
}

const AUTH = "/.netlify/functions/auth";
const TAGS = "/.netlify/functions/tags";
const TAG_PALETTE = ["#7aa2ff", "#34d399", "#f472b6", "#fbbf24", "#a78bfa", "#38bdf8", "#fb923c", "#f87171", "#4ade80", "#e879f9"];

const $ = (id) => document.getElementById(id);

function safe(v){ return (v ?? "").toString().trim(); }

function toast(msg){
  const el = $("toast");
  if(!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(()=> el.classList.add("hidden"), 2800);
}

// Titles stored in ALL CAPS become Title Case, so the small-caps font can
// render capitals as capitals and the rest as small caps.
function displayTitle(v){
  const t = safe(v);
  if(!t || t !== t.toUpperCase() || t === t.toLowerCase()) return t;
  return t.toLowerCase().replace(/(^|[\s\-(\/"])(\p{L})/gu, (_m, p, c) => p + c.toUpperCase());
}

function makeYouTubeEmbedUrl(queryOrUrl){
  const v = safe(queryOrUrl);
  if(!v) return "";
  // If it's already a URL with a video id, try to extract
  const m1 = v.match(/[?&]v=([\w-]{6,})/);
  const m2 = v.match(/youtu\.be\/([\w-]{6,})/);
  const m3 = v.match(/youtube\.com\/(?:embed|shorts|live)\/([\w-]{6,})/);
  const vid = (m1 && m1[1]) || (m2 && m2[1]) || (m3 && m3[1]);
  if(vid) return `https://www.youtube.com/embed/${encodeURIComponent(vid)}`;
  // Fallback: YouTube search playlist embed (no API key)
  return `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(v)}`;
}

// Reads the "t" / "start" offset of a YouTube link: 255, 255s, 4m15s, 1h2m3s.
function youTubeLinkStart(url){
  const m = safe(url).match(/[?&#](?:t|start)=([0-9hms]+)/i);
  if(!m) return 0;
  const v = m[1].toLowerCase();
  if(/^\d+s?$/.test(v)) return parseInt(v, 10);
  const part = (unit) => Number((v.match(new RegExp(`(\\d+)${unit}`)) || [])[1] || 0);
  return part("h") * 3600 + part("m") * 60 + part("s");
}

// Cue the embed at a given second without autoplay (initial card state).
function withYouTubeCue(url, startSeconds){
  const seconds = Number(startSeconds);
  if(!url || !(seconds > 0)) return url;
  try{
    const u = new URL(url);
    u.searchParams.set("start", Math.floor(seconds));
    return u.toString();
  }catch{
    return url;
  }
}

function withYouTubeStart(url, startSeconds){
  const seconds = Number(startSeconds);
  if(!url) return url;
  try{
    const u = new URL(url);
    if(Number.isFinite(seconds) && seconds > 0){
      u.searchParams.set("start", Math.floor(seconds));
    } else {
      u.searchParams.delete("start");
    }
    u.searchParams.set("autoplay", "1");
    return u.toString();
  }catch{
    return url;
  }
}

function makeSpotifyEmbedOrNull(urlOrUri){
  const v = safe(urlOrUri);
  if(!v) return null;

  // Accept open.spotify.com links: optional intl-xx prefix + track/album/playlist/episode/show
  const m = v.match(/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist|episode|show)\/([a-zA-Z0-9]+)/i);
  if(m){
    const type = m[1];
    const id = m[2];
    return { embed: `https://open.spotify.com/embed/${type}/${id}`, app: `https://open.spotify.com/${type}/${id}` };
  }

  // Accept spotify:track:ID etc.
  const m2 = v.match(/^spotify:(track|album|playlist|episode|show):([a-zA-Z0-9]+)$/);
  if(m2){
    return { embed: `https://open.spotify.com/embed/${m2[1]}/${m2[2]}`, app: `https://open.spotify.com/${m2[1]}/${m2[2]}` };
  }

  return null;
}

const AMAZON_TERRITORY = {
  "com": "US", "it": "IT", "de": "DE", "fr": "FR", "es": "ES", "co.uk": "GB", "ca": "CA",
  "com.mx": "MX", "com.br": "BR", "co.jp": "JP", "com.au": "AU", "in": "IN",
};

// Accepts an Amazon Music share link (track/album/playlist/artist), an album
// link with ?trackAsin=, or the official embed code/URL from "Condividi > Incorpora".
function makeAmazonMusicEmbedOrNull(value){
  const v = safe(value);
  if(!v) return null;

  const em = v.match(/https?:\/\/music\.amazon\.[a-z.]+\/embed\/[^"'\s<>]+/i);
  if(em){
    const embed = em[0].replace(/&amp;/g, "&");
    const asin = (embed.match(/\/embed\/([A-Za-z0-9]+)/) || [])[1];
    return { embed, app: asin ? `https://music.amazon.com/tracks/${asin}` : "", compact: true };
  }

  let u;
  try{ u = new URL(v); }catch{ return null; }
  const host = u.hostname.match(/^music\.amazon\.([a-z.]+)$/i);
  if(!host) return null;
  const tld = host[1].toLowerCase();
  const territory = AMAZON_TERRITORY[tld] || "US";
  const trackAsin = u.searchParams.get("trackAsin");
  const m = u.pathname.match(/\/(tracks|albums|playlists|user-playlists|artists|podcasts)\/([A-Za-z0-9]+)/);
  const asin = trackAsin || (m && m[2]);
  if(!asin) return { embed: null, app: u.toString() };
  // Song links ("albums/<album>?trackAsin=<song>", what Amazon's "share song"
  // gives) open the song's own page, not the whole album. Browsers block
  // autoplay in a newly opened tab anyway, so do=play would not help.
  const isTrack = !!trackAsin || (m && m[1] === "tracks");
  return {
    embed: `https://music.amazon.${tld}/embed/${asin}/?musicTerritory=${territory}`,
    app: isTrack ? `https://music.amazon.${tld}/tracks/${asin}` : u.toString(),
    compact: true,
  };
}

// Difficulty filter: configured levels in order, only those with dances.
function renderYearFilter(levels){
  const sel = $("yearFilter");
  // keep first option
  sel.querySelectorAll("option:not(:first-child)").forEach(o => o.remove());
  levels.filter(l => l.dances == null || l.dances > 0).forEach(l=>{
    const opt = document.createElement("option");
    opt.value = l.code;
    opt.textContent = l.label || l.code;
    sel.appendChild(opt);
  });
}

// Difficulty level shown as the first "tag": same look as the old class badge.
function makeLevelChip(it, opts = {}){
  const label = safe(it.year);
  if(!label) return null;
  const chip = document.createElement(opts.button ? "button" : "span");
  if(opts.button) chip.type = "button";
  chip.className = "chip chipLevel" + (opts.small ? " chipSm" : "");
  chip.textContent = label;
  chip.title = `Difficoltà: ${label}`;
  return chip;
}

function filterByLevel(it){
  const code = safe(it.level) || safe(it.year);
  const sel = $("yearFilter");
  if(!code || ![...sel.options].some(o => o.value === code) || sel.value === code) return;
  sel.value = code;
  applyFilters({ keepSelection: true });
}

function tagsOfDance(danceId){
  const ids = tagState.danceTags.get(String(danceId));
  if(!ids) return [];
  return [...ids].map(id => tagState.tags.get(id)).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, "it", { sensitivity: "base" }));
}

/* ---------- Catalog source: paged API, or data.json in local mode ---------- */

const CATALOG = "/.netlify/functions/catalog";
const PAGE_SIZE = 25;
const catalog = { source: null, meta: null, total: 0, nextOffset: null, loading: false, seq: 0 };

function prepItem(x){
  return {
    ...x,
    year: safe(x.year),
    dance: safe(x.dance),
    style: safe(x.style),
    songTitle: safe(x.songTitle),
    spotifyUrl: safe(x.spotifyUrl),
    amazonMusicUrl: safe(x.amazonMusicUrl),
    videoTitle: safe(x.videoTitle),
    youtubeUrl: safe(x.youtubeUrl),
    details: safe(x.details),
    notes: safe(x.notes),
    choreographer: safe(x.choreographer),
    stepsheetTitle: safe(x.stepsheetTitle),
    stepsheetUrl: safe(x.stepsheetUrl),
  };
}

const remoteSource = {
  meta(){
    return api(`${CATALOG}?view=meta`);
  },
  page({ offset, limit, level, tags, stags, q }){
    const p = new URLSearchParams();
    if(level) p.set("level", level);
    if(tags.length) p.set("tags", tags.join(","));
    if(stags.length) p.set("stags", stags.join(","));
    if(q) p.set("q", q);
    if(limit == null){
      p.set("all", "1");
    } else {
      p.set("offset", String(offset));
      p.set("limit", String(limit));
    }
    return api(`${CATALOG}?${p}`);
  },
};

// Same contract as the API, computed in the browser from data.json.
function makeLocalSource(data){
  const all = (Array.isArray(data) ? data : (data.items || [])).map(prepItem);
  const levelKey = (c) => {
    const m = String(c).match(/^(\d+)(.*)$/);
    return m ? `0${String(m[1]).padStart(6, "0")}${m[2]}` : `1${String(c).toLowerCase()}`;
  };
  return {
    async meta(){
      const codes = [...new Set(all.map(x => x.year).filter(Boolean))].sort((a, b) => levelKey(a).localeCompare(levelKey(b)));
      return { total: all.length, levels: codes.map(code => ({ code, label: code })), propertyDefinitions: [], mediaProviders: [] };
    },
    async page({ offset, limit, level, tags, stags, q }){
      const ql = (q || "").toLowerCase();
      const matches = all.filter(it => {
        if(level && it.year.toLowerCase() !== level.toLowerCase()) return false;
        if(tags.length){
          const own = tagState.danceTags.get(String(it.id));
          if(!own || !tags.every(t => own.has(t))) return false;
        }
        if(stags.length){
          const own = new Set(systemTagsOf(it).map(t => t.id));
          if(!stags.every(t => own.has(t))) return false;
        }
        if(!ql) return true;
        const hay = [it.dance, it.songTitle, it.style, it.details, it.notes, it.choreographer,
          ...tagsOfDance(it.id).map(t => t.name), ...systemTagsOf(it).map(t => t.name)].map(safe).join(" • ").toLowerCase();
        return hay.includes(ql);
      });
      const items = limit == null ? matches : matches.slice(offset, offset + limit);
      const nextOffset = limit != null && offset + items.length < matches.length ? offset + items.length : null;
      return { items, total: matches.length, offset, limit, nextOffset };
    },
  };
}

function currentFilters(){
  return {
    level: $("yearFilter").value || null,
    tags: [...tagState.filter],
    stags: [...tagState.sysFilter],
    q: safe($("searchInput").value) || null,
  };
}

function updateCount(){
  const n = state.items.length;
  $("countLabel").textContent = n < catalog.total ? `${n} di ${catalog.total} risultati` : `${catalog.total} risultati`;
}

function updateSentinel(){
  const s = $("listSentinel");
  if(!s) return;
  const more = catalog.nextOffset != null;
  s.textContent = catalog.loading ? "Caricamento…" : (more ? "Scorri per caricare altri balli" : "");
  s.classList.toggle("hidden", !catalog.loading && !more);
}

function setListLoading(on){
  catalog.loading = on;
  updateSentinel();
}

// Reloads the list from the first page. With a level or tag filter the whole
// result set comes at once; otherwise pages arrive while scrolling.
// Reloads the list from the first page. With a level or tag filter the whole
// result set comes at once; otherwise pages arrive while scrolling.
async function applyFilters(opts = {}){
  const seq = ++catalog.seq;
  const f = currentFilters();
  const everything = !!f.level || f.tags.length > 0 || f.stags.length > 0;
  setListLoading(true);
  let res;
  try{
    res = await catalog.source.page({ ...f, offset: 0, limit: everything ? null : PAGE_SIZE });
  }catch(err){
    if(seq !== catalog.seq) return;
    console.error(err);
    setListLoading(false);
    toast("Errore nel caricamento dei balli");
    return;
  }
  if(seq !== catalog.seq) return; // a newer search/filter superseded this one
  showResults(res, opts);
}

// Renders a result set. `quiet` = background refresh: keeps the list scroll
// and does not re-render the open dance (its videos would restart) unless
// that dance actually changed.
function showResults(res, opts = {}){
  const prev = selectedItem();
  const prevJson = prev ? JSON.stringify(prev) : null;
  const list = $("list");
  const scroll = list.scrollTop;
  $("detailLoading").classList.add("hidden");

  catalog.ready = true;
  state.items = res.items.map(prepItem);
  state.filtered = state.items;
  catalog.total = res.total ?? state.items.length;
  catalog.nextOffset = res.nextOffset ?? null;
  catalog.loading = false;
  renderList();
  updateCount();
  list.scrollTop = opts.quiet ? scroll : 0;

  if(opts.keepSelection || opts.quiet){
    const idx = state.filtered.findIndex(x => String(x.id) === String(state.selectedId));
    if(idx >= 0){
      const it = state.filtered[idx];
      if(opts.quiet && prevJson === JSON.stringify(it)){
        state.cursorIndex = idx;
        markSelected(it.id);
        return;
      }
      selectById(it.id, idx);
      return;
    }
  }
  // Always select the first item after filtering/searching
  if(state.filtered.length > 0){
    selectById(state.filtered[0].id, 0);
  } else {
    clearSelection();
  }
}

/* ---------- Fresh data: cache, revision polling, same-browser push ---------- */

const CACHE_KEY = "ld-catalog-cache-v1";
const REFRESH_MS = 30000;

// Last default view seen (meta + first page): shown instantly on the next
// visit, then refreshed. A per-browser convenience only.
function readCache(){
  try{
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    return c && c.meta && c.page && Array.isArray(c.page.items) ? c : null;
  }catch{
    return null;
  }
}

function writeCache(meta, page){
  try{
    localStorage.setItem(CACHE_KEY, JSON.stringify({ meta, page, at: Date.now() }));
  }catch{}
}

function isDefaultView(f){
  return !f.level && !f.tags.length && !f.stags.length && !f.q;
}

// Levels and official tags can change in the admin: refresh their widgets
// keeping the current choices when they still exist.
function applyMeta(meta){
  catalog.meta = meta;
  const sel = $("yearFilter");
  const current = sel.value;
  renderYearFilter(meta.levels || []);
  sel.value = [...sel.options].some(o => o.value === current) ? current : "";
  const ids = new Set(systemTagList().map(t => t.id));
  [...tagState.sysFilter].forEach(id => { if(!ids.has(id)) tagState.sysFilter.delete(id); });
  renderTagFilter();
}

// Re-reads meta and the current view (as many dances as already loaded).
async function refreshCatalog(){
  if(catalog.refreshing) return;
  catalog.refreshing = true;
  try{
    const seq = catalog.seq;
    const f = currentFilters();
    const everything = !!f.level || f.tags.length > 0 || f.stags.length > 0;
    const limit = everything ? null : Math.min(Math.max(PAGE_SIZE, state.items.length), 200);
    const [meta, res] = await Promise.all([
      catalog.source.meta(),
      catalog.source.page({ ...f, offset: 0, limit }),
    ]);
    if(seq !== catalog.seq) return; // the user changed view meanwhile
    applyMeta(meta);
    showResults(res, { quiet: true });
    if(isDefaultView(f)) writeCache(meta, res);
  }catch(err){
    console.warn("refresh", err);
  }finally{
    catalog.refreshing = false;
  }
}

async function checkForUpdates(){
  if(catalog.source !== remoteSource || document.hidden || catalog.refreshing) return;
  try{
    const { revision } = await api(`${CATALOG}?view=revision`);
    if(revision && catalog.meta && revision !== catalog.meta.revision) await refreshCatalog();
  }catch(err){
    console.warn("revision", err);
  }
}

// Tags may change on another device: re-read them, and touch the page only
// if they actually changed (quietly: no scroll jump, players untouched).
async function refreshTagsQuietly(){
  if(!tagState.user) return;
  try{
    const data = await api(TAGS);
    const json = JSON.stringify(data);
    if(json === catalog.tagsJson) return;
    catalog.tagsJson = json;
    const hadTagFilter = tagState.filter.size > 0;
    setTagData(data);
    renderTagFilter();
    afterTagsChanged(hadTagFilter, { quiet: true });
  }catch{}
}

// Push within the browser (admin tab -> site tabs), plus a cheap revision
// check when the tab comes back into view and every 30 s while visible.
function startUpdateWatchers(){
  if(catalog.source !== remoteSource) return;
  if("BroadcastChannel" in window){
    const ch = new BroadcastChannel("ld-catalog");
    ch.onmessage = (e)=>{ if(e.data && e.data.type === "catalog-changed") refreshCatalog(); };
  }
  let last = 0;
  const onVisible = ()=>{
    if(document.hidden || Date.now() - last < 5000) return;
    last = Date.now();
    checkForUpdates();
    refreshTagsQuietly();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  setInterval(()=>{ if(!document.hidden) checkForUpdates(); }, REFRESH_MS);
}

function showListSkeleton(){
  const list = $("list");
  list.innerHTML = "";
  for(let i = 0; i < 7; i++){
    const li = document.createElement("li");
    li.className = "listItem skeleton";
    li.setAttribute("aria-hidden", "true");
    li.innerHTML = '<div class="itemText"><p class="skLine skTitle"></p><p class="skLine skSub"></p><div class="skLine skChips"></div></div>';
    list.appendChild(li);
  }
  $("countLabel").textContent = "Caricamento…";
}

async function loadMore(){
  if(catalog.loading || catalog.nextOffset == null) return;
  const seq = catalog.seq;
  setListLoading(true);
  let res;
  try{
    res = await catalog.source.page({ ...currentFilters(), offset: catalog.nextOffset, limit: PAGE_SIZE });
  }catch(err){
    if(seq === catalog.seq){
      console.error(err);
      setListLoading(false);
      toast("Errore nel caricamento di altri balli");
    }
    return;
  }
  if(seq !== catalog.seq) return;
  const start = state.items.length;
  const known = new Set(state.items.map(x => String(x.id)));
  state.items.push(...res.items.map(prepItem).filter(x => !known.has(String(x.id))));
  if(res.total != null) catalog.total = res.total;
  catalog.nextOffset = res.nextOffset ?? null;
  catalog.loading = false;
  appendListItems(start);
  updateCount();
}

// Tags changed: the server only needs to be asked again when a tag filter or
// a search (which also matches tag names) is active.
function afterTagsChanged(hadTagFilter = false, opts = {}){
  if(!catalog.ready) return; // the first results will render the tags
  if(hadTagFilter || tagState.filter.size || safe($("searchInput").value)){
    applyFilters({ keepSelection: true, ...opts });
    return;
  }
  renderList();
  updateCount();
  const it = selectedItem();
  if(it) renderDetailTags(it);
}

// Readable text on a solid tag color.
function contrastText(hex){
  const m = String(hex || "").match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if(!m) return "#ffffff";
  const [r, g, b] = m.slice(1).map(h => parseInt(h, 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#0b0f17" : "#ffffff";
}

// Personal tags: tinted outline with a color dot. Official tags (tag.system):
// solid fill with a check badge.
function makeChip(tag, opts = {}){
  const chip = document.createElement(opts.button ? "button" : "span");
  chip.className = "chip" + (opts.small ? " chipSm" : "") + (tag.system ? " chipSystem" : "");
  chip.style.setProperty("--chip", tag.color);
  if(opts.button) chip.type = "button";
  let mark;
  if(tag.system){
    chip.style.setProperty("--chip-text", contrastText(tag.color));
    mark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    mark.setAttribute("viewBox", "0 0 24 24");
    mark.setAttribute("class", "chipBadge");
    mark.setAttribute("aria-hidden", "true");
    mark.innerHTML = '<path d="M12 2l2.4 1.8 3-.2 1 2.8 2.6 1.5-.6 2.9 1.3 2.7-2.1 2.1-.2 3-2.9.7L14.8 22 12 20.8 9.2 22l-1.7-2.5-2.9-.7-.2-3-2.1-2.1 1.3-2.7-.6-2.9 2.6-1.5 1-2.8 3 .2z" fill="currentColor" opacity=".28"/><path d="M8 12.5l2.7 2.7L16.5 9.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>';
    if(!chip.title) chip.title = `Tag ufficiale: ${tag.name}`;
  } else {
    mark = document.createElement("span");
    mark.className = "chipDot";
  }
  const label = document.createElement("span");
  label.className = "chipLabel";
  label.textContent = tag.name;
  chip.append(mark, label);
  return chip;
}

// Chips shown per list row (difficulty included) before collapsing into "+n".
const MAX_LIST_CHIPS = 10;

function buildListItem(it, idx){
  const li = document.createElement("li");
  li.className = "listItem";
  li.setAttribute("role","option");
  li.dataset.id = it.id;
  li.tabIndex = 0;
  li.setAttribute("aria-selected", String(it.id) === String(state.selectedId) ? "true" : "false");

  const box = document.createElement("div");
  box.className = "itemText";

  const t = document.createElement("p");
  t.className = "itemTitle danceTitle";
  t.textContent = displayTitle(it.dance) || "(senza titolo)";

  const s = document.createElement("p");
  s.className = "itemSub";
  const song = safe(it.songTitle);
  const style = safe(it.style);
  s.textContent = [song, style].filter(Boolean).join(" • ");

  box.appendChild(t);
  box.appendChild(s);

  // Order: difficulty, official tags, personal tags.
  const tags = [...systemTagsOf(it), ...tagsOfDance(it.id)];
  const levelChip = makeLevelChip(it, { small: true });
  if(tags.length || levelChip){
    const row = document.createElement("div");
    row.className = "itemTags";
    if(levelChip) row.appendChild(levelChip);
    // Tags are meant to be seen: cap only very long lists (~3 rows).
    const room = MAX_LIST_CHIPS - (levelChip ? 1 : 0);
    tags.slice(0, room).forEach(tag => row.appendChild(makeChip(tag, { small: true })));
    if(tags.length > room){
      const more = document.createElement("span");
      more.className = "chipMore";
      more.textContent = `+${tags.length - room}`;
      more.title = tags.slice(room).map(t => t.name).join(", ");
      row.appendChild(more);
    }
    box.appendChild(row);
  }

  li.appendChild(box);

  li.addEventListener("click", ()=> selectById(it.id, idx));
  li.addEventListener("keydown", (e)=>{
    if(e.key === "Enter" || e.key === " "){
      e.preventDefault();
      selectById(it.id, idx);
    }
  });
  return li;
}

// The sentinel sits after the last item; when it scrolls into view the next
// page is requested (see listObserver in init).
function placeSentinel(){
  const list = $("list");
  let s = $("listSentinel");
  if(!s){
    s = document.createElement("li");
    s.id = "listSentinel";
    s.className = "listSentinel";
    s.setAttribute("role", "presentation");
  }
  list.appendChild(s);
  updateSentinel();
  if(catalog.observer){
    catalog.observer.unobserve(s);
    catalog.observer.observe(s);
  }
}

function renderList(){
  const list = $("list");
  list.innerHTML = "";
  state.filtered.forEach((it, idx)=> list.appendChild(buildListItem(it, idx)));
  placeSentinel();

  // Cursor fallback
  if(state.cursorIndex >= state.filtered.length) state.cursorIndex = state.filtered.length - 1;
}

function appendListItems(start){
  const list = $("list");
  const frag = document.createDocumentFragment();
  state.filtered.slice(start).forEach((it, i)=> frag.appendChild(buildListItem(it, start + i)));
  const s = $("listSentinel");
  if(s) list.insertBefore(frag, s); else list.appendChild(frag);
  placeSentinel();
}

function clearSelection(){
  state.selectedId = null;
  state.cursorIndex = -1;
  $("detailView").classList.add("hidden");
  // reset aria-selected
  document.querySelectorAll(".listItem").forEach(el=> el.setAttribute("aria-selected","false"));
}

function markSelected(id){
  document.querySelectorAll(".listItem").forEach(el=>{
    el.setAttribute("aria-selected", el.dataset.id === String(id) ? "true" : "false");
  });
}

function selectById(id, index){
  state.selectedId = id;
  state.cursorIndex = index;
  markSelected(id);

  const item = state.filtered.find(x=>x.id === id) || state.items.find(x=>x.id===id);
  if(item) renderDetail(item);
}

function selectedItem(){
  return state.items.find(x => String(x.id) === String(state.selectedId)) || null;
}

function getVideos(it){
  if(Array.isArray(it.videos) && it.videos.length){
    return it.videos.filter(v => v && safe(v.url));
  }
  const url = safe(it.youtubeUrl);
  if(!url) return [];
  return [{
    url,
    title: safe(it.videoTitle),
    startSeconds: it.youtubeStartSeconds || it.youtubeStart || 0,
    danceStartSeconds: it.youtubeDanceStartSeconds || it.youtubeDanceStart || 0,
  }];
}

function renderVideos(it, fallbackQuery){
  const col = $("videoColumn");
  col.innerHTML = "";
  const videos = getVideos(it);
  const list = videos.length ? videos : [{ url: "", title: "" }];
  const expanded = document.body.classList.contains("videoExpanded");
  const tpl = $("videoCardTpl");

  list.forEach((v, i)=>{
    const card = tpl.content.firstElementChild.cloneNode(true);
    const url = safe(v.url);
    const embed = makeYouTubeEmbedUrl(url || fallbackQuery);
    // Explicit "Start" wins; otherwise use the link's own t= offset.
    const startSeconds = Number(v.startSeconds || youTubeLinkStart(url) || 0);
    const danceSeconds = Number(v.danceStartSeconds || startSeconds || 0);
    card.dataset.base = embed;
    card.dataset.start = Number.isFinite(startSeconds) ? String(startSeconds) : "0";
    card.dataset.dance = Number.isFinite(danceSeconds) ? String(danceSeconds) : "0";

    const title = safe(v.title) || (list.length > 1 ? `Video ${i + 1}` : "YouTube");
    card.querySelector(".videoTitle").textContent = title;
    const frame = card.querySelector("iframe");
    frame.title = title;
    frame.src = withYouTubeCue(embed, startSeconds);
    card.querySelector('[data-action="size"]').setAttribute("aria-pressed", expanded ? "true" : "false");

    const link = card.querySelector(".videoLink");
    if(/^https?:\/\//i.test(url)){
      link.href = url;
      link.textContent = "Apri su YouTube";
    } else {
      const q = fallbackQuery || url;
      link.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
      link.textContent = q ? `Cerca: ${q}` : "Apri YouTube";
    }
    col.appendChild(card);
  });
}

// Amazon's widget has no compact size: rendered at 500x152 it switches to a
// horizontal layout (cover, title, play); scaling it to the card width gives a
// strip about as tall as Spotify's.
const AMAZON_W = 500;
const AMAZON_H = 152;
const amazonScaler = typeof ResizeObserver === "function" ? new ResizeObserver(entries => {
  entries.forEach(e => fitAmazonFrame(e.target));
}) : null;

function fitAmazonFrame(box){
  const iframe = box.querySelector("iframe");
  if(!iframe) return;
  const scale = Math.min(1, box.clientWidth / AMAZON_W) || 1;
  iframe.style.transform = `scale(${scale})`;
  box.style.height = `${Math.round(AMAZON_H * scale)}px`;
}

function renderMusicCard({ containerId, linkId, info, title, placeholderHtml, searchUrl }){
  const container = $(containerId);
  const appLink = $(linkId);
  container.innerHTML = "";
  if(info && info.embed && info.compact){
    const box = document.createElement("div");
    box.className = "amazonScale";
    const iframe = document.createElement("iframe");
    iframe.title = title;
    iframe.loading = "lazy";
    iframe.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
    iframe.width = String(AMAZON_W);
    iframe.height = String(AMAZON_H);
    iframe.src = info.embed;
    box.appendChild(iframe);
    container.appendChild(box);
    fitAmazonFrame(box);
    if(amazonScaler) amazonScaler.observe(box);
  } else if(info && info.embed){
    const iframe = document.createElement("iframe");
    iframe.className = "frame";
    iframe.title = title;
    iframe.loading = "lazy";
    iframe.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
    iframe.src = info.embed;
    container.appendChild(iframe);
  } else {
    const div = document.createElement("div");
    div.className = "musicPlaceholder";
    div.innerHTML = placeholderHtml;
    div.querySelector("a").href = searchUrl;
    container.appendChild(div);
  }
  const app = info && info.app;
  appLink.parentElement.classList.toggle("hidden", !app);
  if(app) appLink.href = app;
}

function renderDetail(it){
  $("detailView").classList.remove("hidden");

  const dance = safe(it.dance);
  const song = safe(it.songTitle);
  $("detailTitle").textContent = displayTitle(dance) || "(senza titolo)";
  $("detailSong").textContent = song || "—";

  $("detailStyle").textContent = safe(it.style) || "—";

  $("detailDetails").textContent = safe(it.details) || "—";
  $("detailNotes").textContent = safe(it.notes) || "—";
  $("detailChoreo").textContent = safe(it.choreographer) || "—";

  renderDetailTags(it);
  renderExtraLinks(it);

  // Stepsheet link (if it's a URL, open it; else hide)
  const stepsheet = safe(it.stepsheetUrl || it.stepsheetUrlTitle);
  const stepsheetLink = $("stepsheetLink");
  if(/^https?:\/\//i.test(stepsheet)){
    stepsheetLink.href = stepsheet;
    stepsheetLink.style.display = "inline-flex";
    state.stepsheetUrl = stepsheet;
  } else {
    stepsheetLink.href = "#";
    stepsheetLink.style.display = "none";
    state.stepsheetUrl = "";
  }

  const q = song || dance || "";
  const fallbackQuery = [dance, song].filter(Boolean).join(" ");
  const spotify = makeSpotifyEmbedOrNull(safe(it.spotifyUrl || it.spotify || ""));
  const amazon = makeAmazonMusicEmbedOrNull(it.amazonMusicUrl);

  // Players are rebuilt only when what they play changes: refreshing the same
  // dance (background updates, tag edits, filters) must never restart a video
  // or a song the user is listening to.
  const mediaKey = JSON.stringify([it.id, getVideos(it), fallbackQuery, spotify, amazon]);
  const playersChanged = mediaKey !== state.mediaKey;
  state.mediaKey = mediaKey;
  if(!playersChanged){
    scrollSelectedIntoView(it);
    return;
  }

  // YouTube: one card per video
  renderVideos(it, fallbackQuery);

  // Spotify
  renderMusicCard({
    containerId: "spotifyContainer",
    linkId: "spotifyAppLink",
    info: spotify,
    title: "Spotify player",
    searchUrl: `https://open.spotify.com/search/${encodeURIComponent(q)}`,
    placeholderHtml: `
      <p><strong>Embed non disponibile</strong> (manca un link/URI Spotify nel dataset).</p>
      <p>Intanto ti apro la ricerca su Spotify col nome brano.</p>
      <a class="primaryLink" target="_blank" rel="noopener">Cerca su Spotify</a>
    `,
  });

  // Amazon Music
  renderMusicCard({
    containerId: "amazonContainer",
    linkId: "amazonAppLink",
    info: amazon,
    title: "Amazon Music player",
    searchUrl: `https://music.amazon.it/search/${encodeURIComponent(q)}`,
    placeholderHtml: `
      <p><strong>Embed non disponibile</strong> (manca un link Amazon Music nel dataset).</p>
      <a class="primaryLink" target="_blank" rel="noopener">Cerca su Amazon Music</a>
    `,
  });

  scrollSelectedIntoView(it);
}

// Scroll list item into view for visibility
function scrollSelectedIntoView(it){
  const activeEl = document.querySelector(`.listItem[data-id="${CSS.escape(String(it.id))}"]`);
  if(activeEl) activeEl.scrollIntoView({block:"nearest"});
}

// Links of media providers added only in the DB (media_providers) and without
// a dedicated card yet are listed generically.
const BUILTIN_PROVIDERS = new Set(["youtube", "spotify", "amazon_music", "stepsheet"]);

function renderExtraLinks(it){
  const providers = new Map(((catalog.meta && catalog.meta.mediaProviders) || []).map(p => [p.code, p]));
  const links = (it.media || []).filter(m => !BUILTIN_PROVIDERS.has(m.provider) && /^https?:\/\//i.test(safe(m.url)));
  const ul = $("extraLinks");
  ul.innerHTML = "";
  $("extraLinksWrap").classList.toggle("hidden", !links.length);
  links.forEach(m => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = m.url;
    a.target = "_blank";
    a.rel = "noopener";
    const label = (providers.get(m.provider) || {}).label || m.provider;
    a.textContent = m.title ? `${label} · ${m.title}` : label;
    li.appendChild(a);
    ul.appendChild(li);
  });
}

function renderDetailTags(it){
  const box = $("detailTags");
  const btn = $("editTagsBtn");
  box.innerHTML = "";
  const levelChip = makeLevelChip(it, { button: true });
  if(levelChip){
    levelChip.title = `Difficoltà: ${safe(it.year)} · filtra per questa difficoltà`;
    levelChip.addEventListener("click", ()=> filterByLevel(it));
    box.appendChild(levelChip);
  }
  systemTagsOf(it).forEach(tag => {
    const chip = makeChip(tag, { button: true });
    chip.title = `Tag ufficiale · filtra per "${tag.name}"`;
    chip.addEventListener("click", ()=> addSystemTagFilter(tag.id));
    box.appendChild(chip);
  });
  if(!tagState.user){
    btn.textContent = "Accedi per i tuoi tag";
    return;
  }
  const tags = tagsOfDance(it.id);
  tags.forEach(tag => {
    const chip = makeChip(tag, { button: true });
    chip.title = `Filtra per "${tag.name}"`;
    chip.addEventListener("click", ()=> addTagFilter(tag.id));
    box.appendChild(chip);
  });
  btn.textContent = tags.length ? "Modifica i miei tag" : "+ I miei tag";
}

/* ---------- API / auth ---------- */

async function authHeaders(){
  const ni = window.netlifyIdentity;
  const u = ni && ni.currentUser();
  if(!u) return {};
  try{
    return { authorization: `Bearer ${await u.jwt()}` };
  }catch(err){
    console.warn("Netlify Identity: rinnovo token fallito", err);
    return {};
  }
}

async function api(path, opts = {}){
  const headers = {
    ...(opts.body ? { "content-type": "application/json" } : {}),
    ...(await authHeaders()),
  };
  const res = await fetch(path, { ...opts, headers, credentials: "same-origin", cache: "no-store" });
  if(!res.ok){
    const body = await res.text().catch(()=> "");
    const err = new Error(body || `HTTP ${res.status}`);
    err.status = res.status;
    try{ err.data = JSON.parse(body); }catch{}
    throw err;
  }
  return (res.headers.get("content-type") || "").includes("json") ? res.json() : res.text();
}

// Subscribed as soon as the script runs (before the catalog fetch), so the
// widget's one-shot "init" event - which restores a saved login - is never missed.
const identityInit = new Promise(resolve => {
  const ni = window.netlifyIdentity;
  if(!ni) return resolve(null);
  ni.on("init", user => resolve(user || null));
});

function setTagData(data){
  catalog.tagsJson = JSON.stringify(data || {});
  tagState.tags = new Map((data.tags || []).map(t => [String(t.id), t]));
  tagState.danceTags = new Map(Object.entries(data.danceTags || {}).map(([d, ids]) => [String(d), new Set(ids.map(String))]));
  [...tagState.filter].forEach(id => { if(!tagState.tags.has(id)) tagState.filter.delete(id); });
}

function refreshUser(){
  tagState.userRequest = doRefreshUser().finally(()=>{ tagState.userRequest = null; });
  return tagState.userRequest;
}

async function doRefreshUser(){
  const hadTagFilter = tagState.filter.size > 0;
  try{
    const me = await api(`${AUTH}/me`);
    tagState.user = me.user;
    tagState.providers = me.providers || {};
    tagState.providersLoaded = true;
    const ni = window.netlifyIdentity;
    if(!me.user && ni && ni.currentUser()){
      console.warn("auth/me: login Netlify Identity presente ma non accettato dal server");
      toast("Accesso del sito scaduto: rifai l'accesso per vedere i tuoi tag");
    }
  }catch(err){
    console.warn("auth/me", err);
    tagState.user = null;
  }
  if(tagState.user){
    try{
      setTagData(await api(TAGS));
    }catch(err){
      console.error(err);
      toast("Impossibile caricare i tuoi tag");
    }
  } else {
    setTagData({});
  }
  renderUserArea();
  renderTagFilter();
  afterTagsChanged(hadTagFilter);
}

// The menu is always there: user items when logged in, settings (theme) for everyone.
function renderUserArea(){
  const u = tagState.user;
  $("loginBtn").classList.toggle("hidden", !!u);
  document.querySelectorAll("#userMenu .userOnly").forEach(el => el.classList.toggle("hidden", !u));
  document.querySelectorAll("#userMenu .guestOnly").forEach(el => el.classList.toggle("hidden", !!u));
  $("userMenuBtn").setAttribute("aria-label", u ? `Menu di ${u.name}` : "Menu");
  if(!u) return;
  $("userName").textContent = u.name;
  $("userMenuEmail").textContent = u.email || u.name;
  const av = $("userAvatar");
  av.innerHTML = "";
  if(u.avatarUrl){
    const img = document.createElement("img");
    img.src = u.avatarUrl;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    av.appendChild(img);
  } else {
    av.textContent = (u.name || "?").trim().charAt(0).toUpperCase();
  }
}

async function logout(){
  try{ await api(`${AUTH}/logout`, { method: "POST" }); }catch{}
  const ni = window.netlifyIdentity;
  if(ni && ni.currentUser()){
    try{ await ni.logout(); }catch{}
  }
  tagState.filter.clear();
  await refreshUser();
  toast("Disconnesso");
}

function openModal(id){ $(id).classList.remove("hidden"); }
function closeModalEl(id){ $(id).classList.add("hidden"); }

function wireDismissableModal(id, onClose){
  const modal = $(id);
  modal.addEventListener("click", (e)=>{
    if(e.target && e.target.closest("[data-close]")){
      closeModalEl(id);
      if(onClose) onClose();
    }
  });
  document.addEventListener("keydown", (e)=>{
    if(e.key === "Escape" && !modal.classList.contains("hidden")){
      closeModalEl(id);
      if(onClose) onClose();
    }
  });
}

async function openLoginModal(){
  const back = encodeURIComponent(location.pathname + location.search.replace(/[?&]authError=[^&]*/, ""));
  if(!tagState.providersLoaded){
    // Opened before /auth/me answered: wait for it instead of showing the
    // providers as "not configured".
    $("loginNote").textContent = "Caricamento…";
    ["loginGoogle", "loginFacebook"].forEach(id => $(id).classList.add("hidden"));
    openModal("loginModal");
    await (tagState.userRequest || refreshUser());
  }
  // Providers without credentials on the server (e.g. Facebook for now) are
  // not shown at all; they appear as soon as they are configured.
  const providers = tagState.providers || {};
  [["google", "loginGoogle"], ["facebook", "loginFacebook"]].forEach(([p, id])=>{
    const a = $(id);
    const on = !!providers[p];
    a.classList.toggle("hidden", !on);
    a.classList.remove("disabled");
    a.setAttribute("aria-disabled", "false");
    a.href = on ? `${AUTH}/login/${p}?return=${back}` : "#";
  });
  $("loginNote").textContent = "";
  openModal("loginModal");
}

function wireAuth(){
  $("loginBtn").addEventListener("click", openLoginModal);
  ["loginGoogle", "loginFacebook"].forEach(id => {
    $(id).addEventListener("click", (e)=>{
      if($(id).classList.contains("disabled")) e.preventDefault();
    });
  });
  $("loginNetlify").addEventListener("click", ()=>{
    closeModalEl("loginModal");
    if(window.netlifyIdentity) window.netlifyIdentity.open("login");
  });
  wireDismissableModal("loginModal");

  const ni = window.netlifyIdentity;
  if(ni){
    ni.on("login", ()=>{ ni.close(); refreshUser(); });
    // Saved login restored after the first refresh: load the user's tags now.
    identityInit.then(user => { if(user && !tagState.user) refreshUser(); });
    ni.on("logout", ()=> refreshUser());
  }

  const menuBtn = $("userMenuBtn");
  const panel = $("userMenuPanel");
  const setMenu = (open)=>{
    panel.classList.toggle("hidden", !open);
    menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
  };
  menuBtn.addEventListener("click", (e)=>{
    e.stopPropagation();
    setMenu(panel.classList.contains("hidden"));
  });
  document.addEventListener("click", (e)=>{
    if(!panel.contains(e.target)) setMenu(false);
  });
  $("logoutBtn").addEventListener("click", ()=>{ setMenu(false); logout(); });
  wireThemeSwitch(panel);
  $("exportTagsBtn").addEventListener("click", ()=>{ setMenu(false); openExportModal(); });
  $("importTagsBtn").addEventListener("click", ()=>{ setMenu(false); $("importTagsFile").click(); });
  $("importTagsFile").addEventListener("change", importTagsFromFile);

  const params = new URLSearchParams(location.search);
  if(params.has("authError")){
    toast(`Accesso non riuscito (${params.get("authError")})`);
    params.delete("authError");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
  }
}

/* ---------- Theme ---------- */

function wireThemeSwitch(root){
  const theme = window.LDTheme;
  if(!theme) return;
  const sync = ()=>{
    root.querySelectorAll("[data-theme-choice]").forEach(b => {
      b.setAttribute("aria-checked", b.dataset.themeChoice === theme.get() ? "true" : "false");
    });
  };
  root.querySelectorAll("[data-theme-choice]").forEach(b => {
    b.addEventListener("click", (e)=>{
      e.stopPropagation();
      theme.set(b.dataset.themeChoice);
    });
  });
  theme.onChange(sync);
  sync();
}

/* ---------- Tags: filter, editor, export/import ---------- */

function defaultTagColor(name){
  let h = 0;
  for(const ch of name.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return TAG_PALETTE[h % TAG_PALETTE.length];
}

function sortedTags(){
  return [...tagState.tags.values()].sort((a, b) => a.name.localeCompare(b.name, "it", { sensitivity: "base" }));
}

function renderTagFilter(){
  const sel = $("tagFilter");
  const chips = $("tagFilterChips");
  const sysAvailable = systemTagList().filter(t => !tagState.sysFilter.has(t.id));
  const available = tagState.user ? sortedTags().filter(t => !tagState.filter.has(t.id)) : [];
  const anyTags = systemTagList().length > 0 || (tagState.user && tagState.tags.size > 0);
  sel.classList.toggle("hidden", !anyTags);
  sel.innerHTML = "";
  const first = document.createElement("option");
  first.value = "";
  first.textContent = sysAvailable.length || available.length ? "Filtra per tag…" : "Tutti i tag selezionati";
  sel.appendChild(first);
  const group = (label, tags, prefix, mark) => {
    if(!tags.length) return;
    const g = document.createElement("optgroup");
    g.label = label;
    tags.forEach(t => {
      const opt = document.createElement("option");
      opt.value = `${prefix}:${t.id}`;
      opt.textContent = `${mark}${t.name}`;
      g.appendChild(opt);
    });
    sel.appendChild(g);
  };
  group("Tag ufficiali", sysAvailable, "s", "✓ ");
  group("I miei tag", available, "u", "");

  chips.innerHTML = "";
  const selected = [
    ...[...tagState.sysFilter].map(systemTagById).filter(Boolean),
    ...[...tagState.filter].map(id => tagState.tags.get(id)).filter(Boolean),
  ];
  chips.classList.toggle("hidden", selected.length === 0);
  if(!selected.length) return;
  const label = document.createElement("span");
  label.className = "filterLabel";
  label.textContent = "Tag:";
  chips.appendChild(label);
  selected.forEach(tag => {
    const chip = makeChip(tag, { button: true });
    chip.classList.add("chipRemovable");
    chip.title = `Rimuovi filtro "${tag.name}"`;
    chip.setAttribute("aria-label", `Rimuovi filtro ${tag.name}`);
    const x = document.createElement("span");
    x.className = "chipX";
    x.textContent = "×";
    chip.appendChild(x);
    chip.addEventListener("click", ()=>{
      (tag.system ? tagState.sysFilter : tagState.filter).delete(tag.id);
      renderTagFilter();
      applyFilters();
    });
    chips.appendChild(chip);
  });
}

function addTagFilter(tagId){
  if(!tagId || tagState.filter.has(tagId)) return;
  tagState.filter.add(tagId);
  renderTagFilter();
  applyFilters({ keepSelection: true });
}

function addSystemTagFilter(tagId){
  if(!tagId || tagState.sysFilter.has(tagId)) return;
  tagState.sysFilter.add(tagId);
  renderTagFilter();
  applyFilters({ keepSelection: true });
}

const tagEditor = { danceId: null, draft: [], colorIndex: null };

function openTagEditor(){
  if(!tagState.user){
    openLoginModal();
    return;
  }
  const it = selectedItem();
  if(!it) return;
  tagEditor.danceId = it.id;
  tagEditor.draft = tagsOfDance(it.id).map(t => ({ id: t.id, name: t.name, color: t.color }));
  tagEditor.colorIndex = null;
  $("tagModalTitle").textContent = `Tag · ${displayTitle(it.dance) || "ballo"}`;
  $("tagInput").value = "";
  renderTagEditor();
  openModal("tagModal");
  setTimeout(()=> $("tagInput").focus(), 30);
}

function renderTagEditor(){
  const box = $("tagEditorChips");
  box.innerHTML = "";
  if(!tagEditor.draft.length){
    const p = document.createElement("span");
    p.className = "muted emptyChips";
    p.textContent = "Nessun tag su questo ballo.";
    box.appendChild(p);
  }
  tagEditor.draft.forEach((tag, i) => {
    const chip = makeChip(tag);
    chip.classList.add("chipEditable");
    chip.classList.toggle("chipActive", tagEditor.colorIndex === i);
    chip.dataset.index = String(i);
    const dot = chip.querySelector(".chipDot");
    const colorBtn = document.createElement("button");
    colorBtn.type = "button";
    colorBtn.className = "chipDot chipDotBtn";
    colorBtn.title = "Cambia colore";
    colorBtn.setAttribute("aria-label", `Cambia colore di ${tag.name}`);
    colorBtn.setAttribute("aria-expanded", tagEditor.colorIndex === i ? "true" : "false");
    colorBtn.addEventListener("click", ()=>{
      tagEditor.colorIndex = tagEditor.colorIndex === i ? null : i;
      renderTagEditor();
    });
    dot.replaceWith(colorBtn);
    const x = document.createElement("button");
    x.type = "button";
    x.className = "chipX";
    x.textContent = "×";
    x.setAttribute("aria-label", `Rimuovi ${tag.name}`);
    x.addEventListener("click", ()=>{
      tagEditor.draft.splice(i, 1);
      if(tagEditor.colorIndex === i) tagEditor.colorIndex = null;
      else if(tagEditor.colorIndex > i) tagEditor.colorIndex -= 1;
      renderTagEditor();
    });
    chip.appendChild(x);
    box.appendChild(chip);
  });

  renderColorPanel();

  const inDraft = new Set(tagEditor.draft.map(t => t.name.toLowerCase()));
  const suggestions = sortedTags().filter(t => !inDraft.has(t.name.toLowerCase()));
  $("tagSuggestions").innerHTML = suggestions.map(t => `<option value="${t.name.replace(/"/g, "&quot;")}"></option>`).join("");
  const sbox = $("tagSuggestChips");
  sbox.innerHTML = "";
  $("tagSuggestWrap").classList.toggle("hidden", !suggestions.length);
  suggestions.forEach(tag => {
    const chip = makeChip(tag, { button: true });
    chip.title = `Aggiungi "${tag.name}"`;
    chip.addEventListener("click", ()=> addDraftTag(tag.name));
    sbox.appendChild(chip);
  });
}

// Palette swatches + free color picker for the tag selected in the editor.
// Changes are applied in place (no full re-render) so the native picker stays open.
function renderColorPanel(){
  const panel = $("tagColorPanel");
  const tag = tagEditor.draft[tagEditor.colorIndex];
  panel.innerHTML = "";
  panel.classList.toggle("hidden", !tag);
  if(!tag) return;

  panel.appendChild(renderRenameRow(tag));

  const head = document.createElement("div");
  head.className = "colorPanelHead";
  head.textContent = "Colore";
  panel.appendChild(head);

  const swatches = document.createElement("div");
  swatches.className = "swatches";
  const syncPressed = ()=>{
    swatches.querySelectorAll(".swatch").forEach(b => {
      b.setAttribute("aria-pressed", b.dataset.color === tag.color.toLowerCase() ? "true" : "false");
    });
  };
  const applyColor = (color)=>{
    tag.color = color.toLowerCase();
    const chip = $("tagEditorChips").querySelector(`.chip[data-index="${tagEditor.colorIndex}"]`);
    if(chip) chip.style.setProperty("--chip", tag.color);
    picker.value = tag.color;
    hex.textContent = tag.color;
    syncPressed();
  };
  TAG_PALETTE.forEach(color => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.dataset.color = color;
    b.style.setProperty("--chip", color);
    b.title = color;
    b.setAttribute("aria-label", `Colore ${color}`);
    b.addEventListener("click", ()=> applyColor(color));
    swatches.appendChild(b);
  });

  const custom = document.createElement("label");
  custom.className = "customColor";
  const picker = document.createElement("input");
  picker.type = "color";
  picker.value = tag.color;
  picker.setAttribute("aria-label", `Colore personalizzato per ${tag.name}`);
  picker.addEventListener("input", ()=> applyColor(picker.value));
  const text = document.createElement("span");
  text.textContent = "Personalizzato";
  const hex = document.createElement("code");
  hex.className = "hexValue";
  hex.textContent = tag.color;
  custom.append(picker, text, hex);

  panel.append(swatches, custom);
  syncPressed();
}

function renderRenameRow(tag){
  const wrap = document.createElement("form");
  wrap.className = "renameRow";
  wrap.autocomplete = "off";
  const head = document.createElement("div");
  head.className = "colorPanelHead";
  const saved = tag.id && tagState.tags.has(tag.id);
  const n = saved ? (danceCountByTag().get(tag.id) || 0) : 0;
  head.textContent = saved
    ? `Nome · il cambio vale subito su ${n === 1 ? "1 ballo" : `tutti i ${n} balli`} con questo tag`
    : "Nome · tag nuovo, verrà creato al salvataggio";
  const row = document.createElement("div");
  row.className = "renameInputs";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 40;
  input.value = tag.name;
  input.setAttribute("aria-label", `Nuovo nome per ${tag.name}`);
  const btn = document.createElement("button");
  btn.type = "submit";
  btn.textContent = "Rinomina";
  row.append(input, btn);
  wrap.append(head, row);
  wrap.addEventListener("submit", async (e)=>{
    e.preventDefault();
    btn.disabled = true;
    try{
      await renameDraftTag(tagEditor.colorIndex, input.value);
    }finally{
      btn.disabled = false;
    }
  });
  return wrap;
}

function cleanTagName(v){
  return String(v || "").replace(/\s+/g, " ").trim().slice(0, 40);
}

async function renameDraftTag(index, rawName){
  const entry = tagEditor.draft[index];
  const name = cleanTagName(rawName);
  if(!entry || !name || name === entry.name) return;
  const lower = name.toLowerCase();
  const twin = tagEditor.draft.find((t, i) => i !== index && t.name.toLowerCase() === lower);

  // Not saved yet: rename (or merge) only inside the editor.
  if(!entry.id || !tagState.tags.has(entry.id)){
    if(twin) tagEditor.draft.splice(index, 1);
    else entry.name = name;
    tagEditor.colorIndex = null;
    renderTagEditor();
    return;
  }

  const oldName = entry.name;
  let data;
  try{
    data = await api(TAGS, { method: "PATCH", body: JSON.stringify({ id: entry.id, name }) });
  }catch(err){
    if(err.status !== 409 || !err.data || !err.data.conflict){
      console.error(err);
      toast("Errore nella rinomina del tag");
      return;
    }
    const other = err.data.conflict.name;
    const ok = confirm(`Esiste già il tag "${other}".\n\nVuoi unire "${oldName}" in "${other}"? Tutti i balli con "${oldName}" avranno "${other}" e "${oldName}" verrà eliminato.`);
    if(!ok) return;
    try{
      data = await api(TAGS, { method: "PATCH", body: JSON.stringify({ id: entry.id, name, merge: true }) });
    }catch(err2){
      console.error(err2);
      toast("Errore nell'unione dei tag");
      return;
    }
  }

  setTagData(data);
  const target = tagState.tags.get(data.renamed.id);
  if(data.renamed.merged){
    const keep = tagEditor.draft.find((t, i) => i !== index && t.id === target.id);
    if(keep) tagEditor.draft.splice(index, 1);
    else Object.assign(entry, { id: target.id, name: target.name, color: target.color });
    tagEditor.colorIndex = null;
  } else {
    entry.name = target.name;
  }
  renderTagEditor();
  renderTagFilter();
  afterTagsChanged();
  const n = danceCountByTag().get(target.id) || 0;
  toast(data.renamed.merged
    ? `"${oldName}" unito in "${target.name}" (${n} balli)`
    : `Rinominato in "${target.name}" su ${n === 1 ? "1 ballo" : `${n} balli`}`);
}

function addDraftTag(raw){
  const names = String(raw || "").split(",").map(s => s.replace(/\s+/g, " ").trim().slice(0, 40)).filter(Boolean);
  names.forEach(name => {
    if(tagEditor.draft.some(t => t.name.toLowerCase() === name.toLowerCase())) return;
    const existing = sortedTags().find(t => t.name.toLowerCase() === name.toLowerCase());
    tagEditor.draft.push(existing ? { id: existing.id, name: existing.name, color: existing.color } : { id: null, name, color: defaultTagColor(name) });
  });
  renderTagEditor();
}

async function saveTagEditor(){
  const pending = $("tagInput").value;
  if(pending.trim()){
    addDraftTag(pending);
    $("tagInput").value = "";
  }
  const btn = $("tagSaveBtn");
  btn.disabled = true;
  try{
    const data = await api(TAGS, {
      method: "PUT",
      body: JSON.stringify({ danceId: tagEditor.danceId, tags: tagEditor.draft }),
    });
    setTagData(data);
    closeModalEl("tagModal");
    renderTagFilter();
    afterTagsChanged();
    toast("Tag salvati");
  }catch(err){
    console.error(err);
    toast(err.status === 401 ? "Sessione scaduta: accedi di nuovo" : "Errore nel salvataggio dei tag");
  }finally{
    btn.disabled = false;
  }
}

function downloadJson(obj, filename){
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=> URL.revokeObjectURL(a.href), 1000);
}

const exportSel = new Set();

function danceCountByTag(){
  const counts = new Map();
  tagState.danceTags.forEach(ids => ids.forEach(id => counts.set(id, (counts.get(id) || 0) + 1)));
  return counts;
}

function openExportModal(){
  if(!tagState.tags.size){
    toast("Non hai ancora tag da esportare");
    return;
  }
  exportSel.clear();
  // Preselect the active tag filter if any, otherwise everything.
  const preset = tagState.filter.size ? [...tagState.filter] : [...tagState.tags.keys()];
  preset.forEach(id => exportSel.add(id));
  $("exportSearch").value = "";
  renderExportList();
  openModal("exportModal");
}

function renderExportList(){
  const q = safe($("exportSearch").value).toLowerCase();
  const counts = danceCountByTag();
  const list = $("exportList");
  list.innerHTML = "";
  const visible = sortedTags().filter(t => !q || t.name.toLowerCase().includes(q));
  visible.forEach(tag => {
    const li = document.createElement("li");
    const label = document.createElement("label");
    label.className = "exportRow";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = exportSel.has(tag.id);
    cb.addEventListener("change", ()=>{
      if(cb.checked) exportSel.add(tag.id); else exportSel.delete(tag.id);
      updateExportSummary();
    });
    const n = counts.get(tag.id) || 0;
    const count = document.createElement("span");
    count.className = "exportCount";
    count.textContent = n === 1 ? "1 ballo" : `${n} balli`;
    label.append(cb, makeChip(tag), count);
    li.appendChild(label);
    list.appendChild(li);
  });
  if(!visible.length){
    const li = document.createElement("li");
    li.className = "muted exportEmpty";
    li.textContent = "Nessun tag corrisponde alla ricerca.";
    list.appendChild(li);
  }
  updateExportSummary();
}

function updateExportSummary(){
  const n = exportSel.size;
  const all = n === tagState.tags.size;
  $("exportSummary").textContent = all ? `Tutti i ${n} tag selezionati` : `${n} di ${tagState.tags.size} tag selezionati`;
  const btn = $("exportConfirmBtn");
  btn.disabled = n === 0;
  btn.textContent = n === 0 ? "Esporta" : (all ? "Esporta tutti" : `Esporta ${n === 1 ? "1 tag" : `${n} tag`}`);
}

function exportFileName(ids){
  const date = new Date().toISOString().slice(0, 10);
  if(ids.length === tagState.tags.size) return `line-dance-tag-${date}.json`;
  if(ids.length === 1){
    const slug = (tagState.tags.get(ids[0]).name || "tag").toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tag";
    return `line-dance-tag-${slug}-${date}.json`;
  }
  return `line-dance-tag-selezione-${ids.length}-${date}.json`;
}

async function exportTags(){
  const ids = [...exportSel].filter(id => tagState.tags.has(id));
  if(!ids.length) return;
  const all = ids.length === tagState.tags.size;
  const btn = $("exportConfirmBtn");
  btn.disabled = true;
  try{
    const qs = all ? "" : `&tags=${encodeURIComponent(ids.join(","))}`;
    const data = await api(`${TAGS}?action=export${qs}`);
    downloadJson(data, exportFileName(ids));
    closeModalEl("exportModal");
    toast(`Esportati ${data.tags.length} tag`);
  }catch(err){
    console.error(err);
    toast("Errore nell'esportazione");
  }finally{
    updateExportSummary();
  }
}

async function importTagsFromFile(e){
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if(!file) return;
  let doc;
  try{
    doc = JSON.parse(await file.text());
  }catch{
    toast("Il file non è un JSON valido");
    return;
  }
  if(!doc || !Array.isArray(doc.tags)){
    toast("Formato non riconosciuto: serve { tags: [...] }");
    return;
  }
  try{
    const data = await api(`${TAGS}?action=import`, { method: "POST", body: JSON.stringify(doc) });
    setTagData(data);
    renderTagFilter();
    afterTagsChanged();
    const r = data.imported || {};
    toast(`Importati ${r.tags || 0} tag (${r.links || 0} nuove associazioni${r.ignoredDances ? `, ${r.ignoredDances} balli ignorati` : ""})`);
  }catch(err){
    console.error(err);
    toast("Errore nell'importazione");
  }
}

function wireTags(){
  $("editTagsBtn").addEventListener("click", openTagEditor);
  $("tagFilter").addEventListener("change", (e)=>{
    const [kind, id] = e.target.value.split(":");
    if(kind === "s") addSystemTagFilter(id);
    else if(kind === "u") addTagFilter(id);
  });
  $("tagAddForm").addEventListener("submit", (e)=>{
    e.preventDefault();
    addDraftTag($("tagInput").value);
    $("tagInput").value = "";
  });
  $("tagInput").addEventListener("keydown", (e)=>{
    if(e.key === ","){
      e.preventDefault();
      addDraftTag($("tagInput").value);
      $("tagInput").value = "";
    }
  });
  $("tagSaveBtn").addEventListener("click", saveTagEditor);
  wireDismissableModal("tagModal");

  $("exportSearch").addEventListener("input", renderExportList);
  $("exportAllBtn").addEventListener("click", ()=>{
    tagState.tags.forEach((_t, id) => exportSel.add(id));
    renderExportList();
  });
  $("exportNoneBtn").addEventListener("click", ()=>{
    exportSel.clear();
    renderExportList();
  });
  $("exportConfirmBtn").addEventListener("click", exportTags);
  wireDismissableModal("exportModal");
}

/* ---------- Existing UI wiring ---------- */

function wireKeyboardNav(){
  document.addEventListener("keydown", (e)=>{
    const activeTag = (document.activeElement && document.activeElement.tagName) || "";
    const isTyping = ["INPUT","TEXTAREA","SELECT"].includes(activeTag);
    if(isTyping) return;
    if(document.querySelector(".modal:not(.hidden)")) return;

    if(e.key === "ArrowDown"){
      e.preventDefault();
      if(state.filtered.length === 0) return;
      if(state.cursorIndex >= state.filtered.length - 2) loadMore();
      state.cursorIndex = Math.min(state.cursorIndex + 1, state.filtered.length - 1);
      selectById(state.filtered[state.cursorIndex].id, state.cursorIndex);
    }
    if(e.key === "ArrowUp"){
      e.preventDefault();
      if(state.filtered.length === 0) return;
      state.cursorIndex = Math.max(state.cursorIndex - 1, 0);
      selectById(state.filtered[state.cursorIndex].id, state.cursorIndex);
    }
  });
}

function wireYouTubeButtons(){
  const col = $("videoColumn");
  if(!col) return;

  col.addEventListener("click", (e)=>{
    const btn = e.target.closest("button[data-action]");
    if(!btn) return;
    const card = btn.closest(".videoCard");
    const frame = card && card.querySelector("iframe");
    if(!card || !frame) return;
    const action = btn.dataset.action;

    if(action === "start" || action === "dance"){
      const base = card.dataset.base || "";
      const start = action === "start" ? card.dataset.start : card.dataset.dance;
      if(base) frame.src = withYouTubeStart(base, start || "0");
    }
    if(action === "size"){
      const isExpanded = document.body.classList.toggle("videoExpanded");
      col.querySelectorAll('[data-action="size"]').forEach(b => b.setAttribute("aria-pressed", isExpanded ? "true" : "false"));
    }
  });
}

function wireStepsheetModal(){
  const link = $("stepsheetLink");
  const modal = $("stepsheetModal");
  const frame = $("stepsheetFrame");
  const closeBtn = $("stepsheetClose");
  const openNew = $("stepsheetOpenNew");
  if(!link || !modal || !frame || !closeBtn || !openNew) return;

  function openModal(url){
    if(!url) return;
    frame.src = url;
    openNew.href = url;
    modal.classList.remove("hidden");
  }
  function closeModal(){
    modal.classList.add("hidden");
    frame.src = "about:blank";
  }
  function openPdfWindow(url){
    if(!url) return;
    const width = 1100;
    const height = 760;
    const left = Math.max(0, Math.floor((window.screen.width - width) / 2));
    const top = Math.max(0, Math.floor((window.screen.height - height) / 2));
    const features = [
      "popup=yes",
      "noopener",
      "noreferrer",
      "toolbar=no",
      "menubar=no",
      "location=no",
      "status=no",
      "scrollbars=yes",
      "resizable=yes",
      `width=${width}`,
      `height=${height}`,
      `left=${left}`,
      `top=${top}`,
    ].join(",");
    const w = window.open(url, "stepsheetPdf", features);
    if(w) w.focus();
  }
  function isPdfUrl(url){
    try{
      const u = new URL(url);
      return u.pathname.toLowerCase().endsWith(".pdf");
    }catch{
      return url.toLowerCase().split("?")[0].endsWith(".pdf");
    }
  }

  link.addEventListener("click", (e)=>{
    if(!state.stepsheetUrl) return;
    e.preventDefault();
    if(isPdfUrl(state.stepsheetUrl)){
      closeModal();
      openPdfWindow(state.stepsheetUrl);
      return;
    }
    openModal(state.stepsheetUrl);
  });
  closeBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", (e)=>{
    if(e.target && e.target.dataset && e.target.dataset.close){
      closeModal();
    }
  });
  document.addEventListener("keydown", (e)=>{
    if(e.key === "Escape" && !modal.classList.contains("hidden")){
      closeModal();
    }
  });
}

async function getDataMode(){
  try{
    const res = await fetch("./data-mode.json", {cache:"no-store"});
    if(res.ok){
      const m = await res.json();
      if(m && typeof m.mode === "string") return m.mode;
    }
  }catch(_e){}
  return "remote";
}

async function createSource(){
  const mode = await getDataMode();
  if(mode === "local"){
    const res = await fetch("./data.json", {cache:"no-store"});
    if(!res.ok) throw new Error("Impossibile caricare data.json");
    return makeLocalSource(await res.json());
  }
  return remoteSource;
}

async function init(){
  catalog.observer = new IntersectionObserver((entries)=>{
    if(entries.some(e => e.isIntersecting)) loadMore();
  }, { root: $("list"), rootMargin: "0px 0px 300px 0px" });

  let searchTimer = null;
  $("searchInput").addEventListener("input", ()=>{
    clearTimeout(searchTimer);
    searchTimer = setTimeout(()=> applyFilters(), 250);
  });
  $("yearFilter").addEventListener("change", ()=> applyFilters());
  $("clearBtn").addEventListener("click", ()=>{
    $("searchInput").value = "";
    $("yearFilter").value = "";
    tagState.filter.clear();
    tagState.sysFilter.clear();
    renderTagFilter();
    applyFilters();
  });

  wireKeyboardNav();
  wireYouTubeButtons();
  wireStepsheetModal();
  wireAuth();
  wireTags();

  // User and login providers do not depend on the catalog nor on Netlify
  // Identity (Google/Facebook use our session cookie): ask right away. A saved
  // Netlify Identity login is picked up when the widget initializes (wireAuth).
  refreshUser();

  catalog.source = await createSource();
  const remote = catalog.source === remoteSource;
  // Show the last catalog seen right away (if any), then refresh it.
  const cached = remote ? readCache() : null;
  if(cached){
    applyMeta(cached.meta);
    showResults(cached.page);
  } else {
    showListSkeleton();
  }

  const seq = ++catalog.seq;
  let meta, page;
  try{
    [meta, page] = await Promise.all([
      catalog.source.meta(),
      catalog.source.page({ ...currentFilters(), offset: 0, limit: PAGE_SIZE }),
    ]);
  }catch(err){
    if(!cached) throw err;
    console.error(err);
    toast("Catalogo non aggiornato: connessione al server non riuscita");
  }
  if(meta){
    applyMeta(meta);
    if(seq === catalog.seq) showResults(page, { quiet: !!cached, keepSelection: !!cached });
    if(remote) writeCache(meta, page);
  }
  startUpdateWatchers();
}

init().catch(err=>{
  console.error(err);
  const detail = $("detailView");
  if(detail){
    detail.classList.remove("hidden");
    detail.innerHTML = `
      <div class="card">
        <div class="cardTitle">Errore</div>
        <div class="textBlock">
          <p class="muted">Non riesco a caricare il catalogo dei balli. Apri la console per dettagli.</p>
        </div>
      </div>
    `;
  }
});
