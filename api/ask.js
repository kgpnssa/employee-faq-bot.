import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;

// helpers to read Notion rich text / title
const title = (p) => (p?.Question?.title || []).map(t => t.plain_text).join(" ").trim();
const answer = (p) => (p?.Answer?.rich_text || []).map(t => t.plain_text).join(" ").trim();

// --- text utils ---
const normalize = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[?!.,:;()\[\]{}/\\'"`~^%€$#@*-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

function diceCoefficient(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // build bigram sets
  const bigrams = (str) => {
    const out = new Map();
    for (let i = 0; i < str.length - 1; i++) {
      const bg = str.slice(i, i + 2);
      out.set(bg, (out.get(bg) || 0) + 1);
    }
    return out;
  };
  const A = bigrams(a), B = bigrams(b);
  let overlap = 0;
  for (const [bg, cnt] of A) {
    const inB = B.get(bg) || 0;
    overlap += Math.min(cnt, inB);
  }
  const sizeA = Array.from(A.values()).reduce((s, n) => s + n, 0);
  const sizeB = Array.from(B.values()).reduce((s, n) => s + n, 0);
  return (2 * overlap) / (sizeA + sizeB || 1);
}

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

    const qNorm = normalize(q);

    // pull up to 100 rows once, then match locally (more robust than strict API filter)
    const rows = [];
    let cursor = undefined;
    do {
      const resp = await notion.databases.query({
        database_id: DB_ID,
        page_size: 100,
        start_cursor: cursor,
      });
      rows.push(...resp.results);
      cursor = resp.has_more ? resp.next_cursor : undefined;
    } while (cursor && rows.length < 300);

    // build light objects {title, answer}
    const items = rows
      .map(r => ({
        title: title(r.properties),
        answer: answer(r.properties),
      }))
      .filter(it => it.title && it.answer);

    // 1) exact/contains on normalized strings
    const normMap = items.map(it => ({ ...it, tNorm: normalize(it.title) }));
    let hit = normMap.find(it => it.tNorm === qNorm)
           || normMap.find(it => it.tNorm.includes(qNorm))
           || normMap.find(it => qNorm.includes(it.tNorm) && it.tNorm.length >= 5);

    if (hit) return res.status(200).json({ answer: hit.answer });

    // 2) fuzzy (Dice on bigrams)
    let best = { score: 0, item: null };
    for (const it of items) {
      const s = diceCoefficient(it.title, q);
      if (s > best.score) best = { score: s, item: it };
    }

    if (best.item && best.score >= 0.58) { // just under 0.6 for Danish punctuation etc.
      return res.status(200).json({ answer: best.item.answer, _score: best.score });
    }

    return res.status(200).json({ answer: "Sorry, I couldn't find an answer." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch from Notion" });
  }
}
