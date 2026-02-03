/* Line Dance Catalog - Static SPA
 * Data source: ./data.json
 * - Master list with search + year filter
 * - Detail view with YouTube embed (search-based) + Spotify link/embed if available
 */

const state = {
  items: [],
  filtered: [],
  selectedId: null,
  cursorIndex: -1,
};

const $ = (id) => document.getElementById(id);

function safe(v){ return (v ?? "").toString().trim(); }

function makeYouTubeEmbedUrl(queryOrUrl){
  const v = safe(queryOrUrl);
  if(!v) return "";
  // If it's already a URL with a video id, try to extract
  const m1 = v.match(/[?&]v=([\w-]{6,})/);
  const m2 = v.match(/youtu\.be\/([\w-]{6,})/);
  const m3 = v.match(/youtube\.com\/embed\/([\w-]{6,})/);
  const vid = (m1 && m1[1]) || (m2 && m2[1]) || (m3 && m3[1]);
  if(vid) return `https://www.youtube.com/embed/${encodeURIComponent(vid)}`;
  // Fallback: YouTube search playlist embed (no API key)
  return `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(v)}`;
}

function withYouTubeStart(url, startSeconds){
  const seconds = Number(startSeconds);
  if(!url || !Number.isFinite(seconds) || seconds <= 0) return url;
  try{
    const u = new URL(url);
    u.searchParams.set("start", Math.floor(seconds));
    return u.toString();
  }catch{
    return url;
  }
}

function makeSpotifyEmbedOrNull(urlOrUri){
  const v = safe(urlOrUri);
  if(!v) return null;

  // Accept open.spotify.com links: track/album/playlist/episode/show
  const m = v.match(/open\.spotify\.com\/(track|album|playlist|episode|show)\/([a-zA-Z0-9]+)/);
  if(m){
    const type = m[1];
    const id = m[2];
    return `https://open.spotify.com/embed/${type}/${id}`;
  }

  // Accept spotify:track:ID etc.
  const m2 = v.match(/^spotify:(track|album|playlist|episode|show):([a-zA-Z0-9]+)$/);
  if(m2){
    return `https://open.spotify.com/embed/${m2[1]}/${m2[2]}`;
  }

  return null;
}

function renderYearFilter(items){
  const years = [...new Set(items.map(x => safe(x.year)).filter(Boolean))].sort((a,b)=> {
    const na = Number(a), nb = Number(b);
    if(!Number.isNaN(na) && !Number.isNaN(nb)) return na-nb;
    return a.localeCompare(b);
  });

  const sel = $("yearFilter");
  // keep first option
  years.forEach(y=>{
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = `Anno ${y}`;
    sel.appendChild(opt);
  });
}

function applyFilters(){
  const q = safe($("searchInput").value).toLowerCase();
  const year = $("yearFilter").value;

  state.filtered = state.items.filter(it => {
    if(year && safe(it.year) !== year) return false;
    if(!q) return true;
    const hay = [
      it.dance, it.songTitle, it.style, it.details, it.notes, it.choreographer
    ].map(safe).join(" • ").toLowerCase();
    return hay.includes(q);
  });

  $("countLabel").textContent = `${state.filtered.length} risultati`;
  renderList();
  // If selected item disappeared, reset selection
  if(state.selectedId && !state.filtered.some(x=>x.id === state.selectedId)){
    clearSelection();
  }
}

