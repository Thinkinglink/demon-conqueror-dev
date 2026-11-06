// Demon Conqueror multiplayer server: node server.js  → http://localhost:3000
// Rooms: everyone starts in 'public'; a party is a private room with a 5-letter code. Players in a room fight the same enemies.
// Cloud accounts: one save per username, shared by every device that signs in with that username (no password).
const app = require('express')(), http = require('http').createServer(app), io = require('socket.io')(http, { cors: { origin: '*' }, maxHttpBufferSize: 2e6 });
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ADMINS = ['legitmasterzero'];
const serverState = {};                                          // socket id → latest move packet + its room
let joins = 0;
const members = r => Object.keys(serverState).filter(id => serverState[id].room === r).sort((a, b) => serverState[a].since - serverState[b].since);   // join order: the first one in is the host
const roomInfo = r => { const ids = members(r); io.to(r).emit('room', { code: r === 'public' ? null : r, host: ids[0] || null, members: ids.map(id => ({ id, name: serverState[id].name || 'Player', lv: serverState[id].lv || 1 })) }); };
const newCode = () => { let c; do c = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.random() * 32 | 0]).join(''); while (members(c).length); return c; };

// ---------- cloud saves: one JSON file, written a moment after each change ----------
// SAVE_FILE can point at a persistent disk; on hosts that wipe files on redeploy, players' devices upload their save again when they reconnect.
const SAVE_FILE = process.env.SAVE_FILE || path.join(__dirname, 'saves.json');
let saves = {}; try { saves = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')); } catch (_) {}
let writeTimer = null;
// trading: posted trades live in the same save file; items in a trade are held here until it ends, then delivered to the right inbox
const market = saves['#market'] ||= { next: 1, posts: [] };
let seat = null;                                                // the player sitting at the Trade Table, waiting for a partner
const okItem = it => !!it && typeof it === 'object' && (['beli', 'fragments'].includes(it.k) ? Number(it.n) > 0 : ['fruit', 'item'].includes(it.k) && typeof it.id === 'string' && it.id.length < 40);
const notify = (k, ev, d) => { for (const id in serverState) if (serverState[id].acct === k) io.to(id).emit(ev, d); };
// standing rule: the server writes its save file at most once every 5 minutes (players' progress lives on their own devices first)
const WRITE_GAP = 5 * 60 * 1000; let lastWrite = 0;
const flushSaves = () => { writeTimer = null; lastWrite = Date.now(); const tmp = SAVE_FILE + '.tmp'; fs.writeFile(tmp, JSON.stringify(saves), e => { if (!e) fs.rename(tmp, SAVE_FILE, () => {}); }); };
const persist = () => { if (!writeTimer) writeTimer = setTimeout(flushSaves, Math.max(1500, WRITE_GAP - (Date.now() - lastWrite))); };
// admin: the account signed in as legitmasterzero (no admin key, by the owner's choice)
const adminOk = me => ADMINS.includes(me && me.acct);
const okGift = g => !!g && typeof g === 'object' && typeof g.kind === 'string' && g.kind.length < 20 && (g.id === undefined || (typeof g.id === 'string' && g.id.length < 60)) && (g.n === undefined || Number.isFinite(+g.n));
const pwHash = p => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(String(p), salt, 32).toString('hex'); };
const pwOk = (a, p) => { try { const [salt, h] = a.pw.split(':'), x = crypto.scryptSync(String(p), salt, 32); return crypto.timingSafeEqual(x, Buffer.from(h, 'hex')); } catch (_) { return false; } };
const USER_RE = /^[A-Za-z0-9_]{3,20}$/, keyOf = u => String(u || '').toLowerCase();
const authed = (q = {}) => { const a = saves[keyOf(q.user)]; return a && typeof q.token === 'string' && a.token.length === q.token.length && crypto.timingSafeEqual(Buffer.from(a.token), Buffer.from(q.token)) ? a : null; };

