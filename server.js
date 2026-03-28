const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const COPILOT_BASE = 'https://copilot.colosseum.com/api/v1';

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => { res.setTimeout(120000); next(); });

// GET request to Colosseum API
async function copilotGet(endpoint, pat) {
  const res = await fetch(`${COPILOT_BASE}/${endpoint}`, {
    headers: { 'Authorization': `Bearer ${pat}` }
  });
  if (!res.ok) throw new Error(`Copilot GET error ${res.status} on ${endpoint}`);
  return res.json();
}

// POST request to Colosseum API
async function copilotPost(endpoint, pat, body) {
  const res = await fetch(`${COPILOT_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Copilot POST error ${res.status} on ${endpoint}`);
  return res.json();
}

// Call Anthropic API directly
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
    // Step 1: Auth check
    await copilotGet('status', pat);
    console.log(`[research] Auth OK`);

    // Step 2: Run all searches in parallel using CORRECT endpoints
    const query = `${project_name} ${description}`;

    const [
      projectsGeneral,
      projectsAccelerator,
      projectsWinners,
      archivesGeneral,
      archivesCategory,
      filters,
    ] = await Promise.allSettled([
      // General project search - full description
      copilotPost('search/projects', pat, {
        query,
        limit: 20,
      }),
      // Accelerator-only projects (for accelerator_overlap dimension)
      copilotPost('search/projects', pat, {
        query,
        limit: 10,
        filters: { acceleratorOnly: true },
      }),
      // Winners only (for hackathon_precedent dimension)
      copilotPost('search/projects', pat, {
        query,
        limit: 10,
        filters: { winnersOnly: true },
      }),
      // Archive search - full description
      copilotPost('search/archives', pat, {
        query,
        limit: 10,
      }),
      // Archive search - by category
      copilotPost('search/archives', pat, {
        query: `${category} ${description}`,
        limit: 10,
      }),
      // Get available filters + hackathon chronology
      copilotGet('filters', pat),
    ]);

    function getVal(settled) {
      return settled.status === 'fulfilled' ? settled.value : null;
    }

    const projectsData       = getVal(projectsGeneral);
    const acceleratorData    = getVal(projectsAccelerator);
    const winnersData        = getVal(projectsWinners);
    const archivesData       = getVal(archivesGeneral);
    const archivesCatData    = getVal(archivesCategory);
    const filtersData        = getVal(filters);

    console.log(`[research] Results: projects=${projectsData?.results?.length || 0} accelerator=${acceleratorData?.results?.length || 0} winners=${winnersData?.results?.length || 0} archives=${archivesData?.results?.length || 0}`);

    // Step 3: Send to Claude for scoring
    const systemPrompt = `You are an expert crypto/Solana ecosystem analyst for Colosseum hackathons.
Analyze the provided Colosseum Copilot corpus data and return ONLY a valid JSON scorecard.
No markdown, no explanation, nothing outside the JSON.`;

    const userMessage = `Analyze this project using the Colosseum Copilot corpus data below.

PROJECT:
- Name: ${project_name}
- Category: ${category}
- Country: ${country}
- Description: ${description}

═══ COLOSSEUM CORPUS DATA ═══

## Similar Projects (semantic search, ${projectsData?.results?.length || 0} results):
${JSON.stringify(projectsData?.results || [], null, 2)}

## Accelerator Portfolio Overlap (${acceleratorData?.results?.length || 0} results):
${JSON.stringify(acceleratorData?.results || [], null, 2)}

## Hackathon Winners (${winnersData?.results?.length || 0} results):
${JSON.stringify(winnersData?.results || [], null, 2)}

## Archive Sources - General (${archivesData?.results?.length || 0} results):
${JSON.stringify(archivesData?.results || [], null, 2)}

## Archive Sources - Category (${archivesCatData?.results?.length || 0} results):
${JSON.stringify(archivesCatData?.results || [], null, 2)}

## Available Hackathons (chronological):
${JSON.stringify(filtersData?.hackathons || [], null, 2)}

═══ SCORING GUIDE ═══

- novelty: How unique vs all similar projects found?
- market_timing: Does archive data support strong current demand?
- competitive_gap: Room to win given competing projects?
- mechanism_design: Sophistication of core mechanism?
- accelerator_overlap: Overlap with accelerator portfolio projects?
- hackathon_precedent: Similar projects in hackathon history?
- archive_backing: Archive sources supporting this market?
- builder_density: How crowded is this space? (high = low score)

Return ONLY this JSON:
{
  "score": <weighted average 1-10>,
  "novelty": <1-10>,
  "market_timing": <1-10>,
  "competitive_gap": <1-10>,
  "mechanism_design": <1-10>,
  "accelerator_overlap": <1-10>,
  "hackathon_precedent": <1-10>,
  "archive_backing": <1-10>,
  "builder_density": <1-10>,
  "summary": "<3-4 sentences citing specific project slugs and archive titles from corpus>",
  "top_competing_projects": ["<real slug from corpus>", "<real slug>", "<real slug>"],
  "key_sources": ["<real archive title>", "<real archive title>"]
}`;

    const claudeResponse = await callClaude(
      anthropic_key,
      [{ role: 'user', content: userMessage }],
      systemPrompt
    );

    const match = claudeResponse.match(/\{[\s\S]*"score"[\s\S]*\}/);
    if (!match) throw new Error('Could not extract scorecard from response');

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
    if (err.message.includes('rate_limit'))
      return res.status(429).json({ error: 'Rate limit hit — retry in a moment' });
    res.status(500).json({ error: err.message || 'Research failed' });
  }
});

app.listen(PORT, () => {
  console.log(`[server] Running on port ${PORT}`);
  console.log(`[server] PAT: ${process.env.COLOSSEUM_COPILOT_PAT ? '✓ set' : '✗ missing'}`);
});
