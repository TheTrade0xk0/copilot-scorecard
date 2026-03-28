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
  if (!CLAUDE_PATH) return res.js
