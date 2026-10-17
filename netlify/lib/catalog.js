function pickPayload(row){
  if(!row || typeof row !== "object") return null;
  if("payload" in row) return row.payload;
  if("data" in row) return row.data;
  if("json" in row) return row.json;
  if("items" in row) return row.items;
  const keys = Object.keys(row);
  if(keys.length === 1) return row[keys[0]];
  return null;
}

async function readCatalog(sql){
  const query = process.env.DANCES_SQL || "select data as payload from line_dance_data limit 1";
  const rows = await sql(query);
  let data = pickPayload(rows && rows[0]);
  if(typeof data === "string") data = JSON.parse(data);
  if(Array.isArray(data)) data = { items: data };
  return data || { items: [] };
}

function str(v){ return (v ?? "").toString().trim(); }

function seconds(v){
  if(v === "" || v == null) return "";
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : "";
}

function normalizeVideo(v){
  if(!v || typeof v !== "object") return null;
  const url = str(v.url);
  if(!url) return null;
  return {
    url,
    title: str(v.title),
    startSeconds: seconds(v.startSeconds),
    danceStartSeconds: seconds(v.danceStartSeconds),
  };
}

// `videos` is the source of truth; the legacy single-video fields mirror
// videos[0] so older clients keep working.
function normalizeItem(it){
  const item = { ...it };
  let videos = Array.isArray(item.videos) ? item.videos.map(normalizeVideo).filter(Boolean) : null;
  if(!videos){
    const legacy = normalizeVideo({
      url: item.youtubeUrl,
      title: item.videoTitle,
      startSeconds: item.youtubeStartSeconds,
      danceStartSeconds: item.youtubeDanceStartSeconds,
    });
    videos = legacy ? [legacy] : [];
  }
  item.videos = videos;
  const first = videos[0];
  item.youtubeUrl = first ? first.url : "";
  item.videoTitle = first ? first.title : "";
  item.youtubeStartSeconds = first ? first.startSeconds : "";
  item.youtubeDanceStartSeconds = first ? first.danceStartSeconds : "";
  item.amazonMusicUrl = str(item.amazonMusicUrl);
  return item;
}

module.exports = { readCatalog, normalizeItem };
