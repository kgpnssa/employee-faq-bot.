// /api/ask.js
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// Setup clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  try {
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ error: 'No query provided' });
    }

    // 1. Create embedding for the question
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    });

    const [{ embedding }] = embeddingResponse.data;

    // 2. Find the most relevant FAQ in Supabase using vector similarity
    const { data: matches, error } = await supabase.rpc('match_faqs', {
      query_embedding: embedding,
      match_threshold: 0.7,  // adjust threshold
      match_count: 3,        // how many answers to return
    });

    if (error) throw error;

    if (!matches || matches.length === 0) {
      return res.json({ answer: "I couldn’t find anything relevant in the FAQ." });
    }

    // 3. Use the top match to craft an answer
    const context = matches.map(m => m.answer).join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are an assistant answering questions from the Employee Handbook FAQ.' },
        { role: 'user', content: `Question: ${query}\n\nContext: ${context}` }
      ],
      max_tokens: 200,
    });

    const answer = completion.choices[0].message.content;

    res.json({ answer });
  } catch (err) {
    console.error('❌ Error in ask.js:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
}
