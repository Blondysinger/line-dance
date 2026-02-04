const { neon } = require("@neondatabase/serverless");

function parseBody(event){
  if(!event.body) return null;
  try{
    return JSON.parse(event.body);
  }catch{
    return null;
  }
}

exports.handler = async (event, context) => {
  if(event.httpMethod !== "POST"){
    return { statusCode: 405, body: "Method not allowed" };
  }
  if(!context.clientContext || !context.clientContext.user){
    return { statusCode: 401, body: "Unauthorized" };
  }

  const data = parseBody(event);
  if(!data || !Array.isArray(data.items)){
    return { statusCode: 400, body: "Invalid payload" };
  }

  try{
    const conn = process.env.NEON_DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
    if(!conn){
      return { statusCode: 500, body: "Missing DB connection" };
    }
    const sql = neon(conn);
    const payload = JSON.stringify(data);
    const query = process.env.DANCES_SQL_WRITE || "update line_dance_data set data = $1::jsonb";
    const res = await sql(query, [payload]);

    // If update affected 0 rows, insert one
    if(res && res.length === 0 && query.toLowerCase().startsWith("update")){
      await sql("insert into line_dance_data (data) values ($1::jsonb)", [payload]);
    }

    return { statusCode: 200, body: "ok" };
  }catch(err){
    return { statusCode: 500, body: `Error: ${err && err.message ? err.message : "unknown"}` };
  }
};
