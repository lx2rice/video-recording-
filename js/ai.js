// Talking to the model. Two providers, one shape: `streamChat()` takes a
// system prompt plus a message list and streams text back through `onDelta`.
//
// These are raw `fetch` calls rather than an SDK because the app ships as
// static files with no build step and no server — the whole point is that you
// can host it anywhere and it still works from a Home Screen tile.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_VERSION = '2023-06-01';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export const ANTHROPIC_MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 — best quality' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — faster, cheaper' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — cheapest' },
];

export const OPENAI_MODELS = [
  { id: 'gpt-4o-mini', label: 'gpt-4o-mini — fast and cheap' },
  { id: 'gpt-4o', label: 'gpt-4o — stronger, multimodal' },
  { id: 'gpt-4.1', label: 'gpt-4.1' },
];

function url(settings, provider, path) {
  if (settings.proxyUrl) return `${settings.proxyUrl.replace(/\/$/, '')}/${provider}${path}`;
  return provider === 'anthropic' ? ANTHROPIC_URL : OPENAI_URL;
}

export function activeProvider(settings) {
  return settings.provider === 'openai' ? 'openai' : 'anthropic';
}

export function describeModel(settings) {
  return activeProvider(settings) === 'openai'
    ? (settings.openaiModel || 'gpt-4o-mini')
    : (settings.anthropicModel || 'claude-opus-5');
}

export function missingCredentials(settings) {
  if (settings.proxyUrl) return null;
  if (activeProvider(settings) === 'openai' && !settings.openaiKey) {
    return 'Add your OpenAI API key in Settings.';
  }
  if (activeProvider(settings) === 'anthropic' && !settings.anthropicKey) {
    return 'Add your Anthropic API key in Settings.';
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.system        system prompt (transcript context lives here)
 * @param {Array}  opts.messages      [{role:'user'|'assistant', content:string}]
 * @param {Array}  [opts.images]      [{base64, mediaType, at}] attached to the last user turn
 * @param {(t:string)=>void} [opts.onDelta]
 * @returns {Promise<string>} the full reply
 */
export async function streamChat(settings, opts) {
  const problem = missingCredentials(settings);
  if (problem) throw new Error(problem);
  return activeProvider(settings) === 'openai'
    ? streamOpenAI(settings, opts)
    : streamAnthropic(settings, opts);
}

// --- Anthropic --------------------------------------------------------------

function anthropicContent(message, images) {
  if (!images || images.length === 0) return message.content;
  const blocks = images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
  }));
  return [...blocks, { type: 'text', text: message.content }];
}

async function streamAnthropic(settings, { system, messages, images, onDelta, signal }) {
  const model = settings.anthropicModel || 'claude-opus-5';
  const last = messages.length - 1;
  const body = {
    model,
    max_tokens: 16000,
    stream: true,
    system,
    // Adaptive thinking is the current API; `budget_tokens` is rejected on this
    // model family. Depth is steered with output_config.effort instead.
    thinking: { type: 'adaptive' },
    output_config: { effort: settings.effort || 'high' },
    messages: messages.map((m, i) => ({
      role: m.role,
      content: i === last && m.role === 'user' ? anthropicContent(m, images) : m.content,
    })),
  };

  const send = async (withFallbacks) => {
    const headers = {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    };
    if (!settings.proxyUrl) {
      headers['x-api-key'] = settings.anthropicKey;
      // Required for calls made straight from a browser rather than a server.
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }
    const payload = { ...body };
    if (withFallbacks) {
      headers['anthropic-beta'] = FALLBACK_BETA;
      // On a policy decline the API retries on a fallback model in the same call.
      payload.fallbacks = 'default';
    }
    return fetch(url(settings, 'anthropic', '/v1/messages'), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });
  };

  let wantFallbacks = settings.useFallbacks !== false;
  let res;
  try {
    res = await send(wantFallbacks);
  } catch (err) {
    if (!wantFallbacks) throw networkError(err);
    // A proxy or older gateway may reject the beta header outright.
    wantFallbacks = false;
    res = await send(false).catch((e) => { throw networkError(e); });
  }
  if (!res.ok && wantFallbacks && res.status === 400) {
    const detail = await res.text();
    if (/fallback|beta/i.test(detail)) res = await send(false);
    else throw new Error(apiError('Claude', res.status, detail));
  }
  if (!res.ok) throw new Error(apiError('Claude', res.status, await res.text()));

  let text = '';
  let stopReason = null;
  await readSSE(res, (event) => {
    if (event.type === 'content_block_delta' && event.delta) {
      if (event.delta.type === 'text_delta' && event.delta.text) {
        text += event.delta.text;
        if (onDelta) onDelta(event.delta.text);
      }
    } else if (event.type === 'message_delta' && event.delta) {
      stopReason = event.delta.stop_reason || stopReason;
    } else if (event.type === 'error') {
      throw new Error(event.error?.message || 'Claude returned an error.');
    }
  });

  if (stopReason === 'refusal' && !text.trim()) {
    throw new Error('Claude declined this request. Try rephrasing what you want done with the video.');
  }
  return text;
}

// --- OpenAI -----------------------------------------------------------------

function openaiContent(message, images) {
  if (!images || images.length === 0) return message.content;
  return [
    { type: 'text', text: message.content },
    ...images.map((img) => ({
      type: 'image_url',
      image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
    })),
  ];
}

async function streamOpenAI(settings, { system, messages, images, onDelta, signal }) {
  const last = messages.length - 1;
  const headers = { 'content-type': 'application/json' };
  if (!settings.proxyUrl) headers.Authorization = `Bearer ${settings.openaiKey}`;

  const res = await fetch(url(settings, 'openai', '/v1/chat/completions'), {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: settings.openaiModel || 'gpt-4o-mini',
      stream: true,
      messages: [
        { role: 'system', content: system },
        ...messages.map((m, i) => ({
          role: m.role,
          content: i === last && m.role === 'user' ? openaiContent(m, images) : m.content,
        })),
      ],
    }),
  }).catch((err) => { throw networkError(err); });

  if (!res.ok) throw new Error(apiError('OpenAI', res.status, await res.text()));

  let text = '';
  await readSSE(res, (event) => {
    const delta = event.choices?.[0]?.delta?.content;
    if (delta) {
      text += delta;
      if (onDelta) onDelta(delta);
    }
    if (event.error) throw new Error(event.error.message || 'OpenAI returned an error.');
  });
  return text;
}

// --- shared plumbing --------------------------------------------------------

async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf('\n\n');
    while (cut !== -1) {
      const raw = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          onEvent(JSON.parse(data));
        } catch (err) {
          if (err instanceof SyntaxError) continue;   // partial frame; ignore
          throw err;
        }
      }
      cut = buffer.indexOf('\n\n');
    }
  }
}

function apiError(label, status, detail) {
  let message = detail;
  try {
    const parsed = JSON.parse(detail);
    message = parsed.error?.message || parsed.message || detail;
  } catch { /* plain text */ }
  if (status === 401) return `${label} rejected the API key. Check it in Settings.`;
  if (status === 429) return `${label} is rate limiting or out of credit (429). ${message}`;
  return `${label} error ${status}: ${String(message).slice(0, 400)}`;
}

function networkError(err) {
  if (err && err.name === 'AbortError') return err;
  return new Error(
    `Could not reach the API (${err?.message || 'network error'}). If you are offline or behind a filter, ` +
    'try again on another network — or run the bundled proxy and set its URL in Settings.',
  );
}
