export const config = { runtime: 'edge' };

const COPILOT_BASE = 'https://copilot.colosseum.com/api/v1';

export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Pat',
      },
    });
  }

  try {
    const { searchParams } = new URL(req.url);
    const endpoint = searchParams.get('endpoint') || 'status';
    const pat = req.headers.get('x-pat');

    if (!pat) {
      return json({ error: 'Missing PAT' }, 400);
    }

    // Build target URL
    const targetUrl = `${COPILOT_BASE}/${endpoint}`;

    // Forward the request
    const upstream = await fetch(targetUrl, {
      method: req.method === 'GET' ? 'GET' : req.method,
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Content-Type': 'application/json',
      },
      body: req.method !== 'GET' ? await req.text() : undefined,
    });

    const data = await upstream.text();

    return new Response(data, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
