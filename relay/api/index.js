// Single Vercel function; vercel.json rewrites /api/(.*) here and routing is done below.
import crypto from 'node:crypto';
import * as L from '../lib/logic.js';
import { getStore } from '../lib/db.js';

const MAX_BODY = 32 * 1024;
const MAX_MEMBERS = 12;
const FORMER = 'a former member';

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const nowIso = () => new Date().toISOString();
const iso = (d) => (d instanceof Date ? d.toISOString() : d || null);

// best-effort per-instance rate limit for create/join
const hits = new Map();
function rateLimit(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'x').split(',')[0].trim();
  const t = Date.now();
  const list = (hits.get(ip) || []).filter((x) => t - x < 600000);
  list.push(t);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  if (list.length > 120) throw new HttpError(429, 'rate_limited', 'Too many requests, please slow down and try again in a few minutes.');
}

async function readBody(req) {
  let b;
  try {
    b = req.body; // Vercel's lazy body parser throws on invalid JSON
  } catch {
    throw new HttpError(400, 'bad_json', 'Request body is not valid JSON.');
  }
  if (b === undefined || b === null) {
    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_BODY) throw new HttpError(400, 'body_too_large', 'Request body is too large (32KB max).');
    const chunks = [];
    let size = 0;
    for await (const ch of req) {
      size += ch.length;
      if (size > MAX_BODY) throw new HttpError(400, 'body_too_large', 'Request body is too large (32KB max).');
      chunks.push(ch);
    }
    b = Buffer.concat(chunks);
  }
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') {
    if (b.length > MAX_BODY) throw new HttpError(400, 'body_too_large', 'Request body is too large (32KB max).');
    if (!b.trim()) return {};
    try {
      b = JSON.parse(b);
    } catch {
      throw new HttpError(400, 'bad_json', 'Request body is not valid JSON.');
    }
  } else if (JSON.stringify(b).length > MAX_BODY) {
    throw new HttpError(400, 'body_too_large', 'Request body is too large (32KB max).');
  }
  return b;
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

function bearer(req) {
  const m = /^Bearer\s+([A-Za-z0-9]{16,128})$/.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
}

/** Resolves the member for a token; if `code` given, checks the circle exists and the member belongs to it. */
async function authMember(store, token, code) {
  const member = token ? await store.getMemberByTokenHash(sha256(token)) : null;
  if (!member) throw new HttpError(401, 'bad_token', 'Your token was not accepted. Join the circle again.');
  if (code) {
    if (!(await store.getCircle(code))) throw new HttpError(404, 'code_not_found', 'No circle with that code.');
    if (member.circle_code !== code) throw new HttpError(401, 'bad_token', 'Your token is not valid for this circle.');
  }
  return member;
}

// kind: who produced the entry - the student's Cubbie (agent), the student's own decision, or Orbit itself.
const DEFAULT_KIND = { joined: 'student', left: 'system', shared: 'agent', proposed: 'agent', accepted: 'student', declined: 'student', countered: 'system', moved: 'agent', paused: 'student', resumed: 'student' };
const kindOf = (e) => e.kind || DEFAULT_KIND[e.type] || 'system';
const log = (store, code, actor, type, text, actor_id, kind) => store.addLog({ circle_code: code, ts: new Date(), actor, actor_id: actor_id || null, type, kind: kind || DEFAULT_KIND[type] || 'system', text });
const todayParam = (v) => (v === undefined || v === null || v === '' ? new Date().toISOString().slice(0, 10) : L.isISODate(v) ? v : (() => { throw new HttpError(400, 'bad_today', 'today must be an ISO date (YYYY-MM-DD).'); })());

const newViewKey = () => crypto.randomBytes(12).toString('hex');
const TIMEOUT_MS = 24 * 3600 * 1000;
const FAKE_REQ = { headers: {}, socket: {} };

/** Public origin of this deployment, from the request headers. */
function originOf(req) {
  const h = req.headers || {};
  const host = String(h['x-forwarded-host'] || h.host || 'orbit-cubbie.vercel.app').split(',')[0].trim();
  const local = /^(localhost|127\.|\[::1\])/.test(host);
  const proto = String(h['x-forwarded-proto'] || (local ? 'http' : 'https')).split(',')[0].trim();
  return `${proto}://${host}`;
}

/** Read-only access with a circle's view key (?v=). Returns the circle; 401 on any mismatch. */
async function viewAuth(ctx, code) {
  const v = ctx.query.get('v');
  const circle = await ctx.store.getCircle(code);
  if (!circle) throw new HttpError(404, 'code_not_found', 'No circle with that code.');
  const a = Buffer.from(String(v));
  const b = Buffer.from(String(circle.view_key || ''));
  if (!v || !circle.view_key || !/^[0-9a-f]{24}$/.test(v) || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new HttpError(401, 'bad_view_key', 'That view link is not valid.');
  }
  return circle;
}

/** Inserts a circle under a fresh unique code (with a view key). `nameFor(code)` gives its name. */
async function allocCircle(store, nameFor, extra = {}) {
  for (let i = 0; i < 10; i++) {
    const code = newCode();
    const circle = { code, name: nameFor(code), created_at: new Date(), view_key: newViewKey(), ...extra };
    try {
      await store.createCircle(circle);
      return circle;
    } catch (e) {
      if (!e.dup) throw e;
    }
  }
  throw new HttpError(500, 'code_exhausted', 'Could not allocate a circle code, try again.');
}

