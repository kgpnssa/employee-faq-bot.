// /api/ask.js
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""; // valgfri

// --- Utils ---
const plain = (arr = []) => arr.map(t => t.plain_text || t.text?.content || "").join(" ").trim();
const titleOf = (p) => plain(p?.Question?.title || []);
const answerOf = (p) => plain(p?.Answer?.rich_text || []);
const norm = (s) => (s || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu,"").replace(/\s+/g," ").trim();

// simpel fuzzy (Dice-koefficient)
function dice(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  const bg = s => Array.from({length: s.length-1}, (_,i)=> s.slice(i,i+2));
  const A = bg(a), B = bg(b);
  if (A.length <= 0 || B.length <= 0) return 0;
  let matches = 0; const setB = [...B];
  for (const x of A) {
    const i = setB.indexOf(x);
    if (i !== -1) { matches++; setB.splice(i,1); }
  }
  return (2*matches) / (A.length + B.length);
}

// OpenAI embeddings (REST)
async function embed(text) {
  const body = {
    input: text,
    model: "text-embedding-3-small",
  };
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`OpenAI error: ${r.status}`);
  const data = await r.json();
  return data.data[0].embedding;
}

const cos = (a, b) => {
  let dot=0, na=0, nb=0;
  for (let i=0;i<a.length;i++){ const x=a[i], y=b[i]; dot+=x*y; na+=x*x; nb+=y*y; }
  return dot / (Math.sqrt(na)*Math.sqrt(nb) || 1);
};

// hent ALLE rækker fra Notion (paged)
async function fetchAllRows() {
  const rows = [];
  let cursor = undefined;
  do {
    const resp = await notion.databases.query({
      database_id: DB_ID,
      start_cursor: cursor,
      page_size: 100,
      sorts: [{ property: "Question", direction: "ascending" }]
    });
    rows.push(...resp.results.map(r => r.properties));
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  // filtrér til rækker som faktisk har Question & Answer
  return rows
    .map(p => ({ title: titleOf(p), answer: answerOf(p) }))
    .filter(x => x.title && x.answer);
}

export default async function handler(req, res) {
  try {
    // 1) læs q fra query eller POST-body
    let q = new URL(req.url, "http://localhost").searchParams.get("q");
    if (!q && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      q = body.q || body.question || "";
    }
    q = (q || "").trim();
    if (!q) {
      return res.status(200).json({ answer: "Skriv et spørgsmål, fx: 'Hvordan kontakter jeg nye spillere?'" });
    }

    // 2) hent bank fra Notion
    const bank = await fetchAllRows();

    // 3) hurtig exact/contains i title (Notion filter kan også bruges, men bank er i RAM nu)
    {
      const nq = norm(q);
      const hit = bank.find(it => norm(it.title).includes(nq));
      if (hit) return res.status(200).json({ answer: hit.answer });
    }

    // 4) Embeddings (kun hvis OPENAI_API_KEY findes)
    if (OPENAI_API_KEY) {
      try {
        const qvec = await embed(q);
        let best = { score: -1, item: null };
        for (const it of bank) {
          const ivec = await embed(it.title); // (simpelt: embed hver gang; for speed kan du cache)
          const score = cos(qvec, ivec);
          if (score > best.score) best = { score, item: it };
        }
        // styr tærsklen efter behov (0.78 er konservativt)
        if (best.item && best.score >= 0.78) {
          return res.status(200).json({ answer: best.item.answer });
        }
      } catch (e) {
        // fald blot videre til keyword/fuzzy
        console.error("Embeddings fejlede:", e.message);
      }
    }

    // 5) Keyword fallback (dansk rekrutter/“kontakt” m.m.)
    {
      const nq = norm(q);
      const keywords = [
        "kontakt", "kontaktperson", "kontakt spillere", "rekrutter", "rekruttering", "rekruttere",
        "scholarship", "stipendium", "kollegie", "college", "ansøgning", "tryouts", "prøve",
        "træning", "skole", "studie", "visa", "visum"
      ];
      const keyHit = bank.find(it =>
        keywords.some(k => norm(it.title).includes(k)) &&
        keywords.some(k => nq.includes(k))
      );
      if (keyHit) return res.status(200).json({ answer: keyHit.answer });
    }

    // 6) Fuzzy fallback på title
    {
      let best = { score: -1, item: null };
      for (const it of bank) {
        const s = dice(q, it.title);
        if (s > best.score) best = { score: s, item: it };
      }
      if (best.item && best.score >= 0.4) {
        return res.status(200).json({ answer: best.item.answer });
      }
    }

    // 7) Til sidst: standard svar
    return res.status(200).json({ answer: "Sorry, I couldn't find an answer." });

  } catch (err) {
    console.error(err);
    return res.status(200).json({ answer: "Sorry, I couldn't find an answer." });
  }
}