function renderList(){
  const list = $("list");
  list.innerHTML = "";

  state.filtered.forEach((it, idx)=>{
    const li = document.createElement("li");
    li.className = "listItem";
    li.setAttribute("role","option");
    li.dataset.id = it.id;
    li.tabIndex = 0;
    li.setAttribute("aria-selected", it.id === state.selectedId ? "true" : "false");

    const badge = document.createElement("div");
    badge.className = "badge";
    badge.textContent = safe(it.year) ? it.year : "—";

    const box = document.createElement("div");
    box.className = "itemText";

    const t = document.createElement("p");
    t.className = "itemTitle";
    t.textContent = safe(it.dance) || "(senza titolo)";

    const s = document.createElement("p");
    s.className = "itemSub";
    const song = safe(it.songTitle);
    const style = safe(it.style);
    s.textContent = [song, style].filter(Boolean).join(" • ");

    box.appendChild(t);
    box.appendChild(s);

    li.appendChild(badge);
    li.appendChild(box);

    li.addEventListener("click", ()=> selectById(it.id, idx));
    li.addEventListener("keydown", (e)=>{
      if(e.key === "Enter" || e.key === " "){
        e.preventDefault();
        selectById(it.id, idx);
      }
    });

    list.appendChild(li);
  });

  // Cursor fallback
  if(state.cursorIndex >= state.filtered.length) state.cursorIndex = state.filtered.length - 1;
}

function clearSelection(){
  state.selectedId = null;
  state.cursorIndex = -1;
  $("detailView").classList.add("hidden");
  $("emptyState").classList.remove("hidden");
  // reset aria-selected
  document.querySelectorAll(".listItem").forEach(el=> el.setAttribute("aria-selected","false"));
}

function selectById(id, index){
  state.selectedId = id;
  state.cursorIndex = index;

  document.querySelectorAll(".listItem").forEach(el=>{
    el.setAttribute("aria-selected", el.dataset.id === id ? "true" : "false");
  });

  const item = state.filtered.find(x=>x.id === id) || state.items.find(x=>x.id===id);
  if(item) renderDetail(item);
}

function renderDetail(it){
  $("emptyState").classList.add("hidden");
  $("detailView").classList.remove("hidden");

  const dance = safe(it.dance);
  const song = safe(it.songTitle);
  $("detailTitle").textContent = dance || "(senza titolo)";
  $("detailSong").textContent = song || "—";

  $("detailYear").textContent = safe(it.year) ? `Anno ${it.year}` : "Anno —";
  $("detailStyle").textContent = safe(it.style) || "—";

  $("detailDetails").textContent = safe(it.details) || "—";
  $("detailNotes").textContent = safe(it.notes) || "—";
  $("detailChoreo").textContent = safe(it.choreographer) || "—";

  // Stepsheet link (if it's a URL, open it; else hide)
  const stepsheet = safe(it.stepsheetUrl || it.stepsheetUrlTitle);
  const stepsheetLink = $("stepsheetLink");
  if(/^https?:\/\//i.test(stepsheet)){
    stepsheetLink.href = stepsheet;
    stepsheetLink.style.display = "inline-flex";
  } else {
    stepsheetLink.href = "#";
    stepsheetLink.style.display = "none";
  }

  // YouTube
  const ytValue = safe(it.youtubeUrl);
  const fallbackQuery = [dance, song].filter(Boolean).join(" ");
  const ytEmbed = makeYouTubeEmbedUrl(ytValue || fallbackQuery);
  $("ytFrame").src = ytEmbed;

  const startBtn = $("ytStartBtn");
  const danceBtn = $("ytDanceBtn");
  if(startBtn && danceBtn){
    const startSeconds = Number(it.youtubeStartSeconds || it.youtubeStart || 0);
    const danceSeconds = Number(it.youtubeDanceStartSeconds || it.youtubeDanceStart || startSeconds || 0);
    startBtn.dataset.base = ytEmbed;
    startBtn.dataset.start = Number.isFinite(startSeconds) ? String(startSeconds) : "0";
    danceBtn.dataset.base = ytEmbed;
    danceBtn.dataset.start = Number.isFinite(danceSeconds) ? String(danceSeconds) : "0";
  }

  const ytLink = $("ytSearchLink");
  if(/^https?:\/\//i.test(ytValue)){
    ytLink.href = ytValue;
    ytLink.textContent = "Apri su YouTube";
  } else {
    ytLink.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(fallbackQuery || ytValue)}`;
    ytLink.textContent = (fallbackQuery || ytValue) ? `Cerca: ${fallbackQuery || ytValue}` : "Apri YouTube";
  }

  // Spotify
  const sp = makeSpotifyEmbedOrNull(safe(it.spotifyUrl || it.spotify || "")); // optional future fields
  const container = $("spotifyContainer");
  container.innerHTML = "";
  if(sp){
    const iframe = document.createElement("iframe");
    iframe.className = "frame";
    iframe.title = "Spotify player";
    iframe.loading = "lazy";
    iframe.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
    iframe.src = sp;
    container.appendChild(iframe);
  } else {
    const div = document.createElement("div");
    div.className = "spotifyPlaceholder";
    div.innerHTML = `
      <p><strong>Embed non disponibile</strong> (manca un link/URI Spotify nel dataset).</p>
      <p>Intanto ti apro la ricerca su Spotify col nome brano.</p>
      <a id="spSearchLink" class="primaryLink" target="_blank" rel="noopener">Cerca su Spotify</a>
    `;
    container.appendChild(div);
    const link = div.querySelector("#spSearchLink");
    const q = song || dance || "";
    link.href = `https://open.spotify.com/search/${encodeURIComponent(q)}`;
  }

  // Scroll list item into view for visibility
  const activeEl = document.querySelector(`.listItem[data-id="${CSS.escape(it.id)}"]`);
  if(activeEl) activeEl.scrollIntoView({block:"nearest"});
}