async function addMember(store, code, name) {
  const token = crypto.randomBytes(32).toString('hex');
  const m = { circle_code: code, member_id: crypto.randomBytes(4).toString('hex'), name, token_hash: sha256(token), joined_at: new Date(), paused: false };
  try {
    await store.insertMember(m);
  } catch (e) {
    if (e.dup) return addMember(store, code, name);
    throw e;
  }
  return { member: m, token };
}

function newCode() {
  let s = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) s += L.CODE_ALPHABET[bytes[i] % L.CODE_ALPHABET.length];
  return s;
}

function liveSignals(signals, members, now = new Date()) {
  const paused = new Set(members.filter((m) => m.paused).map((m) => m.member_id));
  const map = new Map();
  for (const s of signals) if (L.isLive(s, now) && !paused.has(s.member_id)) map.set(s.member_id, s);
  return map;
}

/**
 * Lazy 24 h timeout, run whenever proposals are read. Open group proposals drop non-responders if at least one invitee said yes
 * (plan set for the rest); anything else open for more than 24 h expires. Returns the proposals with updates applied.
 */
async function sweepProposals(store, proposals) {
  const out = [];
  let names = null;
  for (const p of proposals) {
    if (p.status !== 'open' || Date.now() - new Date(p.created_at).getTime() <= TIMEOUT_MS) { out.push(p); continue; }
    if (!names) names = new Map((await store.listMembers(p.circle_code)).map((m) => [m.member_id, m.name]));
    const yes = p.to_ids.filter((i) => p.responses[i] === 'yes');
    let next;
    if (p.to_ids.length >= 2 && yes.length) {
      const date = p.date || L.windowDate(p.window, String(iso(p.created_at)).slice(0, 10));
      const time = p.time || L.canonTime(p.window);
      next = await store.transitionProposal(p.id, { status: 'open' }, { to_ids: yes, status: 'accepted', date, time, updated_at: new Date(), change: 'accepted' });
      if (next) {
        const dropped = p.to_ids.filter((i) => !yes.includes(i)).map((i) => names.get(i) || FORMER).join(' and ');
        const what = `${p.kind === 'study' ? (p.course ? `Study ${p.course}` : 'Study session') : 'Hangout'} · ${L.prettyDate(date)} · ${L.prettyTime(time)}`;
        await log(store, p.circle_code, 'Orbit', 'accepted', `${dropped} didn't answer in time; plan set for the rest. Plan set: ${what}`, null, 'system');
      }
    } else {
      next = await store.transitionProposal(p.id, { status: 'open' }, { status: 'expired', updated_at: new Date(), change: 'expired' });
      if (next) await log(store, p.circle_code, 'Orbit', 'expired', 'No answer in 24 h; plan expired.', null, 'system');
    }
    out.push(next || (await store.getProposal(p.id)) || p);
  }
  return out;
}

function proposalView(p, names, me) {
  return {
    id: p.id, circle_code: p.circle_code, from_id: p.from_id, from_name: names.get(p.from_id) || FORMER,
    to_ids: p.to_ids, to_names: p.to_ids.map((i) => names.get(i) || FORMER),
    kind: p.kind, course: p.course || null, window: p.window, windows: p.windows || [p.window], date: p.date || null, time: p.time || null,
    round: p.round || 1, note: p.note || '',
    status: p.status, responses: p.responses, parent_id: p.parent_id || null, created_at: iso(p.created_at),
    moved_by_name: p.moved_by_name || null,
    my_response: me ? p.responses[me] || null : null,
  };
}

