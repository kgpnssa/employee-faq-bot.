import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;

const title = p => (p?.Question?.title || []).map(t=>t.plain_text).join(" ").trim();
const answer = p => (p?.Answer?.rich_text || []).map(t=>t.plain_text).join(" ").trim();

export default async function handler(req, res) {
  try {
    // read q from ?q=... or POST body
    let q = new URL(req.url, "http://localhost").searchParams.get("q");
    if (!q && req.method === "POST") {
      const chunks=[]; for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString()||"{}");
      q = body.q || body.question || "";
    }
    if (!q) return res.status(400).json({ error: "Missing q" });

    // fast contains search on Question
    const hit = await notion.databases.query({
      database_id: DB_ID,
      filter: { property: "Question", rich_text: { contains: q } },
      page_size: 1,
    });
    if (hit.results.length) {
      return res.status(200).json({ answer: answer(hit.results[0].properties) });
    }

    // fallback: scan all and pick best simple keyword match
    let cursor, best = { score: -1, ans: "" };
    do {
      const resp = await notion.databases.query({
        database_id: DB_ID, start_cursor: cursor, page_size: 100,
      });
      for (const page of resp.results) {
        const Q = title(page.properties), A = answer(page.properties);
        const s = score(q, Q, A);
        if (s > best.score) best = { score: s, ans: A };
      }
      cursor = resp.has_more ? resp.next_cursor : undefined;
    } while (cursor);

    return res.status(200).json({ answer: best.ans || "Sorry, I don’t know that yet." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to fetch from Notion" });
  }
}

function score(q, Q, A) {
  const norm = s => String(s||"").toLowerCase();
  q = norm(q); Q = norm(Q); A = norm(A);
  const words = Array.from(new Set(q.split(/\s+/)));
  const inQ = Q.includes(q) ? 1 : 0;
  const overlapQ = words.filter(w=>Q.includes(w)).length / Math.max(1,words.length);
  const overlapA = words.filter(w=>A.includes(w)).length / Math.max(1,words.length);
  return inQ + overlapQ + 0.4*overlapA;
}
