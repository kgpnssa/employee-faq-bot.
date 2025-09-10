// /pages/api/ask.js

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// --- Environment checks ---
const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY'];
for (const k of required) {
  if (!process.env[k]) {
    console.error(`[ask] Missing required env var: ${k}`);
  }
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Helpers ---
const normalize = (s = '') => s.toLowerCase().trim();

function keywordFallback(q) {
  const t = normalize(q);
  if (
    (t.includes('kontakt') || t.includes('kontaktinfo') || t.includes('kontor') || t.includes('adresse')) ||
    (t.includes('contact') || t.includes('office') || t.includes('address'))
  ) {
    return 'Kontoradresse: (indsæt jeres adresse). Email: (indsæt), Telefon: (indsæt).';
  }
  if (
    t.includes('rekrutter') || t.includes('rekruttér') || t.includes('rekruttering') ||
    t.includes('recruit') || t.includes('new players') || t.includes('spillere')
  ) {
    return 'Til rekruttering bruger vi primært Instagram/X i DE/SE og Facebook/Messenger i DK/NO. Start med en venlig intro, hvem du er, og hvorfor spilleren passer til NSSA.';
  }
  return null;
}

function toContext(matches, max = 5) {
  return matches.slice(0, max).map(m => `Q: ${m.question}\nA: ${m.answer}`).join('\n\n');
}

function maybeDirectAnswer(matches, hi = 0.92) {
  if (!matches?.length) return null;
  const best = matches[0];
  if (best.similarity >= hi) return best.answer?.trim();
  return null;
}

// --- Main API handler ---
export default async function handler(req, res) {
  try {
    const q =
      req.method === 'GET'
        ? (req.query.q || '').toString()
        : (req.body?.query || req.body?.q || '').toString();

    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Missing query. Provide ?q=... or { query: ... }' });
    }

    // 0) Keyword fallback
    const kw = keywordFallback(q);
    if (kw) return res.status(200).json({ answer: kw, source: 'keyword' });

    // 1) Create embedding for user query
    const embedResp = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: q
    });
    const userEmbedding = embedResp.data?.[0]?.embedding;
    if (!userEmbedding) throw new Error('No embedding returned from OpenAI');

    // 2) Call match_faqs SQL function in Supabase
    const { data: matches, error } = await supabase.rpc('match_faqs', {
      query_embedding: userEmbedding,
      match_count: 8
    });
    if (error) throw error;

    const MIN_SIM = 0.78;
    const top = (matches || []).filter(m => (m?.similarity ?? 0) >= MIN_SIM);

    // 3) If super confident, return direct answer
    const direct = maybeDirectAnswer(top, 0.92);
    if (direct) {
      return res.status(200).json({
        answer: direct,
        source: 'direct',
        top: top.slice(0, 3).map(({ id, question, similarity }) => ({ id, question, similarity }))
      });
    }

    // 4) Build context for GPT
    const context = toContext(top, 5);
    if (!context) {
      return res.status(200).json({
        answer: `Jeg fandt ikke et klart svar i håndbogen på: "${q}". 
Prøv at omformulere spørgsmålet, eller spørg mere specifikt (fx emne + land).`,
        source: 'no_context'
      });
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'Du er en hjælpsom assistent for NSSA. Svar KUN ud fra konteksten. Hvis du er i tvivl, sig ærligt, at du ikke ved det.'
        },
        {
          role: 'user',
          content:
            `Kontekst:\n${context}\n\n` +
            `Spørgsmål: ${q}\n\n` +
            `Svar venligst på dansk, kort og præcist.`
        }
      ],
      temperature: 0.2,
      max_tokens: 400
    });

    const answer = completion.choices?.[0]?.message?.content?.trim() || 'Jeg er ikke sikker.';
    return res.status(200).json({
      answer,
      source: 'rag',
      top: top.slice(0, 5).map(({ id, question, similarity }) => ({ id, question, similarity }))
    });
  } catch (err) {
    console.error('[ask] Error:', err);
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
}
