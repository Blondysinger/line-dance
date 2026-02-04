const state = {
  items: [],
  filtered: [],
  selectedIndex: -1,
  jsonOnly: false,
};
let dragItemId = null;

const $ = (id) => document.getElementById(id);

function toast(msg){
  const el = $("toast");
  if(!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(()=> el.classList.add("hidden"), 2400);
}

function safe(v){ return (v ?? "").toString(); }

function renderList(){
  const list = $("list");
  list.innerHTML = "";
  state.filtered.forEach((it, idx)=>{
    const li = document.createElement("li");
    li.className = "listItem" + (idx === state.selectedIndex ? " active" : "");
    li.setAttribute("draggable", "true");
    li.dataset.id = safe(it.id);
    const title = document.createElement("span");
    title.className = "listTitle";
    title.textContent = safe(it.dance) || "(senza titolo)";
    const del = document.createElement("button");
    del.className = "deleteBtn";
    del.type = "button";
    del.textContent = "Elimina";
    del.addEventListener("click", (e)=>{
      e.stopPropagation();
      confirmDelete(idx);
    });
    li.appendChild(title);
    li.appendChild(del);
    li.addEventListener("click", ()=> selectIndex(idx));
    li.addEventListener("dragstart", (e)=> {
      dragItemId = li.dataset.id;
      li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragItemId);
    });
    li.addEventListener("dragend", ()=> {
      dragItemId = null;
      li.classList.remove("dragging");
      list.querySelectorAll(".dragOver").forEach(el => el.classList.remove("dragOver"));
    });
    li.addEventListener("dragover", (e)=> {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      li.classList.add("dragOver");
    });
    li.addEventListener("dragleave", ()=> li.classList.remove("dragOver"));
    li.addEventListener("drop", (e)=> {
      e.preventDefault();
      li.classList.remove("dragOver");
      const targetId = li.dataset.id;
      const fromId = dragItemId || e.dataTransfer.getData("text/plain");
      if(!fromId || !targetId || fromId === targetId) return;
      moveItemById(fromId, targetId);
    });
    list.appendChild(li);
  });
  $("countLabel").textContent = `${state.filtered.length}`;
}

function selectIndex(idx){
  state.selectedIndex = idx;
  renderList();
  const it = state.filtered[idx];
  if(!it) return;
  $("dance").value = safe(it.dance);
  $("songTitle").value = safe(it.songTitle);
  $("style").value = safe(it.style);
  $("year").value = safe(it.year);
  $("youtubeUrl").value = safe(it.youtubeUrl);
  $("youtubeStartSeconds").value = safe(it.youtubeStartSeconds);
  $("youtubeDanceStartSeconds").value = safe(it.youtubeDanceStartSeconds);
  $("spotifyUrl").value = safe(it.spotifyUrl);
  $("stepsheetUrl").value = safe(it.stepsheetUrl);
  $("stepsheetTitle").value = safe(it.stepsheetTitle);
  $("videoTitle").value = safe(it.videoTitle);
  $("choreographer").value = safe(it.choreographer);
  $("details").value = safe(it.details);
  $("notes").value = safe(it.notes);
}

