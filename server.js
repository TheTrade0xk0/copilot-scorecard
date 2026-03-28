const express = require('express');
const cors = require('cors');
const { execSync, spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
let CLAUDE_PATH = null;

function findClaude() {
  try {
    const prefix = execSync('npm config get prefix 2>/dev/null', { stdio: 'pipe' }).toString().trim();
    if (prefix) {
      const p = `${prefix}/bin/claude`;
      try { execSync(`ls "${p}"`, { stdio: 'pipe' }); return p; } catch {}
    }
  } catch {}
  try {
    const p = execSync('which claude 2>/dev/null', { stdio: 'pipe' }).toString().trim();
    if (p) return p;
  } catch {}
  return null;
}

function runClaude(claudePath, args, env) {
  return new Promise((resolve, reject) => {
    console.log(`[claude] Spawning: ${claudePath}`);

    const proc = spawn(claudePath, args, {
      env: {
        ...env,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        NO_UPDATE_NOTIFIER: '1',
        DISABLE_AUTOUPDATER: '1',
        CI: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdin.end();

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => {
      stdout += d.toString();
      process.stdout.write(`[claude:out] ${d.toString().slice(0, 100)}\n`);
    });

    proc.stderr.on('data', d => {
      stderr += d.toString();
      process.stdout.write(`[claude:err] ${d.toString().slice(0, 100)}\n`);
    });

    proc.on('close', code => {
      console.log(`[claude] exit=${code} stdout=${stdout.length}b stderr=${stderr.length}b`);
      if (code !== 0 && !stdout) {
        reject(new Error(`Claude exited ${code}: ${stderr.slice(0, 500)}`));
      } else {
        resolve({ stdout, stderr });
      }
    });

    proc.on('error', (err) => {
      console.error('[claude] spawn error:', err.message);
      reject(err);
    });

    setTimeout(() => {
      console.log('[claude] Killing after timeout');
      proc.kill('SIGTERM');
      reject(new Error('timeout'));
    }, 180000);
  });
}

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { res.setTimeout(240000); next(); });

app.get('/health', (req, res) => {
  res.json({ status: 'ok', claude: CLAUDE_PATH || 'not found' });
});

app.get('/test-claude', async (req, res) => {
  if (!CLAUDE_PATH) return res.json({ error: 'Claude not found' });
  try {
    const { stdout } = await runClaude(CLAUDE_PATH, ['-p', 'Say "OK" and nothing else', '--output-format', 'json', '--max-turns', '1', '--bare'], {
      ...process.env,
      ANTHROPIC_API_KEY: req.query.key || '',
    });
    res.json({ success: true, output: stdout.slice(0, 500) });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.post('/research', async (req, res) => {
  if (!CLAUDE_PATH) return res.status(500).json({ error: 'Claude Code not ready' });

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
    };

    const { stdout } = await runClaude(
      CLAUDE_PATH,
      ['-p', prompt, '--output-format', 'json', '--max-turns', '15', '--bare'],
      env
    );

    if (!stdout) throw new Error('No response from Claude');

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
    if (err.message.includes('timeout'))
      return res.status(408).json({ error: 'Research timed out — try again' });
    if (err.message.includes('rate_limit'))
      return res.status(429).json({ error: 'Rate limit hit — retry in a moment' });
    res.status(500).json({ error: err.message || 'Research failed' });
  }
});

async function main() {
  CLAUDE_PATH = findClaude();
  console.log(`[server] Claude: ${CLAUDE_PATH ? '✓ ' + CLAUDE_PATH : '✗ NOT FOUND'}`);
  console.log(`[server] PAT: ${process.env.COLOSSEUM_COPILOT_PAT ? '✓ set' : '✗ MISSING'}`);
  app.listen(PORT, () => console.log(`[server] Running on port ${PORT}`));
}

main();
