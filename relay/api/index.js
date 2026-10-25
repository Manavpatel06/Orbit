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
  if (list.length > 30) throw new HttpError(429, 'rate_limited', 'Too many requests, please slow down and try again in a few minutes.');
}

async function readBody(req) {
  let b = req.body;
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

const log = (store, code, actor, type, text, actor_id) => store.addLog({ circle_code: code, ts: new Date(), actor, actor_id: actor_id || null, type, text });
const todayParam = (v) => (v === undefined || v === null || v === '' ? new Date().toISOString().slice(0, 10) : L.isISODate(v) ? v : (() => { throw new HttpError(400, 'bad_today', 'today must be an ISO date (YYYY-MM-DD).'); })());

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

function proposalView(p, names, me) {
  return {
    id: p.id, circle_code: p.circle_code, from_id: p.from_id, from_name: names.get(p.from_id) || FORMER,
    to_ids: p.to_ids, to_names: p.to_ids.map((i) => names.get(i) || FORMER),
    kind: p.kind, course: p.course || null, window: p.window, time: p.time || null, note: p.note || '',
    status: p.status, responses: p.responses, parent_id: p.parent_id || null, created_at: iso(p.created_at),
    my_response: me ? p.responses[me] || null : null,
  };
}

// ---------- handlers ----------
const H = {
  async createCircle(ctx) {
    rateLimit(ctx.req);
    const name = L.sanitizeName(ctx.body.name, 40, 'name');
    const memberName = L.sanitizeName(ctx.body.member_name, 24, 'member_name');
    let code;
    for (let i = 0; i < 10 && !code; i++) {
      const c = newCode();
      try {
        await ctx.store.createCircle({ code: c, name, created_at: new Date() });
        code = c;
      } catch (e) {
        if (!e.dup) throw e;
      }
    }
    if (!code) throw new HttpError(500, 'code_exhausted', 'Could not allocate a circle code, try again.');
    const { member, token } = await addMember(ctx.store, code, memberName);
    await log(ctx.store, code, memberName, 'joined', `${memberName} started the circle.`, member.member_id);
    return [200, { code, name, member_id: member.member_id, token }];
  },

  async join(ctx, code) {
    rateLimit(ctx.req);
    const memberName = L.sanitizeName(ctx.body.member_name, 24, 'member_name');
    const circle = await ctx.store.getCircle(code);
    if (!circle) throw new HttpError(404, 'code_not_found', 'No circle with that code.');
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
    return [200, {
      code, name: circle.name,
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
    const [members, signals, proposals] = await Promise.all([ctx.store.listMembers(code), ctx.store.listSignals(code), ctx.store.listProposals(code)]);
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
    const p = {
      id: crypto.randomBytes(4).toString('hex'), circle_code: code, from_id: me.member_id, to_ids: input.to, kind: input.kind,
      window: input.window, note: input.note, status: 'open', responses: {}, parent_id: null, created_at: new Date(),
    };
    if (input.course) p.course = input.course;
    if (input.time) p.time = input.time;
    await ctx.store.insertProposal(p);
    const who = input.to.map((i) => names.get(i)).join(' and ');
    await log(ctx.store, code, me.name, 'proposed', `${me.name} proposed a ${input.kind === 'study' ? 'study session' : 'hangout'} to ${who} (${L.prettyWindow(input.window)}).`, me.member_id);
    return [200, proposalView(p, names, me.member_id)];
  },

  async respond(ctx, id) {
    const me = await authMember(ctx.store, ctx.token);
    const p = await ctx.store.getProposal(id);
    if (!p || p.circle_code !== me.circle_code) throw new HttpError(404, 'proposal_not_found', 'No such proposal.');
    if (!p.to_ids.includes(me.member_id)) throw new HttpError(404, 'not_recipient', 'That proposal was not addressed to you.');
    const answer = ctx.body.answer;
    if (answer !== 'yes' && answer !== 'no') throw new HttpError(400, 'bad_answer', 'answer must be yes or no.');
    if (p.status !== 'open') throw new HttpError(409, 'proposal_closed', `This proposal is already ${p.status}.`);
    const today = todayParam(ctx.body.today);
    const code = p.circle_code;
    const members = await ctx.store.listMembers(code);
    const names = new Map(members.map((m) => [m.member_id, m.name]));
    const nm = (i) => names.get(i) || FORMER;
    const responses = { ...p.responses, [me.member_id]: answer };
    const label = `${p.kind === 'study' ? 'study session' : 'hangout'} (${L.prettyWindow(p.window)})`;
    let status = 'open';
    let counter = null;

    if (answer === 'yes') {
      if (p.to_ids.every((i) => responses[i] === 'yes')) {
        status = 'accepted';
        await log(ctx.store, code, me.name, 'accepted', `${me.name} said yes. ${nm(p.from_id)}'s ${label} is on.`, me.member_id);
      }
    } else {
      const live = liveSignals(await ctx.store.listSignals(code), members);
      const parts = [p.from_id, ...p.to_ids];
      const sigs = parts.map((i) => live.get(i));
      let beforeDate;
      if (p.kind === 'study' && p.course) {
        const dates = sigs.filter(Boolean).flatMap((s) => (s.courses || []).filter((c) => c.code === p.course).flatMap((c) => c.events.map((e) => e.date))).filter((d) => d >= today).sort();
        beforeDate = dates[0];
      }
      const win = sigs.every(Boolean) ? L.nextBestWindow(sigs, { declined: p.window, today, beforeDate }) : null;
      if (win) {
        status = 'countered';
        counter = {
          id: crypto.randomBytes(4).toString('hex'), circle_code: code, from_id: me.member_id,
          to_ids: [p.from_id, ...p.to_ids.filter((i) => i !== me.member_id)], kind: p.kind, window: win, note: '',
          status: 'open', responses: {}, parent_id: p.id, created_at: new Date(),
        };
        if (p.course) counter.course = p.course;
        await ctx.store.insertProposal(counter);
        await log(ctx.store, code, 'Orbit', 'countered', `${me.name} can't do ${L.prettyWindow(p.window)}. Orbit suggested ${L.prettyWindow(win)} instead.`);
      } else {
        status = 'declined';
        await log(ctx.store, code, me.name, 'declined', `${me.name} can't make ${nm(p.from_id)}'s ${label}, and no other common window was found.`, me.member_id);
      }
    }
    await ctx.store.updateProposal(id, { responses, status });
    return [200, { proposal: proposalView({ ...p, responses, status }, names, me.member_id), counter: counter ? proposalView(counter, names, me.member_id) : null }];
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
    await authMember(ctx.store, ctx.token || (k && /^[A-Za-z0-9]{16,128}$/.test(k) ? k : null), code);
    const limit = Math.min(100, Math.max(1, parseInt(ctx.query.get('limit') || '30', 10) || 30));
    const [circle, members, entries] = await Promise.all([ctx.store.getCircle(code), ctx.store.listMembers(code), ctx.store.listLog(code, limit)]);
    return [200, {
      name: circle.name,
      members: members.map((m) => m.name),
      entries: entries.map((e) => ({ ts: iso(e.ts), actor: e.actor, type: e.type, text: e.text })),
    }];
  },
};

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
      if (c === 'proposals' && method === 'POST') return [H.propose, code];
      if (c === 'pause' && method === 'POST') return [(x, k) => H.setPaused(x, k, true), code];
      if (c === 'resume' && method === 'POST') return [(x, k) => H.setPaused(x, k, false), code];
      if (c === 'leave' && method === 'POST') return [H.leave, code];
      if (c === 'log' && method === 'GET') return [H.getLog, code];
    }
  }
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
