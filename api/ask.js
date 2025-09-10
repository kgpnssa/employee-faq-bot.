// api/ask.js
import { Client } from "@notionhq/client";

// --- simple normalize + levenshtein for fuzzy ---
const normalize = (s="") =>
  s.toString().normalize("NFKD").replace(/\p{Diacritic}/gu,"").toLowerCase().trim();

const levenshtein = (a, b) => {
  a = normalize(a); b = normalize(b);
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({length:m+1}, (_,i)=>[i, ...Array(n).fill(0)]);
  for (let j=1; j<=n; j++) dp[0][j] = j;
  for (let i=1; i<=m; i++) {
    for (let j=1; j<=n; j++) {
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + cost);
    }
  }
  return dp[m][n];
};

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;

const getRows = async () => {
  const out = [];
  let cursor = undefined;
  do {
    const resp = await notion.databases.query({
      database_id: DB_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    resp.results.forEach(p => {
      const title = (p.properties?.Question?.title || [])
        .map(t => t?.plain_text || "").join(" ").trim();
      const answer = (p.properties?.Answer?.rich_text || [])
        .map(t => t?.plain_text || "").join(" ").trim();
      if (title && answer) out.push({ id: p.id, title, answer });
    });
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return out;
};

export default async function handler(req, res) {
  try {
    // 1) Læs q fra query eller body
    let q = new URL(req.url, "http://localhost").searchParams.get("q");
    if (!q && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      q = body.question || "";
    }
    if (!q) return res.status(400).json({ error: "Missing q" });

    // 2) Hent alle rækker fra Notion
    const bank = await getRows();
    if (!bank.length) return res.status(500).json({ error: "Empty database" });

    // --- Quick exact title contains (hurtigt “starts-with/contains”) ---
    const qNorm = normalize(q);
    const quick = bank.find(it => {
      const t = normalize(it.title);
      return t.includes(qNorm) || qNorm.includes(t);
    });
    if (quick) return res.status(200).json({ answer: quick.answer });

    // --- (Valgfri) Embeddings, hvis OPENAI_API_KEY findes ---
    const useEmb = !!process.env.OPENAI_API_KEY;
    if (useEmb) {
      // fetch er global i Vercel edge/node 18+
      const embed = async (text) => {
        const r = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            input: text,
            model: "text-embedding-3-small"
          })
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error?.message || "Embedding failed");
        return j.data[0].embedding;
      };
      const dot = (a,b) => a.reduce((s,v,i)=>s+v*b[i],0);
      const mag = (a) => Math.sqrt(a.reduce((s,v)=>s+v*v,0));
      const cosSim = (a,b) => dot(a,b)/(mag(a)*mag(b) || 1);

      // embed bank (cache i memory pr. cold start)
      const all = [];
      for (const it of bank) {
        const e = await embed(it.title);
        all.push({ ...it, embedding: e });
      }
      const qe = await embed(q);
      let best = { score:-1, item:null };
      for (const it of all) {
        const s = cosSim(qe, it.embedding);
        if (s > best.score) best = { score:s, item:it };
      }
      // Tærskel – 0.27 plejer at være fint til korte titler
      if (best.item && best.score >= 0.27) {
        return res.status(200).json({ answer: best.item.answer });
      }
    }

    // --- Keyword fallback (DK/NO/EN synonymer) ---
    const ql = qNorm;
    const contactHit =
      (ql.includes("kontakt") || ql.includes("skriv") || ql.includes("besked") || ql.includes("message") ) &&
      bank.find(it => normalize(it.title).includes("kontakt"));
    if (contactHit) return res.status(200).json({ answer: contactHit.answer });

    const recruitHit =
      (ql.includes("rekrut") || ql.includes("recruit") || ql.includes("spill") || ql.includes("spiller")) &&
      bank.find(it => /rekrut|recruit/i.test(it.title));
    if (recruitHit) return res.status(200).json({ answer: recruitHit.answer });

    // --- Fuzzy backup ---
    let best = { dist: Infinity, item: null };
    for (const it of bank) {
      const d = levenshtein(q, it.title);
      if (d < best.dist) best = { dist:d, item:it };
    }
    const maxDist = Math.max(2, Math.ceil(q.length * 0.35)); // tolerant for korte spørgsmål
    if (best.item && best.dist <= maxDist) {
      return res.status(200).json({ answer: best.item.answer });
    }

    // Intet fundet
    return res.status(200).json({ answer: "Sorry, I couldn't find an answer." });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
