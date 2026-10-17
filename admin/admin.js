const state = {
  items: [],
  filtered: [],
  selectedIndex: -1,
  jsonOnly: false,
  dirty: false,
  saving: false,
  // Server state as loaded: id -> { json, version }, plus the catalog order.
  // Saving sends only what differs from it, one dance at a time.
  base: new Map(),
  baseOrder: [],
  nextTempId: -1,
};
let dragItemId = null;

const $ = (id) => document.getElementById(id);
const DANCE_API = "/.netlify/functions/dance";
// Tells the public site open in other tabs of this browser to refresh now.
const catalogChannel = "BroadcastChannel" in window ? new BroadcastChannel("ld-catalog") : null;
function announceCatalogChange(){
  if(catalogChannel) catalogChannel.postMessage({ type: "catalog-changed", at: Date.now() });
}
const SYSTAG_API = "/.netlify/functions/system-tags";

// Key-sorted JSON, so equal content always compares equal.
function stableJson(v){
  if(Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if(v && typeof v === "object"){
    return `{${Object.keys(v).sort().filter(k => k !== "version" && v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function isNew(it){ return Number(it.id) < 0; }

function rememberBase(it){
  state.base.set(Number(it.id), { json: stableJson(it), version: it.version });
}

function pendingChanges(){
  const ids = new Set(state.items.map(it => Number(it.id)));
  const created = state.items.filter(isNew);
  const updated = state.items.filter(it => !isNew(it) && state.base.has(Number(it.id)) && state.base.get(Number(it.id)).json !== stableJson(it));
  const deleted = [...state.base.keys()].filter(id => !ids.has(id));
  const order = state.items.filter(it => !isNew(it)).map(it => Number(it.id));
  const baseOrder = state.baseOrder.filter(id => ids.has(id));
  const reordered = order.join(",") !== baseOrder.join(",");
  return { created, updated, deleted, reordered, count: created.length + updated.length + deleted.length + (reordered ? 1 : 0) };
}

// Edits live only in the browser until "Salva" succeeds: make that visible.
function refreshDirty(){
  const p = pendingChanges();
  state.dirty = p.count > 0;
  const btn = $("saveBtn");
  btn.classList.toggle("dirty", state.dirty);
  btn.textContent = state.saving ? "Salvataggio…" : (state.dirty ? `Salva modifiche (${p.count})` : "Salva");
  const changed = new Set([...p.created, ...p.updated].map(it => String(it.id)));
  document.querySelectorAll("#list .listItem").forEach(li => li.classList.toggle("modified", changed.has(li.dataset.id)));
}

function toast(msg){
  const el = $("toast");
  if(!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(()=> el.classList.add("hidden"), 2400);
}

function safe(v){ return (v ?? "").toString(); }

// Same as the public site: ALL CAPS titles become Title Case for the small-caps font.
function displayTitle(v){
  const t = safe(v).trim();
  if(!t || t !== t.toUpperCase() || t === t.toLowerCase()) return t;
  return t.toLowerCase().replace(/(^|[\s\-(\/"])(\p{L})/gu, (_m, p, c) => p + c.toUpperCase());
}

// `videos` is the source of truth; legacy single-video fields mirror videos[0]
// so the public site keeps working with older data.
function legacyVideos(it){
  const url = safe(it.youtubeUrl).trim();
  if(!url) return [];
  return [{
    url,
    title: safe(it.videoTitle),
    startSeconds: safe(it.youtubeStartSeconds),
    danceStartSeconds: safe(it.youtubeDanceStartSeconds),
  }];
}

// "Tempi: 32\nMuri: 4\naltro" -> { counts: "32", walls: "4" } + "altro" (same rule as the server)
function parseDetails(text){
  const byLabel = new Map(propertyDefs().filter(d => d.detailsLabel).map(d => [d.detailsLabel.toLowerCase(), d]));
  const props = {};
  const extra = [];
  safe(text).split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([^:]{1,40}):\s*(.*)$/);
    const def = m && byLabel.get(m[1].trim().toLowerCase());
    if(def && !(def.key in props)){
      if(m[2].trim()) props[def.key] = m[2].trim();
      return;
    }
    extra.push(line);
  });
  return { props, extra: extra.join("\n").trim() };
}

function levelList(){ return (state.meta && state.meta.levels) || []; }
function findLevel(v){
  const k = safe(v).trim().toLowerCase();
  return k ? levelList().find(l => l.code.toLowerCase() === k || safe(l.label).toLowerCase() === k) || null : null;
}

function propertyDefs(){ return (state.meta && state.meta.propertyDefinitions) || []; }
function linkProviders(){ return ((state.meta && state.meta.mediaProviders) || []).filter(p => p.kind !== "video"); }

// Editing model: `properties` + `detailsExtra` are the source of truth; the
// composed `details`, `media` and `choreographers` are read-only API extras.
function normalizeItem(it){
  if(!Array.isArray(it.videos)) it.videos = legacyVideos(it);
  // Same shape the form produces, so opening a dance never makes it "modified".
  it.videos = it.videos.map(v => ({
    url: safe(v && v.url).trim(),
    title: safe(v && v.title).trim(),
    startSeconds: safe(v && v.startSeconds).trim(),
    danceStartSeconds: safe(v && v.danceStartSeconds).trim(),
  }));
  ["dance", "songTitle", "style", "year", "choreographer"].forEach(k => { it[k] = safe(it[k]).trim(); });
  // Difficulty: `level` is the code, `year` its label (historical field name).
  const lv = findLevel(it.level) || findLevel(it.year);
  if(lv){ it.level = lv.code; it.year = lv.label; } else { it.level = safe(it.level).trim(); }
  it.notes = safe(it.notes);
  if(!it.properties || typeof it.properties !== "object" || Array.isArray(it.properties)){
    const { props, extra } = parseDetails(it.details);
    it.properties = props;
    it.detailsExtra = extra;
  }
  if(it.detailsExtra == null) it.detailsExtra = "";
  linkProviders().forEach(p => {
    if(it[p.fields.url] == null) it[p.fields.url] = "";
    if(p.fields.title && it[p.fields.title] == null) it[p.fields.title] = "";
  });
  it.systemTags = normalizeSysTags(it.systemTags);
  mirrorLegacyVideo(it);
  delete it.details;
  delete it.media;
  delete it.choreographers;
  return it;
}

/* ---------- Official (system) tags ----------
 * Global tags visible to everyone. They live in each item's `systemTags`
 * ([{name, color}]) and are saved with the catalog ("Salva"); rename and
 * color apply to the tag on every dance. */
const SYS_PALETTE = ["#2563eb", "#059669", "#db2777", "#d97706", "#7c3aed", "#0891b2", "#ea580c", "#dc2626", "#16a34a", "#c026d3"];

function sysDefaultColor(name){
  let h = 0;
  for(const ch of name.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return SYS_PALETTE[h % SYS_PALETTE.length];
}

function cleanTagName(v){
  return safe(v).replace(/\s+/g, " ").trim().slice(0, 40);
}

function normalizeSysTags(list){
  const seen = new Map();
  (Array.isArray(list) ? list : []).forEach(t => {
    const raw = typeof t === "string" ? { name: t } : (t || {});
    const name = cleanTagName(raw.name);
    if(!name || seen.has(name.toLowerCase())) return;
    const color = /^#[0-9a-f]{6}$/i.test(safe(raw.color)) ? safe(raw.color).toLowerCase() : sysDefaultColor(name);
    const id = /^\d+$/.test(String(raw.id ?? "")) ? Number(raw.id) : null;
    seen.set(name.toLowerCase(), id != null ? { id, name, color } : { name, color });
  });
  return [...seen.values()];
}

// lower(name) -> { name, color, count } across the whole catalog
function sysTagRegistry(){
  const reg = new Map();
  state.items.forEach(it => (it.systemTags || []).forEach(t => {
    const k = t.name.toLowerCase();
    if(!reg.has(k)) reg.set(k, { id: null, name: t.name, color: t.color, count: 0 });
    const e = reg.get(k);
    if(e.id == null && t.id != null) e.id = t.id;
    e.count++;
  }));
  return reg;
}

function contrastText(hex){
  const m = String(hex || "").match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if(!m) return "#ffffff";
  const [r, g, b] = m.slice(1).map(h => parseInt(h, 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#0b0f17" : "#ffffff";
}

function sysChip(tag, { button = false } = {}){
  const chip = document.createElement(button ? "button" : "span");
  if(button) chip.type = "button";
  chip.className = "chip chipSystem";
  chip.style.setProperty("--chip", tag.color);
  chip.style.setProperty("--chip-text", contrastText(tag.color));
  const badge = document.createElement("span");
  badge.className = "chipBadge";
  badge.textContent = "✓";
  const label = document.createElement("span");
  label.className = "chipLabel";
  label.textContent = tag.name;
  chip.append(badge, label);
  return chip;
}

function currentItem(){
  return state.filtered[state.selectedIndex] || null;
}

function sysTagsChanged(){
  syncJsonEditor();
  renderSysTags(currentItem());
}

function renderSysTags(it){
  const box = $("sysTagChips");
  box.innerHTML = "";
  if(!it) return;
  const reg = sysTagRegistry();
  if(!it.systemTags.length){
    const p = document.createElement("span");
    p.className = "fieldHint";
    p.textContent = "Nessun tag ufficiale su questo ballo.";
    box.appendChild(p);
  }
  it.systemTags.forEach((tag, i) => {
    const chip = sysChip(tag);
    chip.classList.toggle("chipActive", state.sysEdit === tag.name.toLowerCase());
    const badge = chip.querySelector(".chipBadge");
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "chipBadge chipBadgeBtn";
    edit.textContent = "✓";
    edit.title = "Rinomina o cambia colore";
    edit.setAttribute("aria-label", `Modifica ${tag.name}`);
    edit.addEventListener("click", ()=>{
      const k = tag.name.toLowerCase();
      state.sysEdit = state.sysEdit === k ? null : k;
      renderSysTags(currentItem());
    });
    badge.replaceWith(edit);
    const x = document.createElement("button");
    x.type = "button";
    x.className = "chipX";
    x.textContent = "×";
    x.setAttribute("aria-label", `Rimuovi ${tag.name} da questo ballo`);
    x.addEventListener("click", ()=>{
      it.systemTags.splice(i, 1);
      if(state.sysEdit === tag.name.toLowerCase() && !sysTagRegistry().has(state.sysEdit)) state.sysEdit = null;
      sysTagsChanged();
    });
    chip.appendChild(x);
    box.appendChild(chip);
  });

  const onItem = new Set(it.systemTags.map(t => t.name.toLowerCase()));
  const others = [...reg.values()].filter(t => !onItem.has(t.name.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, "it", { sensitivity: "base" }));
  $("sysTagList").innerHTML = others.map(t => `<option value="${t.name.replace(/"/g, "&quot;")}"></option>`).join("");
  const sug = $("sysTagSuggest");
  sug.innerHTML = "";
  $("sysTagSuggestWrap").classList.toggle("hidden", !others.length);
  others.forEach(t => {
    const chip = sysChip(t, { button: true });
    chip.title = `Aggiungi "${t.name}" (${t.count} balli)`;
    chip.addEventListener("click", ()=> addSysTag(t.name));
    sug.appendChild(chip);
  });
  renderSysTagPanel();
}

