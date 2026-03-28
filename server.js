const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const COPILOT_BASE = 'https://copilot.colosseum.com/api/v1';

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => { res.setTimeout(120000); next(); });

async function copilotGet(endpoint, pat) {
  const res = await fetch(`${COPILOT_BASE}/${endpoint}`, {
    headers: { 'Authorization': `Bearer ${pat}` }
  });
  if (!res.ok) throw new Error(`Copilot GET error ${res.status} on ${endpoint}`);
  return res.json();
}

async function copilotPost(endpoint, pat, body) {
  const res = await fetch(`${COPILOT_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Copilot POST error ${res.status} on ${endpoint}`);
  return res.json();
}

async function callClaude(apiKey, messages, systemPrompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      temperature: 0,
      system: systemPrompt,
      messages,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Anthropic API error ${res.status}`);
  }
  const data = await res.json();
  return data.content[0].text;
}

function trimProject(p) {
  return {
    name: p.name || p.title,
    slug: p.slug,
    description: (p.description || p.summary || '').slice(0, 150),
    hackathon: p.hackathon?.slug || p.hackathon,
    tags: p.tags?.slice(0, 5),
    score: p.score || p.similarity,
  };
}

function trimArchive(a) {
  return {
    title: a.title,
    summary: (a.summary || a.content || '').slice(0, 200),
    source: a.source || a.url,
    date: a.date || a.publishedAt,
  };
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', mode: 'direct-api-v2' });
});

app.post('/research', async (req, res) => {
  const { anthropic_key, colosseum_pat: user_pat, project_name, category, country, x_link, description } = req.body;

  if (!anthropic_key) return res.status(400).json({ error: 'Anthropic API key is required' });
  if (!anthropic_key.startsWith('sk-ant-')) return res.status(400).json({ error: 'Invalid Anthropic API key format' });
  if (!project_name) return res.status(400).json({ error: 'Project name is required' });
  if (!description || description.length < 30) return res.status(400).json({ error: 'Description too short' });
  if (!category) return res.status(400).json({ error: 'Category is required' });
  if (!country) return res.status(400).json({ error: 'Country is required' });

  const pat = user_pat || process.env.COLOSSEUM_COPILOT_PAT;
  if (!pat) return res.status(500).json({ error: 'Colosseum PAT missing' });

  console.log(`[research] Starting: ${project_name}`);

  try {
    await copilotGet('status', pat);

    const query = `${project_name} ${description}`;

    const [
      projectsGeneral,
      projectsAccelerator,
      projectsWinners,
      archivesGeneral,
      archivesCategory,
    ] = await Promise.allSettled([
      copilotPost('search/projects', pat, { query, limit: 15 }),
      copilotPost('search/projects', pat, { query, limit: 8, filters: { acceleratorOnly: true } }),
      copilotPost('search/projects', pat, { query, limit: 8, filters: { winnersOnly: true } }),
      copilotPost('search/archives', pat, { query, limit: 8 }),
      copilotPost('search/archives', pat, { query: `${category} ${project_name}`, limit: 5 }),
    ]);

    function getResults(settled) {
      return settled.status === 'fulfilled' ? (settled.value?.results || []) : [];
    }

    const projects    = getResults(projectsGeneral).map(trimProject);
    const accelerator = getResults(projectsAccelerator).map(trimProject);
    const winners     = getResults(projectsWinners).map(trimProject);
    const archives    = [...getResults(archivesGeneral), ...getResults(archivesCategory)]
                         .slice(0, 10).map(trimArchive);

    console.log(`[research] Data: projects=${projects.length} accelerator=${accelerator.length} winners=${winners.length} archives=${archives.length}`);

    const systemPrompt = `You are an expert crypto/Solana ecosystem analyst for Colosseum hackathons.
Analyze the Colosseum Copilot corpus data and return ONLY a valid JSON scorecard. No markdown, no text outside the JSON.`;

    const userMessage = `Score this project using Colosseum corpus data.

PROJECT: ${project_name} | ${category} | ${country}
DESCRIPTION: ${description}

SIMILAR PROJECTS (${projects.length}):
${JSON.stringify(projects)}

ACCELERATOR PORTFOLIO (${accelerator.length}):
${JSON.stringify(accelerator)}

HACKATHON WINNERS (${winners.length}):
${JSON.stringify(winners)}

ARCHIVE SOURCES (${archives.length}):
${JSON.stringify(archives)}

Return ONLY this JSON:
{
  "score": <weighted average>,
  "novelty": <1-10>,
  "market_timing": <1-10>,
  "competitive_gap": <1-10>,
  "mechanism_design": <1-10>,
  "accelerator_overlap": <1-10>,
  "hackathon_precedent": <1-10>,
  "archive_backing": <1-10>,
  "builder_density": <1-10>,
  "summary": "<3-4 sentences with specific project names/slugs and archive titles from data above>",
  "top_competing_projects": ["<slug from data>", "<slug>", "<slug>"],
  "key_sources": ["<archive title>", "<archive title>"]
}`;

    const claudeResponse = await callClaude(
      anthropic_key,
      [{ role: 'user', content: userMessage }],
      systemPrompt
    );

    const match = claudeResponse.match(/\{[\s\S]*"score"[\s\S]*\}/);
    if (!match) throw new Error('Could not extract scorecard — try again');

    const data = JSON.parse(match[0]);
    const dims = ['novelty','market_timing','competitive_gap','mechanism_design',
      'accelerator_overlap','hackathon_precedent','archive_backing','builder_density'];
    dims.forEach(f => { data[f] = Math.min(10, Math.max(1, Math.round(Number(data[f])))); });
    data.score = Math.round((dims.reduce((s,f) => s + data[f], 0) / dims.length) * 4) / 4;
    data.project_name = project_name;
    data.category = category;
    data.country = country;
    data.x_link = x_link || null;

    console.log(`[research] Done: ${project_name} → ${data.score}/10`);
    res.json({ success: true, scorecard: data });

  } catch (err) {
    console.error(`[research] Error: ${err.message}`);
    if (err.message.includes('401') || err.message.includes('invalid_api_key'))
      return res.status(401).json({ error: 'Invalid Anthropic API key' });
    if (err.message.includes('Copilot') && err.message.includes('401'))
      return res.status(401).json({ error: 'Invalid Colosseum PAT' });
    if (err.message.includes('rate_limit') || err.message.includes('rate limit'))
      return res.status(429).json({ error: 'Rate limit hit — wait 1 minute and retry' });
    res.status(500).json({ error: err.message || 'Research failed' });
  }
});

app.listen(PORT, () => {
  console.log(`[server] Running on port ${PORT}`);
  console.log(`[server] PAT: ${process.env.COLOSSEUM_COPILOT_PAT ? '✓ set' : '✗ missing'}`);
});
