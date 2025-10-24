// bot.mjs
import 'dotenv/config';
import { TwitterApi } from 'twitter-api-v2';
import fs from 'node:fs';
import OpenAI from 'openai';

const env = (k, req = true) => {
  const v = process.env[k];
  if (!v && req) throw new Error(`Missing env: ${k}`);
  return v || '';
};

// -------- config --------
const USERS = (env('USERS') || '').split(',').map(s => s.trim()).filter(Boolean);
if (!USERS.length) throw new Error('USERS is empty (comma-separated usernames)');

// Optional: numeric IDs matching USERS order (skips username->id lookups)
const USERS_IDS = (process.env.USERS_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const MAX_CHARS   = parseInt(process.env.MAX_CHARS   || '220', 10);
const ALLOWED_LANGS = (process.env.LANGS || 'en').split(',').map(s => s.trim().toLowerCase());
const STYLE       = env('STYLE', false) || 'short, helpful, 1 sentence';
const FRESH_HOURS = parseInt(process.env.FRESH_HOURS || '24', 10);
const MAX_PER_RUN = parseInt(process.env.MAX_PER_RUN || '2', 10);
const DRY         = (process.env.DRY_RUN || '').toLowerCase() === 'true';
const SEED        = (process.env.SEED    || '').toLowerCase() === 'true';

// -------- state (anti-duplicate) --------
const STATE_FILE = './state.json';
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const save  = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

// cache for resolved IDs (username -> id)
const CACHE_FILE = './users.cache.json';
const userCache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
const saveCache = () => fs.writeFileSync(CACHE_FILE, JSON.stringify(userCache, null, 2));

// -------- OPTIONAL read cooldown (only after READ 429) --------
function now(){ return Date.now(); }
function readCooldownActive() { return state.readBlockUntil && now() < state.readBlockUntil; }
function setReadCooldown(fallbackMs = 10 * 60 * 1000) {  // 10 minutes
  state.readBlockUntil = now() + fallbackMs;
  save();
}

// -------- clients --------
const x  = new TwitterApi({
  appKey: env('X_APP_KEY'),
  appSecret: env('X_APP_SECRET'),
  accessToken: env('X_ACCESS_TOKEN'),
  accessSecret: env('X_ACCESS_SECRET'),
});
const ai = new OpenAI({ apiKey: env('OPENAI_API_KEY') });

// -------- helpers --------
function sanitize(s) {
  let out = s.replace(/@\w{1,50}/g, '@user').trim();
  const urls = out.match(/https?:\/\/\S+/g) || [];
  if (urls.length > 1) {
    let seen = false;
    out = out.replace(/https?:\/\/\S+/g, m => (seen ? '' : ((seen = true), m)));
  }
  return out.slice(0, MAX_CHARS);
}

async function generateReply({ author, text, url }) {
  const block = /(giveaway|airdrop|referral|casino|loan|signal|pump|bet)/i;
  if (block.test(text)) return null;

  const persona = `You are a Harvard-graduated DeFi/crypto researcher with a very strong technical background (smart contracts, L2s, MEV, risk), who writes crisp replies with a tiny dash of dry humor.`;
  const guardrails = `Stay helpful and non-promotional. No financial advice or guarantees. No hashtags. No emojis at the start. Max 1 link if a link is provided.`;

  const system = `${persona}
${guardrails}
Write ONE concise Twitter reply (${MAX_CHARS} chars max), ${STYLE}.
- Be relevant to the post.
- If the post is in one of [${ALLOWED_LANGS.join(', ')}], reply in that language; otherwise reply in English.
- Prefer a pointed micro-insight, quick sanity check, or a clarifying question rather than generic praise.
Return ONLY the reply text.`;

  const user = `Original post by @${author}:
"""
${text}
"""
Permalink: ${url || 'n/a'}
Now write the reply:`;

  const r = await ai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.5,
    max_tokens: 120,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
  });

  const raw = r.choices?.[0]?.message?.content?.trim();
  return raw ? sanitize(raw) : null;
}

function isFresh(createdAtIso, hours) {
  if (!createdAtIso) return false;
  const cutoff = Date.now() - hours * 3600 * 1000;
  return new Date(createdAtIso).getTime() >= cutoff;
}

// Use id if present, else username
const keyFor = (t) => t.id ? `id:${t.id}` : `u:${t.username}`;

// Build targets from USERS + (optional) USERS_IDS + cache; avoid lookups if possible
async function buildTargets() {
  // 1) If IDs were provided (same length), use them directly
  if (USERS_IDS.length && USERS_IDS.length === USERS.length) {
    return USERS.map((username, i) => ({ username, id: USERS_IDS[i] }));
  }

  // 2) Use cache for any usernames we’ve resolved before
  const missing = [];
  const out = USERS.map(username => {
    const id = userCache[username];
    if (!id) missing.push(username);
    return { username, id: id || null };
  });

  if (missing.length === 0) return out;

  // 3) Last resort: resolve via API (can 429 on low tiers)
  try {
    const r = await x.v2.usersByUsernames(missing, { 'user.fields': ['id', 'username'] });
    (r.data || []).forEach(u => { userCache[u.username] = u.id; });
    saveCache();
    return out.map(t => t.id ? t : ({ username: t.username, id: userCache[t.username] }));
  } catch (e) {
    if (e?.code === 429) {
      console.log('🧊 429 while resolving usernames. To avoid this, add USERS_IDS=... to .env in the same order as USERS.');
      // Return entries we can; others will use search fallback
      return out;
    }
    throw e;
  }
}

