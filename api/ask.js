// /api/ask.js
import { Client } from "@notionhq/client";

// --- ENV ---
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID   = process.env.NOTION_DB_ID;

// --- Helpers ---
const normalize = (s = "") =>
  s.toString()
   .toLowerCase()
   .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // fjern diakritik
   .replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa")
   .replace(/\s+/g, " ")
   .trim();

const titleFrom = (props = {}) =>
  (props?.Question?.title ?? props?.Question?.rich_text ?? [])
    .map(t => t.plain_text).join(" ").trim();

const answerFrom = (props = {}) =>
  (props?.Answer?.rich_text ?? [])
    .map(t => t.plain_text).join(" ").trim();

// --- HTTP handler ---
export default async function handler(req, res) {
  try {
    // 1) tag q fra ?q= eller POST-body
    let q = new URL(req.url, "http://localhost").searchParams.get("q");
    if (!q && req.method === "POST") {
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        q = body.q;
      } catch {}
    }
    if (!q) return res.status(400).json({ error: "Missing q" });
    const qNorm = normalize(q);

    // 2) hent hele databasen (små DBs = fint; vil du optimere kan du cache)
    const rows = [];
    let cursor = undefined;
    do {
      const resp = await notion.databases.query({
        database_id: DB_ID,
        start_cursor: cursor,
        page_size: 100,
      });
      rows.push(...resp.results);
      cursor = resp.has_more ? resp.next_cursor : undefined;
    } while (cursor);

    // 3) byg bank [{title, answer}]
    const bank = rows.map(r => ({
      title: titleFrom(r.properties),
      answer: answerFrom(r.properties),
    })).filter(x => x.title && x.answer);

    // 4) exact match først
    const exact = bank.find(it => normalize(it.title) === qNorm);
    if (exact) return res.status(200).json({ answer: exact.answer });

    // 5) PARTIAL / KEYWORD fallback (METODE 2)
    //    a) simpel partial: t inde i q eller q inde i t
    let partialHit = bank.find(it => {
      const t = normalize(it.title);
      return t.includes(qNorm) || qNorm.includes(t);
    });

    //    b) hvis ikke, så keyword-score (små synonymgrupper)
    if (!partialHit) {
      const KEYWORD_GROUPS = [
        ["rekrutter", "rekruter", "rekrutt", "kontakt", "spillere", "spiller"],
        ["kontor", "adresse", "office", "kontoradresse"],
        ["mission", "vision", "formaal", "formål", "purpose"],
        ["stipendier", "scholarship", "stipendium"],
        ["college", "universitet", "uni"],
      ];
      const KEYWORDS = [...new Set(KEYWORD_GROUPS.flat())];

      const tokens = new Set(
        qNorm.split(/\W+/).filter(w => w && (w.length > 3 || KEYWORDS.includes(w)))
      );

      let best = null; // { score, item }
      for (const it of bank) {
        const tWords = new Set(normalize(it.title).split(/\W+/));
        let score = 0;

        // overlap i ord
        for (const w of tokens) if (tWords.has(w)) score += 1;

        // lille bonus hvis de deler en gruppe (synonymer)
        for (const grp of KEYWORD_GROUPS) {
          const qHas = grp.some(g => tokens.has(g));
          const tHas = grp.some(g => tWords.has(g));
          if (qHas && tHas) score += 1;
        }

        if (!best || score > best.score) best = { score, item: it };
      }

      if (best && best.score >= 1) partialHit = best.item; // kræv min-score
    }

    if (partialHit) return res.status(200).json({ answer: partialHit.answer });

    // 6) fallback
    return res.status(200).json({ answer: "Sorry, I couldn't find an answer." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
