// /api/ask.js
// Node/Serverless function for Vercel

import { createClient } from '@supabase/supabase-js';

// ---- env (set in Vercel) ----
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
// OPENAI_API_KEY

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false },
  }
);

// quick util
const ok = (res, data) => res.status(200).json(data);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// Normalize/clean query a little
const normalize = (s = '') =>
  (s || '')
    .toString()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

/**
 * Get OpenAI embedding
 */
async function embed(text) {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small', // 1536-dim
      input: text,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`OpenAI embeddings failed: ${resp.status} ${body}`);
  }

  const json = await resp.json();
  return json.data[0].embedding;
}

/**
 * Ask handler
 * - GET /api/ask?q=...
 * - POST { q: "..." }
 */
export default async function handler(req, res) {
// ---- debug: env + input ---------------------------------
const q = (req.query?.q ?? req.body?.q ?? "").toString();
console.log("[ask] start", {
  method: req.method,
  qLen: q.length,
  SUPABASE_URL: process.env.SUPABASE_URL,
  hasSRK: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  hasOPENAI: !!process.env.OPENAI_API_KEY,
});

// optional: quick Supabase ping to see if we can reach DB
try {
  const { data: ping, error: pingErr } = await supabase
    .from("faqs")
    .select("id")
    .limit(1);
  console.log("[ask] supabase ping", {
    ok: !pingErr,
    err: pingErr?.message,
    count: ping?.length ?? 0,
  });
} catch (e) {
  console.log("[ask] supabase ping threw", e?.message);
}

  try {
    // CORS (optional, safe default)
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).end();
    }
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Read question
    const q =
      req.method === 'POST'
        ? (req.body?.q ?? req.body?.question ?? '')
        : (req.query?.q ?? '');

    const question = normalize(q);
    if (!question) return bad(res, 'Missing q');

    // 1) Create query embedding
    const queryEmbedding = await embed(question);

    // 2) Call RPC to match against faqs (you create this function once; see note below)
    // tweak these if you want
    const MATCH_COUNT = 5;
    const MATCH_THRESHOLD = 0.22; // lower = more results

    const { data: matches, error } = await supabase.rpc('match_faqs', {
      query_embedding: queryEmbedding,
      match_threshold: MATCH_THRESHOLD,
      match_count: MATCH_COUNT,
    });

    if (error) throw error;

    if (!matches || matches.length === 0) {
      return ok(res, { answer: "Sorry, I couldn't find an answer." });
    }

    // top hit
    const top = matches[0]; // { id, question, answer, score }
    if (!top?.answer) {
      return ok(res, { answer: "Sorry, I couldn't find an answer." });
    }

    // Return best answer; include meta if you like
    return ok(res, {
      answer: top.answer,
      matched_question: top.question,
      score: top.score,
    });
  } catch (err) {
    console.error('[ask] error:', err);
    return bad(res, 'Server error', 500);
  }
}