function addSysTag(raw){
  const it = currentItem();
  if(!it) return;
  const reg = sysTagRegistry();
  String(raw || "").split(",").map(cleanTagName).filter(Boolean).forEach(name => {
    if(it.systemTags.some(t => t.name.toLowerCase() === name.toLowerCase())) return;
    const known = reg.get(name.toLowerCase());
    it.systemTags.push(known
      ? (known.id != null ? { id: known.id, name: known.name, color: known.color } : { name: known.name, color: known.color })
      : { name, color: sysDefaultColor(name) });
  });
  sysTagsChanged();
}

// Applies fn to the tag `key` on every dance, in the edited items and (for
// tags already on the server) in the loaded base too: a tag-level change is
// not a pending edit of the dances.
function updateSysTagEverywhere(key, fn, { base = false } = {}){
  const apply = (tags) => normalizeSysTags((tags || []).map(t => t.name.toLowerCase() === key ? fn({ ...t }) : t));
  state.items.forEach(it => { it.systemTags = apply(it.systemTags); });
  if(base){
    state.base.forEach((b, id) => {
      const obj = JSON.parse(b.json);
      obj.systemTags = apply(obj.systemTags);
      state.base.set(id, { ...b, json: stableJson(obj) });
    });
  }
}

async function patchSystemTag(body){
  const res = await fetch(SYSTAG_API, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function renameSysTag(key, rawName){
  const name = cleanTagName(rawName);
  const reg = sysTagRegistry();
  const cur = reg.get(key);
  if(!cur || !name || name === cur.name) return;
  const target = reg.get(name.toLowerCase());
  const merging = target && name.toLowerCase() !== key;
  if(merging && !confirm(`Esiste già il tag ufficiale "${target.name}".\n\nUnire "${cur.name}" in "${target.name}"? Tutti i balli con "${cur.name}" avranno "${target.name}".`)) return;

  if(cur.id == null){
    // Not on the server yet: rename locally, it is created with the dance save.
    updateSysTagEverywhere(key, () => merging ? { ...target } : { name, color: cur.color });
  } else {
    let { status, data } = await patchSystemTag({ id: cur.id, name, merge: merging });
    if(status === 409 && data.conflict){
      if(!confirm(`Sul server esiste già il tag ufficiale "${data.conflict.name}". Unire i due tag?`)) return;
      ({ status, data } = await patchSystemTag({ id: cur.id, name, merge: true }));
    }
    if(status !== 200){
      toast(status === 401 ? "Sessione scaduta: rifai il login" : "Errore nella modifica del tag");
      return;
    }
    const t = data.tag;
    updateSysTagEverywhere(key, () => ({ id: Number(t.id), name: t.name, color: t.color }), { base: true });
    announceCatalogChange();
  }
  state.sysEdit = (merging ? target.name : name).toLowerCase();
  toast(merging ? `"${cur.name}" unito in "${target.name}"` : `Rinominato in "${name}" su ${cur.count === 1 ? "1 ballo" : `${cur.count} balli`}`);
  sysTagsChanged();
}

function renderSysTagPanel(){
  const panel = $("sysTagPanel");
  const tag = state.sysEdit && sysTagRegistry().get(state.sysEdit);
  panel.innerHTML = "";
  panel.classList.toggle("hidden", !tag);
  if(!tag) return;

  const form = document.createElement("form");
  form.className = "sysTagRename";
  form.autocomplete = "off";
  const head = document.createElement("div");
  head.className = "fieldHint";
  head.textContent = `Nome · vale su ${tag.count === 1 ? "1 ballo" : `tutti i ${tag.count} balli`} con questo tag`;
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 40;
  input.value = tag.name;
  const btn = document.createElement("button");
  btn.type = "submit";
  btn.className = "ghostBtn";
  btn.textContent = "Rinomina";
  const row = document.createElement("div");
  row.className = "sysTagRow";
  row.append(input, btn);
  form.append(head, row);
  form.addEventListener("submit", (e)=>{
    e.preventDefault();
    renameSysTag(state.sysEdit, input.value);
  });

  const colorHead = document.createElement("div");
  colorHead.className = "fieldHint";
  colorHead.textContent = "Colore";
  const swatches = document.createElement("div");
  swatches.className = "swatches";
  const setColor = (color)=>{
    const key = state.sysEdit;
    const saved = tag.id != null;
    updateSysTagEverywhere(key, t => ({ ...t, color: color.toLowerCase() }), { base: saved });
    syncJsonEditor();
    if(saved){
      // Saved immediately (debounced) as a tag-level change.
      clearTimeout(state.colorTimer);
      state.colorTimer = setTimeout(async ()=>{
        const { status } = await patchSystemTag({ id: tag.id, color: color.toLowerCase() });
        if(status !== 200) toast("Errore nel salvataggio del colore");
        else announceCatalogChange();
      }, 400);
    }
    // update chips in place so the native color picker stays open
    $("sysTagChips").querySelectorAll(".chipActive").forEach(c => {
      c.style.setProperty("--chip", color);
      c.style.setProperty("--chip-text", contrastText(color));
    });
    swatches.querySelectorAll(".swatch").forEach(b => b.setAttribute("aria-pressed", b.dataset.color === color.toLowerCase() ? "true" : "false"));
    hex.textContent = color.toLowerCase();
  };
  SYS_PALETTE.forEach(color => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.dataset.color = color;
    b.style.background = color;
    b.setAttribute("aria-label", `Colore ${color}`);
    b.setAttribute("aria-pressed", color === tag.color ? "true" : "false");
    b.addEventListener("click", ()=>{ picker.value = color; setColor(color); });
    swatches.appendChild(b);
  });
  const custom = document.createElement("label");
  custom.className = "customColor";
  const picker = document.createElement("input");
  picker.type = "color";
  picker.value = tag.color;
  picker.addEventListener("input", ()=> setColor(picker.value));
  const hex = document.createElement("code");
  hex.textContent = tag.color;
  custom.append(picker, document.createTextNode("Personalizzato"), hex);

  panel.append(form, colorHead, swatches, custom);
}

function renderDynamicFields(){
  const lvSel = $("level");
  lvSel.querySelectorAll("option:not(:first-child)").forEach(o => o.remove());
  levelList().forEach(l => {
    const opt = document.createElement("option");
    opt.value = l.code;
    opt.textContent = l.label || l.code;
    lvSel.appendChild(opt);
  });
  const links = $("linkFields");
  links.innerHTML = "";
  linkProviders().forEach(p => {
    const add = (field, text, placeholder) => {
      const label = document.createElement("label");
      label.textContent = text;
      const input = document.createElement("input");
      input.type = "text";
      input.dataset.link = field;
      if(placeholder) input.placeholder = placeholder;
      label.appendChild(input);
      links.appendChild(label);
    };
    add(p.fields.url, `${p.label} URL`, p.code === "amazon_music" ? 'Link di condivisione o codice "Incorpora"' : "");
    if(p.fields.title) add(p.fields.title, `${p.label} titolo`, "");
  });

  const props = $("propFields");
  props.innerHTML = "";
  propertyDefs().forEach(d => {
    const label = document.createElement("label");
    label.textContent = d.label;
    let input;
    if(d.dataType === "longtext"){
      input = document.createElement("textarea");
      input.rows = 3;
    } else {
      input = document.createElement("input");
      input.type = d.dataType === "number" ? "number" : d.dataType === "boolean" ? "checkbox" : d.dataType === "date" ? "date" : "text";
    }
    input.dataset.prop = d.key;
    label.appendChild(input);
    props.appendChild(label);
  });
}

function mirrorLegacyVideo(it){
  const first = it.videos.find(v => safe(v.url).trim());
  it.youtubeUrl = first ? first.url : "";
  it.videoTitle = first ? first.title : "";
  it.youtubeStartSeconds = first ? first.startSeconds : "";
  it.youtubeDanceStartSeconds = first ? first.danceStartSeconds : "";
}

function renderVideoRows(it){
  const list = $("videoList");
  list.innerHTML = "";
  const tpl = $("videoRowTpl");
  (it ? it.videos : []).forEach((v, i)=>{
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.dataset.index = String(i);
    li.querySelector(".videoIndex").textContent = i === 0 ? "#1 · principale" : `#${i + 1}`;
    li.querySelectorAll("[data-field]").forEach(input => {
      input.value = safe(v[input.dataset.field]);
    });
    li.querySelector('[data-action="up"]').disabled = i === 0;
    li.querySelector('[data-action="down"]').disabled = i === it.videos.length - 1;
    list.appendChild(li);
  });
  updateDuplicateHints();
}

function youTubeId(url){
  const v = safe(url);
  const m = v.match(/[?&]v=([\w-]{6,})/) || v.match(/youtu\.be\/([\w-]{6,})/) || v.match(/youtube\.com\/(?:embed|shorts|live)\/([\w-]{6,})/);
  return m ? m[1] : "";
}

// Flags rows pointing to the same YouTube video as an earlier row.
function updateDuplicateHints(){
  const seen = new Map();
  $("videoList").querySelectorAll(".videoRow").forEach((li, i) => {
    const id = youTubeId(li.querySelector('[data-field="url"]').value);
    const hint = li.querySelector(".videoDup");
    const first = id ? seen.get(id) : undefined;
    hint.textContent = first != null ? `Stesso video del #${first + 1}` : "";
    hint.classList.toggle("hidden", first == null);
    if(id && first == null) seen.set(id, i);
  });
}

function readVideoRows(){
  return [...$("videoList").querySelectorAll(".videoRow")].map(li => {
    const v = {};
    li.querySelectorAll("[data-field]").forEach(input => {
      v[input.dataset.field] = input.value.trim();
    });
    return v;
  });
}

function onVideoAction(e){
  const btn = e.target.closest("button[data-action]");
  if(!btn) return;
  const it = state.filtered[state.selectedIndex];
  if(!it) return;
  const i = Number(btn.closest(".videoRow").dataset.index);
  const action = btn.dataset.action;
  if(action === "remove"){
    it.videos.splice(i, 1);
  } else {
    const j = action === "up" ? i - 1 : i + 1;
    if(j < 0 || j >= it.videos.length) return;
    [it.videos[i], it.videos[j]] = [it.videos[j], it.videos[i]];
  }
  mirrorLegacyVideo(it);
  renderVideoRows(it);
  syncJsonEditor();
}

function addVideo(){
  const it = state.filtered[state.selectedIndex];
  if(!it) return;
  it.videos.push({ url: "", title: "", startSeconds: "", danceStartSeconds: "" });
  renderVideoRows(it);
  const rows = $("videoList").querySelectorAll('[data-field="url"]');
  if(rows.length) rows[rows.length - 1].focus();
}

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
    title.textContent = displayTitle(it.dance) || "(senza titolo)";
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
  refreshDirty();
}

