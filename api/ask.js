import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;

const title = (p) => (p.Question?.title || []).map(t => t.plain_text).join(" ").trim();
const answer = (p) => (p.Answer?.rich_text || []).map(t => t.plain_text).join(" ").trim();

export default async function handler(req, res) {
  try {
    // read q from ?q=... or POST body
    let q = new URL(req.url, "http://localhost").searchParams.get("q");
    if (!q && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      q = body.q || body.question || "";
    }
    if (!q) return res.status(400).json({ error: "Missing q" });

    // try exact match search first
    const hit = await notion.databases.query({
      database_id: DB_ID,
      filter: { property: "Question", title: { contains: q } },  // ✅ use "title" not "rich_text"
      page_size: 1,
    });

    if (hit.results.length) {
      return res.status(200).json({ answer: answer(hit.results[0].properties) });
    }

    // fallback: scan all and pick best simple keyword match
    let cursor, best = { score: -1, ans: "" };
    do {
      const resp = await notion.databases.query({
        database_id: DB_ID,
        start_cursor: cursor,
        page_size: 50,
      });
      for (const r of resp.results) {
        const t = title(r.properties).toLowerCase();
        let score = 0;
        q.toLowerCase().split(/\s+/).forEach(w => {
          if (t.includes(w)) score++;
        });
        if (score > best.score) {
          best = { score, ans: answer(r.properties) };
        }
      }
      cursor = resp.has_more ? resp.next_cursor : null;
    } while (cursor);

    return res.status(200).json({ answer: best.ans || "(no answer found)" });

  } catch (e) {
    console.error(e);
    const msg = e?.body?.message || e?.message || "Failed to fetch from Notion";
    return res.status(500).json({ error: msg });
  }
}
