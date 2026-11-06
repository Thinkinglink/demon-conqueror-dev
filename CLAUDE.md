# Demon Conqueror + Revamp (handoff from the claude.ai chat, version 13.10.0)

## What this is
- `src/game.html`: the whole game in ONE file (three.js r128 from cdnjs). Demon Conqueror (Blox Fruits style open world) plus Revamp
  (a Roblox style platform with 50 built in 3D mini games, Isle of Six Crowns embedded as JSON in `<script id="isleSrc">`).
- Revamp only boots on `*.github.io` or with `?revamp=1`. Render and the desktop app show the original Demon Conqueror.
- `server/server.js`: Render server (socket.io). Accounts with scrypt passwords, token login, `rv:put` Revamp profile,
  offline gift inbox, Revamp chat rooms (`rv:join`, `rv:chat`), shared server bots (`rv:bot`), `/upload` page, `/play`.
- The server reads its code from env vars P1..P5 (gzip+base64 of server.js split in 5). `tools/render_env.py` makes them.

## Code layout inside game.html
Later modules wrap earlier functions by reassignment (`useSkillInner`, `doM1Inner`, `playerDamage`, `hitEnemy`,
`killEnemy`, `openNpc`, `fruitMaster`, `tick68`, `chatSend`). Search for these section markers:
`12.68` (stances, races, Ghoul, new fruits), `mod70` (materials, trees, inventory), `pot71` (potions),
`13.5: fruit reworks` (REWORK74, Creation quest + Forge, Control, Kitsune, Buddha), `13.6` (sword movesets SWORDS75, SWX76),
`13.7` (GUNS77), `13.8` (STYLES78), `13.9` (style quests and keys, REQ79, POST79), `13.10` (BOTS80 bots, triple swords),
then `REVAMP` (rv_ui, rv games, RV3 3D toolkit, live layer: names, weekly updates, bots, chat).
Saves are sanitized in `sanitize`: new save fields must be added there (see `d.x74`).

## Release workflow (every update)
1. Edit `src/game.html` (and `server/server.js` if needed). Bump nothing by hand.
2. `python3 tools/make_update.py <version>` -> `releases/Demon-Conqueror-<v>.dcupdate` and `releases/index.html`.
3. Upload the .dcupdate at the Render site `/upload`. Upload `releases/index.html` to the GitHub repo (Revamp site).
4. Only if server.js changed: `python3 tools/render_env.py`, paste P1..P5 into Render env, redeploy.

## Standing rules from the owner (must follow)
- Never leak secrets: no keys, tokens, passwords in code, files or git history. Scan before every upload.
  `PRIVATE-signing-key/` signs updates: NEVER commit or upload it (it is in .gitignore). On Claude Code on the web the key comes from the cloud environment variable UPD_PRIVATE_KEY instead; never print it or write it into the repo.
- Never trust a typed name or email for admin rights. Admin = signed in as `legitmasterzero` (with password).
- GitHub: at most one write every 5 minutes, one push per release, never retry pushes in a loop. Same 5 minute limit for Render.
- Prefer saving player stats locally; admin keeps control (bans, nerfs, accounts).
- No exact copies of Blox Fruits or Roblox assets; all art and models are original.
- Writing style for the owner: no hyphens or dashes in copy; make text large and readable.