function selectIndex(idx){
  state.selectedIndex = idx;
  renderList();
  const it = state.filtered[idx];
  if(!it) return;
  $("dance").value = safe(it.dance);
  $("songTitle").value = safe(it.songTitle);
  $("style").value = safe(it.style);
  $("level").value = findLevel(it.level) ? it.level : "";
  $("linkFields").querySelectorAll("[data-link]").forEach(input => {
    input.value = safe(it[input.dataset.link]);
  });
  $("propFields").querySelectorAll("[data-prop]").forEach(input => {
    const v = it.properties[input.dataset.prop];
    if(input.type === "checkbox") input.checked = v === true;
    else input.value = safe(v);
  });
  $("choreographer").value = safe(it.choreographer);
  $("details").value = safe(it.detailsExtra);
  state.sysEdit = null;
  renderSysTags(it);
  $("notes").value = safe(it.notes);
  renderVideoRows(it);
}

function applyFilters(opts = {}){
  const q = safe($("searchInput").value).toLowerCase().trim();
  if(!q){
    state.filtered = [...state.items];
  } else {
    state.filtered = state.items.filter(it => {
      const hay = [
        it.dance, it.songTitle, it.style, it.year,
        it.detailsExtra, it.notes, it.choreographer, ...Object.values(it.properties || {}),
        ...(it.systemTags || []).map(t => t.name)
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
  const lv = findLevel($("level").value);
  it.level = lv ? lv.code : "";
  it.year = lv ? lv.label : "";
  $("linkFields").querySelectorAll("[data-link]").forEach(input => {
    it[input.dataset.link] = input.value.trim();
  });
  const props = {};
  $("propFields").querySelectorAll("[data-prop]").forEach(input => {
    if(input.type === "checkbox"){
      if(input.checked) props[input.dataset.prop] = true;
    } else if(input.value.trim()){
      props[input.dataset.prop] = input.type === "number" ? Number(input.value) : input.value.trim();
    }
  });
  it.properties = props;
  it.videos = readVideoRows();
  updateDuplicateHints();
  mirrorLegacyVideo(it);
  it.choreographer = $("choreographer").value.trim();
  it.detailsExtra = $("details").value;
  it.notes = $("notes").value;

  renderList();
  syncJsonEditor();
}

function addItem(){
  // Temporary negative id: the server assigns the real one on save.
  const nextId = state.nextTempId--;
  const blank = normalizeItem({
    id: nextId,
    year: "",
    level: "",
    dance: "",
    style: "",
    songTitle: "",
    spotifyUrl: "",
    amazonMusicUrl: "",
    videos: [],
    videoTitle: "",
    youtubeUrl: "",
    details: "",
    notes: "",
    choreographer: "",
    stepsheetTitle: "",
    stepsheetUrl: "",
    youtubeStartSeconds: "",
    youtubeDanceStartSeconds: "",
    properties: {},
    detailsExtra: "",
  });
  state.items.push(blank);
  applyFilters({ selectId: nextId });
  syncJsonEditor();
  toast("Nuovo ballo: verrà creato con \"Salva\"");
}

function confirmDelete(idx){
  const it = state.filtered[idx];
  if(!it) return;
  const name = safe(it.dance) || "(senza titolo)";
  if(!confirm(`Eliminare "${name}"?`)) return;
  const id = it.id;
  state.items = state.items.filter(x => x.id !== id);
  applyFilters();
  syncJsonEditor();
  toast("Ballo eliminato: confermato con \"Salva\"");
}

function moveItemById(fromId, targetId){
  const fromIdx = state.items.findIndex(it => safe(it.id) === safe(fromId));
  const toIdx = state.items.findIndex(it => safe(it.id) === safe(targetId));
  if(fromIdx === -1 || toIdx === -1) return;
  const [moved] = state.items.splice(fromIdx, 1);
  const insertIdx = fromIdx < toIdx ? toIdx - 1 : toIdx;
  state.items.splice(insertIdx, 0, moved);
  applyFilters({ selectId: fromId });
  syncJsonEditor();
  toast("Ordine modificato");
}

function syncJsonEditor(){
  $("jsonEditor").value = JSON.stringify({ items: state.items }, null, 2);
  state.syncedJson = $("jsonEditor").value;
  refreshDirty();
}

function applyJsonEditor(){
  const text = $("jsonEditor").value;
  if(text === state.syncedJson) return;
  const data = JSON.parse(text);
  if(!data || !Array.isArray(data.items)) throw new Error("JSON non valido: serve { items: [...] }");
  state.items = data.items.map(normalizeItem);
  state.syncedJson = text;
  applyFilters();
  refreshDirty();
}

// Netlify Identity token when signed in that way; Google users rely on the
// session cookie, sent automatically with same-origin requests.
async function getToken(){
  const ni = window.netlifyIdentity;
  const user = ni && ni.currentUser();
  if(!user) return null;
  try{
    return await user.jwt();
  }catch{
    return null;
  }
}

// Reads the relational catalog (all dances) plus the field configuration.
async function loadData(){
  const [metaRes, res] = await Promise.all([
    fetch("/.netlify/functions/catalog?view=meta", { cache: "no-store" }),
    fetch("/.netlify/functions/catalog?all=1", { cache: "no-store" }),
  ]);
  if(!metaRes.ok || !res.ok) throw new Error("Errore nel caricamento dati");
  state.meta = await metaRes.json();
  renderDynamicFields();
  const data = await res.json();
  const items = Array.isArray(data) ? data : (data.items || []);
  state.items = items.map(normalizeItem);
  state.base = new Map();
  state.items.forEach(rememberBase);
  state.baseOrder = state.items.map(it => Number(it.id));
  applyFilters();
  syncJsonEditor();
}

async function danceRequest(method, { body, query = "" } = {}){
  const res = await fetch(`${DANCE_API}${query}`, {
    method,
    headers: { "content-type": "application/json", ...(await authHeaders()) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// Replaces the local item `localId` with the server copy and marks it saved.
function adoptServerItem(localId, serverItem){
  const item = normalizeItem(serverItem);
  const idx = state.items.findIndex(x => Number(x.id) === Number(localId));
  if(idx >= 0) state.items[idx] = item; else state.items.push(item);
  rememberBase(item);
  return item;
}

// A dance changed elsewhere since it was loaded: never overwrite silently.
async function resolveConflict(local, current){
  const title = displayTitle(local.dance) || "(senza titolo)";
  if(!current){
    toast(`"${title}" è stato eliminato altrove`);
    state.items = state.items.filter(x => x !== local);
    state.base.delete(Number(local.id));
    return "dropped";
  }
  if(confirm(`"${title}" è stato modificato altrove dopo che lo hai aperto.\n\nOK: carica la versione aggiornata (le tue modifiche a questo ballo vengono scartate).\nAnnulla: scegli se sovrascriverla.`)){
    adoptServerItem(local.id, current);
    return "reloaded";
  }
  if(confirm(`Sovrascrivere la versione aggiornata di "${title}" con le tue modifiche?`)){
    const { status, data } = await danceRequest("PUT", { body: { item: local, version: current.version } });
    if(status === 200){ adoptServerItem(local.id, data.item); return "overwritten"; }
  }
  return "pending";
}

async function saveData(){
  if(state.saving) return;
  // Form edits are applied on every input; only the JSON view needs applying.
  if(state.jsonOnly){
    try{ applyJsonEditor(); }catch(e){ toast(e.message || "JSON non valido"); return; }
  }
  const selectedId = (state.filtered[state.selectedIndex] || {}).id;
  const p = pendingChanges();
  if(!p.count){ toast("Nessuna modifica da salvare"); return; }

  state.saving = true;
  refreshDirty();
  const done = { created: 0, updated: 0, deleted: 0, reloaded: 0, overwritten: 0, reordered: false, conflicts: 0, errors: 0 };
  let newSelectedId = selectedId;
  try{
    for(const it of p.created){
      const { id, version, ...item } = it;
      const { status, data } = await danceRequest("POST", { body: { item } });
      if(status === 201){
        const saved = adoptServerItem(id, data.item);
        state.baseOrder.push(Number(saved.id));
        if(Number(selectedId) === Number(id)) newSelectedId = saved.id;
        done.created++;
      } else { done.errors++; if(status === 401 || status === 403) throw Object.assign(new Error(), { status }); }
    }
    for(const it of p.updated){
      const { status, data } = await danceRequest("PUT", { body: { item: it, version: state.base.get(Number(it.id)).version } });
      if(status === 200){ adoptServerItem(it.id, data.item); done.updated++; }
      else if(status === 409 || status === 404){
        const r = await resolveConflict(it, data.current || null);
        if(r === "pending") done.conflicts++;
        if(r === "reloaded") done.reloaded++;
        if(r === "overwritten") done.overwritten++;
      } else { done.errors++; if(status === 401 || status === 403) throw Object.assign(new Error(), { status }); }
    }
    for(const id of p.deleted){
      const b = state.base.get(id);
      const { status } = await danceRequest("DELETE", { query: `?id=${id}&version=${b.version}` });
      if(status === 200 || status === 404){
        state.base.delete(id);
        state.baseOrder = state.baseOrder.filter(x => x !== id);
        done.deleted++;
      } else if(status === 409){
        done.conflicts++;
        toast("Un ballo da eliminare è stato modificato altrove: ricarica la pagina per vederlo");
      } else { done.errors++; if(status === 401 || status === 403) throw Object.assign(new Error(), { status }); }
    }
    if(pendingChanges().reordered){
      const ids = state.items.filter(it => !isNew(it)).map(it => Number(it.id));
      const { status } = await danceRequest("POST", { query: "?action=order", body: { ids } });
      if(status === 200){ state.baseOrder = ids; done.reordered = true; }
      else if(status === 409){ done.conflicts++; toast("L'elenco dei balli è cambiato altrove: ricarica per salvare l'ordine"); }
      else done.errors++;
    }
  }catch(err){
    console.error(err);
    toast(err.status === 403 ? "Il tuo account non ha più i permessi di editor" : err.status === 401 ? "Sessione scaduta: fai di nuovo login e risalva" : `Errore salvataggio: ${err.message || "rete non disponibile"}`);
  }finally{
    state.saving = false;
    applyFilters({ selectId: newSelectedId });
    syncJsonEditor();
  }
  if(done.created || done.updated || done.deleted || done.reordered || done.overwritten) announceCatalogChange();
  const parts = [];
  if(done.created) parts.push(`${done.created} creati`);
  if(done.updated) parts.push(`${done.updated} aggiornati`);
  if(done.deleted) parts.push(`${done.deleted} eliminati`);
  if(done.reordered) parts.push("ordine salvato");
  if(done.reloaded) parts.push(`${done.reloaded} ricaricati dalla versione aggiornata`);
  if(done.overwritten) parts.push(`${done.overwritten} sovrascritti`);
  if(done.conflicts) parts.push(`${done.conflicts} in conflitto`);
  if(done.errors) parts.push(`${done.errors} errori`);
  toast(parts.length ? `Salvato: ${parts.join(", ")}` : "Nessuna modifica salvata");
}

function setJsonOnly(on){
  state.jsonOnly = on;
  $("formPanel").style.display = on ? "none" : "grid";
  $("jsonPanel").classList.toggle("hidden", !on);
  $("toggleJsonOnly").textContent = on ? "Vista completa" : "Solo JSON";
}

/* ---------- Access: editors and administrators ----------
 * Who may use this page is decided by the server (/auth/me): administrators
 * (ADMIN_EMAILS), editors (promoted by an administrator) and Netlify Identity
 * accounts. Sign-in works with Google (session cookie) or Netlify Identity. */

// Resolves once the Netlify Identity widget has restored a saved login (or
// after a short timeout when it never initializes, e.g. on localhost).
const identityReady = new Promise(resolve => {
  const ni = window.netlifyIdentity;
  if(!ni) return resolve();
  ni.on("init", () => resolve());
  setTimeout(resolve, 1500);
});

async function authHeaders(){
  const token = await getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function fetchMe(){
  try{
    const res = await fetch("/.netlify/functions/auth/me", { cache: "no-store", headers: await authHeaders() });
    if(res.ok) return await res.json();
  }catch{}
  return { user: null, providers: {} };
}

async function checkAccess(){
  const { user, providers } = await fetchMe();
  state.me = user;
  const content = $("adminContent");
  const gate = $("adminGate");
  const who = $("whoami");
  who.classList.toggle("hidden", !user);
  who.textContent = user ? `${user.name}${user.isAdmin ? " · amministratore" : user.canEdit ? " · editor" : ""}` : "";
  $("loginBtn").classList.toggle("hidden", !!user);
  $("logoutBtn").classList.toggle("hidden", !user);
  $("usersBtn").classList.toggle("hidden", !(user && user.isAdmin));
  // Editing tools only for those who may edit.
  ["saveBtn", "toggleJsonOnly"].forEach(id => $(id).classList.toggle("hidden", !(user && user.canEdit)));

  if(user && user.canEdit){
    gate.classList.add("hidden");
    content.classList.remove("hidden");
    if(!state.loaded){
      state.loaded = true;
      await loadData().catch(err => { state.loaded = false; toast(err.message || "Errore caricamento"); });
    }
    return;
  }

  content.classList.add("hidden");
  gate.classList.remove("hidden");
  state.loaded = false;
  if(user){
    $("gateTitle").textContent = "Permessi insufficienti";
    $("gateText").textContent = `Sei entrato come ${user.email || user.name}, ma il tuo account non ha il ruolo di editor. Chiedi a un amministratore di abilitarlo, poi ricarica questa pagina.`;
    $("gateGoogle").classList.add("hidden");
    $("gateNetlify").classList.add("hidden");
    $("gateLogout").classList.remove("hidden");
  } else {
    $("gateTitle").textContent = "Accesso all'area admin";
    $("gateText").textContent = "Entra con un account abilitato come editor o amministratore.";
    $("gateGoogle").classList.toggle("hidden", !providers.google);
    $("gateNetlify").classList.toggle("hidden", !window.netlifyIdentity);
    $("gateLogout").classList.add("hidden");
  }
}

async function signOut(){
  if(state.dirty && !confirm("Ci sono modifiche non salvate. Uscire comunque?")) return;
  state.dirty = false;
  try{ await fetch("/.netlify/functions/auth/logout", { method: "POST" }); }catch{}
  const ni = window.netlifyIdentity;
  if(ni && ni.currentUser()){
    try{ await ni.logout(); }catch{}
  }
  await checkAccess();
}

function wireIdentity(){
  const ni = window.netlifyIdentity;
  $("loginBtn").addEventListener("click", ()=> $("adminGate").scrollIntoView({ behavior: "smooth" }));
  $("logoutBtn").addEventListener("click", signOut);
  $("gateLogout").addEventListener("click", signOut);
  $("gateNetlify").addEventListener("click", ()=> ni && ni.open("login"));
  if(ni){
    ni.on("login", ()=>{ ni.close(); checkAccess(); });
    ni.on("logout", ()=> checkAccess());
  }
  identityReady.then(checkAccess);
}

/* ---------- User management (administrators) ---------- */

const PROVIDER_LABELS = { google: "Google", netlify: "Account del sito", facebook: "Facebook" };

async function usersRequest(method, body){
  const res = await fetch("/.netlify/functions/admin-users", {
    method,
    cache: "no-store",
    headers: { "content-type": "application/json", ...(await authHeaders()) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if(!res.ok) throw Object.assign(new Error(await res.text()), { status: res.status });
  return res.json();
}

function formatDate(v){
  if(!v) return "—";
  const d = new Date(v);
  return isNaN(d) ? "—" : d.toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
}

function renderUsers(users){
  const body = $("usersBody");
  body.innerHTML = "";
  users.forEach(u => {
    const tr = document.createElement("tr");
    const who = document.createElement("td");
    who.className = "userCell";
    const av = document.createElement("span");
    av.className = "uAvatar";
    if(u.avatarUrl){
      const img = document.createElement("img");
      img.src = u.avatarUrl; img.alt = ""; img.referrerPolicy = "no-referrer";
      av.appendChild(img);
    } else {
      av.textContent = (u.name || "?").trim().charAt(0).toUpperCase();
    }
    const txt = document.createElement("div");
    txt.innerHTML = `<div class="uName"></div><div class="uMail"></div>`;
    txt.querySelector(".uName").textContent = u.name;
    txt.querySelector(".uMail").textContent = u.email || "—";
    who.append(av, txt);

    const via = document.createElement("td");
    via.textContent = u.providers.map(p => PROVIDER_LABELS[p] || p).join(", ") || "—";
    const last = document.createElement("td");
    last.textContent = formatDate(u.lastLoginAt);

    const roleTd = document.createElement("td");
    if(u.locked){
      roleTd.innerHTML = `<span class="roleBadge roleAdmin">Amministratore</span>`;
    } else if(u.viaNetlify && u.storedRole !== "editor"){
      roleTd.innerHTML = `<span class="roleBadge">Editor (account del sito)</span>`;
    } else {
      const sel = document.createElement("select");
      sel.className = "roleSelect";
      sel.setAttribute("aria-label", `Ruolo di ${u.name}`);
      [["user", "Utente"], ["editor", "Editor"]].forEach(([v, l]) => {
        const o = document.createElement("option");
        o.value = v; o.textContent = l;
        sel.appendChild(o);
      });
      sel.value = u.storedRole;
      sel.addEventListener("change", async ()=>{
        sel.disabled = true;
        try{
          const data = await usersRequest("PATCH", { id: u.id, role: sel.value });
          renderUsers(data.users);
          toast(sel.value === "editor" ? `${u.name} ora è editor` : `${u.name} non è più editor`);
        }catch(err){
          sel.value = u.storedRole;
          sel.disabled = false;
          toast(err.status === 403 ? "Solo un amministratore può cambiare i ruoli" : "Errore nel cambio di ruolo");
        }
      });
      roleTd.appendChild(sel);
    }
    tr.append(who, via, last, roleTd);
    body.appendChild(tr);
  });
}

async function openUsers(){
  const modal = $("usersModal");
  $("usersBody").innerHTML = `<tr><td colspan="4" class="fieldHint">Caricamento…</td></tr>`;
  modal.classList.remove("hidden");
  try{
    renderUsers((await usersRequest("GET")).users);
  }catch(err){
    $("usersBody").innerHTML = `<tr><td colspan="4" class="fieldHint">${err.status === 403 ? "Solo gli amministratori possono gestire gli utenti." : "Errore nel caricamento degli utenti."}</td></tr>`;
  }
}

function wireUsers(){
  const modal = $("usersModal");
  $("usersBtn").addEventListener("click", openUsers);
  modal.addEventListener("click", (e)=>{ if(e.target.closest("[data-close]")) modal.classList.add("hidden"); });
  document.addEventListener("keydown", (e)=>{ if(e.key === "Escape") modal.classList.add("hidden"); });
}

// Theme: Automatico -> Chiaro -> Scuro (same preference as the public site).
function wireThemeButton(){
  const theme = window.LDTheme;
  const btn = $("themeBtn");
  if(!theme || !btn) return;
  const order = ["system", "light", "dark"];
  const sync = ()=>{ btn.textContent = `Tema: ${theme.labels[theme.get()]}`; };
  btn.addEventListener("click", ()=>{
    theme.set(order[(order.indexOf(theme.get()) + 1) % order.length]);
  });
  theme.onChange(sync);
  sync();
}

function init(){
  wireThemeButton();
  wireUsers();
  wireIdentity();
  $("searchInput").addEventListener("input", applyFilters);
  $("addBtn").addEventListener("click", addItem);
  $("toggleJsonOnly").addEventListener("click", ()=>{
    setJsonOnly(!state.jsonOnly);
  });
  $("saveBtn").addEventListener("click", saveData);
  window.addEventListener("beforeunload", (e)=>{
    if(!state.dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });
  [
    "dance","songTitle","style","level","choreographer","details","notes","linkFields","propFields"
  ].forEach(id=>{
    $(id).addEventListener("input", updateItemFromForm);
  });
  $("propFields").addEventListener("change", updateItemFromForm);
  $("videoList").addEventListener("input", updateItemFromForm);
  $("videoList").addEventListener("click", onVideoAction);
  $("addVideoBtn").addEventListener("click", addVideo);
  $("sysTagForm").addEventListener("submit", (e)=>{
    e.preventDefault();
    addSysTag($("sysTagInput").value);
    $("sysTagInput").value = "";
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