// ---------- handlers ----------
const H = {
  async createCircle(ctx) {
    rateLimit(ctx.req);
    const name = L.sanitizeName(ctx.body.name, 40, 'name');
    const memberName = L.sanitizeName(ctx.body.member_name, 24, 'member_name');
    const { code } = await allocCircle(ctx.store, () => name);
    const { member, token } = await addMember(ctx.store, code, memberName);
    await log(ctx.store, code, memberName, 'joined', `${memberName} started the circle.`, member.member_id);
    return [200, { code, name, member_id: member.member_id, token }];
  },

  async join(ctx, code) {
    rateLimit(ctx.req);
    const memberName = L.sanitizeName(ctx.body.member_name, 24, 'member_name');
    const circle = await ctx.store.getCircle(code);
    if (!circle) throw new HttpError(404, 'code_not_found', 'No circle with that code.');
    if (circle.demo) throw new HttpError(403, 'demo_circle', 'This is a demo circle; you cannot join it.');
    const members = await ctx.store.listMembers(code);
    if (members.length >= MAX_MEMBERS) throw new HttpError(409, 'circle_full', `This circle already has ${MAX_MEMBERS} members.`);
    if (members.some((m) => m.name.toLowerCase() === memberName.toLowerCase())) throw new HttpError(409, 'name_taken', 'Someone in this circle already uses that name. Pick another.');
    const { member, token } = await addMember(ctx.store, code, memberName);
    await log(ctx.store, code, memberName, 'joined', `${memberName} joined the circle.`, member.member_id);
    return [200, { code, name: circle.name, member_id: member.member_id, token }];
  },

  async getCircle(ctx, code) {
    await authMember(ctx.store, ctx.token, code);
    const [circle, members, signals] = await Promise.all([ctx.store.getCircle(code), ctx.store.listMembers(code), ctx.store.listSignals(code)]);
    const live = new Map(signals.filter((s) => L.isLive(s)).map((s) => [s.member_id, s]));
    const viewKey = circle.view_key || (await ctx.store.ensureViewKey(code, newViewKey()));
    return [200, {
      code, name: circle.name,
      view_url: `${originOf(ctx.req)}/circle?c=${code}&v=${viewKey}`,
      members: members.map((m) => ({ member_id: m.member_id, name: m.name, paused: !!m.paused, has_signal: live.has(m.member_id), updated_at: iso(live.get(m.member_id)?.updated_at) })),
    }];
  },

  async putSignal(ctx, code) {
    const me = await authMember(ctx.store, ctx.token, code);
    const sig = L.sanitizeSignal(ctx.body);
    const updated = new Date();
    await ctx.store.putSignal({ ...sig, circle_code: code, member_id: me.member_id, updated_at: updated, expires_at: new Date(updated.getTime() + 8 * 86400000) });
    await log(ctx.store, code, me.name, 'shared', `${me.name}'s Cubbie updated their availability.`, me.member_id);
    return [200, { ok: true, updated_at: updated.toISOString() }];
  },

  async feed(ctx, code) {
    const me = await authMember(ctx.store, ctx.token, code);
    const today = todayParam(ctx.query.get('today'));
    const [members, signals, proposalsRaw] = await Promise.all([ctx.store.listMembers(code), ctx.store.listSignals(code), ctx.store.listProposals(code)]);
    const proposals = await sweepProposals(ctx.store, proposalsRaw);
    const live = liveSignals(signals, members);
    const allSignals = new Map(signals.filter((s) => L.isLive(s)).map((s) => [s.member_id, s]));
    const mySig = allSignals.get(me.member_id) || null;
    const entries = members.filter((m) => m.member_id !== me.member_id && live.has(m.member_id)).map((m) => ({ member: m, signal: live.get(m.member_id) }));
    const names = new Map(members.map((m) => [m.member_id, m.name]));
    const cutoff = Date.now() - 7 * 86400000;
    const mine = proposals
      .filter((p) => ['open', 'countered', 'accepted'].includes(p.status) && new Date(p.created_at).getTime() >= cutoff && (p.from_id === me.member_id || p.to_ids.includes(me.member_id)))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .map((p) => proposalView(p, names, me.member_id));
    return [200, {
      me: { member_id: me.member_id, name: me.name },
      friends: entries.map((e) => L.friendView(mySig, e.member, e.signal)),
      proposals: mine,
      suggestions: L.buildSuggestions({ meId: me.member_id, mySig, entries, proposals, today }),
    }];
  },

  async propose(ctx, code) {
    const me = await authMember(ctx.store, ctx.token, code);
    const input = L.sanitizeProposalInput(ctx.body, me.member_id);
    const members = await ctx.store.listMembers(code);
    const names = new Map(members.map((m) => [m.member_id, m.name]));
    for (const id of input.to) if (!names.has(id)) throw new HttpError(400, 'unknown_member', 'One of the people you picked is not in this circle.');
    const today = todayParam(ctx.body.today);
    const now = new Date();
    const p = {
      id: crypto.randomBytes(4).toString('hex'), circle_code: code, from_id: me.member_id, to_ids: input.to, kind: input.kind,
      window: input.window, windows: input.windows, date: L.windowDate(input.window, today), time: input.time || L.canonTime(input.window),
      round: 1, tried: [input.window], note: input.note, status: 'open', responses: {}, parent_id: null, created_at: now,
    };
    if (input.course) p.course = input.course;
    await ctx.store.insertProposal(p);
    const who = input.to.map((i) => names.get(i)).join(' and ');
    const order = input.windows.length > 1 ? `: ${input.windows.map(L.prettyWindow).join(', then ')}` : ` (${L.prettyWindow(input.window)})`;
    await log(ctx.store, code, me.name, 'proposed', `${me.name}'s Cubbie proposed a ${input.kind === 'study' ? 'study session' : 'hangout'} to ${who}${order}.`, me.member_id, 'agent');
    return [200, proposalView(p, names, me.member_id)];
  },

  async respond(ctx, id) {
    const me = await authMember(ctx.store, ctx.token);
    let p = await ctx.store.getProposal(id);
    if (!p || p.circle_code !== me.circle_code) throw new HttpError(404, 'proposal_not_found', 'No such proposal.');
    [p] = await sweepProposals(ctx.store, [p]);
    if (!p.to_ids.includes(me.member_id)) throw new HttpError(404, 'not_recipient', 'That proposal was not addressed to you.');
    const answer = ctx.body.answer;
    if (answer !== 'yes' && answer !== 'no' && answer !== 'busy') throw new HttpError(400, 'bad_answer', 'answer must be yes, no or busy.');
    const freeWindows = answer === 'busy' && ctx.body.free_windows !== undefined && ctx.body.free_windows !== null ? L.windowList(ctx.body.free_windows, 21, 'free_windows') : null;
    if (p.status !== 'open') throw new HttpError(409, 'proposal_closed', `This proposal is already ${p.status}.`);
    const today = todayParam(ctx.body.today);
    const code = p.circle_code;
    const members = await ctx.store.listMembers(code);
    const names = new Map(members.map((m) => [m.member_id, m.name]));
    const nm = (i) => names.get(i) || FORMER;
    const view = (q, mv = false, counter = null) => [200, { proposal: proposalView(q, names, me.member_id), counter: counter ? proposalView(counter, names, me.member_id) : null, moved: mv }];
    const closed = async () => {
      const cur = await ctx.store.getProposal(id);
      throw new HttpError(409, 'proposal_closed', `This proposal is already ${cur ? cur.status : 'closed'}.`);
    };
    const label = (q) => `${q.kind === 'study' ? 'study session' : 'hangout'} (${L.prettyWindow(q.window)})`;
    const plan = (q) => `${q.kind === 'study' ? (q.course ? `Study ${q.course}` : 'Study session') : 'Hangout'} · ${L.prettyDate(q.date)} · ${L.prettyTime(q.time)}`;

    if (answer === 'yes') {
      let cur = await ctx.store.setResponse(id, me.member_id, 'yes'); // atomic: concurrent yeses cannot overwrite each other
      if (!cur) return closed();
      if (cur.to_ids.every((i) => cur.responses[i] === 'yes')) {
        const date = cur.date || L.windowDate(cur.window, today);
        const won = await ctx.store.transitionProposal(id, { status: 'open' }, { status: 'accepted', date, time: cur.time || L.canonTime(cur.window), updated_at: new Date(), change: 'accepted' });
        if (won) {
          cur = won;
          await log(ctx.store, code, me.name, 'accepted', `${me.name} said yes. Plan set: ${plan(cur)}`, me.member_id, 'student');
        } else cur = (await ctx.store.getProposal(id)) || cur;
      }
      return view(cur);
    }

    const live = liveSignals(await ctx.store.listSignals(code), members);
    const parts = [p.from_id, ...p.to_ids];
    // exclude every window already turned down in this proposal and its counter chain, so nothing ping-pongs
    const excluded = new Set([p.window, ...(p.tried || [])]);
    for (let q = p, i = 0; q && q.parent_id && i < 10; i++) {
      q = await ctx.store.getProposal(q.parent_id);
      if (q && q.circle_code === code) {
        excluded.add(q.window);
        (q.tried || []).forEach((w) => excluded.add(w));
      }
    }
    const beforeDateFor = (sigs) => {
      if (p.kind !== 'study' || !p.course) return undefined;
      return sigs.filter(Boolean).flatMap((s) => (s.courses || []).filter((c) => c.code === p.course).flatMap((c) => c.events.map((e) => e.date))).filter((d) => d >= today).sort()[0];
    };

    if (answer === 'busy') {
      // The responder's Cubbie checked its own student's calendar: the window is not free. Try the next candidate in place.
      if (freeWindows) {
        const old = await ctx.store.getSignal(code, me.member_id);
        const t = new Date();
        await ctx.store.putSignal(old ? { ...old, free: freeWindows } : { circle_code: code, member_id: me.member_id, free: freeWindows, updated_at: t, expires_at: new Date(t.getTime() + 8 * 86400000) });
        live.set(me.member_id, { ...(live.get(me.member_id) || {}), free: freeWindows });
      }
      const myFree = (live.get(me.member_id) || {}).free || null;
      const round = p.round || 1;
      let win = null;
      if (myFree && round < L.MAX_ROUNDS) {
        // group plans: a window must be free for the proposer and ALL invitees (those with a live signal)
        const allFree = (w) => p.to_ids.length < 2 || parts.every((i) => { const f = i === me.member_id ? myFree : (live.get(i) || {}).free; return !f || f.includes(w); });
        win = (p.windows || []).find((w) => !excluded.has(w) && myFree.includes(w) && allFree(w)) || null;
        if (!win) {
          const sigs = parts.map((i) => (i === me.member_id ? { free: myFree } : live.get(i)));
          if (sigs.every(Boolean)) win = L.nextBestWindow(sigs, { declined: [...excluded], today, beforeDate: beforeDateFor(sigs) });
        }
      }
      const checked = `${me.name}'s Cubbie checked their calendar — ${L.prettyWindow(p.window)} is busy.`;
      if (win) {
        const set = { window: win, date: L.windowDate(win, today), time: L.canonTime(win), responses: { [p.from_id]: 'yes' }, round: round + 1, tried: [...excluded, win], updated_at: new Date(), change: 'moved', moved_by_name: me.name };
        const moved = await ctx.store.transitionProposal(id, { status: 'open', window: p.window }, set);
        if (!moved) return view((await ctx.store.getProposal(id)) || p); // someone else moved/closed it first
        await log(ctx.store, code, me.name, 'moved', `${checked} Moved to ${L.prettyWindow(win)}.`, me.member_id, 'agent');
        return view(moved, true);
      }
      const declined = await ctx.store.transitionProposal(id, { status: 'open', window: p.window }, { status: 'declined', responses: { ...p.responses, [me.member_id]: 'no' }, updated_at: new Date(), change: 'declined' });
      if (!declined) return view((await ctx.store.getProposal(id)) || p);
      await log(ctx.store, code, me.name, 'declined', `${checked} No shared time this week.`, me.member_id, 'agent');
      return view(declined);
    }

    // answer === 'no': the student declined; Orbit looks for a counter, skipping every window already rejected
    const responses = { ...p.responses, [me.member_id]: 'no' };
    const sigs = parts.map((i) => live.get(i));
    const win = sigs.every(Boolean) ? L.nextBestWindow(sigs, { declined: [...excluded], today, beforeDate: beforeDateFor(sigs) }) : null;
    const status = win ? 'countered' : 'declined';
    const upd = await ctx.store.transitionProposal(id, { status: 'open' }, { responses, status, updated_at: new Date(), change: status });
    if (!upd) return closed();
    if (!win) {
      await log(ctx.store, code, me.name, 'declined', `${me.name} can't make ${nm(p.from_id)}'s ${label(p)}, and no other common window was found.`, me.member_id, 'student');
      return view(upd);
    }
    const counter = {
      id: crypto.randomBytes(4).toString('hex'), circle_code: code, from_id: me.member_id,
      to_ids: [p.from_id, ...p.to_ids.filter((i) => i !== me.member_id)], kind: p.kind, window: win, windows: [win],
      date: L.windowDate(win, today), time: L.canonTime(win), round: 1, tried: [...excluded, win], note: '',
      status: 'open', responses: {}, parent_id: p.id, created_at: new Date(),
    };
    if (p.course) counter.course = p.course;
    await ctx.store.insertProposal(counter);
    await log(ctx.store, code, 'Orbit', 'countered', `${me.name} can't do ${L.prettyWindow(p.window)}. Orbit suggested ${L.prettyWindow(win)} instead.`, null, 'system');
    return view(upd, false, counter);
  },

  async inbox(ctx, code) {
    const me = await authMember(ctx.store, ctx.token, code);
    const today = todayParam(ctx.query.get('today'));
    const sinceRaw = ctx.query.get('since');
    const since = sinceRaw ? new Date(sinceRaw) : new Date(0);
    if (Number.isNaN(since.getTime())) throw new HttpError(400, 'bad_since', 'since must be an ISO timestamp.');
    const [members, signals, proposalsRaw] = await Promise.all([ctx.store.listMembers(code), ctx.store.listSignals(code), ctx.store.listProposals(code)]);
    const proposals = await sweepProposals(ctx.store, proposalsRaw);
    const names = new Map(members.map((m) => [m.member_id, m.name]));
    const cutoff = Date.now() - 7 * 86400000;
    const recent = proposals.filter((p) => new Date(p.created_at).getTime() >= cutoff);
    const needs = recent.filter((p) => p.status === 'open' && p.to_ids.includes(me.member_id) && !p.responses[me.member_id])
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map((p) => proposalView(p, names, me.member_id));
    const updates = recent.filter((p) => p.from_id === me.member_id && p.updated_at && new Date(p.updated_at) > since && p.change)
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).map((p) => ({ ...proposalView(p, names, me.member_id), change: p.change, updated_at: iso(p.updated_at) }));
    const live = liveSignals(signals, members);
    const mySig = signals.find((s) => s.member_id === me.member_id && L.isLive(s)) || null;
    const entries = members.filter((m) => m.member_id !== me.member_id && live.has(m.member_id)).map((m) => ({ member: m, signal: live.get(m.member_id) }));
    const fresh = new Set(entries.filter((e) => new Date(e.signal.updated_at) > since).map((e) => e.member.member_id));
    const new_nudges = L.buildSuggestions({ meId: me.member_id, mySig, entries, proposals, today, limit: 1000 })
      .filter((s) => (s.type === 'check_on' || s.type === 'celebrate') && fresh.has(s.friend_id));
    return [200, { needs_answer: needs, updates, new_nudges, now: nowIso() }];
  },

  async setPaused(ctx, code, paused) {
    const me = await authMember(ctx.store, ctx.token, code);
    if (!!me.paused !== paused) {
      await ctx.store.setMember(code, me.member_id, { paused });
      await log(ctx.store, code, me.name, paused ? 'paused' : 'resumed', paused ? `${me.name}'s Cubbie paused sharing.` : `${me.name}'s Cubbie resumed sharing.`, me.member_id);
    }
    return [200, { ok: true }];
  },

  async leave(ctx, code) {
    const me = await authMember(ctx.store, ctx.token, code);
    const id = me.member_id;
    const proposals = await ctx.store.listProposals(code);
    const del = [];
    for (const p of proposals) {
      if (p.from_id === id || (p.to_ids.length === 1 && p.to_ids[0] === id)) del.push(p.id);
      else if (p.to_ids.includes(id)) {
        const { [id]: _drop, ...responses } = p.responses;
        await ctx.store.updateProposal(p.id, { to_ids: p.to_ids.filter((i) => i !== id), responses });
      }
    }
    await ctx.store.deleteProposals(del);
    await ctx.store.deleteSignal(code, id);
    await ctx.store.deleteMember(code, id);
    await ctx.store.scrubLog(code, (e) => {
      const actor = e.actor === me.name || e.actor_id === id ? FORMER : e.actor;
      const text = L.scrubText(e.text, me.name, FORMER);
      return actor !== e.actor || text !== e.text || e.actor_id === id ? { actor, text, actor_id: null } : null;
    });
    if ((await ctx.store.countMembers(code)) === 0) await ctx.store.deleteCircleAll(code);
    else await log(ctx.store, code, FORMER, 'left', 'A member left the circle.');
    return [200, { ok: true, deleted: true }];
  },

  async getLog(ctx, code) {
    const k = ctx.query.get('k');
    if (!ctx.token && !k && ctx.query.get('v') !== null) await viewAuth(ctx, code);
    else await authMember(ctx.store, ctx.token || (k && /^[A-Za-z0-9]{16,128}$/.test(k) ? k : null), code);
    const limit = Math.min(100, Math.max(1, parseInt(ctx.query.get('limit') || '30', 10) || 30));
    const [circle, members, entries] = await Promise.all([ctx.store.getCircle(code), ctx.store.listMembers(code), ctx.store.listLog(code, limit)]);
    return [200, {
      name: circle.name,
      members: members.map((m) => m.name),
      entries: entries.map((e) => ({ ts: iso(e.ts), actor: e.actor, type: e.type, kind: kindOf(e), text: e.text })),
    }];
  },

  /** Judge-safe read-only board: who is in the circle (busy level only), recent plans, the agent log, and counters. */
  async board(ctx, code) {
    if (!ctx.token && ctx.query.get('v') !== null) await viewAuth(ctx, code);
    else await authMember(ctx.store, ctx.token, code);
    const [circle, members, signals, proposalsRaw, entries, moves] = await Promise.all([
      ctx.store.getCircle(code), ctx.store.listMembers(code), ctx.store.listSignals(code), ctx.store.listProposals(code),
      ctx.store.listLog(code, 60), ctx.store.countLog(code, ['moved', 'countered']),
    ]);
    const proposals = await sweepProposals(ctx.store, proposalsRaw);
    const live = liveSignals(signals, members);
    const names = new Map(members.map((m) => [m.member_id, m.name]));
    const cutoff = Date.now() - 14 * 86400000;
    return [200, {
      name: circle.name,
      members: members.map((m) => {
        const s = live.get(m.member_id);
        return { name: m.name, ...(s && s.busy ? { busy: s.busy } : {}), updated_at: iso(s && s.updated_at) };
      }),
      plans: proposals.filter((p) => new Date(p.created_at).getTime() >= cutoff)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .map((p) => ({
          kind: p.kind, course: p.course || null, date: p.date || null, time: p.time || null, status: p.status, round: p.round || 1,
          from_name: names.get(p.from_id) || FORMER, to_names: p.to_ids.map((i) => names.get(i) || FORMER), created_at: iso(p.created_at),
        })),
      log: entries.map((e) => ({ ts: iso(e.ts), actor: e.actor, type: e.type, kind: kindOf(e), text: e.text })),
      stats: { proposals: proposals.length, locked: proposals.filter((p) => p.status === 'accepted').length, agent_moves: moves },
    }];
  },

  async stats(ctx) {
    if (!statsCache || statsCache.store !== ctx.store || Date.now() - statsCache.t > 30000) {
      statsCache = { store: ctx.store, t: Date.now(), data: { ...(await ctx.store.stats()), updated_at: nowIso() } };
    }
    return [200, statsCache.data];
  },

  async demoStart(ctx) {
    demoRateLimit(ctx.req);
    const store = ctx.store;
    // lazy cleanup: demo circles (and their data) older than 24 h
    for (const old of await store.listDemoCircles(new Date(Date.now() - 24 * 3600 * 1000))) await store.deleteCircleAll(old.code);
    const circle = await allocCircle(store, (c) => `Demo · ${c}`, { demo: true, expires_at: new Date(Date.now() + 24 * 3600 * 1000) });
    const code = circle.code;
    const today = demoToday();
    const quiz = L.windowDate('fri-evening', today);
    const week_of = L.weekMonday(today);
    const people = [
      ['manav', 'Manav', { week_of, busy: 'busy', free: ['tue-evening', 'thu-evening'], courses: [{ code: 'CSE 576', events: [{ kind: 'quiz', title: 'Quiz 2', date: quiz }] }] }],
      // Manas's coarse estimate still shows Tue evening as open; his calendar says otherwise (step 5)
      ['manas', 'Manas', { week_of, busy: 'busy', free: ['tue-evening', 'thu-evening', 'sat-afternoon'], courses: [{ code: 'CSE 576', events: [{ kind: 'quiz', title: 'Quiz 2', date: quiz }] }] }],
      ['reya', 'Reya', { week_of, busy: 'packed', big_days: [L.addDays(today, 1)], free: ['wed-evening'], wins: ['Finished my capstone draft'], courses: [{ code: 'BIO 201', events: [{ kind: 'exam', title: 'Midterm', date: L.addDays(today, 1) }] }] }],
    ];
    const ids = {};
    const tokens = {};
    for (const [key, name, sig] of people) {
      const { member, token } = await addMember(store, code, name);
      ids[key] = member.member_id;
      tokens[key] = token;
      await log(store, code, name, 'joined', key === 'manav' ? `${name} started the circle.` : `${name} joined the circle.`, member.member_id);
      await demoCall(store, H.putSignal, token, sig, {}, code);
    }
    const demo_id = crypto.randomBytes(6).toString('hex');
    await store.insertDemo({ demo_id, circle_code: code, step: 0, today, ids, tokens, proposal_id: null, created_at: new Date() });
    return [200, { demo_id, code, view_v: circle.view_key, steps_total: DEMO_STEPS }];
  },

  async demoStep(ctx, demoId) {
    const store = ctx.store;
    const demo = /^[0-9a-f]{12}$/.test(demoId) ? await store.getDemo(demoId) : null;
    if (!demo) throw new HttpError(404, 'demo_not_found', 'That demo does not exist or has expired.');
    if (demo.step >= DEMO_STEPS) throw new HttpError(409, 'demo_done', 'The demo already finished. Start a new one.');
    const n = demo.step + 1;
    if (!(await store.advanceDemo(demoId, demo.step, n))) throw new HttpError(409, 'demo_busy', 'Another step is already running.');
    try {
      return [200, await runDemoStep(store, demo, n)];
    } catch (e) {
      await store.advanceDemo(demoId, n, demo.step); // let the viewer retry the same step
      throw e;
    }
  },
};

