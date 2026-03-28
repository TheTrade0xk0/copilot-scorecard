const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const COPILOT_BASE = 'https://copilot.colosseum.com/api/v1';

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'x-colosseum-pat'] }));
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
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
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

function archiveKeywords(project_name, category, description) {
  const words = `${project_name} ${category} ${description}`
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4)
    .slice(0, 6)
    .join(' ');
  return words;
}

function hackathonsForCategory(category) {
  const map = {
    'Gaming': ['radar'],
    'Infrastructure': ['breakout'],
    'AI': ['breakout'],
    'DePIN': ['breakout'],
    'Consumer': ['renaissance'],
    'DeFi': ['cypherpunk', 'breakout'],
    'Stablecoins': ['cypherpunk', 'breakout'],
    'Payments': ['cypherpunk', 'breakout'],
    'DAOs & Network States': ['renaissance', 'cypherpunk'],
    'Public Goods': ['renaissance'],
    'Climate': ['breakout'],
  };
  return map[category] || ['breakout', 'radar', 'cypherpunk', 'renaissance'];
}

function trimProject(p) {
  return {
    name: p.name || p.title,
    slug: p.slug,
    description: (p.description || p.summary || '').slice(0, 120),
    hackathon: p.hackathon?.slug || p.hackathon,
    tags: Array.isArray(p.tags) ? p.tags.slice(0, 4) : p.tags,
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
  res.json({ status: 'ok', mode: 'deep-research-v2' });
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
    console.log(`[research] Auth OK`);

    const semanticQuery = `${project_name} ${description}`;
    const problemQuery = `${category} problem ${description}`;
    const nameQuery = project_name;
    const archiveKeywordsGeneral = archiveKeywords(project_name, category, description);
    const archiveKeywordsCategory = `${category} crypto Solana`;
    const hackathons = hackathonsForCategory(category);

    const [
      s1_projects_semantic,
      s2_projects_problem,
      s3_projects_accelerator,
      s4_projects_winners,
      s5_projects_by_name,
      s6_archives_general,
      s7_archives_category,
      s8_filters,
      s9_analyze,
    ] = await Promise.allSettled([
      copilotPost('search/projects', pat, { query: semanticQuery, limit: 12 }),
      copilotPost('search/projects', pat, { query: problemQuery, limit: 10 }),
      copilotPost('search/projects', pat, { query: semanticQuery, limit: 10, filters: { acceleratorOnly: true } }),
      copilotPost('search/projects', pat, { query: semanticQuery, limit: 8, filters: { winnersOnly: true } }),
      copilotPost('search/projects', pat, { query: nameQuery, limit: 5 }),
      copilotPost('search/archives', pat, { query: archiveKeywordsGeneral, limit: 5, maxChunksPerDoc: 1 }),
      copilotPost('search/archives', pat, { query: archiveKeywordsCategory, limit: 5, maxChunksPerDoc: 1 }),
      copilotGet('filters', pat),
      copilotPost('analyze', pat, {
        cohort: { hackathons, winnersOnly: false },
        dimensions: ['tracks', 'problemTags', 'techStack'],
        topK: 8,
        samplePerBucket: 1,
      }).catch(() => null),
    ]);

    const projects_semantic    = settled(s1_projects_semantic).map(trimProject);
    const projects_problem     = settled(s2_projects_problem).map(trimProject);
    const projects_accelerator = settled(s3_projects_accelerator).map(trimProject);
    const projects_winners     = settled(s4_projects_winners).map(trimProject);
    const projects_by_name     = settled(s5_projects_by_name).map(trimProject);
    const archives_general     = settled(s6_archives_general).map(trimArchive);
    const archives_category    = settled(s7_archives_category).map(trimArchive);
    const filters              = s8_filters.status === 'fulfilled' ? s8_filters.value : null;
    const analyze              = s9_analyze.status === 'fulfilled' ? s9_analyze.value : null;

    console.log(`[research] Data: semantic=${projects_semantic.length} problem=${projects_problem.length} accelerator=${projects_accelerator.length} winners=${projects_winners.length} archives=${archives_general.length + archives_category.length}`);

    const systemPrompt = `You are an expert Colosseum hackathon analyst.
Analyze ALL provided corpus data carefully and produce a rigorous, evidence-based scorecard.
Be critical and specific — cite actual project slugs and archive titles from the data.
Scores must reflect real corpus evidence, not assumptions.
Return ONLY valid JSON, no markdown, no text outside the JSON.`;

    const userMessage = `Score this project using Colosseum Copilot corpus data.

PROJECT: ${project_name} | ${category} | ${country}
DESCRIPTION: ${description}

── SIMILAR PROJECTS semantic search (${projects_semantic.length}) ──
${JSON.stringify(projects_semantic)}

── SIMILAR PROJECTS problem-space search (${projects_problem.length}) ──
${JSON.stringify(projects_problem)}

── ACCELERATOR PORTFOLIO (${projects_accelerator.length}) ──
${JSON.stringify(projects_accelerator)}

── HACKATHON WINNERS (${projects_winners.length}) ──
${JSON.stringify(projects_winners)}

── ENTITY SEARCH by name (${projects_by_name.length}) ──
${JSON.stringify(projects_by_name)}

── ARCHIVE SOURCES general (${archives_general.length}) ──
${JSON.stringify(archives_general)}

── ARCHIVE SOURCES category (${archives_category.length}) ──
${JSON.stringify(archives_category)}

── HACKATHON CHRONOLOGY ──
${JSON.stringify(filters?.hackathons || [])}

── HACKATHON ANALYSIS ──
${JSON.stringify(analyze || 'Not available')}

SCORING RULES:
- Be critical. If many similar projects exist, novelty and competitive_gap must be LOW.
- accelerator_overlap: if accelerator projects match → score LOW (more competition)
- hackathon_precedent: if many similar hackathon projects → score LOW (saturated)
- builder_density: if space is crowded → score LOW
- Each dimension_insight must cite specific slugs or archive titles from the data above.
- Do NOT invent project names. Only cite what appears in the data.

Return ONLY this JSON (no markdown):
{
  "score": <weighted average>,
  "novelty": <1-10>,
  "novelty_insight": "<2-3 sentences citing specific project slugs that are similar or different. Be critical.>",
  "market_timing": <1-10>,
  "market_timing_insight": "<2-3 sentences citing specific archive titles and what they say about demand.>",
  "competitive_gap": <1-10>,
  "competitive_gap_insight": "<2-3 sentences naming the closest competing projects by slug and explaining the gap.>",
  "mechanism_design": <1-10>,
  "mechanism_design_insight": "<2-3 sentences comparing mechanism sophistication to similar projects in corpus.>",
  "accelerator_overlap": <1-10>,
  "accelerator_overlap_insight": "<2-3 sentences naming accelerator projects found and what that means.>",
  "hackathon_precedent": <1-10>,
  "hackathon_precedent_insight": "<2-3 sentences citing winner slugs and hackathon editions where similar projects appeared.>",
  "archive_backing": <1-10>,
  "archive_backing_insight": "<2-3 sentences citing specific archive document titles and what they validate.>",
  "builder_density": <1-10>,
  "builder_density_insight": "<2-3 sentences with specific counts from corpus data about how crowded this space is.>",
  "summary": "<3-4 sentences overall assessment with specific evidence, naming real projects and sources.>",
  "top_competing_projects": ["<real slug>", "<real slug>", "<real slug>"],
  "key_sources": ["<real archive title>", "<real archive title>"]
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

app.post('/competitive-dive', async (req, res) => {
  const { anthropic_key, colosseum_pat: user_pat, project_name, category, description, competing_slugs } = req.body;
  if (!anthropic_key) return res.status(400).json({ error: 'Anthropic API key required' });
  if (!competing_slugs?.length) return res.status(400).json({ error: 'No competing projects provided' });

  const pat = user_pat || process.env.COLOSSEUM_COPILOT_PAT;
  if (!pat) return res.status(500).json({ error: 'Colosseum PAT missing' });

  try {
    // Fetch full details for each competing project + archive search
    const [projectDetails, archives] = await Promise.all([
      Promise.allSettled(competing_slugs.map(slug => copilotGet(`projects/by-slug/${slug}`, pat))),
      copilotPost('search/archives', pat, {
        query: `${project_name} ${category} competitor analysis`,
        limit: 4,
        maxChunksPerDoc: 1,
      }).catch(() => ({ results: [] })),
    ]);

    const projects = projectDetails
      .filter(r => r.status === 'fulfilled')
      .map(r => {
        const p = r.value;
        return {
          name: p.name,
          slug: p.slug,
          description: (p.description || p.oneLiner || '').slice(0, 300),
          hackathon: p.hackathon?.name || p.hackathon?.slug,
          hackathon_date: p.hackathon?.startDate,
          prize: p.prize || null,
          tags: Array.isArray(p.tags) ? p.tags.slice(0, 6) : [],
          links: p.links?.website || p.links?.github || null,
        };
      });

    const archiveResults = (archives.results || []).map(trimArchive);

    const prompt = `You are a competitive intelligence analyst for Solana/crypto startups.

OUR PROJECT: ${project_name} (${category})
DESCRIPTION: ${description}

COMPETING PROJECTS FROM COLOSSEUM CORPUS:
${JSON.stringify(projects, null, 2)}

RELEVANT ARCHIVE SOURCES:
${JSON.stringify(archiveResults, null, 2)}

For each competing project, analyze:
1. What they built and when
2. How directly they compete with our project (direct/adjacent/tangential)
3. Their apparent strengths
4. Differentiation angle our project could take against them

Then provide an overall competitive landscape summary.

Return ONLY this JSON:
{
  "competitors": [
    {
      "slug": "<slug>",
      "name": "<name>",
      "hackathon": "<hackathon + date>",
      "prize": "<prize or null>",
      "what_they_built": "<1-2 sentences>",
      "overlap": "direct" | "adjacent" | "tangential",
      "their_strengths": "<1 sentence>",
      "differentiation_angle": "<1-2 sentences on how our project can differentiate>"
    }
  ],
  "landscape_summary": "<3-4 sentences overall competitive landscape assessment with specific evidence>"
}`;

    const response = await callClaude(anthropic_key, [{ role: 'user', content: prompt }],
      'You are a competitive intelligence analyst. Return ONLY valid JSON, no markdown.');

    const match = response.match(/\{[\s\S]*"competitors"[\s\S]*\}/);
    if (!match) throw new Error('Could not parse competitive analysis');

    res.json({ success: true, analysis: JSON.parse(match[0]) });
  } catch (err) {
    console.error(`[competitive-dive] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/project/:slug', async (req, res) => {
  const { slug } = req.params;
  const pat = req.headers['x-colosseum-pat'] || process.env.COLOSSEUM_COPILOT_PAT;
  if (!pat) return res.status(400).json({ error: 'Colosseum PAT required' });
  try {
    const data = await copilotGet(`projects/by-slug/${slug}`, pat);
    res.json({ success: true, project: data });
  } catch (err) {
    console.error(`[project] Error fetching ${slug}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[server] Running on port ${PORT} — deep research v2`);
  console.log(`[server] PAT: ${process.env.COLOSSEUM_COPILOT_PAT ? '✓ set' : '✗ missing'}`);
});
