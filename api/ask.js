// /api/ask.js
import { Client as Notion } from "@notionhq/client";

// ---------- helpers ----------
const normalize = (s = "") =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa")
    .replace(/\s+/g, " ")
    .trim();

const titleFrom = (p) =>
  (p?.Question?.title ?? []).map((t) => t?.plain_text ?? "").join(" ").trim();

const answerFrom = (p) =>
  (p?.Answer?.rich_text ?? []).map((t) => t?.plain_text ?? "").join(" ").trim();

const json = (res, code, data) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (code) res.status(code);
  return res.json(data);
};

// very small fuzzy score (0..1)
const dice = (a, b) => {
  a = normalize(a); b = normalize(b);
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (str) => {
    const set = new Map();
    for (let i = 0; i < str.length - 1; i++) {
      const bg = str.slice(i, i + 2);
      set.set(bg, (set.get(bg) ?? 0) + 1);
    }
    return set;
  };
  const A = bigrams(a), B = bigrams(b);
  let overlap = 0, sizeA = 0, sizeB = 0;
  for (const [, v] of A) sizeA += v;
  for (const [, v] of B) sizeB += v;
  for (const [k, v] of A) overlap += Math.min(v, B.get(k) ?? 0);
  return (2 * overlap) / (sizeA + sizeB || 1);
};

// ---------- env / clients ----------
const notion = new Notion({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Lazy OpenAI embed call (no SDK; keeps it tiny)
async function embed(text) {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: text,
      model: "text-embedding-3-small",
    }),
  });
  if (!r.ok) throw new Error(`OpenAI error: ${r.status}`);
  const j = await r.json();
  return j?.data?.[0]?.embedding ?? [];
}

// Pull a small bank of rows (first pages)
async function fetchBank(limit = 50) {
  const rows = await notion.databases.query({
    database_id: DB_ID,
    page_size: limit,
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  });
  return rows.results.map((r) => {
    const props = r.properties ?? {};
    return {
      id: r.id,
      title: titleFrom(props),
      answer: answerFrom(props),
    };
  }).filter((x) => x.title && x.answer);
}

// ---------- main handler ----------
export default async function handler(req, res) {
  if (req.method === "OPTIONS") return json(res, 200, {});
  try {
    // read q from ?q= or JSON body
    let q = new URL(req.url, "http://localhost").searchParams.get("q");
    if (!q && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      q = body.q || body.question || "";
    }
    if (!q) return json(res, 400, { error: "Missing q" });

    const qNorm = normalize(q);
    const bank = await fetchBank(100);

    // 1) Quick exact/contains on title
    const exact = bank.find((i) => normalize(i.title) === qNorm)
      ?? bank.find((i) => normalize(i.title).includes(qNorm));
    if (exact) return json(res, 200, { answer: exact.answer });

    // 2) Embeddings (only if we have an API key)
    if (OPENAI_API_KEY) {
      const bankWithVec = await Promise.all(
        bank.map(async (i) => ({
          ...i,
          vec: await embed(i.title),
        }))
      );
      const qVec = await embed(q);
      // cosine
      const cos = (a, b) => {
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length && i < b.length; i++) {
          dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
        }
        return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
      };
      let best = { score: -1, item: null };
      for (const it of bankWithVec) {
        const s = cos(qVec, it.vec);
        if (s > best.score) best = { score: s, item: it };
      }
      if (best.item && best.score >= 0.80) {
        return json(res, 200, { answer: best.item.answer, _sim: +best.score.toFixed(3) });
      }
    }

    // 3) Keyword fallback (just to be extra forgiving)
    const kw = qNorm;
    const kwHit =
      bank.find((i) =>
        normalize(i.title).includes("kontakt") && (kw.includes("kontakt") || kw.includes("rekrutter"))
      ) ?? bank.find((i) =>
        normalize(i.title).includes("rekrutter") && (kw.includes("spiller") || kw.includes("rekrutter"))
      );
    if (kwHit) return json(res, 200, { answer: kwHit.answer });

    // 4) Tiny fuzzy backup
    let fuzzyBest = { s: 0, item: null };
    for (const it of bank) {
      const s = dice(q, it.title);
      if (s > fuzzyBest.s) fuzzyBest = { s, item: it };
    }
    if (fuzzyBest.item && fuzzyBest.s >= 0.6) {
      return json(res, 200, { answer: fuzzyBest.item.answer, _fuzzy: +fuzzyBest.s.toFixed(3) });
    }

    // If we reached here: nothing solid
    return json(res, 200, { answer: "Sorry, I couldn't find an answer." });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: "Failed to fetch from Notion/OpenAI" });
  }
}
