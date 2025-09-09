// /api/ask.js
import { Client } from "@notionhq/client";

// ---------- Config ----------
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = "text-embedding-3-small"; // cheap & good
const TOP_K = 1;        // how many nearest neighbors to consider
const MIN_SIM = 0.72;   // similarity floor to accept a match (0..1)

// ---------- Small helpers ----------
const title = (p) =>
  (p?.Question?.title || []).map((t) => t.plain_text).join(" ").trim();
const answer = (p) =>
  (p?.Answer?.rich_text || []).map((t) => t.plain_text).join(" ").trim();

const norm = (s = "") =>
  s.toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    dot += x * y; na += x * x; nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
};

async function embed(text) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embedding error: ${res.status} ${err}`);
  }
  const data = await res.json();
  return data.data[0].embedding;
}

async function fetchAllRows() {
  const rows = [];
  let cursor = undefined;
  do {
    const page = await notion.databases.query({
      database_id: DB_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    rows.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return rows.map((r) => ({
    id: r.id,
    q: title(r.properties),
    a: answer(r.properties),
  })).filter((r) => r.q && r.a);
}

// ---------- In-memory cache (per serverless cold start) ----------
let CACHE = {
  rows: null,               // [{id, q, a}]
  embeddings: null,         // Float32Array[]
  qnorm: null,              // normalized question strings
  loadedAt: 0,
};

async function ensureCache() {
  if (CACHE.rows && CACHE.embeddings && Date.now() - CACHE.loadedAt < 1000 * 60 * 10) {
    return CACHE;
  }
  const rows = await fetchAllRows();

  // Precompute embeddings (batched lightly)
  const qnorm = rows.map((r) => norm(r.q));
  const allEmbeds = [];
  for (let i = 0; i < rows.length; i += 32) {
    const chunk = qnorm.slice(i, i + 32);
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: chunk }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Batch embedding error: ${res.status} ${err}`);
    }
    const data = await res.json();
    data.data.forEach((d) => allEmbeds.push(d.embedding));
  }

  CACHE = {
    rows,
    embeddings: allEmbeds,
    qnorm,
    loadedAt: Date.now(),
  };
  return CACHE;
}

// ---------- Handler ----------
export default async function handler(req, res) {
  try {
    // 1) read q from GET ?q= or POST JSON {question}
    let q = new URL(req.url, "http://localhost").searchParams.get("q");
    if (!q && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      q = body?.question || body?.q || "";
    }
    q = (q || "").toString().trim();
    if (!q) return res.status(400).json({ error: "Missing q" });

    // 2) Exact / partial title match first (fast)
    const exact = await notion.databases.query({
      database_id: DB_ID,
      filter: {
        property: "Question",
        title: { contains: q }, // "contains" enables partial keyword hits
      },
      page_size: 1,
    });
    if (exact.results?.length) {
      return res.status(200).json({
        answer: answer(exact.results[0].properties),
        matched: title(exact.results[0].properties),
        via: "exact",
      });
    }

    // 3) Semantic fallback (embeddings)
    const { rows, embeddings, qnorm } = await ensureCache();
    if (!rows.length) return res.status(200).json({ answer: "No entries yet." });

    const qEmbed = await embed(norm(q));

    let bestIdx = -1, bestSim = -1;
    for (let i = 0; i < embeddings.length; i++) {
      const sim = cosine(qEmbed, embeddings[i]);
      if (sim > bestSim) { bestSim = sim; bestIdx = i; }
    }

    if (bestIdx >= 0 && bestSim >= MIN_SIM) {
      return res.status(200).json({
        answer: rows[bestIdx].a,
        matched: rows[bestIdx].q,
        similarity: Number(bestSim.toFixed(3)),
        via: "semantic",
      });
    }

    // 4) Nothing strong enough
    return res.status(200).json({
      answer: "Sorry, I couldn’t find a good match for that yet.",
      via: "none",
    });

  } catch (err) {
    console.error(err);
    const msg = err?.message || "Server error";
    if (/unauthorized|invalid api key/i.test(msg)) {
      return res.status(401).json({ error: "OpenAI API key is invalid or missing." });
    }
    if (/object_not_found|could not find database/i.test(msg)) {
      return res.status(400).json({
        error: "Notion DB not found or not shared with the integration.",
      });
    }
    return res.status(500).json({ error: msg });
  }
}
