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

// Trim to essential fields only to manage token count
function trimProject(p) {
  return {
    name: p.name || p.title,
    slug: p.slug,
    description: (p.description || p.summary || '').slice(0, 120),
    hackathon: p.hackathon?.slug || p.hackathon,
    tags: (p.tags || []).slice(0, 4),
    similarity: p.score || p.similarity,
  };
}

function trimArchive(a) {
  return {
    title: a.title,
    summary: (a.summary || a.content || '').slice(0, 150),
    source: a.source || a.url,
    date: a.date || a.publishedAt,
  };
}

function settled(r) {
  return r.status === 'fulfilled' ? (r.value?.results || r.value || []) : [];
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', mode: 'deep-research-v1' });
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

  console.log(`[research] Starting deep research: ${project_name}`);

  try {
    // STEP 1 — Auth preflight (required per SKILL.md)
    await copilotGet('status', pat);
    console.log(`[research] Step 1: Auth OK`);

    // Full query = project name + full description (no truncation)
    const fullQuery = `${project_name} ${description}`;
    const categoryQuery = `${category} ${description}`;
    const nameQuery = project_name;

    // STEP 2 — Parallel searches following SKILL.md deep research workflow:
    // - search/projects: general, acceleratorOnly, winnersOnly, by name
    // - search/archives: by full description, by category
    // - /filters: hackathon chronology
    // - /analyze: hackathon distribution for this category
    const [
      // Step 2a: Similar projects (general semantic search — full description)
      s1_projects_general,
      // Step 2b: Accelerator portfolio overlap (SKILL.md: required for evaluative queries)
      s2_projects_accelerator,
      // Step 2c: Hackathon winners only (precedent check)
      s3_projects_winners,
      // Step 2d: Search by project name alone (entity coverage check per SKILL.md)
      s4_projects_by_name,
      // Step 2e: Archives — general (required per SKILL.md archive integration rule)
      s5_archives_general,
      // Step 2f: Archives — by category (conceptual framing)
      s6_archives_category,
      // Step 2g: Hackathon chronology + available filters
      s7_filters,
      // Step 2h: Analyze hackathon distribution for this category
      s8_analyze,
    ] = await Promise.allSettled([
      copilotPost('search/projects', pat, { query: fullQuery, limit: 15 }),
      copilotPost('search/projects', pat, { query: fullQuery, limit: 10, filters: { acceleratorOnly: true } }),
      copilotPost('search/projects', pat, { query: fullQuery, limit: 10, filters: { winnersOnly: true } }),
      copilotPost('search/projects', pat, { query: nameQuery, limit: 5 }),
      copilotPost('search/archives', pat, { query: fullQuery, limit: 8 }),
      copilotPost('search/archives', pat, { query: categoryQuery, limit: 5 }),
      copilotGet('filters', pat),
      copilotPost('analyze', pat, { query: fullQuery, hackathon: 'all' }).catch(() => null),
    ]);

    // Extract and trim all results
    const projects_general    = settled(s1_projects_general).map(trimProject);
    const projects_accelerator= settled(s2_projects_accelerator).map(trimProject);
    const projects_winners    = settled(s3_projects_winners).map(trimProject);
    const projects_by_name    = settled(s4_projects_by_name).map(trimProject);
    const archives_general    = settled(s5_archives_general).map(trimArchive);
    const archives_category   = settled(s6_archives_category).map(trimArchive);
    const filters             = s7_filters.status === 'fulfilled' ? s7_filters.value : null;
    const analyze             = s8_analyze.status === 'fulfilled' ? s8_analyze.value : null;

    // Deduplicate projects by slug
    const allProjectSlugs = new Set();
    function dedupe(arr) {
      return arr.filter(p => {
        if (!p.slug || allProjectSlugs.has(p.slug)) return true; // keep if no slug
        allProjectSlugs.add(p.slug);
        return true;
      });
    }

    console.log(`[research] Step 2 complete: general=${projects_general.length} accelerator=${projects_accelerator.length} winners=${projects_winners.length} name=${projects_by_name.length} archives=${archives_general.length + archives_category.length}`);

    // STEP 3 — Send all corpus data to Claude for scoring
    const systemPrompt = `You are an expert Colosseum hackathon analyst. 
You have received data from all 8 steps of the Colosseum Copilot deep research workflow.
Analyze ALL the data carefully, then return ONLY a valid JSON scorecard.
No markdown, no explanation, no text outside the JSON object.`;

    const userMessage = `Deep research scorecard for this project:

PROJECT: ${project_name}
CATEGORY: ${category}
COUNTRY: ${country}
DESCRIPTION: ${description}

══ STEP 1: SIMILAR PROJECTS — semantic search (${projects_general.length} results) ══
${JSON.stringify(projects_general)}

══ STEP 2: ACCELERATOR PORTFOLIO — projects that won Colosseum accelerator (${projects_accelerator.length} results) ══
${JSON.stringify(projects_accelerator)}

══ STEP 3: HACKATHON WINNERS — prize winners across all editions (${projects_winners.length} results) ══
${JSON.stringify(projects_winners)}

══ STEP 4: ENTITY SEARCH — projects matching the project name directly (${projects_by_name.length} results) ══
${JSON.stringify(projects_by_name)}

══ STEP 5: ARCHIVE SOURCES — curated crypto literature (${archives_general.length} results) ══
${JSON.stringify(archives_general)}

══ STEP 6: ARCHIVE SOURCES — category-specific (${archives_category.length} results) ══
${JSON.stringify(archives_category)}

══ STEP 7: HACKATHON CHRONOLOGY ══
${JSON.stringify(filters?.hackathons || [])}

══ STEP 8: HACKATHON ANALYSIS ══
${JSON.stringify(analyze || 'Not available')}

══ SCORING INSTRUCTIONS ══
Score each 1-10 based strictly on corpus evidence above:
- novelty: Uniqueness vs all similar projects found
- market_timing: Archive evidence for current demand
- competitive_gap: Room to win given all competing projects + accelerator overlap
- mechanism_design: Sophistication vs similar projects in corpus
- accelerator_overlap: How many accelerator projects are in the same space
- hackathon_precedent: How many similar winners/projects exist in hackathon history
- archive_backing: Strength of archive support for this thesis
- builder_density: How crowded is the space (high density = lower score)

Return ONLY this JSON:
{
  "score": <weighted average of all 8 dimensions>,
  "novelty": <1-10>,
  "market_timing": <1-10>,
  "competitive_gap": <1-10>,
  "mechanism_design": <1-10>,
  "accelerator_overlap": <1-10>,
  "hackathon_precedent": <1-10>,
  "archive_backing": <1-10>,
  "builder_density": <1-10>,
  "summary": "<3-4 sentences citing specific slugs and archive titles from the data>",
  "top_competing_projects": ["<real slug from corpus>", "<real slug>", "<real slug>"],
  "key_sources": ["<real archive title from corpus>", "<real archive title>"]
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
  console.log(`[server] Running on port ${PORT} — deep research mode`);
  console.log(`[server] PAT: ${process.env.COLOSSEUM_COPILOT_PAT ? '✓ set' : '✗ missing'}`);
});
