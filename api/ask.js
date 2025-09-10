import { Client } from "@notionhq/client";

// --- Notion client ---
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;

// --- OpenAI REST (ingen ekstra dependency) ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = "text-embedding-3-small"; // 1536 dims, billig og god til semantik

// --- helpers til Notion felter ---
const getTitle = (p) => (p?.Question?.title || []).map(t => t.plain_text).join(" ").trim();
const getAnswer = (p) => (p?.Answer?.rich_text || []).map(t => t.plain_text).join(" ").trim();

// --- simple text utils + fuzzy fallback ---
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
  for (const [bg, cnt] of A) overlap += Math.min(cnt, B.get(bg) || 0);
  const size = (m) => Array.from(m.values()).reduce((s, n) => s + n, 0);
  return (2 * overlap) / ((size(A) + size(B)) || 1);
}

// --- cosine similarity ---
const cosineSim = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    dot += x * y; na += x * x; nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

// --- embed via OpenAI REST ---
async function embedTexts(texts) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`OpenAI error: ${res.status} ${err}`);
  }
  const json = await res.json();
  return json.data.map(d => d.embedding);
}

async function embedOne(text) {
  const [v] = await embedTexts([text || ""]);
  return v;
}

// --- Notion fetch med pagination ---
async function fetchNotionItems() {
  const rows = [];
  let cursor;
  do {
    const resp = await notion.databases.query({
      database_id: DB_ID,
      page_size: 100,
      start_cursor: cursor,
    });
    rows.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor && rows.length < 1000);

  const items = rows.map(r => ({
    title: getTitle(r.properties),
    answer: getAnswer(r.properties),
  })).filter(x => x.title && x.answer);

  return items;
}

// --- simpel in-memory cache (lever over flere requests pr. container) ---
let CACHE = {
  at: 0,
  ttlMs: 10 * 60 * 1000, // 10 min
  items: null,           // [{title, answer, embedding}]
};

async function getCachedEmbeddings() {
  const now = Date.now();
  if (CACHE.items && now - CACHE.at < CACHE.ttlMs) return CACHE.items;

  const items = await fetchNotionItems();
  if (!items.length) {
    CACHE = { ...CACHE, at: now, items: [] };
    return CACHE.items;
  }

  // batch embed titler (100 ad gangen for at være venlig mod API’et)
  const batchSize = 100;
  const embeddings = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const slice = items.slice(i, i + batchSize).map(x => x.title);
    const vecs = await embedTexts(slice);
    embeddings.push(...vecs);
  }

  const enriched = items.map((x, i) => ({ ...x, embedding: embeddings[i] }));
  CACHE = { ...CACHE, at: now, items: enriched };
  return enriched;
}

export default async function handler(req, res) {
  try {
    // parse q
    let q = new URL(req.url, "http://localhost").searchParams.get("q");
    if (!q && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      q = body.q || body.question || "";
    }
    if (!q) return res.status(400).json({ error: "Missing q" });

    const qNorm = normalize(q);

    // 1) lokal exact/contains som hurtig genvej
    const baseRows = await fetchNotionItems();
    const normRows = baseRows.map(it => ({ ...it, tNorm: normalize(it.title) }));
    let quick =
      normRows.find(it => it.tNorm === qNorm) ||
      normRows.find(it => it.tNorm.includes(qNorm)) ||
      normRows.find(it => qNorm.includes(it.tNorm) && it.tNorm.length >= 5);

    if (quick) return res.status(200).json({ answer: quick.answer });

    // 2) embeddings matching
    const bank = await getCachedEmbeddings(); // med vectors
    if (!bank.length) return res.status(200).json({ answer: "Sorry, I couldn't find an answer." });

    const qVec = await embedOne(q);
    let best = { score: -1, item: null };
    for (const it of bank) {
      const s = cosineSim(qVec, it.embedding);
      if (s > best.score) best = { score: s, item: it };
    }

    // tærskel (justér hvis du vil være mere/ mindre kræsen)
    if (best.item && best.score >= 0.7) {
      return res.status(200).json({ answer: best.item.answer, _score: +best.score.toFixed(3) });
    }

    // 3) fuzzy backup hvis embeddings-score var lav
    let fuzzy = { score: 0, item: null };
    for (const it of baseRows) {
      const s = diceCoefficient(it.title, q);
      if (s > fuzzy.score) fuzzy = { score: s, item: it };
    }
    if (fuzzy.item && fuzzy.score >= 0.6) {
      return res.status(200).json({ answer: fuzzy.item.answer, _fuzzy: +fuzzy.score.toFixed(3) });
    }

    return res.status(200).json({ answer: "Sorry, I couldn't find an answer." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to answer", detail: String(err?.message || err) });
  }
}
