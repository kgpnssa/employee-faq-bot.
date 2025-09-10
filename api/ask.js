// api/ask.js
import { Client } from "@notionhq/client";

// --- Notion setup ---
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;

// --- Helpers ---
const normalize = (s = "") =>
  (s || "")
    .toString()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase()
    .trim();

const getTitle = (page) =>
  (page?.properties?.Question?.title || [])
    .map((t) => t?.plain_text || "")
    .join(" ")
    .trim();

const getAnswer = (page) => {
  // support rich_text or text
  const from = page?.properties?.Answer?.rich_text ?? page?.properties?.Answer?.text ?? [];
  const txt = (from || []).map((t) => t?.plain_text || "").join(" ").trim();
  return txt || "Sorry, I couldn’t find an answer.";
};

// fetch all rows in the DB (handles pagination)
async function fetchAllRows(dbId) {
  const results = [];
  let cursor = undefined;
  do {
    const resp = await notion.databases.query({
      database_id: dbId,
      start_cursor: cursor,
      page_size: 100,
    });
    results.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return results.map((p) => {
    const title = getTitle(p);
    return {
      title,
      titleNorm: normalize(title),
      answer: getAnswer(p),
    };
  });
}

// in-memory cache (simple and good enough here)
let BANK = null;
let BANK_LOADED_AT = 0;
async function getBank() {
  const maxAgeMs = 1000 * 60 * 5; // 5 minutes
  if (!BANK || Date.now() - BANK_LOADED_AT > maxAgeMs) {
    BANK = await fetchAllRows(DB_ID);
    BANK_LOADED_AT = Date.now();
  }
  return BANK;
}

// --- Main handler ---
export default async function handler(req, res) {
  try {
    // read q from query OR POST body
    let q =
      new URL(req.url, "http://localhost").searchParams.get("q") || "";
    if (!q && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      q = body.q || "";
    }
    q = (q || "").trim();
    if (!q) return res.status(400).json({ error: "Missing q" });

    const bank = await getBank();
    const qNorm = normalize(q);

    // 1) EXACT / STRONG PARTIAL MATCHES FIRST
    // exact normalized equality
    let exact = bank.find((it) => it.titleNorm === qNorm);
    if (exact) return res.status(200).json({ answer: exact.answer });

    // strong partial (title contains full query tokens)
    const qTokens = qNorm.split(/\W+/).filter(Boolean);
    if (qTokens.length) {
      const partial = bank.find((it) =>
        qTokens.every((w) => it.titleNorm.includes(w))
      );
      if (partial) return res.status(200).json({ answer: partial.answer });
    }

    // 2) KEYWORD FALLBACK (metode 2) — safer scoring with a higher threshold
    const KEYWORD_GROUPS = [
      ["rekrutter", "rekruter", "rekrutt", "kontakt", "spillere", "spiller"],
      ["kontor", "adresse", "office", "kontoradresse"],
      ["mission", "vision", "formaal", "formål", "purpose"],
      ["stipendier", "scholarship", "stipendium"],
      ["college", "universitet", "uni"],
    ];
    const KEYWORDS = [...new Set(KEYWORD_GROUPS.flat())];

    const tokens = new Set(
      qNorm.split(/\W+/).filter((w) => w && (w.length > 3 || KEYWORDS.includes(w)))
    );

    let best = null; // { score, item }
    for (const it of bank) {
      const tWords = new Set(it.titleNorm.split(/\W+/));
      let score = 0;

      // exact word overlap is strong → 2 points each
      for (const w of tokens) if (tWords.has(w)) score += 2;

      // synonym group overlap → +1
      for (const grp of KEYWORD_GROUPS) {
        const qHas = grp.some((g) => tokens.has(g));
        const tHas = grp.some((g) => tWords.has(g));
        if (qHas && tHas) score += 1;
      }

      if (!best || score > best.score) best = { score, item: it };
    }

    // Require a minimum score to avoid wrong mappings
    if (best && best.score >= 2) {
      return res.status(200).json({ answer: best.item.answer });
    }

    // 3) Final fallback
    return res
      .status(200)
      .json({ answer: "Sorry, I couldn’t find an answer." });
  } catch (err) {
    console.error("ask.js error:", err);
    return res.status(500).json({ error: "Server error." });
  }
}
