# X Reply Bot

Replies to **new original** posts from target accounts with an AI-generated one-liner (Harvard-DeFi persona).

## Quick start
\`\`\`bash
cp .env.example .env   # then put your real keys in .env (do NOT commit)
npm i
SEED=true npm run once      # mark current latest tweets as seen
DRY_RUN=true npm run once   # safe test, no posting
# set DRY_RUN=false in .env when ready to post
npm run once
\`\`\`

## Env vars
- \`X_APP_KEY\`, \`X_APP_SECRET\`, \`X_ACCESS_TOKEN\`, \`X_ACCESS_SECRET\`
- \`OPENAI_API_KEY\`
- \`USERS=0x_ultra,Talus_Labs,Cbb0fe\`
- \`USERS_IDS=924134809,1912085033902616577,1703332734603591680\`
- \`MAX_CHARS=220\`, \`LANGS=ru,en\`, \`STYLE=short, specific, a bit witty, 1 sentence\`
- \`FRESH_HOURS=24\`, \`MAX_PER_RUN=2\`
- \`DRY_RUN=true|false\`, \`SEED=true\` (run once)

## Notes
- Replies only to **fresh** originals (no RTs/replies).
- Handles **rate limits**: DRY_RUN safe, minimal read cooldown after 429.
- No “bot badge” unless you enable X’s Automated label.