function applyFilters(opts = {}){
  const q = safe($("searchInput").value).toLowerCase().trim();
  if(!q){
    state.filtered = [...state.items];
  } else {
    state.filtered = state.items.filter(it => {
      const hay = [
        it.dance, it.songTitle, it.style, it.year,
        it.details, it.notes, it.choreographer
      ].map(safe).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }
  if(state.filtered.length > 0){
    if(opts.selectId != null){
      const idx = state.filtered.findIndex(it => safe(it.id) === safe(opts.selectId));
      if(idx >= 0){
        selectIndex(idx);
        return;
      }
    }
    selectIndex(0);
  } else {
    state.selectedIndex = -1;
    renderList();
  }
}

function updateItemFromForm(){
  const it = state.filtered[state.selectedIndex];
  if(!it) return;
  it.dance = $("dance").value.trim();
  it.songTitle = $("songTitle").value.trim();
  it.style = $("style").value.trim();
  it.year = $("year").value.trim();
  it.youtubeUrl = $("youtubeUrl").value.trim();
  it.youtubeStartSeconds = $("youtubeStartSeconds").value.trim();
  it.youtubeDanceStartSeconds = $("youtubeDanceStartSeconds").value.trim();
  it.spotifyUrl = $("spotifyUrl").value.trim();
  it.stepsheetUrl = $("stepsheetUrl").value.trim();
  it.stepsheetTitle = $("stepsheetTitle").value.trim();
  it.videoTitle = $("videoTitle").value.trim();
  it.choreographer = $("choreographer").value.trim();
  it.details = $("details").value;
  it.notes = $("notes").value;

  renderList();
  syncJsonEditor();
}

function addItem(){
  const maxId = state.items.reduce((m, it)=> Math.max(m, Number(it.id) || 0), 0);
  const nextId = maxId + 1;
  const blank = {
    id: nextId,
    year: "",
    dance: "",
    style: "",
    songTitle: "",
    spotifyUrl: "",
    videoTitle: "",
    youtubeUrl: "",
    details: "",
    notes: "",
    choreographer: "",
    stepsheetTitle: "",
    stepsheetUrl: "",
    youtubeStartSeconds: "",
    youtubeDanceStartSeconds: "",
  };
  state.items.push(blank);
  applyFilters({ selectId: nextId });
  toast("Nuovo ballo creato");
}

function confirmDelete(idx){
  const it = state.filtered[idx];
  if(!it) return;
  const name = safe(it.dance) || "(senza titolo)";
  if(!confirm(`Eliminare "${name}"?`)) return;
  const id = it.id;
  state.items = state.items.filter(x => x.id !== id);
  applyFilters();
  toast("Ballo eliminato");
}

function moveItemById(fromId, targetId){
  const fromIdx = state.items.findIndex(it => safe(it.id) === safe(fromId));
  const toIdx = state.items.findIndex(it => safe(it.id) === safe(targetId));
  if(fromIdx === -1 || toIdx === -1) return;
  const [moved] = state.items.splice(fromIdx, 1);
  const insertIdx = fromIdx < toIdx ? toIdx - 1 : toIdx;
  state.items.splice(insertIdx, 0, moved);
  applyFilters({ selectId: fromId });
  toast("Ordine aggiornato");
}

function syncJsonEditor(){
  $("jsonEditor").value = JSON.stringify({ items: state.items }, null, 2);
}

function applyJsonEditor(){
  const text = $("jsonEditor").value;
  const data = JSON.parse(text);
  if(!data || !Array.isArray(data.items)) throw new Error("JSON non valido: serve { items: [...] }");
  state.items = data.items;
  applyFilters();
}

async function getToken(){
  if(!window.netlifyIdentity) return null;
  const user = window.netlifyIdentity.currentUser();
  if(!user) return null;
  const token = await user.jwt();
  return token;
}

async function loadData(){
  const res = await fetch("/.netlify/functions/dances", { cache: "no-store" });
  if(!res.ok) throw new Error("Errore nel caricamento dati");
  const data = await res.json();
  const items = Array.isArray(data) ? data : (data.items || []);
  state.items = items;
  applyFilters();
  syncJsonEditor();
}

async function saveData(){
  // ensure form edits are applied
  updateItemFromForm();
  let payload;
  try{
    payload = JSON.parse($("jsonEditor").value);
  }catch{
    toast("JSON non valido");
    return;
  }
  const token = await getToken();
  if(!token){
    toast("Devi fare login");
    return;
  }
  const res = await fetch("/.netlify/functions/dances-update", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  if(!res.ok){
    const t = await res.text();
    toast(`Errore salvataggio: ${t}`);
    return;
  }
  toast("Salvato");
}

function setJsonOnly(on){
  state.jsonOnly = on;
  $("formPanel").style.display = on ? "none" : "grid";
  $("jsonPanel").classList.toggle("hidden", !on);
  $("toggleJsonOnly").textContent = on ? "Vista completa" : "Solo JSON";
}

function wireIdentity(){
  const loginBtn = $("loginBtn");
  const logoutBtn = $("logoutBtn");
  const content = $("adminContent");
  if(!window.netlifyIdentity) return;

  function hideGate(){
    content.classList.remove("hidden");
  }

  window.netlifyIdentity.on("login", () => {
    loginBtn.classList.add("hidden");
    logoutBtn.classList.remove("hidden");
    hideGate();
    window.netlifyIdentity.close();
    loadData().catch(err => toast(err.message || "Errore caricamento"));
  });
  window.netlifyIdentity.on("logout", () => {
    logoutBtn.classList.add("hidden");
    loginBtn.classList.remove("hidden");
    content.classList.add("hidden");
  });
  loginBtn.addEventListener("click", () => window.netlifyIdentity.open());
  logoutBtn.addEventListener("click", () => window.netlifyIdentity.logout());

  // initial state
  const user = window.netlifyIdentity.currentUser();
  if(user){
    loginBtn.classList.add("hidden");
    logoutBtn.classList.remove("hidden");
    hideGate();
    loadData().catch(err => toast(err.message || "Errore caricamento"));
  } else {
    content.classList.add("hidden");
    window.netlifyIdentity.open();
  }
}

function init(){
  wireIdentity();
  $("searchInput").addEventListener("input", applyFilters);
  $("addBtn").addEventListener("click", addItem);
  $("toggleJsonOnly").addEventListener("click", ()=>{
    setJsonOnly(!state.jsonOnly);
  });
  $("saveBtn").addEventListener("click", saveData);
  [
    "dance","songTitle","style","year","youtubeUrl","youtubeStartSeconds","youtubeDanceStartSeconds",
    "spotifyUrl","stepsheetUrl","stepsheetTitle","videoTitle","choreographer","details","notes"
  ].forEach(id=>{
    $(id).addEventListener("input", updateItemFromForm);
  });
  $("jsonEditor").addEventListener("blur", ()=>{
    try{
      applyJsonEditor();
    }catch(e){
      toast(e.message || "JSON non valido");
    }
  });
}

init();