let statsCache = null;
const DEMO_STEPS = 10;
const demoHits = new Map();
function demoRateLimit(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'x').split(',')[0].trim();
  const t = Date.now();
  const list = (demoHits.get(ip) || []).filter((x) => t - x < 600000);
  list.push(t);
  demoHits.set(ip, list);
  if (demoHits.size > 5000) demoHits.clear();
  if (list.length > 20) throw new HttpError(429, 'rate_limited', 'Too many demos started, please wait a few minutes.');
}

/** "Today" for the demo: Phoenix time (UTC-7, no DST); Wed-Sun roll to next Monday so Tue/Thu windows come before the Friday quiz. */
function demoToday(now = new Date()) {
  const phoenix = new Date(now.getTime() - 7 * 3600 * 1000).toISOString().slice(0, 10);
  const d = L.dow(phoenix);
  return d <= 1 ? phoenix : L.addDays(phoenix, 7 - d);
}

/** Runs a real handler as a demo member (same code path as a real client). */
async function demoCall(store, fn, token, body, query, ...args) {
  const [, data] = await fn({ req: FAKE_REQ, body: body || {}, query: new URLSearchParams(query || {}), token, store }, ...args);
  return data;
}

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const dayWord = (token, today) => cap(L.prettyDate(L.windowDate(token, today)).slice(0, 3));
const winLabel = (token) => cap(L.prettyWindow(token));
const clock = (hhmm) => L.prettyTime(hhmm).replace(':00', '');

