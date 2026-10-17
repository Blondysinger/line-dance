const { getSql } = require("../lib/db");
const { readCatalog } = require("../lib/catalog");

exports.handler = async () => {
  try{
    let sql;
    try{
      sql = getSql();
    }catch{
      return {
        statusCode: 500,
        body: "Missing NEON_DATABASE_URL",
      };
    }
    const data = await readCatalog(sql);

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