function wireKeyboardNav(){
  document.addEventListener("keydown", (e)=>{
    const activeTag = (document.activeElement && document.activeElement.tagName) || "";
    const isTyping = ["INPUT","TEXTAREA","SELECT"].includes(activeTag);
    if(isTyping) return;

    if(e.key === "ArrowDown"){
      e.preventDefault();
      if(state.filtered.length === 0) return;
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
  const startBtn = $("ytStartBtn");
  const danceBtn = $("ytDanceBtn");
  const frame = $("ytFrame");
  if(!startBtn || !danceBtn || !frame) return;

  startBtn.addEventListener("click", ()=>{
    const base = startBtn.dataset.base || "";
    const start = startBtn.dataset.start || "0";
    if(base) frame.src = withYouTubeStart(base, start);
  });

  danceBtn.addEventListener("click", ()=>{
    const base = danceBtn.dataset.base || "";
    const start = danceBtn.dataset.start || "0";
    if(base) frame.src = withYouTubeStart(base, start);
  });
}

async function init(){
  const res = await fetch("./data.json", {cache:"no-store"});
  if(!res.ok) throw new Error("Impossibile caricare data.json");
  const data = await res.json();

  state.items = (Array.isArray(data) ? data : (data.items || [])).map(x=>({
    ...x,
    year: safe(x.year),
    dance: safe(x.dance),
    style: safe(x.style),
    songTitle: safe(x.songTitle),
    spotifyUrl: safe(x.spotifyUrl),
    videoTitle: safe(x.videoTitle),
    youtubeUrl: safe(x.youtubeUrl),
    details: safe(x.details),
    notes: safe(x.notes),
    choreographer: safe(x.choreographer),
    stepsheetTitle: safe(x.stepsheetTitle),
    stepsheetUrl: safe(x.stepsheetUrl),
  }));

  renderYearFilter(state.items);

  $("searchInput").addEventListener("input", applyFilters);
  $("yearFilter").addEventListener("change", applyFilters);
  $("clearBtn").addEventListener("click", ()=>{
    $("searchInput").value = "";
    $("yearFilter").value = "";
    applyFilters();
  });

  state.filtered = [...state.items];
  $("countLabel").textContent = `${state.filtered.length} risultati`;
  renderList();
  wireKeyboardNav();
  wireYouTubeButtons();
}

init().catch(err=>{
  console.error(err);
  $("emptyState").innerHTML = `
    <h2>Errore</h2>
    <p class="muted">Non riesco a caricare <code>data.json</code>. Apri la console per dettagli.</p>
  `;
});
