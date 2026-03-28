const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const COPILOT_BASE = 'https://copilot.colosseum.com/api/v1';

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { res.setTimeout(60000); next(); });

// Helper: call Colosseum Copilot API
async function copilot(endpoint, pat) {
  const res = await fetch(`${COPILOT_BASE}/${endpoint}`, {
    headers: { 'Authorization': `Bearer ${pat}`, 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`Copilot API error ${res.status} on ${endpoint}`);
  return res.json();
}

// Helper: call Anthropic API directly
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
  res.json({ status: 'ok', mode: 'direct-api' });
});

app.post('/research', async (req, res) => {
  const { anthropic_key, colosseum_pat: user_pat, project_name, category, country, x_link, description } = req.body;

  if (!anthropic_key) return res.status(400).json({ error: 'Anthropic API key is required' });
  if (!anthropic_key.startsWith('sk-ant-')) return res.status(400).json({ error: 'Invalid Anthropic API key format' });
  if (!project_name) return res.status(400).json({ error: 'Project name is required' });
  if (!description || description.length < 30) return res.status(400).json({ error: 'Description too short' });
  if (!category) return res.status(400).json({ error: 'Category is required' });
  if (!country) return res.status(400).json({ error: 'Country is required' });

  const colosseum_pat = user_pat || process.env.COLOSSEUM_COPILOT_PAT;
  if (!colosseum_pat) return res.status(500).json({ error: 'Colosseum PAT missing' });

  console.log(`[research] Starting: ${project_name}`);

  try {
    // Step 1: Verify PAT
    await copilot('status', colosseum_pat);
    console.log(`[research] PAT verified`);

    // Step 2: Search in parallel
    const query = encodeURIComponent(`${project_name} ${description.slice(0, 200)}`);
    const [clusters, projects, archives] = await Promise.allSettled([
      copilot(`clusters/search?q=${query}&limit=5`, colosseum_pat),
      copilot(`projects/search?q=${query}&limit=10`, colosseum_pat),
      copilot(`archives/search?q=${query}&limit=5`, colosseum_pat),
    ]);

    const clustersData  = clusters.status  === 'fulfilled' ? clusters.value  : { results: [] };
    const projectsData  = projects.status  === 'fulfilled' ? projects.value  : { results: [] };
    const archivesData  = archives.status  === 'fulfilled' ? archives.value  : { results: [] };

    console.log(`[research] Data: clusters=${clustersData?.results?.length || 0} projects=${projectsData?.results?.length || 0} archives=${archivesData?.results?.length || 0}`);

    // Step 3: Ask Claude to analyze and score
    const systemPrompt = `You are an expert crypto/Solana ecosystem analyst. You analyze projects for Colosseum hackathons.
You will be given research data from the Colosseum Copilot corpus and must return ONLY a valid JSON scorecard.
Never include markdown, explanations, or any text outside the JSON object.`;

    const userMessage = `Analyze this project and return a scorecard JSON based on the Colosseum Copilot corpus data below.

PROJECT:
- Name: ${project_name}
- Category: ${category}
- Country: ${country}
- Description: ${description}

COLOSSEUM CORPUS DATA:

## Relevant Clusters (${clustersData?.results?.length || 0} found):
${JSON.stringify(clustersData?.results?.slice(0,5) || [], null, 2)}

## Similar Projects (${projectsData?.results?.length || 0} found):
${JSON.stringify(projectsData?.results?.slice(0,10) || [], null, 2)}

## Archive Sources (${archivesData?.results?.length || 0} found):
${JSON.stringify(archivesData?.results?.slice(0,5) || [], null, 2)}

Based on this data, return ONLY this JSON (no markdown, no explanation):
{
  "score": <number 1-10, weighted average of all dimensions>,
  "novelty": <integer 1-10>,
  "market_timing": <integer 1-10>,
  "competitive_gap": <integer 1-10>,
  "mechanism_design": <integer 1-10>,
  "accelerator_overlap": <integer 1-10>,
  "hackathon_precedent": <integer 1-10>,
  "archive_backing": <integer 1-10>,
  "builder_density": <integer 1-10>,
  "summary": "<2-3 sentences with specific evidence from the corpus data above>",
  "top_competing_projects": ["<name from corpus>", "<name>", "<name>"],
  "key_sources": ["<source from archives>", "<source>"]
}`;

    const claudeResponse = await callClaude(anthropic_key, [{ role: 'user', content: userMessage }], systemPrompt);

    // Extract JSON
    const match = claudeResponse.match(/\{[\s\S]*"score"[\s\S]*\}/);
    if (!match) throw new Error('Could not extract scorecard from Claude response');

    const data = JSON.parse(match[0]);
    const dims = ['novelty','market_timing','competitive_gap','mechanism_design','accelerator_overlap','hackathon_precedent','archive_backing','builder_density'];
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
    if (err.message.includes('Copilot API error 401'))
      return res.status(401).json({ error: 'Invalid Colosseum PAT' });
    if (err.message.includes('rate_limit'))
      return res.status(429).json({ error: 'Rate limit hit — retry in a moment' });
    res.status(500).json({ error: err.message || 'Research failed' });
  }
});

app.listen(PORT, () => {
  console.log(`[server] Running on port ${PORT} (direct API mode — no Claude Code needed)`);
  console.log(`[server] PAT: ${process.env.COLOSSEUM_COPILOT_PAT ? '✓ set' : '✗ missing (users must provide own)'}`);
});
