import 'dotenv/config';

const apiUrl = (process.env.PLUGGY_API_URL ?? 'https://api.pluggy.ai').replace(
  /\/$/,
  '',
);

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validateWebhookUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new Error('PLUGGY_WEBHOOK_URL must use HTTPS');
  }
  return url.toString();
}

async function readResponse(response) {
  if (response.status === 204) return undefined;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return undefined;
  return response.json();
}

async function authenticate(clientId, clientSecret) {
  const response = await fetch(`${apiUrl}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await readResponse(response);
  if (!response.ok || !payload?.apiKey) {
    throw new Error(`Pluggy authentication failed (${response.status})`);
  }
  return payload.apiKey;
}

async function pluggyRequest(path, apiKey, init = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await readResponse(response);
  if (!response.ok) {
    const code = payload?.code ? ` ${payload.code}` : '';
    const message = payload?.message ? `: ${payload.message}` : '';
    throw new Error(`Pluggy request failed (${response.status}${code})${message}`);
  }
  return payload;
}

function normalizeWebhooks(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

async function main() {
  const clientId = requireEnv('PLUGGY_CLIENT_ID');
  const clientSecret = requireEnv('PLUGGY_CLIENT_SECRET');
  const webhookUrl = validateWebhookUrl(requireEnv('PLUGGY_WEBHOOK_URL'));
  const webhookSecret = requireEnv('PLUGGY_WEBHOOK_SECRET');
  const apiKey = await authenticate(clientId, clientSecret);
  const webhooks = normalizeWebhooks(
    await pluggyRequest('/webhooks', apiKey),
  );
  const existing =
    webhooks.find(
      (webhook) => webhook.event === 'all' && webhook.url === webhookUrl,
    ) ?? webhooks.find((webhook) => webhook.event === 'all');
  if (existing?.id) {
    const update = {
      enabled: true,
      headers: {
        'x-gatekeep-webhook-secret': webhookSecret,
      },
    };
    if (existing.url !== webhookUrl) update.url = webhookUrl;
    if (existing.event !== 'all') update.event = 'all';

    await pluggyRequest(`/webhooks/${encodeURIComponent(existing.id)}`, apiKey, {
      method: 'PATCH',
      body: JSON.stringify(update),
    });
    console.log(`Pluggy webhook updated: ${existing.id}`);
    return;
  }

  const created = await pluggyRequest('/webhooks', apiKey, {
    method: 'POST',
    body: JSON.stringify({
      event: 'all',
      url: webhookUrl,
      enabled: true,
      headers: {
        'x-gatekeep-webhook-secret': webhookSecret,
      },
    }),
  });
  console.log(`Pluggy webhook created: ${created?.id ?? 'success'}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
});
