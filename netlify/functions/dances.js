const { neon } = require("@neondatabase/serverless");

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

exports.handler = async () => {
  try{
    const conn = process.env.NEON_DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
    if(!conn){
      return {
        statusCode: 500,
        body: "Missing NEON_DATABASE_URL",
      };
    }
    const sql = neon(conn);
    const query = process.env.DANCES_SQL || "select data as payload from line_dance_data limit 1";
    const rows = await sql(query);
    const payload = pickPayload(rows && rows[0]);

    let data = payload;
    if(typeof data === "string"){
      data = JSON.parse(data);
    }
    if(!data){
      data = { items: [] };
    }

    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
      body: JSON.stringify(data),
    };
  }catch(err){
    return {
      statusCode: 500,
      body: `Error: ${err && err.message ? err.message : "unknown"}`,
    };
  }
};