app.get('/', (_, res) => res.set('Access-Control-Allow-Origin', '*').send('Demon Conqueror server running'));
// ---------- game updates: the newest signed copy of the game lives here; /play serves it, apps download it ----------
const UPD_PUB = crypto.createPublicKey({ key: Buffer.from('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEm9QoRiytvAC6+ZW+WoWiXOXTolZzwX1uMcUl1+xS39c5mekqtBWXuGCjUkY6OKDdPBBfgnuJfSv0GO3EDC25NQ==', 'base64'), format: 'der', type: 'spki' });
const vNum = v => String(v).split('.').map(n => +n || 0), newer = (a, b) => { const x = vNum(a), y = vNum(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
const updOk = u => { try { return u && typeof u.v === 'string' && typeof u.gz === 'string' && typeof u.sig === 'string' && crypto.verify('sha256', Buffer.from(u.v + '\n' + u.gz), { key: UPD_PUB, dsaEncoding: 'ieee-p1363' }, Buffer.from(u.sig, 'base64')); } catch (_) { return false; } };
const updCur = () => (saves.dcupd_latest || {}).save || null;
const updPut = u => { if (!updOk(u)) return 'That is not a genuine Demon Conqueror update file.'; const c = updCur(); if (c && !newer(u.v, c.v)) return c.v === u.v ? 'ok' : `The server already has a newer version (${c.v}).`;
  saves.dcupd_latest = { user: 'dcupd_latest', display: 'Updates', token: crypto.randomBytes(24).toString('hex'), save: { v: u.v, gz: u.gz, sig: u.sig }, at: Date.now(), created: Date.now() }; persist(); return 'ok'; };
app.get('/play', (_, res) => { const c = playCur(); if (!c) return res.status(503).send('<p style="font:18px sans-serif;padding:24px">No game uploaded yet. Open /upload and choose the update file.</p>'); res.type('html').send(require('zlib').gunzipSync(Buffer.from(c.gz, 'base64'))); });
app.get('/upload', (_, res) => res.type('html').send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Demon Conqueror</title><body style="font:17px system-ui;max-width:560px;margin:40px auto;padding:0 16px;background:#081326;color:#f4ecd8"><h1 style="color:#ffdb7d">Demon Conqueror</h1><p>Upload the newest Demon Conqueror update.</p><p>Server has version: <b id=v>${(updCur() || {}).v || 'none'}</b></p><p>Choose the update file Claude sent you (it ends in <b>.dcupdate</b>).</p><input type=file id=f accept=".dcupdate,.json"><p id=m></p><p><a style="color:#8ef0c2" href="/play">Play Demon Conqueror</a></p><script>f.onchange=async()=>{m.textContent='Uploading...';try{const r=await fetch('/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:await f.files[0].text()});const t=await r.text();m.textContent=t==='ok'?'Done! The server now has the new version. Apps update themselves within a few minutes.':t;if(t==='ok')v.textContent=JSON.parse(await f.files[0].text()).v}catch(e){m.textContent='Upload failed: '+e.message}}</script>`));
app.post('/upload', require('express').text({ type: '*/*', limit: '5mb' }), (req, res) => { let u = null; try { u = JSON.parse(req.body); } catch (_) {} res.send(updPut(u)); });   // the game reads this to check an address really is a game server
// ---------- Revamp bots: shared by everyone in the same game, simulated only while real players are in that game ----------
const RVG = ['parkour', 'tycoon', 'rpg', 'romance', 'racing', 'defense', 'fishing', 'farming', 'survivor', 'puzzle'], RVB = {};
const pick = a => a[Math.random() * a.length | 0];
const B_A = ['Swift', 'Lucky', 'Pixel', 'Turbo', 'Cosmic', 'Sunny', 'Shadow', 'Frosty', 'Mighty', 'Sneaky', 'Happy', 'Blazing', 'Tiny', 'Epic', 'Silly', 'Royal', 'Neon', 'Crispy', 'Fluffy', 'Hyper'],
  B_B = ['Panda', 'Ninja', 'Taco', 'Dragon', 'Otter', 'Comet', 'Wizard', 'Pickle', 'Falcon', 'Bean', 'Rocket', 'Kitty', 'Golem', 'Muffin', 'Shark', 'Llama', 'Robot', 'Noodle', 'Fox', 'Bunny'];
const newBot = () => ({ n: pick(B_A) + pick(B_B) + (Math.random() * 999 | 0), s: 1 + (Math.random() * 1e9 | 0) });
const B_TALK = { parkour: ['that jump was so close', 'anyone past stage 10?', 'the moving platforms are tricky', 'i keep falling lol', 'speedrun time', 'green platforms bounce you really high'],
  tycoon: ['just bought another helper', 'rebirth is worth it', 'my income is going crazy', 'saving up for the big one', 'golden deliveries are the best'],
  rpg: ['boss down!', 'need more potions', 'the shop armour is good', 'leveling up fast today', 'my pet just did 40 damage'], romance: ['this story is so cute', 'who did you pick?', 'the ending made me smile', 'chapter 3 is my favourite', 'aww'],
  racing: ['gg that was close', 'grip upgrade helps a lot', 'brake before the corners', 'new lap record!', 'who wants a rematch?'], defense: ['frost towers slow them down', 'wave 10 incoming', 'build near the corners', 'three stars!', 'the boss wave is tough'],
  fishing: ['got a rare one!', 'patience is key', 'better rod = better fish', 'nothing biting here', 'my bag is full'], farming: ['harvest time', 'just bought more land', 'golden crops are worth it', 'my farm is huge now', 'planting everything'],
  survivor: ['so many enemies', 'extra shot is the best power', 'made it to 3 minutes!', 'stay moving', 'gems everywhere'], puzzle: ['huge combo!', 'one move left...', 'got three stars', 'this level is hard', 'chain reaction!'] };
const B_ANY = ['hi everyone', 'this update is cool', 'love this game', 'brb', 'gg', 'anyone else here?', 'nice', 'lets goo', 'this place looks amazing'];
// what bots know about each game, so they can answer questions
const B_KB = { parkour: [[/jump|double/, 'press jump again in the air if your game has double jump'], [/fall|die|hard/, 'look for checkpoints and slow down before small platforms'], [/coin/, 'coins float above platforms, golden coins count 3'], [/stage|level/, 'every stage gets longer and the platforms start moving']],
  tycoon: [[/rich|money|fast|earn/, 'buy the cheapest helper first, then rebirth at 1M for a permanent boost'], [/rebirth/, 'rebirth resets your money but everything earns 0.5x more forever'], [/click/, 'stronger clicks are good early, helpers win later'], [/offline|away/, 'you earn money while you are away too']],
  rpg: [[/boss/, 'win 5 battles in a zone to unlock its boss'], [/level|xp/, 'fight in the newest zone you unlocked for the most XP'], [/potion|heal/, 'potions heal half your HP, buy them in the shop'], [/weapon|armou?r|shop/, 'upgrade your weapon first, then armour']],
  romance: [[/ending|end/, 'the friend you spend the most time with gets the ending'], [/heart|like/, 'rainy day and worries chapters give the most hearts'], [/pick|choose|who/, 'pick whoever you like, every ending is cute']],
  racing: [[/win|fast|first/, 'upgrade the engine for speed and grip for corners'], [/corner|turn|crash/, 'let go of the gas before sharp corners'], [/nitro|boost/, 'press Shift for nitro if your game has it'], [/track|unlock/, 'win a track to unlock the next one']],
  defense: [[/tower|best|build/, 'put towers near the bends of the path so they shoot longer'], [/boss/, 'catapults splash the crowds, archers finish the boss'], [/money|upgrade/, 'tap a tower to upgrade it, it is often better than a new one'], [/star/, 'keep 18 lives for three stars']],
  fishing: [[/catch|bite|how/, 'tap when it says BITE, then hold to keep the green zone on the fish'], [/rare|legend/, 'better rods find rarer fish'], [/money|sell|coin/, 'sell your bag, rare fish are worth way more']],
  farming: [[/grow|plant|how/, 'pick a crop at the bottom then tap an empty plot'], [/money|coin|rich/, 'harvest, sell, then buy more land'], [/level|unlock/, 'harvesting gives farm XP and unlocks better crops']],
  survivor: [[/survive|how|die/, 'keep moving in circles and pick up the blue gems'], [/power|level/, 'extra shot and fire rate are the strongest powers'], [/gold|upgrade/, 'spend gold in the menu on permanent upgrades']],
  puzzle: [[/how|play|swap/, 'tap a gem, then tap the one next to it to swap'], [/combo|score/, 'matches near the bottom cause bigger chain reactions'], [/star/, 'finish with moves left to get more stars']] };
function botReply(t, g, who) { const s = t.toLowerCase(), kb = (B_KB[g] || []).find(([re]) => re.test(s));
  if (/\b(are you|r u|you)\b.*\b(bot|ai|real|human)\b|\bbot\b/.test(s)) return `yes ${who}, I'm a Revamp bot. I play this game all day and know a lot about it!`;
  if (kb) return `${who}, ${kb[1]}`; if (/\b(hi|hello|hey|yo|sup|hiya)\b/.test(s)) return pick([`hey ${who}!`, `hi ${who} :)`, `welcome ${who}!`]);
  if (/\b(bye|cya|leaving)\b/.test(s)) return pick([`bye ${who}!`, 'see you next update']); if (/\b(friend|team|play with)\b/.test(s)) return `sure ${who}, I'll stay in this server with you`;
  if (/\b(gg|nice|cool|wow|awesome)\b/.test(s)) return pick(['thanks!', 'gg!', 'right?!']); if (/\b(lol|haha|xd)\b/.test(s)) return pick(['haha', 'lol same']);
  if (/\?\s*$/.test(s)) return pick(['good question! try it and see', 'I think so', 'not sure, ask me about tips!']); return Math.random() < .5 ? pick(B_ANY) : null; }
setInterval(() => { for (const r in RVB) { const room = io.sockets.adapter.rooms.get(r), R = RVB[r]; if (!room || !room.size) { delete RVB[r]; continue; } if ((R.t -= 2) > 0) continue; R.t = 6 + Math.random() * 10; const x = Math.random();
    if (x < .12 && R.bots.length > 3) { const b = R.bots.splice(Math.random() * R.bots.length | 0, 1)[0]; io.to(r).emit('rv:bot', { k: 'leave', n: b.n, s: b.s }); }
    else if (x < .25 && R.bots.length < 10) { const b = newBot(); R.bots.push(b); io.to(r).emit('rv:bot', { k: 'join', n: b.n, s: b.s }); setTimeout(() => R.bots.includes(b) && io.to(r).emit('rv:bot', { k: 'say', n: b.n, s: b.s, t: pick(['hi!', 'hey all', 'just joined :)']) }), 2000); }
    else { const b = pick(R.bots); if (b) io.to(r).emit('rv:bot', { k: 'say', n: b.n, s: b.s, t: Math.random() < .7 ? pick(B_TALK[R.g]) : pick(B_ANY) }); } } }, 2000);
io.on('connection', s => {
  serverState[s.id] = { room: 'public', since: ++joins }; s.join('public'); roomInfo('public');
  const go = r => { const old = serverState[s.id].room; if (old !== r) { s.leave(old); s.join(r); serverState[s.id].room = r; serverState[s.id].since = ++joins; roomInfo(old); } roomInfo(r); };
  // Revamp in-game chat: one room per game, signed-in players only, 1 message every 1.5 s, plain text up to 120 characters
  let rvRoom = null, chatT = 0;
  s.on('rv:join', (g, ack) => { const id = g && typeof g === 'object' ? g.id : g, gen = g && RVG.includes(g.genre) ? g.genre : 'parkour', r = typeof id === 'string' && /^[A-Za-z0-9]{1,24}$/.test(id) ? 'rv_' + id : null; if (rvRoom) s.leave(rvRoom); rvRoom = r; if (!r) return; s.join(r);
    const R = RVB[r] ||= { g: gen, t: 4, bots: Array.from({ length: 5 + (Math.random() * 4 | 0) }, newBot) }; if (typeof ack === 'function') ack({ players: (io.sockets.adapter.rooms.get(r) || { size: 1 }).size, bots: R.bots }); });
  s.on('rv:chat', (m = {}) => { const me = serverState[s.id], now = Date.now(); if (!rvRoom || !me || !me.acct || now - chatT < 1500) return; chatT = now;
    const t = String((m && m.t) || '').replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, 120).trim(); if (!t) return; const room = rvRoom, who = String(me.acct).slice(0, 20); s.to(room).emit('rv:chat', { n: who, t });
    setTimeout(() => { const R = RVB[room]; if (!R || !R.bots.length) return; const b = pick(R.bots), rep = botReply(t, R.g, who); if (rep) io.to(room).emit('rv:bot', { k: 'say', n: b.n, s: b.s, t: rep }); }, 1200 + Math.random() * 2500); });
  s.on('upd:get', (q, ack = () => {}) => ack(updCur()));
  s.on('upd:put', (u, ack = () => {}) => ack(updPut(u)));
  s.on('move', d => { const me = serverState[s.id], named = me.name !== d.name || me.lv !== d.lv; Object.assign(me, d, { room: me.room, since: me.since, acct: me.acct }); if (named) roomInfo(me.room); });

  // sign in by username alone (no password): {user, display} → {ok, isNew, token, save, at}. The same username on any device is the same account.
  s.on('acct:login', (q = {}, ack = () => {}) => {
    const user = String(q.user || '').trim(); if (!USER_RE.test(user)) return ack({ ok: false, msg: 'Username must be 3-20 letters, numbers or underscores.' });
    const k = keyOf(user); if (k === 'dcupd_latest') return ack({ ok: true, save: updCur(), token: '' }); let a = saves[k], isNew = false;
    const pw = typeof q.pw === 'string' ? q.pw : null, tokOk = a && typeof q.token === 'string' && q.token.length === a.token.length && crypto.timingSafeEqual(Buffer.from(a.token), Buffer.from(q.token));
    if (pw !== null && (pw.length < 4 || pw.length > 64)) return ack({ ok: false, msg: 'Password must be 4 to 64 characters.' });
    if (q.create && a && a.pw) return ack({ ok: false, msg: 'That username is taken. Log in instead.' });
    if (q.login && !a) return ack({ ok: false, msg: 'No account has that username. Create one.' });
    if (a && a.pw && !tokOk) { if (pw === null) return ack({ ok: false, needPw: true, msg: 'This account has a password.' }); if (!pwOk(a, pw)) return ack({ ok: false, msg: 'Wrong password.' }); }
    if (a && !a.pw && pw !== null) { a.pw = pwHash(pw); if (q.display) a.display = String(q.display).slice(0, 20); persist(); }      // an older account (no password yet) is claimed: all its progress is kept
    if (!a && pw !== null) { a = saves[k] = { user, display: String(q.display || user).slice(0, 20), token: crypto.randomBytes(24).toString('hex'), save: null, at: 0, created: Date.now(), pw: pwHash(pw) }; isNew = true; persist(); }
    if (!a) { a = saves[k] = { user, display: String(q.display || user).slice(0, 20), token: crypto.randomBytes(24).toString('hex'), save: null, at: 0, created: Date.now() }; isNew = true; persist(); }
    serverState[s.id].acct = k;
    ack({ ok: true, isNew, user: a.user, display: a.display, token: a.token, save: a.save, at: a.at, rv: a.rv || null });
  });
  // Revamp profile (avatar, favourites, game progress): saved on the device first; uploaded at most once every 5 minutes by the client
  s.on('rv:put', (q = {}, ack = () => {}) => { const a = authed(q); if (!a) return ack({ ok: false }); try { const j = JSON.stringify(q.rv || {}); if (j.length > 200000) return ack({ ok: false, msg: 'Too big.' }); a.rv = JSON.parse(j); } catch (_) { return ack({ ok: false }); } persist(); ack({ ok: true }); });
  // after a server wipe (a host that clears files on redeploy) a device puts its account back with its save
  s.on('acct:restore', (q = {}, ack = () => {}) => {
    const user = String(q.user || ''), k = keyOf(user);
    if (saves[k]) return ack({ ok: false, msg: 'That account already exists.' });
    if (!USER_RE.test(user) || !/^[0-9a-f]{48}$/.test(q.token || '')) return ack({ ok: false, msg: 'Sign in again.' });
    saves[k] = { user, display: String(q.display || user).slice(0, 20), token: q.token, save: q.save && typeof q.save === 'object' ? q.save : null, at: Number(q.at) || 0, created: Date.now() }; persist();
    serverState[s.id].acct = k; ack({ ok: true });
  });
  // latest cloud save for a signed-in device: {user, token} → {ok, save, at}
  s.on('acct:pull', (q = {}, ack = () => {}) => { if (!saves[keyOf(q.user)]) return ack({ ok: false, missing: true }); const a = authed(q); if (!a) return ack({ ok: false, msg: 'Sign in again.' }); serverState[s.id].acct = keyOf(q.user); ack({ ok: true, save: a.save, at: a.at }); });
  // upload progress: {user, token, save, at}; an older save never replaces a newer one
  s.on('acct:push', (q = {}, ack = () => {}) => {
    if (!saves[keyOf(q.user)]) return ack({ ok: false, missing: true });
    const a = authed(q); if (!a) return ack({ ok: false, msg: 'Sign in again.' });
    serverState[s.id].acct = keyOf(q.user);
    const at = Number(q.at) || 0; if (!q.save || typeof q.save !== 'object') return ack({ ok: false, msg: 'Nothing to save.' });
    if (at < a.at) return ack({ ok: true, stale: true, at: a.at });
    a.save = q.save; a.at = at; if (q.display) a.display = String(q.display).slice(0, 20); persist();
    ack({ ok: true, at });
  });

  // ---------- Trade Table ----------
  const who = () => serverState[s.id].acct, nm = () => serverState[s.id].name || (saves[who()] || {}).display || 'Player';
  const need = ack => { if (who() && saves[who()]) return true; ack({ ok: false, msg: 'Play an online account first: type your username in Main Menu → Accounts while connected.' }); return false; };
  const deliver = (k, it, note) => { const a = saves[k]; if (!a) return; (a.inbox ||= []).push({ it, note }); notify(k, 'market:inbox', {}); };
  s.on('market:list', (q, ack = () => {}) => { const k = who(); ack({ ok: true, posts: market.posts.map(p => ({ id: p.id, sellerName: p.sellerName, item: p.item, mine: p.seller === k, offers: p.seller === k ? p.offers.map(o => ({ id: o.id, buyerName: o.buyerName, item: o.item })) : p.offers.length })) }); });
  s.on('market:post', (q = {}, ack = () => {}) => { if (!need(ack)) return; const k = who();
    if (!okItem(q.item)) return ack({ ok: false, msg: 'That cannot be traded.' }); if (market.posts.filter(p => p.seller === k).length >= 5) return ack({ ok: false, msg: 'You can post up to 5 trades.' });
    market.posts.push({ id: market.next++, seller: k, sellerName: nm(), item: q.item, offers: [], at: Date.now() }); persist(); ack({ ok: true }); });
  s.on('market:offer', (q = {}, ack = () => {}) => { if (!need(ack)) return; const p = market.posts.find(p => p.id === q.id);
    if (!p) return ack({ ok: false, msg: 'That trade is gone.' }); if (p.seller === who()) return ack({ ok: false, msg: 'That is your own trade.' }); if (!okItem(q.item)) return ack({ ok: false, msg: 'That cannot be traded.' });
    const o = { id: market.next++, buyer: who(), buyerName: nm(), item: q.item }; p.offers.push(o); persist(); notify(p.seller, 'market:offer', { buyerName: o.buyerName, item: o.item, for: p.item }); ack({ ok: true }); });
  s.on('market:answer', (q = {}, ack = () => {}) => { if (!need(ack)) return; const i = market.posts.findIndex(p => p.id === q.id && p.seller === who()), p = market.posts[i], o = p && p.offers.find(o => o.id === q.offerId);
    if (!o) return ack({ ok: false, msg: 'That offer is gone.' });
    if (q.accept) { deliver(o.buyer, p.item, `${p.sellerName} accepted your trade`); deliver(p.seller, o.item, `Trade with ${o.buyerName} complete`); p.offers.filter(x => x !== o).forEach(x => deliver(x.buyer, x.item, `${p.sellerName} traded with someone else, so your offer came back`)); market.posts.splice(i, 1); }
    else { deliver(o.buyer, o.item, `${p.sellerName} declined your offer, so it came back`); p.offers = p.offers.filter(x => x !== o); }
    persist(); ack({ ok: true }); });
  s.on('market:cancel', (q = {}, ack = () => {}) => { if (!need(ack)) return; const i = market.posts.findIndex(p => p.id === q.id && p.seller === who()); if (i < 0) return ack({ ok: false, msg: 'That trade is gone.' });
    const p = market.posts[i]; deliver(p.seller, p.item, 'Your posted item came back'); p.offers.forEach(x => deliver(x.buyer, x.item, `${p.sellerName} took their trade down, so your offer came back`)); market.posts.splice(i, 1); persist(); ack({ ok: true }); });
  s.on('market:claim', (q, ack = () => {}) => { const a = saves[who()], items = (a && a.inbox) || []; if (a && items.length) { a.inbox = []; persist(); } ack({ ok: true, items }); });
  // live trade: two players sit at the table; each puts items down; when both press Ready, the server swaps them
  s.on('trade:sit', (q, ack = () => {}) => { if (!need(ack)) return; const me = serverState[s.id]; if (me.tp) return ack({ ok: true });
    const o = seat && seat !== s.id && serverState[seat] && !serverState[seat].tp ? seat : null;
    if (o) { seat = null; me.tp = o; serverState[o].tp = s.id; me.tItems = []; serverState[o].tItems = []; me.tReady = serverState[o].tReady = false; io.to(o).emit('trade:start', { name: nm() }); s.emit('trade:start', { name: serverState[o].name || 'Player' }); }
    else seat = s.id;
    ack({ ok: true }); });
  s.on('trade:offer', items => { const me = serverState[s.id], o = serverState[me.tp]; if (!o) return; me.tItems = Array.isArray(items) ? items.filter(okItem).slice(0, 8) : []; me.tReady = o.tReady = false; io.to(me.tp).emit('trade:offer', me.tItems); });
  s.on('trade:ready', () => { const me = serverState[s.id], o = serverState[me.tp]; if (!o) return; me.tReady = true; io.to(me.tp).emit('trade:ready');
    if (o.tReady) { s.emit('trade:done', { get: o.tItems }); io.to(me.tp).emit('trade:done', { get: me.tItems }); o.tp = null; me.tp = null; } });
  const leaveTable = () => { if (seat === s.id) seat = null; const me = serverState[s.id], o = me && serverState[me.tp]; if (o) { io.to(me.tp).emit('trade:end'); o.tp = null; } if (me) me.tp = null; };
  s.on('trade:leave', leaveTable);

  s.on('party', (q = {}, ack = () => {}) => {                   // {code:'new'} creates, {code:'AB12C'} joins, {code:null} leaves to public
    let code = q.code;
    if (code === 'new') code = newCode();
    else if (!code) code = 'public';
    else { code = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); if (!q.rejoin && !members(code).length) return ack({ ok: false, msg: 'No party with that code is open.' }); }
    if (code !== 'public' && members(code).length >= 8 && serverState[s.id].room !== code) return ack({ ok: false, msg: 'That party is full (8 players).' });
    go(code); ack({ ok: true, code: code === 'public' ? null : code });
  });
  // admin gifts: only a device signed in to the owner account (with its password) may send them, and only to a player in the same room
  s.on('gift', (q = {}, ack = () => {}) => { const me = serverState[s.id];
    if (!adminOk(me)) return ack({ ok: false, msg: 'Only the admin can give items (sign in to the admin account).' });
    if (!okGift(q.g)) return ack({ ok: false, msg: 'That gift is not valid.' });
    const g = { kind: q.g.kind, id: q.g.id, n: q.g.n === undefined ? undefined : +q.g.n };
    if (q.toUser !== undefined) {               // by username: works even when that player is offline; it waits in their inbox until they next connect
      const k = keyOf(q.toUser), a = saves[k]; if (!USER_RE.test(String(q.toUser)) || !a || k.startsWith('#') || k === 'dcupd_latest') return ack({ ok: false, msg: 'No player has that username.' });
      a.inbox = (a.inbox || []).concat({ g, from: me.name || 'Admin', at: Date.now() }).slice(-100); persist(); notify(k, 'gift:pending', {}); return ack({ ok: true, user: a.display || a.user }); }
    const to = serverState[q.to]; if (!to || to.room !== me.room) return ack({ ok: false, msg: 'That player is not in your room any more.' });
    io.to(q.to).emit('gift', { g, from: me.name || 'Admin', acct: me.acct }); ack({ ok: true }); });
  // a player collects the admin gifts waiting in their inbox (needs their own account token)
  s.on('gift:claim', (q = {}, ack = () => {}) => { const a = authed(q); if (!a) return ack({ ok: false }); const list = a.inbox || []; if (list.length) { a.inbox = []; persist(); } ack({ ok: true, gifts: list }); });
  s.on('requestMount', d => { const me = serverState[s.id], t = serverState[d && d.targetId]; if (t && t.room === me.room && t.tf) { me.rd = d.targetId; io.to(me.room).emit('mountConfirmed', { passengerId: s.id, targetId: d.targetId }); } });
  s.on('dismount', () => { const me = serverState[s.id]; me.rd = 0; io.to(me.room).emit('mountConfirmed', { passengerId: s.id, targetId: null }); });
  for (const ev of ['hit', 'mobs', 'action', 'transform', 'raceAction', 'fruit', 'castV']) s.on(ev, d => s.to(serverState[s.id].room).emit(ev, { ...d, id: s.id }));   // shared damage, host enemy positions, Haki / forms / race tiers, ground fruits
  for (const ev of ['pvp', 'pvpKill']) s.on(ev, (q = {}) => { const to = serverState[q.to]; if (to && to.room === serverState[s.id].room) io.to(q.to).emit(ev, { ...q, from: s.id, name: serverState[s.id].name || 'Player' }); });
  s.on('disconnect', () => { leaveTable(); const r = serverState[s.id].room; delete serverState[s.id]; roomInfo(r); });
});
// 45 Hz: each room only receives its own players
setInterval(() => { const by = {}; for (const id in serverState) (by[serverState[id].room] ||= {})[id] = serverState[id]; for (const r in by) io.to(r).emit('stateUpdate', by[r]); }, 1000 / 45);
// ---------- auto-update: every 3 minutes the server looks for a newer game on the Claude page and in the Google Drive folder, so /play is always the newest version ----------
const zlib = require('zlib'), AUTO_CLAUDE = 'https://ee9b85e1-cb79-408f-942a-10f8001158cb.frame.claudeusercontent.com/latest.dcupdate', AUTO_DRIVE = '1jZcpfQeCvqKtO6_HFAWqgteAPzC0UtU4';
const getText = async u => { try { const r = await fetch(u + (u.includes('?') ? '&' : '?') + 't=' + Date.now(), { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0' } }); return r.ok ? await r.text() : ''; } catch (_) { return ''; } };
const playCur = () => { const a = updCur(), b = (saves['#play'] || {}).save; return b && (!a || newer(b.v, a.v)) ? b : a; };
const patchSigOk = p => { try { return crypto.verify('sha256', Buffer.from(p.v + '\n' + p.from + '\n' + p.hash), { key: UPD_PUB, dsaEncoding: 'ieee-p1363' }, Buffer.from(p.sig, 'base64')); } catch (_) { return false; } };
const applyOps = (src, ops) => { const L = src.split('\n'); for (let i = ops.length - 1; i >= 0; i--) { const [a, b, ins] = ops[i]; L.splice(a, b - a, ...ins); } return L.join('\n'); };
async function autoUpdate() {
  try { const u = JSON.parse(await getText(AUTO_CLAUDE)); if (u && u.v) updPut(u); } catch (_) {}
  const html = await getText('https://drive.google.com/embeddedfolderview?id=' + AUTO_DRIVE); if (!html) return;
  const entries = [...html.matchAll(/entry-([\w-]{20,})"[\s\S]*?flip-entry-title">([^<]+)</g)].map(m => ({ id: m[1], name: m[2] })), dl = id => getText('https://drive.google.com/uc?export=download&id=' + id);
  for (const e of entries.filter(e => /\d+\.\d+\.\d+\.dcupdate$/.test(e.name))) try { updPut(JSON.parse(await dl(e.id))); } catch (_) {}       // full update files dropped in the folder
  const cur = playCur(); if (!cur) return; let src = zlib.gunzipSync(Buffer.from(cur.gz, 'base64')).toString(), v = cur.v; const patches = [];
  for (const e of entries.filter(e => /\.dcpatch$/.test(e.name))) try { const p = JSON.parse(await dl(e.id)); patches.push(p, ...(p.chain || [])); } catch (_) {}
  for (let n = 0; n < 60; n++) { const p = patches.filter(q => q && q.from === v && q.v).sort((a, b) => newer(a.v, b.v) ? -1 : 1)[0]; if (!p || !patchSigOk(p)) break;
    const out = applyOps(src, p.ops || []); if (crypto.createHash('sha256').update(out).digest('hex') !== p.hash) break; src = out; v = p.v; }
  if (v !== cur.v) { saves['#play'] = { save: { v, gz: zlib.gzipSync(src).toString('base64') }, at: Date.now() }; persist(); console.log('Game updated to', v); } }
setTimeout(autoUpdate, 5000); setInterval(autoUpdate, 180000);
app.get('/version', (_, res) => res.send((playCur() || {}).v || 'none'));
http.listen(process.env.PORT || 3000, () => console.log('Demon Conqueror server on port', process.env.PORT || 3000));
// 24/7 on Render's free plan: ping our own public address every 10 minutes so it never falls asleep
const SELF = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
if (SELF) setInterval(() => fetch(SELF).catch(() => {}), 10 * 60 * 1000);
