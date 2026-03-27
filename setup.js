// setup.js - runs once on server boot to install Claude Code + Colosseum Copilot
const { execSync } = require('child_process');

function run(cmd, label) {
  console.log(`[setup] ${label}...`);
  try {
    const out = execSync(cmd, { stdio: 'pipe', timeout: 120000 }).toString();
    console.log(`[setup] ✓ ${label}`);
    return out;
  } catch (e) {
    console.error(`[setup] ✗ ${label}: ${e.message}`);
    throw e;
  }
}

async function setup() {
  console.log('[setup] Starting Colosseum Copilot environment setup...');

  // 1. Install Claude Code CLI globally
  run('npm install -g @anthropic-ai/claude-code --quiet', 'Installing Claude Code CLI');

  // 2. Set env vars for Colosseum Copilot install
  process.env.COLOSSEUM_COPILOT_API_BASE = 'https://copilot.colosseum.com/api/v1';
  // COLOSSEUM_COPILOT_PAT comes from Railway env vars

  // 3. Install Colosseum Copilot skill globally (non-interactive)
  run(
    `echo '{"scope":"global"}' | npx skills add ColosseumOrg/colosseum-copilot --yes 2>/dev/null || true`,
    'Installing Colosseum Copilot skill'
  );

  console.log('[setup] ✓ Setup complete');
}

setup().catch(err => {
  console.error('[setup] Setup failed:', err.message);
  process.exit(1);
});