async function runDemoStep(store, demo, n) {
  const { circle_code: code, today, ids, tokens } = demo;
  const bub = (side, from, text) => ({ side, from, text });
  const out = (actor, channel, text, bubbles, extra = {}) => ({ step: n, total: DEMO_STEPS, actor, channel, text, bubble: bubbles[0] || null, bubbles, ...extra, done: n === DEMO_STEPS });
  const lastLog = async () => {
    const [e] = await store.listLog(code, 1);
    return e ? { ts: iso(e.ts), actor: e.actor, type: e.type, kind: kindOf(e), text: e.text } : undefined;
  };
  const planOf = (q) => ({ kind: q.kind, course: q.course || null, window: q.window, date: q.date, time: q.time, status: q.status, round: q.round || 1, from_name: q.from_name, to_names: q.to_names });
  const getPlan = async () => {
    const members = await store.listMembers(code);
    const names = new Map(members.map((m) => [m.member_id, m.name]));
    return proposalView(await store.getProposal(demo.proposal_id), names, null);
  };
  const manavFeed = () => demoCall(store, H.feed, tokens.manav, {}, { today }, code);
  const planLine = (q) => `Study ${q.course} · ${L.prettyDate(q.date)} · ${L.prettyTime(q.time)}`;

  switch (n) {
    case 1: {
      const feed = await manavFeed();
      const sm = feed.suggestions.find((s) => s.type === 'study_match');
      const friend = feed.friends.find((f) => sm && f.member_id === sm.friend_id);
      const mine = (await store.getSignal(code, ids.manav)).free;
      const wins = friend ? L.commonWindows([{ free: mine }, { free: friend.free }], today) : ['tue-evening', 'thu-evening'];
      const second = wins[1] ? (wins[1].split('-')[1] === wins[0].split('-')[1] ? dayWord(wins[1], today) : winLabel(wins[1])) : null;
      const text = `You and ${sm ? sm.friend_name : 'Manas'} both have ${sm ? sm.course : 'CSE 576'}, ${sm ? sm.event.kind : 'quiz'} ${sm ? dayWord('fri-evening', today) : 'Fri'}. Study ${winLabel(wins[0])}${second ? `, or ${second}` : ''}?`;
      return out('manav_cubbie', 'left', text, [bub('left', 'cubbie', text)]);
    }
    case 2:
      return out('manav', 'left', 'yes', [bub('left', 'student', 'yes')]);
    case 3: {
      const pr = await demoCall(store, H.propose, tokens.manav, { to: [ids.manas], kind: 'study', course: 'CSE 576', windows: ['tue-evening', 'thu-evening'], today }, {}, code);
      await store.updateDemo(demo.demo_id, { proposal_id: pr.id });
      return out('manav_cubbie', 'agents', `Manav's Cubbie proposed Study CSE 576: ${winLabel(pr.windows[0])}, then ${winLabel(pr.windows[1])}.`, [], { log_entry: await lastLog(), plan: planOf(pr) });
    }
    case 4: {
      const inbox = await demoCall(store, H.inbox, tokens.manas, {}, { today }, code);
      const q = inbox.needs_answer.find((x) => x.id === demo.proposal_id);
      return out('manas_cubbie', 'agents', `Manas's Cubbie received a proposal${q ? ` from ${q.from_name}'s Cubbie: Study ${q.course}, ${winLabel(q.window)}` : ''}.`, [], q ? { plan: planOf(q) } : {});
    }
    case 5: {
      const r = await demoCall(store, H.respond, tokens.manas, { answer: 'busy', free_windows: ['thu-evening', 'sat-afternoon'], today }, {}, demo.proposal_id);
      const q = r.proposal;
      return out('manas_cubbie', 'agents', `Manas's Cubbie checked his calendar: Tue evening is busy. Moved to ${winLabel(q.window)}.`, [], { log_entry: await lastLog(), plan: planOf(q) });
    }
    case 6: {
      const q = await getPlan();
      const text = `Manav wants to study ${q.course} ${dayWord(q.window, today)} ${clock(q.time)}. You're free then. Lock it in?`;
      return out('manas_cubbie', 'right', text, [bub('right', 'cubbie', text)], { plan: planOf(q) });
    }
    case 7: {
      const r = await demoCall(store, H.respond, tokens.manas, { answer: 'yes', today }, {}, demo.proposal_id);
      return out('manas', 'right', 'yes', [bub('right', 'student', 'yes')], { log_entry: await lastLog(), plan: planOf(r.proposal) });
    }
    case 8: {
      const inbox = await demoCall(store, H.inbox, tokens.manav, {}, { today }, code); // Manav's Cubbie sees the accepted plan
      const q = inbox.updates.find((x) => x.id === demo.proposal_id) || (await getPlan());
      const text = `Locked in: ${planLine(q)}`;
      const added = 'Added to your calendar.';
      return out('orbit', 'left', text, [bub('left', 'cubbie', `${text}\n${added}`), bub('right', 'cubbie', `${text}\n${added}`)], { plan: planOf(q) });
    }
    case 9: {
      const feed = await manavFeed();
      const c = feed.suggestions.find((s) => s.type === 'check_on');
      const text = `${c ? c.friend_name : 'Reya'} has a big day tomorrow. Want a short text to send her?`;
      return out('manav_cubbie', 'left', text, [bub('left', 'cubbie', text)]);
    }
    default: {
      const draft = 'Big day tomorrow, you got this. coffee after? ☕';
      return out('manav', 'left', draft, [bub('left', 'student', 'yes'), bub('left', 'cubbie', draft)], { note: 'You send it, not the AI.' });
    }
  }
}

function route(method, parts) {
  const [a, b, c] = parts;
  if (a === 'circles') {
    if (parts.length === 1 && method === 'POST') return [H.createCircle];
    if (parts.length === 2 && method === 'GET') return [H.getCircle, b];
    if (parts.length === 3 && b) {
      const code = b;
      if (c === 'join' && method === 'POST') return [H.join, code];
      if (c === 'signal' && method === 'PUT') return [H.putSignal, code];
      if (c === 'feed' && method === 'GET') return [H.feed, code];
      if (c === 'inbox' && method === 'GET') return [H.inbox, code];
      if (c === 'proposals' && method === 'POST') return [H.propose, code];
      if (c === 'pause' && method === 'POST') return [(x, k) => H.setPaused(x, k, true), code];
      if (c === 'resume' && method === 'POST') return [(x, k) => H.setPaused(x, k, false), code];
      if (c === 'leave' && method === 'POST') return [H.leave, code];
      if (c === 'log' && method === 'GET') return [H.getLog, code];
      if (c === 'board' && method === 'GET') return [H.board, code];
    }
  }
  if (a === 'stats' && parts.length === 1 && method === 'GET') return [H.stats];
  if (a === 'demo' && b === 'start' && parts.length === 2 && method === 'POST') return [H.demoStart];
  if (a === 'demo' && c === 'step' && parts.length === 3 && method === 'POST') return [H.demoStep, b];
  if (a === 'proposals' && parts.length === 3 && c === 'respond' && method === 'POST') return [H.respond, b];
  return null;
}

export function createHandler(getStoreFn) {
  return async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname.replace(/^\/api(?=\/|$)/, '');
      const parts = path.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
      if (parts[0] === 'circles' && parts[1]) parts[1] = parts[1].toUpperCase();
      const r = route(req.method, parts);
      if (!r) throw new HttpError(404, 'not_found', 'No such endpoint.');
      const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {};
      if (body === null || typeof body !== 'object') throw new HttpError(400, 'bad_json', 'Request body must be a JSON object.');
      const ctx = { req, body, query: url.searchParams, token: bearer(req), store: await getStoreFn() };
      const [status, data] = await r[0](ctx, ...r.slice(1));
      return send(res, status, data);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code });
      if (e instanceof L.InputError) return send(res, 400, { error: e.message, code: 'bad_input' });
      if (e instanceof URIError) return send(res, 400, { error: 'Bad URL.', code: 'bad_input' });
      console.error('orbit relay error:', e && e.message);
      return send(res, 500, { error: 'Something went wrong on the server. Please try again.', code: 'server_error' });
    }
  };
}

export default createHandler(getStore);