// Timeline by ID (new originals since last_seen, oldest→newest) + cooldown
async function fetchNewOriginalsById(userId, sinceId, freshHours) {
  if (readCooldownActive()) return [];
  const params = { exclude: ['retweets', 'replies'], max_results: 10, 'tweet.fields': ['created_at'] };
  if (sinceId) params.since_id = sinceId;

  try {
    const tl = await x.v2.userTimeline(userId, params);
    const tweets = tl.tweets || [];
    const fresh = tweets.filter(t => isFresh(t.created_at, freshHours));
    return fresh.reverse();
  } catch (e) {
    if (e?.code === 429) {
      console.log(`🧊 429 on userTimeline(${userId}) — pausing reads ~10m`);
      setReadCooldown(); // 10 minutes
      return [];
    }
    throw e;
  }
}

// Search by username (no ID needed) — new originals since last_seen, oldest→newest + cooldown
async function fetchNewOriginalsByUsername(username, sinceId, freshHours) {
  if (readCooldownActive()) return [];
  const query = `from:${username} -is:retweet -is:reply`;
  const params = { max_results: 10, 'tweet.fields': ['created_at'] };
  if (sinceId) params.since_id = sinceId;

  try {
    const res = await x.v2.search(query, params);
    const tweets = res.tweets || [];
    const fresh = tweets.filter(t => isFresh(t.created_at, freshHours));
    return fresh.reverse();
  } catch (e) {
    if (e?.code === 429) {
      console.log(`🧊 429 on search(from:${username}) — pausing reads ~10m`);
      setReadCooldown(); // 10 minutes
      return [];
    }
    throw e;
  }
}

async function reply(tweetId, text, authorUsername) {
  if (!text) return;

  if (DRY) {
    console.log(`[DRY_RUN] Would reply to ${tweetId} (@${authorUsername}): ${text}`);
    return;
  }

  try {
    await x.v2.tweet({ text, reply: { in_reply_to_tweet_id: tweetId } });
  } catch (e) {
    if (e?.code === 429) {
      const headers = e.headers || {};
      const userReset = headers['x-user-limit-24hour-reset'];
      const resetTs = userReset ? Number(userReset) * 1000 : null;
      const until = resetTs ? new Date(resetTs).toLocaleString() : 'later';
      console.log(`🚦 429 (write cap). Posting blocked until ${until}.`);
      return;
    }
    throw e;
  }
}

// Seed “last_seen = current latest” without replying
async function seedLastSeen(targets) {
  let changed = false;
  for (const u of targets) {
    const key = keyFor(u);
    const list = u.id
      ? await fetchNewOriginalsById(u.id, undefined, 24 * 365)
      : await fetchNewOriginalsByUsername(u.username, undefined, 24 * 365);
    const last = list.length ? list[list.length - 1] : null;
    if (last && state[key] !== last.id) {
      state[key] = last.id;
      changed = true;
      console.log(`🌱 Seeded @${u.username}: last_seen=${last.id} (${last.created_at})`);
    } else {
      console.log(`🌱 Nothing to seed for @${u.username}`);
    }
  }
  if (changed) save();
}

// -------- main --------
(async () => {
  console.log(`Mode: ${DRY ? 'DRY_RUN (no posting)' : 'LIVE (will post)'} | FRESH_HOURS=${FRESH_HOURS} | MAX_PER_RUN=${MAX_PER_RUN}`);

  const targets = await buildTargets();
  if (targets.length === 0) {
    console.log('No targets available. Ensure USERS is set; optionally add USERS_IDS to avoid lookups.');
    process.exit(0);
  }

  if (SEED) {
    await seedLastSeen(targets);
    process.exit(0);
  }

  for (const u of targets) {
    const key = keyFor(u);
    const last = state[key];

    const news = u.id
      ? await fetchNewOriginalsById(u.id, last, FRESH_HOURS)
      : await fetchNewOriginalsByUsername(u.username, last, FRESH_HOURS);

    console.log(`@${u.username} — key=${key} | last_seen=${last || '∅'} | new_count=${news.length}`);

    if (news.length === 0) {
      console.log(`— No fresh originals for @${u.username}`);
      continue;
    }

    let processed = 0;
    for (const t of news) {
      if (processed >= MAX_PER_RUN) break;

      const url = `https://x.com/${u.username}/status/${t.id}`;
      const txt = await generateReply({ author: u.username, text: t.text || '', url });

      if (txt) {
        await reply(t.id, txt, u.username);

        // Advance last_seen after each item (even in DRY we advance to avoid backlog).
        state[key] = t.id;
        save();

        console.log(`✅ ${DRY ? 'Would have replied' : 'Replied'} to @${u.username} → ${t.id} (${t.created_at})`);
        processed++;
        await new Promise(r => setTimeout(r, 1500));
      } else {
        console.log(`— Skipped (AI returned nothing) for @${u.username} on ${t.id}`);
      }
    }
  }
})().catch(e => {
  console.error('✗ Error:', e);
  process.exit(1);
});
