// server.js - Colosseum Copilot Scorecard Backend
const express = require('express');
const cors = require('cors');
const { execSync, exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ─────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

// ── HEALTH CHECK ───────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── RESEARCH ENDPOINT ──────────────────────────────────
app.post('/research', async (req, res) => {
  const { anthropic_key, project_name, category, country, x_link, description } = req.body;

  // Validate inputs
  if (!anthropic_key) return res.status(400).json({ error: 'Anthropic API key is required' });
  if (!anthropic_key.startsWith('sk-ant-')) return res.status(400).json({ error: 'Invalid Anthropic API key format' });
  if (!project_name) return res.status(400).json({ error: 'Project name is required' });
  if (!description || description.length < 30) return res.status(400).json({ error: 'Description too short' });
  if (!category) return res.status(400).json({ error: 'Category is required' });
  if (!country) return res.status(400).json({ error: 'Country is required' });

  const colosseum_pat = process.env.COLOSSEUM_COPILOT_PAT;
  if (!colosseum_pat) return res.status(500).json({ error: 'Server not configured (missing PAT)' });

  console.log(`[research] Starting research for: ${project_name}`);

  const prompt = buildPrompt(project_name, category, country, description);

  try {
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: anthropic_key,
      COLOSSEUM_COPILOT_API_BASE: 'https://copilot.colosseum.com/api/v1',
      COLOSSEUM_COPILOT_PAT: colosseum_pat,
      HOME: process.env.HOME || '/root',
    };

    const envStr = Object.entries(env)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(' ');

    // Run Claude Code in headless mode with the Colosseum Copilot skill
    const cmd = `claude -p ${JSON.stringify(prompt)} --output-format json --max-turns 10`;

    console.log(`[research] Running Claude Code headless...`);

    const { stdout, stderr } = await execAsync(cmd, {
      env,
      timeout: 120000, // 2 min timeout
      maxBuffer: 1024 * 1024 * 10, // 10MB buffer
    });

    if (!stdout) throw new Error('No response from Claude Code');

    // Parse Claude Code JSON output
    let claudeOutput;
    try {
      claudeOutput = JSON.parse(stdout);
    } catch (e) {
      throw new Error('Failed to parse Claude Code response');
    }

    const resultText = claudeOutput.result || claudeOutput.content || stdout;

    // Extract JSON scorecard from Claude's response
    const scorecard = extractScorecard(resultText);
    if (!scorecard) throw new Error('Failed to extract scorecard from response');

    // Add metadata
    scorecard.project_name = project_name;
    scorecard.category = category;
    scorecard.country = country;
    scorecard.x_link = x_link || null;

    console.log(`[research] ✓ Research complete for: ${project_name} → ${scorecard.score}/10`);
    res.json({ success: true, scorecard });

  } catch (err) {
    console.error(`[research] Error: ${err.message}`);

    // Handle specific errors
    if (err.message.includes('401') || err.message.includes('invalid_api_key')) {
      return res.status(401).json({ error: 'Invalid Anthropic API key' });
    }
    if (err.message.includes('timeout') || err.killed) {
      return res.status(408).json({ error: 'Research timed out — try again' });
    }
    if (err.message.includes('rate_limit')) {
      return res.status(429).json({ error: 'API rate limit hit — wait a moment and retry' });
    }

    res.status(500).json({ error: err.message || 'Research failed — try again' });
  }
});

// ── PROMPT BUILDER ─────────────────────────────────────
function buildPrompt(name, category, country, description) {
  return `You have the Colosseum Copilot skill installed. Use it to do a deep research analysis of this crypto/Solana project.

PROJECT DETAILS:
- Name: ${name}
- Category: ${category}
- Country: ${country}
- Description: ${description}

INSTRUCTIONS:
1. Use the Colosseum Copilot skill to search hackathon project clusters relevant to this project
2. Cross-reference with crypto archives and curated sources
3. Search for similar projects in the Colosseum corpus
4. Analyze the competitive landscape

After your research, return ONLY a valid JSON object (no markdown, no explanation, just raw JSON) with this exact structure:
{
  "score": <number 1-10 with up to 2 decimal places, overall weighted average>,
  "novelty": <integer 1-10>,
  "market_timing": <integer 1-10>,
  "competitive_gap": <integer 1-10>,
  "mechanism_design": <integer 1-10>,
  "accelerator_overlap": <integer 1-10>,
  "hackathon_precedent": <integer 1-10>,
  "archive_backing": <integer 1-10>,
  "builder_density": <integer 1-10>,
  "summary": "<2-3 sentence summary of findings with specific evidence from Copilot corpus>",
  "top_competing_projects": ["<project1>", "<project2>", "<project3>"],
  "key_sources": ["<source1>", "<source2>"]
}`;
}

// ── SCORECARD EXTRACTOR ────────────────────────────────
function extractScorecard(text) {
  // Try to find JSON in the response
  const jsonMatch = text.match(/\{[\s\S]*"score"[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const data = JSON.parse(jsonMatch[0]);

    // Validate required fields
    const required = ['score', 'novelty', 'market_timing', 'competitive_gap',
      'mechanism_design', 'accelerator_overlap', 'hackathon_precedent',
      'archive_backing', 'builder_density', 'summary'];

    for (const field of required) {
      if (data[field] === undefined) return null;
    }

    // Clamp all scores to 1-10
    const numFields = ['novelty', 'market_timing', 'competitive_gap', 'mechanism_design',
      'accelerator_overlap', 'hackathon_precedent', 'archive_backing', 'builder_density'];
    numFields.forEach(f => {
      data[f] = Math.min(10, Math.max(1, Math.round(Number(data[f]))));
    });

    // Recalculate overall score as weighted average
    const avg = numFields.reduce((sum, f) => sum + data[f], 0) / numFields.length;
    data.score = Math.round(avg * 4) / 4; // round to nearest 0.25

    return data;
  } catch (e) {
    return null;
  }
}

// ── START ──────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[server] Copilot Scorecard Backend running on port ${PORT}`);
  console.log(`[server] Colosseum PAT: ${process.env.COLOSSEUM_COPILOT_PAT ? '✓ set' : '✗ MISSING'}`);

  // Run setup on boot
  try {
    console.log('[server] Running environment setup...');
    execSync('node setup.js', { stdio: 'inherit', timeout: 180000 });
  } catch (e) {
    console.error('[server] Setup warning:', e.message);
    // Don't crash — setup may partially succeed
  }
});
