// The "what do you want to do with this?" menu, and the prompts behind it.

export const ACTIONS = [
  {
    id: 'summary',
    icon: '📝',
    label: 'Summarise it',
    hint: 'What it covered, in a minute',
    prompt: 'Summarise this video. Open with a two-sentence overview, then the main points as a short bulleted list with timestamps where the transcript has them. Keep it under 300 words.',
  },
  {
    id: 'takeaways',
    icon: '💡',
    label: 'Key takeaways',
    hint: 'The ideas worth keeping',
    prompt: 'Pull out the key takeaways — the ideas actually worth remembering, not a recap. Five to eight bullets, each one a complete thought. Skip filler, ads and intros.',
  },
  {
    id: 'todos',
    icon: '✅',
    label: 'Action items',
    hint: 'What to do next',
    prompt: 'List the action items implied by this video: things to do, try, buy, read or decide. Each one on its own line, phrased as an instruction, with any deadline or prerequisite mentioned. If the video implies no actions, say so plainly.',
  },
  {
    id: 'steps',
    icon: '🪜',
    label: 'Step-by-step guide',
    hint: 'Turn a how-to into instructions',
    prompt: 'Rewrite this video as a step-by-step guide someone could follow without watching it. Number the steps, include exact settings, commands, ingredients or values mentioned, and add a short "before you start" list of anything needed.',
  },
  {
    id: 'chapters',
    icon: '⏱️',
    label: 'Chapters',
    hint: 'Timestamped outline',
    prompt: 'Produce a timestamped chapter list for this video: `mm:ss — Title — one-line description`. Aim for a chapter every one to three minutes of content. Use only timestamps supported by the transcript.',
  },
  {
    id: 'notes',
    icon: '📚',
    label: 'Study notes',
    hint: 'Notes plus flashcards',
    prompt: 'Turn this video into study notes: a structured outline with headings, definitions of any term introduced, and then a "Flashcards" section of 8-12 question/answer pairs in the form `Q: … / A: …`.',
  },
  {
    id: 'quiz',
    icon: '🧠',
    label: 'Quiz me',
    hint: 'Check what stuck',
    prompt: 'Write a 10-question quiz on this video: a mix of multiple choice and short answer, ordered easy to hard. Put all the answers in an "Answers" section at the very end so they can be covered while answering.',
  },
  {
    id: 'claims',
    icon: '🔍',
    label: 'Check the claims',
    hint: 'What was asserted, and how solid',
    prompt: 'List the factual claims made in this video with timestamps. For each: state the claim in one line, then mark it Supported / Unsupported / Needs checking based only on what is in the video, and note what evidence the speaker gave. Be explicit that you are not verifying against outside sources.',
  },
  {
    id: 'post',
    icon: '📣',
    label: 'Write a post',
    hint: 'Share it somewhere',
    prompt: 'Write two shareable posts about this video: (1) a short punchy one, under 280 characters, and (2) a LinkedIn-style one of about 150 words with a hook, three concrete points and a closing line. No hashtags unless the topic really calls for them, no hype.',
    needsInput: false,
  },
  {
    id: 'extract',
    icon: '📋',
    label: 'Extract the details',
    hint: 'Names, numbers, links, code',
    prompt: 'Extract every concrete detail mentioned: names, products, prices, numbers, dates, URLs, commands, code, settings, book or paper titles. Group them under headings and keep the exact wording. If something was said but unclear in the transcript, mark it `(unclear)`.',
  },
  {
    id: 'translate',
    icon: '🌍',
    label: 'Translate',
    hint: 'Pick a language',
    inputLabel: 'Translate into…',
    inputPlaceholder: 'e.g. Spanish, Mandarin, Arabic',
    prompt: 'Translate the substance of this video into {{input}}. Give a full translated summary, then the key points, keeping names and technical terms in their original form with the translation in brackets on first use.',
  },
  {
    id: 'ask',
    icon: '💬',
    label: 'Ask about it',
    hint: 'Your own question',
    inputLabel: 'What do you want to know?',
    inputPlaceholder: 'e.g. What did they say about pricing?',
    prompt: '{{input}}',
  },
];

export function actionById(id) {
  return ACTIONS.find((a) => a.id === id) || null;
}

export function buildPrompt(action, input) {
  const text = action.prompt.replace('{{input}}', (input || '').trim());
  if (action.id === 'ask' && !input) return 'What is this video about?';
  return text;
}

function stamp(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** Transcript rendered for the model: timestamped lines when we have them. */
export function transcriptForModel(session, limit = 120000) {
  const t = session.transcript;
  if (!t) return '(No transcript available.)';
  let body;
  if (t.segments && t.segments.length) {
    body = t.segments.map((s) => `[${stamp(s.start)}] ${s.text}`).join('\n');
  } else {
    body = t.text;
  }
  if (body.length > limit) {
    const head = body.slice(0, Math.floor(limit * 0.6));
    const tail = body.slice(-Math.floor(limit * 0.35));
    body = `${head}\n\n[… middle of the transcript omitted because it exceeds the size sent to the model …]\n\n${tail}`;
  }
  return body;
}

export function systemPrompt(session, { hasFrames = false } = {}) {
  const meta = [
    `Title: ${session.title}`,
    `Recorded: ${new Date(session.createdAt).toLocaleString()}`,
    session.durationMs ? `Length: ${stamp(session.durationMs / 1000)}` : null,
    session.source ? `Source: ${session.source}` : null,
    session.notes ? `The person's own note: ${session.notes}` : null,
  ].filter(Boolean).join('\n');

  return [
    'You are helping someone work with a video they just watched and recorded on their phone.',
    'You are given the transcript of that recording' + (hasFrames ? ', plus a handful of still frames sampled evenly through it.' : '.'),
    '',
    'Ground every answer in the transcript. When something is inaudible, ambiguous or simply not covered, say so rather than filling the gap — a short honest answer beats a padded one.',
    'Cite timestamps in `[m:ss]` form when the transcript carries them. Match the transcript\'s language unless asked otherwise.',
    'Write in plain Markdown, no preamble about what you are about to do, and keep formatting light enough to read on a phone.',
    hasFrames ? 'The frames show what was on screen; use them for anything visual the words leave out, and say when a frame is what you are describing.' : '',
    '',
    '<video>',
    meta,
    '</video>',
    '',
    '<transcript>',
    transcriptForModel(session),
    '</transcript>',
  ].filter((line) => line !== '').join('\n');
}

export const SUGGEST_PROMPT =
  'Based on this specific video, suggest four things I might usefully ask you to do with it. ' +
  'Each on its own line, imperative, under nine words, no numbering, no bullets, no preamble. ' +
  'Make them specific to the content — not generic advice like "summarise it".';

export function parseSuggestions(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/^[\s\-*\d.)]+/, '').trim())
    .filter((l) => l.length > 3 && l.length < 90)
    .slice(0, 4);
}
