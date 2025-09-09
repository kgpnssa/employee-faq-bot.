import { Client } from '@notionhq/client';
import OpenAI from 'openai';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const dbId = process.env.NOTION_DB_ID;
const openaiKey = process.env.OPENAI_API_KEY;
const adminRefreshKey = process.env.ADMIN_REFRESH_KEY || '';

const useEmbeddings = Boolean(openaiKey);
const openai = useEmbeddings ? new OpenAI({ apiKey: openaiKey }) : null;

let CACHE = { items: [], ts: 0 };

// Fetch FAQ items
async function fetchAllFAQ() {
  const items = [];
  const resp = await notion.databases.query({ database_id: dbId });
  for (const page of resp.results) {
    const props = page.properties || {};
    const q = (props.Question?.title || []).map(t => t.plain_text).join(' ');
    const a = (props.Answer?.rich_text || []).map(t => t.plain_text).join(' ');
    if (q && a) items.push({ id: page.id, question: q, answer: a });
  }
  return items;
}

// API entry
export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname || '/';

  if (path.endsWith('/api/ask')) {
    const q = url.searchParams.get('q');
    if (!q) {
      res.statusCode = 400;
      res.json({ error: 'Missing q' });
      return;
    }
    const items = await fetchAllFAQ();
    const best = items.find(it => it.question.toLowerCase().includes(q.toLowerCase())) || null;
    res.statusCode = 200;
    res.json(best || { answer: 'No match found' });
    return;
  }

  res.statusCode = 200;
  res.end('FAQ bot running!');
}
