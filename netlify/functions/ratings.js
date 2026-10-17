const { json, text, parseJsonBody } = require("../lib/http");
const { getSql, ensureSchema } = require("../lib/db");
const { getCurrentUser } = require("../lib/users");

// Star ratings (0-5), one vote per user and dance.
//   GET                       -> { mine: { danceId: stars } }   (signed-in user)
//   PUT {danceId, stars}      -> vote; stars null removes it    -> { danceId, mine, avg, count }
// Averages are public and come with the catalog (item.rating).
async function summary(sql, danceId){
  const [r] = await sql`
    select round(avg(stars)::numeric, 2) as avg, count(*)::int as count
    from dance_ratings where dance_id = ${danceId}`;
  return { avg: r.avg == null ? null : Number(r.avg), count: r.count };
}

exports.handler = async (event, context) => {
  try{
    const user = await getCurrentUser(event, context);
    if(!user) return text(401, "Unauthorized");
    await ensureSchema();
    const sql = getSql();

    if(event.httpMethod === "GET"){
      const rows = await sql`select dance_id, stars from dance_ratings where user_id = ${user.id}`;
      return json(200, { mine: Object.fromEntries(rows.map(r => [r.dance_id, r.stars])) });
    }

    if(event.httpMethod === "PUT"){
      const body = parseJsonBody(event) || {};
      const danceId = Number(body.danceId);
      if(!Number.isInteger(danceId)) return text(400, "danceId non valido");
      const [exists] = await sql`select 1 from dances where id = ${danceId}`;
      if(!exists) return text(404, "Ballo non trovato");
      if(body.stars == null){
        await sql`delete from dance_ratings where user_id = ${user.id} and dance_id = ${danceId}`;
      } else {
        const stars = Number(body.stars);
        if(!Number.isInteger(stars) || stars < 0 || stars > 5) return text(400, "Le stelle vanno da 0 a 5");
        await sql`
          insert into dance_ratings (user_id, dance_id, stars) values (${user.id}, ${danceId}, ${stars})
          on conflict (user_id, dance_id) do update set stars = excluded.stars, updated_at = now()`;
      }
      return json(200, { danceId, mine: body.stars == null ? null : Number(body.stars), ...(await summary(sql, danceId)) });
    }
    return text(405, "Method not allowed");
  }catch(err){
    console.error("ratings error:", err);
    return text(500, `Error: ${err && err.message ? err.message : "unknown"}`);
  }
};
