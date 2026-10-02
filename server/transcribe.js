// Provider adapters. Each returns the same shape: [{ text, start, end }] in seconds.
// Keys are read from the environment only (see .env.example) and never sent to the browser.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

async function form(file, fields) {
  const fd = new FormData();
  fd.append('file', new Blob([await readFile(file)]), basename(file));
  for (const [k, v] of Object.entries(fields)) [].concat(v).forEach(x => fd.append(k, x));
  return fd;
}

async function post(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const providers = {
  // ElevenLabs Scribe: words come back punctuated, with type word | spacing | audio_event
  async elevenlabs(file, { language, keyterms }) {
    const fields = { model_id: 'scribe_v2', timestamps_granularity: 'word', tag_audio_events: 'false' };
    if (language) fields.language_code = language;
    if (keyterms?.length) fields.keyterms = keyterms;
    const data = await post('https://api.elevenlabs.io/v1/speech-to-text',
      { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, await form(file, fields));
    return {
      language: data.language_code,
      words: data.words.filter(w => w.type === 'word').map(({ text, start, end }) => ({ text: text.trim(), start, end })),
    };
  },

  // OpenAI Whisper: word timestamps are unpunctuated, so punctuation is re-attached from the full text
  async openai(file, { language }) {
    const fields = { model: 'whisper-1', response_format: 'verbose_json', 'timestamp_granularities[]': 'word' };
    if (language) fields.language = language;
    const data = await post('https://api.openai.com/v1/audio/transcriptions',
      { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, await form(file, fields));
    const tokens = data.text.trim().split(/\s+/);
    const words = data.words.map(({ word, start, end }) => ({ text: word, start, end }));
    // ponytail: positional alignment, only when token counts agree; fuzzy alignment if Whisper splits differently
    if (tokens.length === words.length) words.forEach((w, i) => { w.text = tokens[i]; });
    return { language: data.language, words };
  },
};

export function pickProvider(name = process.env.TRANSCRIBE_PROVIDER) {
  if (name) {
    if (!providers[name]) throw new Error(`unknown provider "${name}", use: ${Object.keys(providers).join(', ')}`);
    return name;
  }
  if (process.env.ELEVENLABS_API_KEY) return 'elevenlabs';
  if (process.env.OPENAI_API_KEY) return 'openai';
  throw new Error('no transcription key: set ELEVENLABS_API_KEY or OPENAI_API_KEY in .env');
}

export const transcribe = (file, opts = {}) => providers[pickProvider(opts.provider)](file, opts);
