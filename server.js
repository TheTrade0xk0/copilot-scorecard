const express = require('express');
const cors = require('cors');
const { execSync, execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;

let CLAUDE_PATH = null;

function findClaude() {
  try {
    const p = execSync('which claude 2>/dev/null || true', { stdio: 'pipe' }).toString().trim();
    if (p) { console.log(`[find] which claude: ${p}`); return p; }
  } catch {}

  try {
    const npmBin = execSync('npm bin -g 2>/dev/null || true', { stdio: 'pipe' }).toString().trim().split('\n')[0];
    if (npmBin) {
      const p = `${npmBin}/claude`;
      execSync(`${p} --version`, { stdio: 'pipe', timeout: 5000 });
      console.log(`[find] npm global bin: ${p}`);
      return p;
    }
  } catch {}

  const candidates = [
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    '/root/.npm-global/bin/claude',
    '/root/.local/bin/claude',
    '/app/.npm-global/bin/claude',
    '/home/railway/.npm-global/bin/claude',
    '/usr/local/lib/node_modules/.bin/claude',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude',
  ];
  for (const c of candidates) {
    try {
      execSync(`ls ${c} 2>/dev/null`, { stdio: 'pipe' });
      console.log(`[find] found at: ${c}`);
      return c;
    } catch {}
  }

  try {
    const found = execSync('find /usr /root /app /home -name "claude" -type f 2>/dev/null | head -5', { stdio: 'pipe', timeout: 10000 }).toString().trim();
    if (found) {
      const first = found.split('\n')[0];
      console.log(`[find] find command: ${first}`);
      return first;
    }
  } catch {}

  return null;
}

function installClaude() {
  console.log('[setup] Installing @anthropic-ai/claude-code...');
  try {
    const prefix = execSync('npm config get prefix', { stdio: 'pipe' }).toString().trim();
    console.log(`[setup] npm prefix: ${prefix}`);
    execSync('npm install -g @anthropic-ai/claude-code', { stdio: 'inherit', timeout: 180000 });
    console.log('[setup] Install complete');
    try {
      const ls = execSync(`ls ${prefix}/bin/ 2>/dev/null | grep claude || true`, { stdio: 'pipe' }).toString().trim();
      console.log(`[setup] bin contents: ${ls || 'empty'}`);
    } catch {}
  } catch (e) {
    console.error('[setup] Install failed:', e.message);
  }
}

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    claude: CLAUDE_PATH || 'not found',
    pat: process.env.COLOSSEUM_COPILOT_PAT ? 'set' : 'missing',
  });
});

app.post('/research', async (req, res) => {
  if (!CLAUDE_PATH) {
    CLAUDE_PATH = findClaude();
    if (!CLAUDE_PATH) return res.status(500).json({ error: 'Claude Code not ready — retry in 30 seconds' });
  }

  const { anthropic_key, colosseum_pat: user_pat, project_name, category, country, x_link, description } = req.body;

  if (!anthropic_key) return res.status(400).json({ error: 'Anthropic API key is required' });
  if (!anthropic_key.startsWith('sk-ant-')) return res.status(400).json({ error: 'Invalid Anthropic API key format' });
  if (!project_name) return res.status(400).json({ error: 'Project name is required' });
  if (!description || description.length < 30) return res.status(400).json({ error: 'Description too short' });
  if (!category) return res.status(400).json({ error: 'Category is required' });
  if (!country) return res.status(400).json({ error: 'Country is required' });

  // Use PAT from user request, fall back to server env var
  const colosseum_pat = user_pat || process.env.COLOSSEUM_COPILOT_PAT;
  if (!colosseum_pat) return res.status(500).json({ error: 'Colosseum PAT missing' });

  console.log(`[research] Starting: ${project_name}`);

  const prompt = `You have the Colosseum Copilot skill installed. Use it to do a deep research analysis of this crypto/Solana project.

PROJECT DETAILS:
- Name: ${project_name}
- Category: ${category}
- Country: ${country}
- Description: ${description}

INSTRUCTIONS:
1. Use the Colosseum Copilot skill to search hackathon project clusters relevant to this project
2. Cross-reference with crypto archives and curated sources
3. Search for similar projects in the Colosseum corpus
4. Analyze the competitive landscape

After your research, return ONLY a valid JSON object (no markdown, no explanation, just raw JSON):
{
  "score": <number 1-10 with up to 2 decimal places>,
  "novelty": <integer 1-10>,
  "market_timing": <integer 1-10>,
  "competitive_gap": <integer 1-10>,
  "mechanism_design": <integer 1-10>,
  "accelerator_overlap": <integer 1-10>,
  "hackathon_precedent": <integer 1-10>,
  "archive_backing": <integer 1-10>,
  "builder_density": <integer 1-10>,
  "summary": "<2-3 sentence summary with specific evidence from Copilot corpus>",
  "top_competing_projects": ["<project1>", "<project2>", "<project3>"],
  "key_sources": ["<source1>", "<source2>"]
}`;

  try {
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: anthropic_key,
      COLOSSEUM_COPILOT_API_BASE: 'https://copilot.colosseum.com/api/v1',
      COLOSSEUM_COPILOT_PAT: colosseum_pat,
      HOME: process.env.HOME || '/root',
      PATH: process.env.PATH + ':/usr/local/bin:/root/.npm-global/bin:/usr/local/lib/node_modules/.bin',
    };

    const { stdout } = await execFileAsync(
      CLAUDE_PATH,
      ['-p', prompt, '--output-format', 'json', '--max-turns', '10'],
      { env, timeout: 120000, maxBuffer: 1024 * 1024 * 10 }
    );

    if (!stdout) throw new Error('No response from Claude Code');

    let claudeOutput;
    try { claudeOutput = JSON.parse(stdout); }
    catch { throw new Error('Failed to parse Claude response'); }

    const resultText = claudeOutput.result || claudeOutput.content || '';
    const match = resultText.match(/\{[\s\S]*"score"[\s\S]*\}/);
    if (!match) throw new Error('Could not extract scorecard — try again');

    const data = JSON.parse(match[0]);
    const dims = ['novelty', 'market_timing', 'competitive_gap', 'mechanism_design',
      'accelerator_overlap', 'hackathon_precedent', 'archive_backing', 'builder_density'];
    dims.forEach(f => { data[f] = Math.min(10, Math.max(1, Math.round(Number(data[f])))); });
    data.score = Math.round((dims.reduce((s, f) => s + data[f], 0) / dims.length) * 4) / 4;
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
    if (err.killed || err.message.includes('timeout'))
      return res.status(408).json({ error: 'Research timed out — try again' });
    if (err.message.includes('rate_limit'))
      return res.status(429).json({ error: 'Rate limit hit — retry in a moment' });
    res.status(500).json({ error: err.message || 'Research failed' });
  }
});

async function main() {
  console.log('[setup] Checking for Claude Code...');
  console.log(`[setup] PATH: ${process.env.PATH}`);

  CLAUDE_PATH = findClaude();

  if (!CLAUDE_PATH) {
    installClaude();
    CLAUDE_PATH = findClaude();
  }

  console.log(`[server] Claude: ${CLAUDE_PATH ? '✓ ' + CLAUDE_PATH : '✗ NOT FOUND'}`);
  console.log(`[server] PAT: ${process.env.COLOSSEUM_COPILOT_PAT ? '✓ set' : '✗ MISSING'}`);

  app.listen(PORT, () => {
    console.log(`[server] Running on port ${PORT}`);
  });
}

main();
