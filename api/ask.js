// /api/ask.js
import { Client as NotionClient } from "@notionhq/client";
import OpenAI from "openai";

// ENV
const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// cache in the lambda runtime to avoid re-embedding every request
const EMBED_CACHE = globalThis.__EMBED_CACHE || (globalThis.__EMBED_CACHE = {
  // shape: { items: [{question, answer, vector}], expiresAt: 0 }
  items: null,
  expiresAt: 0
});

const MODEL = "text-embedding-3-small";      // cheap + solid for search
const CACHE_TTL_MS = 5 * 60 * 1000;          // 5 minutes
const MIN_SIMILARITY = 0.70;                 // adjust if you want stricter/looser matches

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function listAllQA() {
  const rows = [];
  let cursor = undefined;
  do {
    const page = await notion.databases.query({
      database_id: DB_ID,
      start_cursor: cursor
    });
    rows.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);

  // Map Notion properties -> question/answer strings.
  // Adjust property names here if your DB names differ.
  const items = rows.map((p) => {
    const props = p.properties || {};
    const q = (props.Question?.title ?? [])
      .map(t => t.plain_text)
      .join(" ")
      .trim();
    const a = (props.Answer?.rich_text ?? [])
      .map(t => t.plain_text)
      .join(" ")
      .trim();
    return { question: q, answer: a };
  }).filter(x => x.question); // must have a question

  return items;
}

async function embedTexts(texts) {
  // OpenAI accepts an array input
  const res = await openai.embeddings.create({
    model: MODEL,
    input: texts
  });
  return res.data.map(d => d.embedding);
}

async function getEmbeddedQA() {
  const now = Date.now();
  if (EMBED_CACHE.items && EMBED_CACHE.expiresAt > now) {
    return EMBED_CACHE.items;
  }

  const qa = await listAllQA();
  // embed all questions in one shot
  const vectors = await embedTexts(qa.map(x => x.question));
  const items = qa.map((x, i) => ({
    question: x.question,
    answer: x.answer,
    vector: vectors[i]
  }));

  EMBED_CACHE.items = items;
  EMBED_CACHE.expiresAt = now + CACHE_TTL_MS;
  return items;
}

export default async function handler(req, res) {
  try {
    // accept GET ?q=... or POST {question: "..."}
    let q =
      (req.method === "POST"
        ? (await new Promise((resolve, reject) => {
            const chunks = [];
            req.on("data", c => chunks.push(c));
            req.on("end", () => {
              try {
                const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
                resolve(body.question || "");
              } catch (e) {
                resolve("");
              }
            });
            req.on("error", reject);
          }))
        : new URL(req.url, "http://localhost").searchParams.get("q")) || "";

    q = (q || "").toString().trim();
    if (!q) {
      res.status(400).json({ error: "Missing question" });
      return;
    }

    const items = await getEmbeddedQA();
    if (!items.length) {
      res.status(200).json({ answer: "I don’t have any Q&A yet in the Notion database." });
      return;
    }

    // embed the user query
    const [qVec] = await embedTexts([q]);

    // find best match
    let best = { idx: -1, score: -1 };
    for (let i = 0; i < items.length; i++) {
      const s = cosine(qVec, items[i].vector);
      if (s > best.score) best = { idx: i, score: s };
    }

    if (best.idx === -1 || best.score < MIN_SIMILARITY) {
      // optional: show top suggestions
      const scored = items
        .map((it, i) => ({ i, s: cosine(qVec, it.vector) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 3)
        .map(({ i, s }) => `${items[i].question} (${s.toFixed(2)})`);

      res.status(200).json({
        answer: "I couldn’t find a confident match in the handbook.",
        suggestions: scored
      });
      return;
    }

    const match = items[best.idx];
    res.status(200).json({
      answer: match.answer || "(blank)",
      matched_question: match.question,
      similarity: Number(best.score.toFixed(3))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error while answering." });
  }
}
