import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';

const mongo = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'orbit_test';
const { default: handler } = await import(new URL('../../relay/api/index.js', import.meta.url).href);
const server = http.createServer((req, res) => handler(req, res));
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/api`;
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('ok -', m); };

async function call(method, path, { token, body, raw } = {}) {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  return { status: r.status, j: await r.json().catch(() => null) };
}
const TODAY = '2026-10-26'; // Monday
const A = (await call('POST', '/circles', { body: { name: 'Study Crew', member_name: 'Manas' } })).j;
ok(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(A.code) && /^[0-9a-f]{64}$/.test(A.token) && /^[0-9a-f]{8}$/.test(A.member_id), 'create returns code/member_id/token');
const code = A.code;
const B = (await call('POST', `/circles/${code.toLowerCase()}/join`, { body: { member_name: 'Sam' } })).j;
const C = (await call('POST', `/circles/${code}/join`, { body: { member_name: 'Priya' } })).j;
ok(B.token && C.token && B.code === code, 'two joins');
ok((await call('POST', `/circles/${code}/join`, { body: { member_name: 'sam' } })).status === 409, 'duplicate name 409');

// auth / not found
ok((await call('GET', `/circles/${code}`, { token: 'deadbeef'.repeat(8) })).status === 401, 'bad token 401');
ok((await call('GET', `/circles/${code}`)).status === 401, 'no token 401');
ok((await call('GET', '/circles/ZZZZZZ', { token: A.token })).status === 404, 'unknown code 404 (get)');
const nf = await call('POST', '/circles/ZZZZZZ/join', { body: { member_name: 'X' } });
ok(nf.status === 404 && nf.j.code === 'code_not_found', 'unknown code 404 (join)');
const info = await call('GET', `/circles/${code}`, { token: A.token });
ok(info.status === 200 && info.j.members.length === 3 && info.j.name === 'Study Crew', 'get circle');

// signal validation
ok((await call('PUT', `/circles/${code}/signal`, { token: A.token, body: { free: ['funday-night'] } })).status === 400, 'bad window 400');
ok((await call('PUT', `/circles/${code}/signal`, { token: A.token, body: { wins: ['a', 'b', 'c', 'd'] } })).status === 400, 'wins cap 400');
ok((await call('PUT', `/circles/${code}/signal`, { token: A.token, raw: '{bad' })).status === 400, 'bad json 400');
ok((await call('PUT', `/circles/${code}/signal`, { token: A.token, raw: JSON.stringify({ wins: ['x'.repeat(40000)] }) })).status === 400, 'body > 32KB rejected');

const put = (m, body) => call('PUT', `/circles/${code}/signal`, { token: m.token, body });
const r1 = await put(A, { week_of: '2026-10-26', busy: 'light', big_days: ['2026-10-27'], free: ['thu-evening', 'fri-afternoon', 'sat-morning'],
  courses: [{ code: 'cse576', events: [{ kind: 'exam', title: 'Midterm', date: '2026-10-30' }] }, { code: 'MAT 343', events: [{ kind: 'quiz', title: 'PRIVATE-QUIZ', date: '2026-10-28' }] }],
  want_help: [{ course: 'CSE 576', topic: 'HMMs' }], evil: 'dropped' });
ok(r1.status === 200 && r1.j.ok, 'A signal');
await put(B, { week_of: '2026-10-26', busy: 'busy', big_days: ['2026-10-27'], free: ['thu-evening', 'fri-afternoon'],
  courses: [{ code: 'CSE  576', events: [{ kind: 'exam', title: 'Midterm', date: '2026-10-30' }] }, { code: 'SECRET 101', events: [{ kind: 'exam', title: 'HIDDEN-EXAM', date: '2026-10-29' }] }],
  can_help: [{ course: 'CSE 576', topic: 'HMMs' }, { course: 'SECRET 101', topic: 'HIDDENTOPIC' }], wins: ['finished my project'] });
await put(C, { free: ['fri-afternoon'], courses: [{ code: 'CSE 576', events: [] }], busy: 'packed' });

const fa = (await call('GET', `/circles/${code}/feed?today=${TODAY}`, { token: A.token })).j;
const fb = (await call('GET', `/circles/${code}/feed?today=${TODAY}`, { token: B.token })).j;
const sFa = JSON.stringify(fa), sFb = JSON.stringify(fb);
ok(!/SECRET|HIDDEN/.test(sFa), "non-shared course (SECRET 101) never in A's feed");
ok(!/MAT 343|PRIVATE-QUIZ/.test(sFb), "non-shared course (MAT 343) never in B's feed");
ok(fa.me.name === 'Manas' && fa.friends.length === 2, 'feed friends (2)');
const sam = fa.friends.find((f) => f.name === 'Sam');
ok(sam.shared_courses.length === 1 && sam.shared_courses[0].code === 'CSE 576' && sam.can_help.length === 1, 'shared_courses/can_help filtered');
ok(!('token_hash' in sam) && !('circle_code' in sam), 'no internals in friend view');
const sug = fa.suggestions;
ok(sug.length <= 5 && sug[0].type === 'check_on' && /big day tomorrow/.test(sug[0].text), 'check_on first');
const sm = sug.find((s) => s.type === 'study_match' && s.friend_name === 'Sam');
ok(sm && sm.help_topic === 'HMMs' && sm.course === 'CSE 576' && sm.window === 'thu-evening' && sm.event.date === '2026-10-30', 'study_match with help_topic');
const types = sug.map((s) => s.type);
ok(JSON.stringify(types) === JSON.stringify([...types].sort((a, b) => ['check_on', 'jam', 'study_match', 'help_match', 'celebrate', 'hangout'].indexOf(a) - ['check_on', 'jam', 'study_match', 'help_match', 'celebrate', 'hangout'].indexOf(b))), 'suggestion priority order');
ok(sug.some((s) => s.type === 'celebrate'), 'celebrate present');
const fc = (await call('GET', `/circles/${code}/feed?today=${TODAY}`, { token: C.token })).j;
ok(!fc.suggestions.some((s) => s.type === 'hangout'), 'packed member gets no hangout suggestion');

// propose -> both yes
const P1 = await call('POST', `/circles/${code}/proposals`, { token: A.token, body: { to: [B.member_id, C.member_id], kind: 'hangout', window: 'fri-afternoon', time: '15:00', note: 'coffee?' } });
ok(P1.status === 200 && P1.j.status === 'open' && P1.j.to_names.join() === 'Sam,Priya', 'propose');
const y1 = (await call('POST', `/proposals/${P1.j.id}/respond`, { token: B.token, body: { answer: 'yes', today: TODAY } })).j;
ok(y1.proposal.status === 'open' && y1.counter === null, 'first yes stays open');
const y2 = (await call('POST', `/proposals/${P1.j.id}/respond`, { token: C.token, body: { answer: 'yes' } })).j;
ok(y2.proposal.status === 'accepted', 'both yes -> accepted');
ok((await call('POST', `/proposals/${P1.j.id}/respond`, { token: C.token, body: { answer: 'no' } })).status === 409, 'respond to closed 409');
ok((await call('POST', `/proposals/${P1.j.id}/respond`, { token: A.token, body: { answer: 'yes' } })).status === 404, 'non-recipient respond rejected');

// propose -> no -> counter
const P2 = (await call('POST', `/circles/${code}/proposals`, { token: A.token, body: { to: [B.member_id], kind: 'study', course: 'cse576', window: 'thu-evening' } })).j;
const n2 = (await call('POST', `/proposals/${P2.id}/respond`, { token: B.token, body: { answer: 'no', today: TODAY } })).j;
ok(n2.proposal.status === 'countered' && n2.counter && n2.counter.window === 'fri-afternoon' && n2.counter.window !== P2.window, 'no -> counter with different common window');
ok(n2.counter.from_id === B.member_id && n2.counter.to_ids.join() === A.member_id && n2.counter.parent_id === P2.id && n2.counter.course === 'CSE 576', 'counter shape (from decliner to original from)');
const fa2 = (await call('GET', `/circles/${code}/feed?today=${TODAY}`, { token: A.token })).j;
ok(fa2.proposals.some((p) => p.id === n2.counter.id && p.my_response === null && p.from_name === 'Sam'), 'counter visible in feed with names');
const acc = (await call('POST', `/proposals/${n2.counter.id}/respond`, { token: A.token, body: { answer: 'yes' } })).j;
ok(acc.proposal.status === 'accepted', 'counter accepted');
// declined when no other window
const P3 = (await call('POST', `/circles/${code}/proposals`, { token: A.token, body: { to: [C.member_id], kind: 'hangout', window: 'fri-afternoon' } })).j;
const d3 = (await call('POST', `/proposals/${P3.id}/respond`, { token: C.token, body: { answer: 'no', today: TODAY } })).j;
ok(d3.proposal.status === 'declined' && d3.counter === null, 'no with no alternative -> declined');

// pause hides
ok((await call('POST', `/circles/${code}/pause`, { token: C.token })).j.ok, 'pause');
const fp = (await call('GET', `/circles/${code}/feed?today=${TODAY}`, { token: A.token })).j;
ok(!fp.friends.some((f) => f.name === 'Priya'), 'paused signal hidden');
await call('POST', `/circles/${code}/resume`, { token: C.token });
const fr = (await call('GET', `/circles/${code}/feed?today=${TODAY}`, { token: A.token })).j;
ok(fr.friends.some((f) => f.name === 'Priya'), 'resume shows again');

// log
const lg = await call('GET', `/circles/${code}/log?k=${B.token}&limit=50`);
ok(lg.status === 200 && lg.j.name === 'Study Crew' && lg.j.members.includes('Sam') && lg.j.entries.length > 5, 'log via k');
ok(new Date(lg.j.entries[0].ts) >= new Date(lg.j.entries.at(-1).ts), 'log newest first');
const shared = lg.j.entries.filter((e) => e.type === 'shared');
ok(shared.length >= 3 && shared.every((e) => !/CSE|SECRET|MAT|HMM|exam|busy|packed|thu/i.test(e.text)), 'shared entries have no signal content');
ok(!/HIDDEN|SECRET|PRIVATE/.test(JSON.stringify(lg.j)), 'log has no course content');
ok((await call('GET', `/circles/${code}/log?k=nope`)).status === 401, 'log bad k 401');
ok((await call('GET', `/circles/${code}/log`, { token: A.token })).status === 200, 'log via bearer');

// ================= v2: multi-window, busy, atomic yes, inbox, de-dup, kinds =================
{
  const fs = await import('node:fs');
  const mk = async (name, circle) => (circle ? (await call('POST', `/circles/${circle}/join`, { body: { member_name: name } })).j : (await call('POST', '/circles', { body: { name: 'V2 Crew', member_name: name } })).j);
  const X = await mk('Xavi'); const c2 = X.code; const Y = await mk('Yuki', c2); const Z = await mk('Zed', c2);
  const sig = (m, body) => call('PUT', `/circles/${c2}/signal`, { token: m.token, body });
  await sig(X, { free: ['tue-evening', 'thu-evening', 'sat-afternoon', 'fri-morning', 'mon-morning'], courses: [{ code: 'CSE 576', events: [] }] });
  await sig(Y, { free: ['thu-evening', 'sat-afternoon'], courses: [{ code: 'CSE 576', events: [] }] });
  await sig(Z, { free: ['thu-evening', 'tue-evening'], courses: [{ code: 'CSE 576', events: [] }] });
  const prop = (m, body) => call('POST', `/circles/${c2}/proposals`, { token: m.token, body });
  const resp = (m, id, body) => call('POST', `/proposals/${id}/respond`, { token: m.token, body: { today: TODAY, ...body } });

  // validation
  ok((await prop(X, { to: [Y.member_id], kind: 'study', windows: ['tue-evening', 'x'] })).status === 400, 'windows bad token 400');
  ok((await prop(X, { to: [Y.member_id], kind: 'study', windows: 'tue-evening' })).status === 400, 'windows not a list 400');
  ok((await prop(X, { to: [Y.member_id], kind: 'study', windows: [] })).status === 400, 'empty windows 400');
  ok((await prop(X, { to: [Y.member_id], kind: 'study', windows: ['mon-morning', 'tue-morning', 'wed-morning', 'thu-morning', 'fri-morning', 'sat-morning'] })).status === 400, 'more than 5 windows 400');

  // multi-window propose
  const M1 = await prop(X, { to: [Y.member_id], kind: 'study', course: 'cse576', windows: ['tue-evening', 'thu-evening', 'sat-afternoon'], today: TODAY });
  ok(M1.status === 200 && M1.j.window === 'tue-evening' && M1.j.windows.join() === 'tue-evening,thu-evening,sat-afternoon' && M1.j.round === 1, 'multi-window propose: window=windows[0], round 1');
  ok(M1.j.date === '2026-10-27' && M1.j.time === '19:00', 'multi-window propose: date from today + canonical evening time');
  const Mx = await prop(X, { to: [Y.member_id], kind: 'hangout', windows: ['sat-afternoon'], time: '16:30', today: TODAY });
  ok(Mx.j.time === '16:30' && Mx.j.date === '2026-10-31', 'explicit time kept; date maps weekday forward');
  const todayMon = await prop(X, { to: [Y.member_id], kind: 'hangout', windows: ['mon-morning'], today: TODAY });
  ok(todayMon.j.date === TODAY && todayMon.j.time === '10:00', "today's weekday maps to today; morning = 10:00");
  const legacy = await prop(X, { to: [Y.member_id], kind: 'hangout', window: 'thu-evening' });
  ok(legacy.status === 200 && legacy.j.windows.join() === 'thu-evening' && /^\d{4}-\d{2}-\d{2}$/.test(legacy.j.date) && legacy.j.time === '19:00', 'legacy single `window` (no today) still works');

  // busy -> moved in place
  const b1 = (await resp(Y, M1.j.id, { answer: 'busy', free_windows: ['thu-evening', 'sat-afternoon'] })).j;
  ok(b1.moved === true && b1.counter === null && b1.proposal.id === M1.j.id && b1.proposal.status === 'open', 'busy moves the SAME proposal, stays open');
  ok(b1.proposal.window === 'thu-evening' && b1.proposal.round === 2 && b1.proposal.date === '2026-10-29' && b1.proposal.time === '19:00', 'busy: next window in responder free set, round+1, date/time recomputed');
  ok(b1.proposal.responses[X.member_id] === 'yes' && !b1.proposal.responses[Y.member_id], 'busy: responses reset except proposer yes');
  const fx = (await call('GET', `/circles/${c2}/feed?today=${TODAY}`, { token: X.token })).j;
  ok(fx.friends.find((f) => f.name === 'Yuki').free.join() === 'thu-evening,sat-afternoon', "busy free_windows updates responder's signal.free");
  const b2 = (await resp(Y, M1.j.id, { answer: 'busy', free_windows: ['sat-afternoon'] })).j;
  ok(b2.moved && b2.proposal.window === 'sat-afternoon' && b2.proposal.round === 3 && b2.proposal.time === '14:00' && b2.proposal.date === '2026-10-31', 'busy again -> third window, afternoon canonical time');
  const b3 = (await resp(Y, M1.j.id, { answer: 'busy', free_windows: [] })).j;
  ok(b3.moved === false && b3.proposal.status === 'declined', 'busy with no option -> declined');
  ok((await resp(Y, M1.j.id, { answer: 'yes' })).status === 409, 'declined proposal is closed');
  ok((await resp(Y, legacy.j.id, { answer: 'maybe' })).status === 400 && (await resp(Y, legacy.j.id, { answer: 'busy', free_windows: ['nope'] })).status === 400, 'bad answer / bad free_windows 400');

  // busy without free_windows falls back to the next common window from stored signals (Y free: sat-afternoon only after above)
  const lg2 = (await call('GET', `/circles/${c2}/log?limit=100`, { token: X.token })).j.entries;
  const mv = lg2.filter((e) => e.type === 'moved');
  ok(mv.length === 2 && mv.some((e) => /Yuki's Cubbie checked their calendar/.test(e.text) && /Tue evening is busy\. Moved to Thu evening\./.test(e.text) && e.kind === 'agent'), 'log text for moved (agent kind)');
  ok(lg2.some((e) => /No shared time this week\./.test(e.text) && e.type === 'declined'), 'log text for no shared time');

  // max 4 rounds
  const R = await prop(X, { to: [Y.member_id], kind: 'study', windows: ['tue-evening', 'thu-evening', 'sat-afternoon', 'fri-morning', 'mon-morning'], today: TODAY });
  const all5 = ['tue-evening', 'thu-evening', 'sat-afternoon', 'fri-morning', 'mon-morning'];
  const rounds = [];
  let last;
  for (let i = 0; i < 4; i++) { last = (await resp(Y, R.j.id, { answer: 'busy', free_windows: all5 })).j; rounds.push(last.proposal.round); }
  ok(rounds.slice(0, 3).join() === '2,3,4' && last.proposal.status === 'declined' && last.moved === false, 'max 4 rounds: 4th busy is declined, rounds went 1->4');

  // busy falls back to the next best common window when no remaining `windows` entry is free
  await sig(Y, { free: ['thu-evening', 'fri-morning'] });
  const F = await prop(X, { to: [Y.member_id], kind: 'hangout', windows: ['tue-evening'], today: TODAY });
  const fb2 = (await resp(Y, F.j.id, { answer: 'busy', free_windows: ['fri-morning', 'thu-evening'] })).j;
  ok(fb2.moved && fb2.proposal.window === 'thu-evening' && fb2.proposal.windows.join() === 'tue-evening', 'busy falls back to next common window (outside windows list)');
  // `no` skips windows already rejected in this proposal
  const nn = (await resp(Y, F.j.id, { answer: 'no' })).j;
  ok(nn.proposal.status === 'countered' && nn.counter.window === 'fri-morning' && nn.counter.date && nn.counter.time === '10:00', 'no -> counter skips tried windows (tue, thu), carries date/time');

  // atomic yes with 3 people (repeat to stress the race)
  let atomicOk = true; const ids = [];
  for (let i = 0; i < 6; i++) {
    const P = (await prop(X, { to: [Y.member_id, Z.member_id], kind: 'study', course: 'CSE 576', windows: ['thu-evening'], today: TODAY })).j;
    const [r1, r2] = await Promise.all([resp(Y, P.id, { answer: 'yes' }), resp(Z, P.id, { answer: 'yes' })]);
    const cur = (await call('GET', `/circles/${c2}/feed?today=${TODAY}`, { token: X.token })).j.proposals.find((p) => p.id === P.id);
    ids.push(P.id);
    if (!(r1.status === 200 && r2.status === 200 && cur.status === 'accepted' && cur.responses[Y.member_id] === 'yes' && cur.responses[Z.member_id] === 'yes')) atomicOk = false;
  }
  ok(atomicOk, 'atomic yes: two concurrent responders both counted, proposal accepted (6 rounds of race)');
  const accP = (await call('GET', `/circles/${c2}/feed?today=${TODAY}`, { token: Z.token })).j.proposals.find((p) => p.id === ids[0]);
  ok(accP.date === '2026-10-29' && accP.time === '19:00' && accP.status === 'accepted', 'accepted proposal has date + canonical time');
  const planLogs = (await call('GET', `/circles/${c2}/log?limit=100`, { token: X.token })).j.entries.filter((e) => /Plan set: Study CSE 576 · Thu Oct 29 · 7:00 PM/.test(e.text));
  ok(planLogs.length === 6, 'exactly one "Plan set" log per accepted proposal (no double-accept)');

  // inbox
  const tBefore = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 20));
  const NP = (await prop(X, { to: [Y.member_id], kind: 'hangout', windows: ['thu-evening'], today: TODAY })).j;
  const iy = (await call('GET', `/circles/${c2}/inbox?since=${tBefore}&today=${TODAY}`, { token: Y.token })).j;
  ok(iy.needs_answer.some((p) => p.id === NP.id) && iy.needs_answer.every((p) => p.to_ids.includes(Y.member_id) && !p.responses[Y.member_id]) && typeof iy.now === 'string', 'inbox needs_answer lists open proposals awaiting my reply');
  await resp(Y, NP.id, { answer: 'busy', free_windows: ['fri-morning'] });
  const ix = (await call('GET', `/circles/${c2}/inbox?since=${tBefore}&today=${TODAY}`, { token: X.token })).j;
  ok(ix.updates.some((u) => u.id === NP.id && u.change === 'moved' && u.window === 'fri-morning'), 'inbox updates: my proposal moved since ts');
  const ixAll = (await call('GET', `/circles/${c2}/inbox?today=${TODAY}`, { token: X.token })).j;
  ok(ixAll.updates.some((u) => u.id === ids[0] && u.change === 'accepted') && !ix.updates.some((u) => u.id === ids[0]), 'inbox updates: accepted shown only for changes since ts');
  const ix2 = (await call('GET', `/circles/${c2}/inbox?since=${ix.now}&today=${TODAY}`, { token: X.token })).j;
  ok(ix2.updates.length === 0, 'inbox updates empty after `now`');
  const tMid = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 20));
  await sig(Z, { free: ['thu-evening'], big_days: ['2026-10-27'], wins: ['aced it'] });
  const ixn = (await call('GET', `/circles/${c2}/inbox?since=${tMid}&today=${TODAY}`, { token: X.token })).j;
  ok(ixn.new_nudges.some((n) => n.type === 'check_on' && n.friend_name === 'Zed') && ixn.new_nudges.some((n) => n.type === 'celebrate') && ixn.new_nudges.every((n) => ['check_on', 'celebrate'].includes(n.type)), 'inbox new_nudges: check_on/celebrate from signals updated since ts');
  const ixn2 = (await call('GET', `/circles/${c2}/inbox?since=${ixn.now}&today=${TODAY}`, { token: X.token })).j;
  ok(ixn2.new_nudges.length === 0, 'inbox new_nudges empty when nothing new');
  const Q = await mk('Quin', c2);
  const iq = (await call('GET', `/circles/${c2}/inbox?since=${ixn.now}&today=${TODAY}`, { token: Q.token })).j;
  ok(iq.needs_answer.length === 0 && iq.updates.length === 0 && iq.new_nudges.length === 0, 'inbox is empty when nothing new');
  ok((await call('GET', `/circles/${c2}/inbox?since=garbage`, { token: Q.token })).status === 400 && (await call('GET', `/circles/${c2}/inbox`)).status === 401, 'inbox validates since + auth');

  // feed suppresses suggestions for pairs with an open/accepted proposal
  const E1 = await mk('Eve'); const c3 = E1.code; const E2 = await mk('Finn', c3);
  const sg = (m, body) => call('PUT', `/circles/${c3}/signal`, { token: m.token, body });
  const exam = [{ code: 'CSE 576', events: [{ kind: 'exam', title: 'Midterm', date: '2026-10-30' }] }];
  await sg(E1, { free: ['thu-evening'], courses: exam }); await sg(E2, { free: ['thu-evening'], courses: exam });
  const feedE = async () => (await call('GET', `/circles/${c3}/feed?today=${TODAY}`, { token: E1.token })).j.suggestions;
  const before = await feedE();
  ok(before.some((s) => s.type === 'study_match' && s.course === 'CSE 576'), 'study_match suggested before any proposal');
  const EP = (await call('POST', `/circles/${c3}/proposals`, { token: E1.token, body: { to: [E2.member_id], kind: 'study', course: 'CSE 576', windows: ['thu-evening'], today: TODAY } })).j;
  const after = await feedE();
  ok(!after.some((s) => s.type === 'study_match' || s.type === 'help_match') && !after.some((s) => s.type === 'hangout'), 'open proposal suppresses study_match/hangout for that pair');
  await call('POST', `/proposals/${EP.id}/respond`, { token: E2.token, body: { answer: 'yes' } });
  ok(!(await feedE()).some((s) => s.type === 'study_match'), 'accepted proposal still suppresses study_match');
  // declined proposal does not suppress
  const EP2 = (await call('POST', `/circles/${c3}/proposals`, { token: E1.token, body: { to: [E2.member_id], kind: 'hangout', windows: ['thu-evening'], today: TODAY } })).j;
  await call('POST', `/proposals/${EP2.id}/respond`, { token: E2.token, body: { answer: 'busy', free_windows: [], today: TODAY } });
  ok((await call('GET', `/circles/${c3}/feed?today=${TODAY}`, { token: E1.token })).j.proposals.find((p) => p.id === EP2.id) === undefined, 'declined proposal not listed in feed');

  // log kinds + viewer
  const lgk = (await call('GET', `/circles/${c2}/log?limit=100`, { token: X.token })).j.entries;
  ok(lgk.every((e) => ['agent', 'student', 'system'].includes(e.kind)), 'every log entry carries kind agent|student|system');
  ok(lgk.some((e) => e.kind === 'agent' && e.type === 'proposed') && lgk.some((e) => e.kind === 'student' && e.type === 'accepted') && lgk.some((e) => e.kind === 'system' && e.type === 'countered'), 'kinds: proposed=agent, accepted=student, countered=system');
  ok(!/Midterm|HIDDEN|SECRET/.test(JSON.stringify(lgk)), 'v2 log has no signal contents');
  // the log viewer moved from index.html to circle.html (index.html is now the landing page)
  const pub = new URL('../../relay/public/', import.meta.url).pathname;
  const viewerFile = fs.existsSync(pub + 'circle.html') ? 'circle.html' : 'index.html';
  const html = fs.readFileSync(pub + viewerFile, 'utf8') + (fs.existsSync(pub + 'orbit.js') ? fs.readFileSync(pub + 'orbit.js', 'utf8') : '');
  ok(/kind/.test(html) && /agent/.test(html) && /student/.test(html), `viewer (${viewerFile}) renders agent/student tags`);
}

// ===================== v3: view keys, board, demo, stats, group plans, timeouts =====================
const mc = await MongoClient.connect(process.env.MONGODB_URI);
const mdb = mc.db('orbit_test');
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const HOUR = 3600e3;

// -- view keys for circles created before v3
{
  const oldTok = crypto.randomBytes(32).toString('hex');
  await mdb.collection('circles').insertOne({ code: 'OLDOLD', name: 'Legacy', created_at: new Date() });
  await mdb.collection('members').insertOne({ circle_code: 'OLDOLD', member_id: 'abcdef01', name: 'Old', token_hash: sha(oldTok), joined_at: new Date(), paused: false });
  ok(!(await mdb.collection('circles').findOne({ code: 'OLDOLD' })).view_key, 'legacy circle starts without view_key');
  const g1 = (await call('GET', '/circles/OLDOLD', { token: oldTok })).j;
  ok(/^http:\/\/127\.0\.0\.1:\d+\/circle\?c=OLDOLD&v=[0-9a-f]{24}$/.test(g1.view_url), 'old circle gets view_url on first GET');
  const stored = (await mdb.collection('circles').findOne({ code: 'OLDOLD' })).view_key;
  ok(g1.view_url.endsWith('v=' + stored) && (await call('GET', '/circles/OLDOLD', { token: oldTok })).j.view_url === g1.view_url, 'view_key persisted and stable');
  const g2 = (await call('GET', `/circles/${code}`, { token: A.token })).j;
  ok(/v=[0-9a-f]{24}$/.test(g2.view_url) && g2.members.length >= 2, 'getCircle keeps members and adds view_url');
  const fresh = (await call('POST', '/circles', { body: { name: 'Fresh', member_name: 'Zed' } })).j;
  ok(/^[0-9a-f]{24}$/.test((await mdb.collection('circles').findOne({ code: fresh.code })).view_key), 'new circles get view_key at creation');
  await call('POST', `/circles/${fresh.code}/leave`, { token: fresh.token });
}

// -- group plans, board, view-only access
const G = {};
for (const [k, n] of [['a', 'Gia'], ['b', 'Gus'], ['c', 'Gwen']]) {
  G[k] = k === 'a' ? (await call('POST', '/circles', { body: { name: 'Group Chat', member_name: n } })).j : (await call('POST', `/circles/${G.a.code}/join`, { body: { member_name: n } })).j;
}
const gcode = G.a.code;
const share = (m, free, extra = {}) => call('PUT', `/circles/${gcode}/signal`, { token: m.token, body: { week_of: TODAY, busy: 'busy', free, courses: [{ code: 'ZZZ 999', events: [{ kind: 'exam', title: 'SECRETEXAM', date: '2026-10-30' }] }], can_help: [{ course: 'ZZZ 999', topic: 'SECRETTOPIC' }], ...extra } });
ok((await share(G.a, ['tue-evening', 'thu-evening', 'sat-evening'])).status === 200, 'group signals shared');
await share(G.b, ['thu-evening', 'sat-evening']);
await share(G.c, ['sat-evening']);
const gv = (await call('GET', `/circles/${gcode}`, { token: G.a.token })).j.view_url.split('v=')[1];
{
  const lg = await call('GET', `/circles/${gcode}/log?v=${gv}&limit=5`);
  ok(lg.status === 200 && lg.j.entries.length > 0 && lg.j.entries.every((e) => e.kind), 'log readable with v=');
  ok((await call('GET', `/circles/${gcode}/log?v=${'0'.repeat(24)}`)).status === 401, 'log with wrong v -> 401');
  ok((await call('GET', `/circles/${gcode}/log?v=short`)).status === 401, 'log with malformed v -> 401');
  ok((await call('GET', `/circles/${code}/log?v=${gv}`)).status === 401, 'v of another circle -> 401');
  const sh = await call('PUT', `/circles/${gcode}/signal?v=${gv}`, { body: { busy: 'light' } });
  ok(sh.status === 401, 'v= cannot share');
  const pr = await call('POST', `/circles/${gcode}/proposals?v=${gv}`, { body: { to: [G.b.member_id], kind: 'hangout', window: 'thu-evening' } });
  ok(pr.status === 401, 'v= cannot propose');
  const gp = (await call('POST', `/circles/${gcode}/proposals`, { token: G.a.token, body: { to: [G.b.member_id], kind: 'hangout', windows: ['thu-evening'], today: TODAY } })).j;
  ok((await call('POST', `/proposals/${gp.id}/respond?v=${gv}`, { body: { answer: 'yes' } })).status === 401, 'v= cannot respond');
  ok((await call('GET', `/circles/${gcode}?v=${gv}`)).status === 401 && (await call('GET', `/circles/${gcode}/feed?v=${gv}&today=${TODAY}`)).status === 401, 'v= cannot read circle or feed');
  await call('POST', `/proposals/${gp.id}/respond`, { token: G.b.token, body: { answer: 'yes', today: TODAY } });

  const bd = await call('GET', `/circles/${gcode}/board?v=${gv}`);
  const raw = JSON.stringify(bd.j);
  ok(bd.status === 200 && bd.j.name === 'Group Chat' && bd.j.members.length === 3 && bd.j.members.every((m) => m.name && m.busy === 'busy' && Object.keys(m).every((k) => ['name', 'busy', 'updated_at', 'cheers', 'cheers_received'].includes(k))), 'board members: name + busy (+ cheers counts) only');
  ok(bd.j.plans.length === 1 && bd.j.plans[0].status === 'accepted' && bd.j.plans[0].kind === 'hangout' && bd.j.plans[0].from_name === 'Gia' && bd.j.plans[0].to_names[0] === 'Gus' && bd.j.plans[0].round === 1 && bd.j.plans[0].date && bd.j.plans[0].time, 'board plans have kind/date/time/status/round/names');
  ok(bd.j.log.length > 0 && bd.j.log.length <= 60 && bd.j.stats.proposals === 1 && bd.j.stats.locked === 1 && bd.j.stats.agent_moves === 0, 'board log + stats');
  ok(!/SECRET|ZZZ|sat-evening|thu-evening"/.test(raw.replace(/"window":"[^"]*"/g, '')) && !raw.includes(G.a.token) && !raw.includes(G.b.token) && !/token|"free"|courses|can_help|want_help/.test(raw), 'board has no free windows, courses or tokens');
  ok((await call('GET', `/circles/${gcode}/board?v=${'f'.repeat(24)}`)).status === 401, 'board needs a valid key');
  const np = await call('GET', `/circles/${gcode}/board`);
  ok(np.status === 404 && np.j.code === 'not_public', 'board without a key is 404 not_public while the circle is private');
  ok((await call('GET', `/circles/${gcode}/board`, { token: G.a.token })).status === 200, 'board also works with bearer');
  ok((await call('GET', `/circles/NOPE22/board?v=${gv}`)).status === 404, 'board unknown circle 404');
}

// -- group proposal busy uses the intersection of everyone
const gprop = async (windows, extra = {}) => (await call('POST', `/circles/${gcode}/proposals`, { token: G.a.token, body: { to: [G.b.member_id, G.c.member_id], kind: 'study', course: 'ZZZ 999', windows, today: TODAY, ...extra } })).j;
{
  const g = await gprop(['tue-evening', 'thu-evening']);
  ok(g.to_ids.length === 2 && g.status === 'open', 'group proposal to 2 invitees');
  const r = await call('POST', `/proposals/${g.id}/respond`, { token: G.b.token, body: { answer: 'busy', free_windows: ['thu-evening', 'sat-evening'], today: TODAY } });
  ok(r.j.moved === true && r.j.proposal.window === 'sat-evening' && r.j.proposal.round === 2, 'group busy skips thu (Gwen busy) and lands on the common sat-evening');
  ok(Object.keys(r.j.proposal.responses).join() === G.a.member_id, 'responses reset on move');
  ok((await call('POST', `/proposals/${g.id}/respond`, { token: G.b.token, body: { answer: 'yes', today: TODAY } })).j.proposal.status === 'open', 'group: one yes keeps it open');
  const fin = (await call('POST', `/proposals/${g.id}/respond`, { token: G.c.token, body: { answer: 'yes', today: TODAY } })).j;
  ok(fin.proposal.status === 'accepted' && fin.proposal.date === '2026-10-31' && fin.proposal.time === '19:00', 'group accepted when all invitees said yes');
  const lgs = (await call('GET', `/circles/${gcode}/log?limit=100`, { token: G.a.token })).j.entries.map((e) => e.text).join('\n');
  ok(/Gus's Cubbie checked their calendar/.test(lgs) && /Plan set: Study ZZZ 999 · Sat Oct 31 · 7:00 PM/.test(lgs), 'group move + plan logged');
  // nothing common at all -> declined
  const g2 = await gprop(['tue-evening']);
  const r2 = await call('POST', `/proposals/${g2.id}/respond`, { token: G.b.token, body: { answer: 'busy', free_windows: ['fri-morning'], today: TODAY } });
  ok(r2.j.proposal.status === 'declined', 'group busy with no common window declines');
}

// -- timeouts
{
  const back = (id, hours) => mdb.collection('proposals').updateOne({ id }, { $set: { created_at: new Date(Date.now() - hours * HOUR) } });
  const inboxA = async () => (await call('GET', `/circles/${gcode}/inbox?since=2000-01-01T00:00:00Z&today=${TODAY}`, { token: G.a.token })).j;
  const g = await gprop(['sat-evening']);
  await call('POST', `/proposals/${g.id}/respond`, { token: G.b.token, body: { answer: 'yes', today: TODAY } });
  const fresh = await inboxA();
  ok(!fresh.updates.some((u) => u.id === g.id), 'before 24 h nothing times out');
  await back(g.id, 25);
  const ib = await inboxA();
  const up = ib.updates.find((u) => u.id === g.id);
  ok(up && up.status === 'accepted' && up.change === 'accepted' && up.to_ids.join() === G.b.member_id, 'group timeout: non-responder dropped, plan accepted for the rest');
  ok(!(await call('GET', `/circles/${gcode}/inbox?today=${TODAY}`, { token: G.c.token })).j.needs_answer.some((x) => x.id === g.id), 'dropped invitee no longer asked');
  ok((await call('POST', `/proposals/${g.id}/respond`, { token: G.c.token, body: { answer: 'yes' } })).status === 404 , 'dropped invitee cannot answer any more');
  ok((await call('GET', `/circles/${gcode}/log?limit=100`, { token: G.a.token })).j.entries.some((e) => /Gwen didn't answer in time; plan set for the rest/.test(e.text) && e.kind === 'system'), 'timeout drop logged');

  const g0 = await gprop(['sun-evening']);
  await back(g0.id, 30);
  const u0 = (await inboxA()).updates.find((u) => u.id === g0.id);
  ok(u0 && u0.status === 'expired' && u0.change === 'expired', 'group with no yes -> expired');

  const one = (await call('POST', `/circles/${gcode}/proposals`, { token: G.a.token, body: { to: [G.b.member_id], kind: 'hangout', windows: ['mon-evening'], today: TODAY } })).j;
  await back(one.id, 24.5);
  const needs = (await call('GET', `/circles/${gcode}/inbox?today=${TODAY}`, { token: G.b.token })).j.needs_answer;
  ok(!needs.some((x) => x.id === one.id), '1:1 expired proposal no longer needs an answer');
  const u1 = (await inboxA()).updates.find((u) => u.id === one.id);
  ok(u1 && u1.status === 'expired' && u1.change === 'expired', '1:1 -> expired, shown in inbox updates');
  ok((await call('POST', `/proposals/${one.id}/respond`, { token: G.b.token, body: { answer: 'yes' } })).status === 409, 'cannot answer an expired proposal');
  ok((await call('GET', `/circles/${gcode}/log?limit=100`, { token: G.a.token })).j.entries.some((e) => /No answer in 24 h; plan expired/.test(e.text)), 'expiry logged');
  const feedP = (await call('GET', `/circles/${gcode}/feed?today=${TODAY}`, { token: G.a.token })).j.proposals;
  ok(!feedP.some((x) => x.status === 'expired'), 'expired not in feed proposals');
  const brd = (await call('GET', `/circles/${gcode}/board?v=${gv}`)).j;
  ok(brd.plans.some((x) => x.status === 'expired'), 'board shows expired plans');
}

// -- live demo
const demoTokens = [];
let demoStarts = 0;
const startDemo = async () => { demoStarts++; return call('POST', '/demo/start'); };
{
  const st = await startDemo();
  ok(st.status === 200 && /^[0-9a-f]{12}$/.test(st.j.demo_id) && /^[A-Z2-9]{6}$/.test(st.j.code) && /^[0-9a-f]{24}$/.test(st.j.view_v) && st.j.steps_total === 18, 'demo start shape');
  const dcode = st.j.code;
  const responses = [JSON.stringify(st.j)];
  const steps = [];
  for (let i = 1; i <= 18; i++) {
    const r = await call('POST', `/demo/${st.j.demo_id}/step`);
    ok(r.status === 200 && r.j.step === i && r.j.total === 18 && r.j.done === (i === 18) && r.j.text && ['left', 'right', 'agents'].includes(r.j.channel), `demo step ${i}`);
    steps.push(r.j); responses.push(JSON.stringify(r.j));
  }
  ok(/^You and Manas both have CSE 576, quiz Fri\. Study Tue evening, or Thu\?$/.test(steps[0].text) && steps[0].bubble.from === 'cubbie' && steps[0].bubble.side === 'left', 'demo step 1 text from the real feed');
  ok(steps[1].text === 'yes' && steps[1].bubble.from === 'student', 'demo step 2');
  ok(steps[2].channel === 'agents' && steps[2].log_entry.type === 'proposed' && steps[2].plan.status === 'open' && steps[2].plan.window === 'tue-evening', 'demo step 3 real proposal');
  ok(steps[2].plan.reasons.length >= 2 && steps[2].plan.reasons[0] === 'before CSE 576 quiz Fri' && steps[2].plan.reasons.includes('free for Manav and Manas') && steps[2].plan.places.join() === 'Hayden Library 2nd floor,Zoom', 'demo step 3 proposal carries reasons + places');
  ok(/received a proposal/.test(steps[3].text), 'demo step 4 inbox');
  ok(steps[4].log_entry.type === 'moved' && steps[4].plan.window === 'thu-evening' && steps[4].plan.round === 2 && /Tue evening is busy\. Moved to Thu evening/.test(steps[4].text), 'demo step 5 real busy-move');
  ok(steps[4].plan.reasons.includes('Tue evening busy for Manas') && steps[4].plan.reasons.some((x) => /preferred evenings/.test(x)), 'demo step 5 reasons explain the move + preferences');
  ok(/^Manav wants to study CSE 576 Thu 7 PM at Hayden Library 2nd floor\. You're free then\. Lock it in\?$/.test(steps[5].text) && steps[5].channel === 'right', 'demo step 6 asks with the place');
  ok(steps[6].plan.status === 'accepted' && steps[6].log_entry.type === 'accepted' && steps[6].bubble.side === 'right' && steps[6].plan.place === 'Hayden Library 2nd floor' && /Hayden Library 2nd floor$/.test(steps[6].log_entry.text), 'demo step 7 accepted via real respond with place choice');
  ok(/^Locked in: Study CSE 576 · Thu [A-Z][a-z]{2} \d{1,2} · 7:00 PM · Hayden Library 2nd floor$/.test(steps[7].text) && steps[7].bubbles.length === 2 && /Added to your calendar/.test(steps[7].bubbles[0].text) && /Reminder set for 6 PM/.test(steps[7].bubbles[0].text) && /T18:00:00$/.test(steps[7].plan.remind_at), 'demo step 8 locked in both phones with reminder');
  ok(steps[8].log_entry.type === 'rescheduled' && steps[8].text === "Manas's Cubbie found a new conflict. Proposed Sat afternoon instead." && steps[8].plan.status === 'open' && steps[8].plan.window === 'sat-afternoon' && steps[8].plan.round === 3 && steps[8].plan.reschedules === 1, 'demo step 9 real auto-reschedule');
  ok(steps[8].plan.reasons.includes('Thu evening no longer free for Manas') && steps[8].plan.reasons.includes('free for Manav and Manas'), 'demo step 9 reasons');
  ok(/^Manas's calendar changed\. Move Study CSE 576 to Sat 2 PM at Hayden Library 2nd floor\? yes\?$/.test(steps[9].text) && steps[9].channel === 'left', 'demo step 10 Manav asked to confirm');
  ok(steps[10].plan.status === 'accepted' && steps[10].log_entry.type === 'accepted' && steps[10].plan.window === 'sat-afternoon', 'demo step 11 Manav confirms the new time');
  ok(/^Locked in: Study CSE 576 · Sat [A-Z][a-z]{2} \d{1,2} · 2:00 PM · Hayden Library 2nd floor$/.test(steps[11].text) && /Calendar updated/.test(steps[11].bubbles[0].text) && steps[11].plan.round === 3, 'demo step 12 locked in again');
  ok(/^Reya has a big day tomorrow\. Want a short text to send her\?$/.test(steps[12].text), 'demo step 13 check_on from real feed');
  ok(steps[13].text === 'Big day tomorrow, you got this. coffee after? ☕' && /not the AI/.test(steps[13].note) && steps[13].done === false && /^Manav checked on Reya/.test(steps[13].log_entry.text), 'demo step 14 draft + cheer logged');
  // v5 jam beat (steps 15-18): share what you play, a jam nudge from the real feed, a jam proposal with a playlist, locked in
  ok(steps[14].channel === 'agents' && steps[14].text === "Manav's Cubbie shared what he's playing: Arctic Monkeys – Do I Wanna Know?. It stays up for 30 min." && steps[14].log_entry.type === 'playing' && !/Arctic/.test(steps[14].log_entry.text) && steps[14].now_playing.artist === 'Arctic Monkeys', 'v5 demo step 15: now-playing shared, log names no artist');
  ok(steps[15].channel === 'right' && steps[15].text === "Manav is playing Arctic Monkeys right now, one of your favorites. You're both free this evening. Jam session?" && steps[15].suggestion.type === 'jam' && steps[15].bubble.side === 'right', 'v5 demo step 16: Manas gets the real jam suggestion');
  ok(steps[16].text === 'yes' && steps[16].bubble.from === 'student' && steps[16].plan.kind === 'jam' && steps[16].plan.status === 'open' && steps[16].plan.playlist.name === "Indie's Top 50" && steps[16].log_entry.type === 'proposed', 'v5 demo step 17: yes proposes a jam session with a playlist');
  ok(steps[17].plan.status === 'accepted' && steps[17].plan.kind === 'jam' && /^Locked in: Jam session · [A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} · 7:00 PM · Manav's place · 🎧 Indie's Top 50$/.test(steps[17].text) && steps[17].done === true && steps[17].bubbles.length === 2 && /Reminder set for 6 PM/.test(steps[17].bubbles[0].text), 'v5 demo step 18: locked in on both phones with the playlist');
  ok(steps.slice(14).every((s) => !/tok|token|[0-9a-f]{64}/i.test(JSON.stringify(s))), 'v5 demo jam steps carry no raw tokens');
  ok(new Date(steps[7].plan.date + 'T00:00:00Z').getUTCDay() === 4 && new Date(steps[11].plan.date + 'T00:00:00Z').getUTCDay() === 6, 'demo plan dates are Thursday then Saturday');
  ok((await call('POST', `/demo/${st.j.demo_id}/step`)).status === 409, 'demo step after done -> 409');
  ok((await call('POST', '/demo/aaaaaaaaaaaa/step')).status === 404 && (await call('POST', '/demo/zzz/step')).status === 404, 'unknown demo 404');

  const bd = await call('GET', `/circles/${dcode}/board?v=${st.j.view_v}`);
  responses.push(JSON.stringify(bd.j), JSON.stringify((await call('GET', `/circles/${dcode}/log?v=${st.j.view_v}&limit=100`)).j));
  ok(bd.status === 200 && bd.j.name === `Demo · ${dcode}` && bd.j.members.map((m) => m.name).sort().join() === 'Manas,Manav,Reya', 'demo board members');
  ok(bd.j.plans.length === 2 && bd.j.plans.find((p) => p.kind === 'jam').status === 'accepted' && bd.j.plans.find((p) => p.kind === 'study').round === 3 && bd.j.stats.locked === 2 && bd.j.stats.agent_moves === 2 && bd.j.stats.jams === 1, 'demo board plans + stats (v5: jam plan counted)');
  ok(bd.j.plans.find((p) => p.kind === 'study').place === 'Hayden Library 2nd floor' && bd.j.plans.find((p) => p.kind === 'study').reasons.length >= 2 && bd.j.members.find((m) => m.name === 'Manav').cheers === 1 && bd.j.members.find((m) => m.name === 'Reya').cheers_received === 1, 'demo board plan has place + reasons, member cheers count');
  const types = bd.j.log.map((e) => e.type);
  ok(['proposed', 'moved', 'rescheduled', 'accepted', 'cheered', 'shared', 'joined', 'playing'].every((t) => types.includes(t)) && bd.j.log[0].type === 'accepted', 'demo log has real proposal, busy-move, reschedule, accept, cheer, playing, jam lock (newest first)');
  const doc = await mdb.collection('demos').findOne({ demo_id: st.j.demo_id });
  const toks = Object.values(doc.tokens);
  ok(toks.length === 3 && toks.every((t) => /^[0-9a-f]{64}$/.test(t)), 'demo doc keeps raw tokens server-side');
  demoTokens.push(...toks);
  ok(toks.every((t) => !responses.join('\n').includes(t)), 'demo raw tokens never in any API response');
  ok((await call('POST', `/circles/${dcode}/join`, { body: { member_name: 'Intruder' } })).status === 403, 'cannot join a demo circle');
  ok((await mdb.collection('proposals').countDocuments({ circle_code: dcode, status: 'accepted' })) === 2, 'demo proposals really stored as accepted (study + jam)');
}

// -- demo cleanup, rate limit, stats
{
  const old = await startDemo();
  await mdb.collection('circles').updateOne({ code: old.j.code }, { $set: { created_at: new Date(Date.now() - 25 * HOUR) } });
  const nxt = await startDemo();
  ok(nxt.status === 200 && (await mdb.collection('circles').countDocuments({ code: old.j.code })) === 0 && (await mdb.collection('members').countDocuments({ circle_code: old.j.code })) === 0 && (await mdb.collection('demos').countDocuments({ demo_id: old.j.demo_id })) === 0, 'expired demo circle + data deleted lazily on next start');
  ok((await mdb.collection('circles').countDocuments({ code: nxt.j.code })) === 1, 'fresh demo kept');
}
{
  // stats: first call in this process; demo circles must be excluded
  const real = { circle_code: { $nin: (await mdb.collection('circles').find({ demo: true }).toArray()).map((c) => c.code) } };
  const exp = {
    students: await mdb.collection('members').countDocuments(real),
    circles: await mdb.collection('circles').countDocuments({ demo: { $ne: true } }),
    proposals: await mdb.collection('proposals').countDocuments(real),
    plans_locked: await mdb.collection('proposals').countDocuments({ ...real, status: 'accepted' }),
    agent_moves: await mdb.collection('log').countDocuments({ ...real, type: { $in: ['moved', 'countered'] } }),
    jams: await mdb.collection('proposals').countDocuments({ ...real, kind: 'jam', status: 'accepted' }),
  };
  const s1 = await call('GET', '/stats');
  ok(s1.status === 200 && Object.keys(s1.j).sort().join() === 'agent_moves,circles,jams,plans_locked,proposals,students,updated_at', 'stats shape (no personal data)');
  ok(['students', 'circles', 'proposals', 'plans_locked', 'agent_moves', 'jams'].every((k) => s1.j[k] === exp[k]), `stats counts match non-demo data ${JSON.stringify(exp)}`);
  ok(exp.students < (await mdb.collection('members').countDocuments({})) && exp.plans_locked >= 2 && exp.agent_moves >= 2 && exp.circles >= 4, 'stats exclude demo circles and count real plans/moves');
  const extra = (await call('POST', '/circles', { body: { name: 'After', member_name: 'Q' } })).j;
  const s2 = await call('GET', '/stats');
  ok(s2.j.updated_at === s1.j.updated_at && s2.j.circles === s1.j.circles, 'stats cached for 30 s');
  await call('POST', `/circles/${extra.code}/leave`, { token: extra.token });
}
{
  let last;
  while (demoStarts < 25) { last = await startDemo(); if (last.status === 429) break; }
  ok(last.status === 429 && last.j.code === 'rate_limited' && demoStarts === 21, 'demo start rate limit: 20 per 10 min per IP');
}
await mc.close();

// ===================== v4: public board, reasons, preferences, places, auto-reschedule, reminders, cheers =====================
{
  const mc4 = await MongoClient.connect(process.env.MONGODB_URI);
  const m4 = mc4.db('orbit_test');
  const seen4 = []; // every v4 response body, scanned for raw tokens at the end
  const c4 = async (...a) => { const r = await call(...a); seen4.push(JSON.stringify(r.j)); return r; };
  const T = '2026-10-26'; // Monday
  const A4 = (await call('POST', '/circles', { body: { name: 'Orbit Four', member_name: 'Ana' } })).j;
  const v4 = A4.code;
  const B4 = (await call('POST', `/circles/${v4}/join`, { body: { member_name: 'Ben' } })).j;
  const C4 = (await call('POST', `/circles/${v4}/join`, { body: { member_name: 'Cal' } })).j;
  const tokens4 = [A4.token, B4.token, C4.token];
  const sg = (m, body) => c4('PUT', `/circles/${v4}/signal`, { token: m.token, body });
  const cse = [{ code: 'CSE 576', events: [{ kind: 'quiz', title: 'Quiz 2', date: '2026-10-30' }] }];

  // ---- public board on/off ----
  ok((await call('GET', `/circles/${v4}/board`)).j.code === 'not_public', 'v4: board without a key is 404 not_public by default');
  ok((await call('GET', '/circles/ZZZZZZ/board')).j.code === 'code_not_found', 'v4: keyless board of an unknown code is 404 code_not_found');
  ok((await call('POST', `/circles/${v4}/public`, { body: { on: true } })).status === 401, 'v4: public toggle needs a member token');
  ok((await call('POST', `/circles/${v4}/public`, { token: A4.token, body: { on: 'yes' } })).status === 400, 'v4: public toggle needs a boolean');
  await sg(A4, { week_of: T, busy: 'busy', prefers: ['evening'], free: ['tue-evening', 'wed-afternoon', 'thu-evening', 'sat-morning', 'sat-afternoon'], courses: cse });
  await sg(B4, { week_of: T, busy: 'light', prefers: ['evening'], avoid_days: ['tue'], free: ['tue-evening', 'wed-afternoon', 'thu-evening', 'sat-morning', 'sat-afternoon'], courses: cse });
  await sg(C4, { week_of: T, busy: 'busy', prefers: ['afternoon'], free: ['thu-evening', 'sat-afternoon', 'sun-morning'], courses: cse });
  const on = await c4('POST', `/circles/${v4}/public`, { token: A4.token, body: { on: true } });
  ok(on.status === 200 && on.j.public_board === true && /\/circle\?c=/.test(on.j.watch_url), 'v4: member turns the board on');
  const pb = await c4('GET', `/circles/${v4}/board`);
  const rawPb = JSON.stringify(pb.j);
  ok(pb.status === 200 && pb.j.public_board === true && pb.j.name === 'Orbit Four' && pb.j.members.length === 3, 'v4: public board readable without any key');
  ok(!/token|"free"|courses|can_help|want_help|view_key|prefers|avoid_days|SECRET/.test(rawPb) && tokens4.every((t) => !rawPb.includes(t)), 'v4: public board has no free windows, courses, preferences or tokens');
  ok(pb.j.log.some((e) => e.text === 'Ana made the board watchable by code' && e.kind === 'system' && e.type === 'public'), 'v4: system log line when the board is made watchable');
  ok((await call('GET', `/circles/${v4}`, { token: B4.token })).j.public_board === true, 'v4: GET circle reports public_board');
  ok((await call('GET', `/circles/${v4}/board?v=${'a'.repeat(24)}`)).status === 401, 'v4: a wrong view key is still 401 even when public');
  const off = await c4('POST', `/circles/${v4}/public`, { token: B4.token, body: { on: false } });
  ok(off.j.public_board === false && (await call('GET', `/circles/${v4}/board`)).status === 404, 'v4: turning it off hides the board again (404)');
  const vk = (await call('GET', `/circles/${v4}`, { token: A4.token })).j.view_url.split('v=')[1];
  ok((await call('GET', `/circles/${v4}/board?v=${vk}`)).status === 200 && (await call('GET', `/circles/${v4}/board`, { token: C4.token })).status === 200, 'v4: view key and bearer keep working when private');
  await c4('POST', `/circles/${v4}/public`, { token: A4.token, body: { on: true } });
  ok((await call('POST', `/circles/${v4}/public`, { token: A4.token, body: { on: true } })).status === 200 && (await call('GET', `/circles/${v4}/board`)).j.log.filter((e) => e.type === 'public').length === 3, 'v4: toggling to the same state does not log again');

  // rate limit: 60 keyless reads per minute per IP
  {
    const hit = () => fetch(`${base}/circles/${v4}/board`, { headers: { 'x-forwarded-for': '203.0.113.7' } }).then((r) => r.status);
    let st = 0; let n = 0;
    while (n < 70 && st !== 429) { st = await hit(); n++; }
    ok(st === 429 && n === 61, 'v4: keyless public board is rate limited to 60/min/IP');
    const keyed = await fetch(`${base}/circles/${v4}/board?v=${vk}`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
    ok(keyed.status === 200, 'v4: rate limit does not affect keyed reads');
  }

  // ---- signal preferences ----
  ok((await call('PUT', `/circles/${v4}/signal`, { token: A4.token, body: { prefers: ['night'] } })).status === 400 && (await call('PUT', `/circles/${v4}/signal`, { token: A4.token, body: { avoid_days: ['funday'] } })).status === 400, 'v4: bad prefers / avoid_days -> 400');
  const fa4 = (await c4('GET', `/circles/${v4}/feed?today=${T}`, { token: A4.token })).j;
  ok(!JSON.stringify(fa4).includes('avoid_days') && !JSON.stringify(fa4).includes('prefers'), 'v4: friends never see raw preferences in the feed');

  // ---- suggest-times: preference-aware ranking with reasons ----
  const bId = B4.member_id; const cId = C4.member_id;
  const sgt = await c4('GET', `/circles/${v4}/suggest-times?with=${bId}&course=cse576&today=${T}`, { token: A4.token });
  const w = sgt.j.windows;
  ok(sgt.status === 200 && w.length === 5 && w.map((x) => x.window).join() === 'thu-evening,tue-evening,wed-afternoon,sat-morning,sat-afternoon', 'v4: suggest-times ranks before-deadline, preferred evenings, avoided day last, then sooner');
  ok(w[0].reasons[0] === 'before CSE 576 quiz Fri' && w[0].reasons.includes('free for Ana and Ben') && w[0].reasons.includes('matches preferred evenings for Ana and Ben') && w[0].reasons.includes('avoids a no-go day for Ben') && w[0].date === '2026-10-29' && w[0].time === '19:00', 'v4: suggest-times reasons (deadline, free for, preferences, avoid day)');
  ok(w[1].reasons.includes('soonest shared time') && !w[1].reasons.some((x) => /no-go/.test(x)) && w[3].reasons.every((x) => !/^before/.test(x)), 'v4: soonest reason; no deadline reason after the quiz');
  ok(!/"free"|token/.test(JSON.stringify(sgt.j)), 'v4: suggest-times exposes no free lists');
  const sg3 = (await c4('GET', `/circles/${v4}/suggest-times?with=${bId},${cId}&today=${T}`, { token: A4.token })).j;
  ok(sg3.windows.map((x) => x.window).join() === 'thu-evening,sat-afternoon' && sg3.windows[0].reasons.includes('free for Ana, Ben and Cal') && sg3.with.join() === 'Ben,Cal' && sg3.missing.length === 0, 'v4: suggest-times for a group');
  ok((await call('GET', `/circles/${v4}/suggest-times?today=${T}`, { token: A4.token })).status === 400 && (await call('GET', `/circles/${v4}/suggest-times?with=${A4.member_id}`, { token: A4.token })).status === 400 && (await call('GET', `/circles/${v4}/suggest-times?with=deadbeef`, { token: A4.token })).status === 400 && (await call('GET', `/circles/${v4}/suggest-times?with=${bId}&course=%3F%3F%3F`, { token: A4.token })).status === 400 && (await call('GET', `/circles/${v4}/suggest-times?with=${bId}`)).status === 401, 'v4: suggest-times validation + auth');
  const manyHeaders = (await call('GET', `/circles/${v4}/suggest-times?with=${bId}&today=${T}`, { token: A4.token })).j.windows;
  ok(manyHeaders.length <= 5, 'v4: suggest-times returns at most 5');

  // ---- places + reasons on proposals ----
  const prop4 = (m, body) => c4('POST', `/circles/${v4}/proposals`, { token: m.token, body: { today: T, ...body } });
  const resp4 = (m, id, body) => c4('POST', `/proposals/${id}/respond`, { token: m.token, body: { today: T, ...body } });
  ok((await prop4(A4, { to: [bId], kind: 'study', windows: ['thu-evening'], places: ['a', 'b', 'c', 'd'] })).status === 400 && (await prop4(A4, { to: [bId], kind: 'study', windows: ['thu-evening'], places: ['x'.repeat(41)] })).status === 400 && (await prop4(A4, { to: [bId], kind: 'study', windows: ['thu-evening'], places: 'Zoom' })).status === 400, 'v4: places validation (max 3, 40 chars, list)');
  const P1 = (await prop4(A4, { to: [bId], kind: 'study', course: 'cse576', windows: ['tue-evening', 'thu-evening', 'sat-morning'], places: ['Hayden Library 2nd floor', 'Zoom', 'Hayden Library 2nd floor'] })).j;
  ok(P1.places.join() === 'Hayden Library 2nd floor,Zoom' && P1.place === null && P1.remind_at === null && P1.reasons[0] === 'before CSE 576 quiz Fri' && P1.reasons.includes('free for Ana and Ben'), 'v4: proposal stores places (deduped) and reasons');
  const lgp = (await c4('GET', `/circles/${v4}/log?limit=100`, { token: A4.token })).j.entries;
  ok(lgp.some((e) => e.type === 'proposed' && /at Hayden Library 2nd floor or Zoom\.$/.test(e.text)), 'v4: proposed log line mentions places');
  const inb = (await c4('GET', `/circles/${v4}/inbox?today=${T}`, { token: B4.token })).j;
  ok(inb.needs_answer.some((p) => p.id === P1.id && p.reasons.length && p.places.length === 2), 'v4: inbox needs_answer carries reasons + places');
  const fb4 = (await c4('GET', `/circles/${v4}/feed?today=${T}`, { token: B4.token })).j;
  ok(fb4.proposals.some((p) => p.id === P1.id && p.reasons.length && p.place === null), 'v4: feed proposals carry reasons + places');
  // busy move explains itself and keeps places
  const mv = (await resp4(B4, P1.id, { answer: 'busy', free_windows: ['thu-evening', 'sat-morning'] })).j;
  ok(mv.moved && mv.proposal.window === 'thu-evening' && mv.proposal.reasons.includes('Tue evening busy for Ben') && mv.proposal.reasons[0] === 'before CSE 576 quiz Fri' && mv.proposal.places.length === 2, 'v4: busy move records why (reasons)');
  ok((await resp4(B4, P1.id, { answer: 'yes', place_choice: 5 })).status === 400 && (await resp4(B4, P1.id, { answer: 'yes', place_choice: 'a' })).status === 400 && (await resp4(B4, P1.id, { answer: 'yes', place_choice: 0, place_suggest: 'Cafe' })).status === 400 && (await resp4(B4, P1.id, { answer: 'yes', place_suggest: 'x'.repeat(41) })).status === 400, 'v4: bad place answers -> 400');
  const lock1 = (await resp4(B4, P1.id, { answer: 'yes', place_choice: 1 })).j;
  ok(lock1.proposal.status === 'accepted' && lock1.proposal.place === 'Zoom' && lock1.proposal.date === '2026-10-29' && lock1.proposal.time === '19:00', 'v4: place_choice sets the accepted place');
  ok(lock1.proposal.remind_at === '2026-10-29T18:00:00', 'v4: accepted plan has remind_at one hour before');
  ok((await c4('GET', `/circles/${v4}/log?limit=100`, { token: A4.token })).j.entries.some((e) => e.type === 'accepted' && e.text === 'Ben said yes. Plan set: Study CSE 576 · Thu Oct 29 · 7:00 PM · Zoom'), 'v4: accepted log line includes the place');
  const P2 = (await prop4(A4, { to: [bId], kind: 'hangout', windows: ['wed-afternoon'], places: ['Tempe Marketplace'] })).j;
  const lock2 = (await resp4(B4, P2.id, { answer: 'yes', place_suggest: '  Kiwi   Cafe ' })).j;
  ok(lock2.proposal.status === 'accepted' && lock2.proposal.place === 'Kiwi Cafe' && lock2.proposal.remind_at === '2026-10-28T13:00:00', 'v4: place_suggest sets the place (cleaned); afternoon reminder 13:00');
  const P3 = (await prop4(A4, { to: [cId], kind: 'hangout', windows: ['sun-morning'], places: ['Zoom', 'Park'] })).j;
  const lock3 = (await resp4(C4, P3.id, { answer: 'yes' })).j;
  ok(lock3.proposal.place === 'Zoom' && lock3.proposal.remind_at === '2026-11-01T09:00:00', 'v4: no place answer defaults to the first proposed place');
  const P4 = (await prop4(A4, { to: [bId], kind: 'hangout', windows: ['sat-afternoon'] })).j;
  const lock4 = (await resp4(B4, P4.id, { answer: 'yes' })).j;
  ok(P4.places.length === 0 && lock4.proposal.place === null && lock4.proposal.remind_at === '2026-10-31T13:00:00', 'v4: proposals without places lock with place null');
  // group place votes: majority wins
  const PG = (await prop4(A4, { to: [bId, cId], kind: 'hangout', windows: ['thu-evening'], places: ['Zoom', 'Park', 'Cafe'] })).j;
  await resp4(B4, PG.id, { answer: 'yes', place_choice: 2 });
  const lockG = (await resp4(C4, PG.id, { answer: 'yes', place_choice: 2 })).j;
  ok(lockG.proposal.status === 'accepted' && lockG.proposal.place === 'Cafe', 'v4: group plan takes the most-voted place');
  // counters keep places and explain themselves
  const PN = (await prop4(A4, { to: [cId], kind: 'study', course: 'CSE 576', windows: ['thu-evening'], places: ['Library'] })).j;
  const no = (await resp4(C4, PN.id, { answer: 'no' })).j;
  ok(no.counter && no.counter.window === 'sat-afternoon' && no.counter.places.join() === 'Library' && no.counter.reasons.includes("Cal can't do Thu evening") && no.counter.reasons.includes('free for Ana and Cal'), 'v4: counter has reasons and keeps places');

  // ---- auto-reschedule after lock-in ----
  ok((await c4('POST', `/proposals/${P1.id}/conflict`, { token: C4.token, body: { free_windows: [], today: T } })).status === 404, 'v4: conflict by a non-participant -> 404');
  ok((await c4('POST', `/proposals/${P1.id}/conflict`, { token: B4.token, body: { free_windows: ['nope'], today: T } })).status === 400, 'v4: conflict validates free_windows');
  const cf1 = (await c4('POST', `/proposals/${P1.id}/conflict`, { token: B4.token, body: { free_windows: ['sat-morning', 'sat-afternoon'], today: T } })).j;
  const q1 = cf1.proposal;
  ok(cf1.rescheduled === true && q1.status === 'open' && q1.window === 'sat-morning' && q1.date === '2026-10-31' && q1.round === 3 && q1.reschedules === 1 && q1.change === 'rescheduled', 'v4: conflict reopens the plan at the next common window (round+1)');
  ok(q1.from_id === bId && q1.to_ids.join() === A4.member_id && q1.responses[bId] === 'yes' && !q1.responses[A4.member_id] && q1.place === 'Zoom' && q1.remind_at === null, 'v4: reporter becomes proposer, others must confirm again, place kept, reminder cleared');
  ok(q1.reasons.includes('Thu evening no longer free for Ben') && q1.reasons.includes('free for Ana and Ben'), 'v4: reschedule reasons');
  const lg1 = (await c4('GET', `/circles/${v4}/log?limit=100`, { token: A4.token })).j.entries[0];
  ok(lg1.type === 'rescheduled' && lg1.kind === 'agent' && lg1.text === "Ben's Cubbie found a new conflict. Proposed Sat morning instead.", 'v4: reschedule log text (agent)');
  const ia = (await c4('GET', `/circles/${v4}/inbox?today=${T}`, { token: A4.token })).j;
  ok(ia.needs_answer.some((p) => p.id === P1.id && p.change === 'rescheduled' && p.from_name === 'Ben'), "v4: the other participant's inbox shows needs_answer after a reschedule");
  const ib = (await c4('GET', `/circles/${v4}/inbox?today=${T}`, { token: B4.token })).j;
  ok(!ib.updates.some((u) => u.id === P1.id && u.change === 'rescheduled'), "v4: the reporter's own reschedule is not an inbox update");
  // a rescheduled plan is not swept away by the 24 h timeout of its original creation time
  await m4.collection('proposals').updateOne({ id: P1.id }, { $set: { created_at: new Date(Date.now() - 3 * 86400000) } });
  ok((await c4('GET', `/circles/${v4}/inbox?today=${T}`, { token: A4.token })).j.needs_answer.some((p) => p.id === P1.id && p.status === 'open'), 'v4: reopened plan does not expire from its old created_at');
  ok((await c4('POST', `/proposals/${P1.id}/conflict`, { token: A4.token, body: { today: T } })).j.reason === 'not_locked', 'v4: conflict on an open plan is a no-op (not_locked)');
  const lockAgain = (await resp4(A4, P1.id, { answer: 'yes' })).j;
  ok(lockAgain.proposal.status === 'accepted' && lockAgain.proposal.place === 'Zoom' && lockAgain.proposal.remind_at === '2026-10-31T09:00:00' && lockAgain.proposal.reschedules === 1, 'v4: confirming the new time locks it again with place + reminder');
  const cf2 = (await c4('POST', `/proposals/${P1.id}/conflict`, { token: A4.token, body: { free_windows: ['sat-afternoon'], today: T } })).j;
  ok(cf2.rescheduled && cf2.proposal.window === 'sat-afternoon' && cf2.proposal.reschedules === 2 && cf2.proposal.from_id === A4.member_id && cf2.proposal.to_ids.join() === bId, 'v4: second reschedule (max 2)');
  await resp4(B4, P1.id, { answer: 'yes' });
  const cf3 = (await c4('POST', `/proposals/${P1.id}/conflict`, { token: B4.token, body: { free_windows: ['sat-morning'], today: T } })).j;
  ok(cf3.rescheduled === false && cf3.reason === 'limit' && cf3.proposal.status === 'accepted' && cf3.proposal.window === 'sat-afternoon', 'v4: a third reschedule is refused (limit), plan stays locked');
  // proposer-reported conflict keeps the proposer; no window -> plan unchanged
  const cf4 = (await c4('POST', `/proposals/${P3.id}/conflict`, { token: A4.token, body: { free_windows: ['sat-afternoon'], today: T } })).j;
  ok(cf4.rescheduled && cf4.proposal.from_id === A4.member_id && cf4.proposal.to_ids.join() === cId && cf4.proposal.window === 'sat-afternoon', 'v4: proposer-reported conflict keeps proposer and invitees');
  await resp4(C4, P3.id, { answer: 'yes' });
  const cf5 = (await c4('POST', `/proposals/${P2.id}/conflict`, { token: A4.token, body: { free_windows: [], today: T } })).j;
  ok(cf5.rescheduled === false && cf5.reason === 'no_window' && cf5.proposal.status === 'accepted', 'v4: no common window -> plan unchanged (no_window)');
  ok((await c4('POST', `/proposals/${no.counter.id}/conflict`, { token: A4.token, body: { today: T } })).j.reason === 'not_locked', 'v4: conflict on an open counter is not_locked');
  ok((await c4('POST', `/proposals/${no.proposal.id}/conflict`, { token: A4.token, body: { today: T } })).status === 409, 'v4: conflict on a closed (countered) plan -> 409');
  ok((await call('POST', '/proposals/ffffffff/conflict', { token: A4.token, body: {} })).status === 404, 'v4: conflict on unknown proposal -> 404');

  // ---- cheers ----
  const ch = await c4('POST', `/circles/${v4}/cheer`, { token: B4.token, body: { friend_id: cId } });
  ok(ch.status === 200 && ch.j.logged === true, 'v4: cheered logs');
  ok((await c4('POST', `/circles/${v4}/cheer`, { token: B4.token, body: { friend_id: cId } })).j.logged === false, 'v4: repeated cheer within 10 min is not logged again');
  ok((await call('POST', `/circles/${v4}/cheer`, { token: B4.token, body: { friend_id: bId } })).status === 400 && (await call('POST', `/circles/${v4}/cheer`, { token: B4.token, body: { friend_id: 'deadbeef' } })).status === 400 && (await call('POST', `/circles/${v4}/cheer`, { body: { friend_id: cId } })).status === 401, 'v4: cheer validation (self, unknown, auth)');
  const bd4 = (await c4('GET', `/circles/${v4}/board`)).j;
  const cheerLog = bd4.log.find((e) => e.type === 'cheered');
  ok(cheerLog && cheerLog.text === 'Ben checked on Cal 💬' && cheerLog.kind === 'student', 'v4: cheered log text has no message content');
  ok(bd4.members.find((m) => m.name === 'Ben').cheers === 1 && bd4.members.find((m) => m.name === 'Cal').cheers_received === 1 && bd4.members.find((m) => m.name === 'Ana').cheers === 0, 'v4: board shows cheers this week per member');
  await m4.collection('log').insertOne({ circle_code: v4, ts: new Date(Date.now() - 9 * 86400000), actor: 'Ana', actor_id: A4.member_id, type: 'cheered', kind: 'student', text: 'Ana checked on Ben 💬', target_id: bId });
  ok((await call('GET', `/circles/${v4}/board`)).j.members.find((m) => m.name === 'Ana').cheers === 0, 'v4: cheers older than 7 days are not counted');

  // ---- board plans + incremental polling ----
  const plan1 = bd4.plans.find((p) => p.id === P1.id);
  ok(plan1 && plan1.status === 'accepted' && plan1.place === 'Zoom' && plan1.reasons.length && plan1.reschedules === 2 && plan1.round === 4 && plan1.remind_at && plan1.window === 'sat-afternoon' && plan1.change === 'accepted' && plan1.updated_at, 'v4: board plan has id/place/reasons/reschedules/remind_at/change');
  ok(bd4.stats.agent_moves === 5 && bd4.log.every((e) => /^[0-9a-f]{24}$/.test(e.id)) && /^[0-9a-f]{24}$/.test(bd4.cursor), 'v4: log entries have ids, board has a cursor, rescheduled counts as an agent move');
  const poll0 = (await c4('GET', `/circles/${v4}/board?since=${bd4.cursor}`)).j;
  ok(poll0.log.length === 0 && poll0.members.length === 3 && poll0.plans.length === bd4.plans.length && poll0.cursor === bd4.cursor, 'v4: board?since=<cursor> returns no old log entries but full members and plans');
  await c4('POST', `/circles/${v4}/cheer`, { token: A4.token, body: { friend_id: bId } });
  const poll1 = (await c4('GET', `/circles/${v4}/board?since=${bd4.cursor}`)).j;
  ok(poll1.log.length === 1 && poll1.log[0].text === 'Ana checked on Ben 💬' && poll1.cursor === poll1.log[0].id && poll1.log[0].id !== bd4.cursor, 'v4: board?since returns only the newer entry; cursor advances');
  const poll2 = (await c4('GET', `/circles/${v4}/board?since=${poll1.cursor}`, { token: C4.token })).j;
  ok(poll2.log.length === 0, 'v4: polling with the new cursor (bearer) is empty');
  const t0 = new Date(Date.now() - 60000).toISOString();
  ok((await call('GET', `/circles/${v4}/board?since=${encodeURIComponent(t0)}`)).j.log.length >= 1 && (await call('GET', `/circles/${v4}/board?since=${encodeURIComponent(new Date(Date.now() + 60000).toISOString())}`)).j.log.length === 0, 'v4: board?since accepts an ISO timestamp');
  ok((await call('GET', `/circles/${v4}/board?since=garbage`)).status === 400, 'v4: bad since -> 400');
  ok((await call('GET', `/circles/${v4}/board?since=${'0'.repeat(24)}`)).j.log.length > 0, 'v4: an unknown cursor id falls back to the latest entries');
  ok((await call('GET', `/circles/${v4}/board?since=${bd4.cursor}&v=${vk}`)).status === 200, 'v4: since works with the view key');

  // ---- legacy data keeps working ----
  const LG = (await call('POST', '/circles', { body: { name: 'Legacy', member_name: 'Old' } })).j;
  const LG2 = (await call('POST', `/circles/${LG.code}/join`, { body: { member_name: 'Timer' } })).j;
  await m4.collection('proposals').insertOne({ id: 'abcdef12', circle_code: LG.code, from_id: LG.member_id, to_ids: [LG2.member_id], kind: 'hangout', window: 'fri-evening', note: '', status: 'open', responses: {}, parent_id: null, created_at: new Date() });
  const lf = await call('GET', `/circles/${LG.code}/feed?today=${T}`, { token: LG2.token });
  const lp = lf.j.proposals[0];
  ok(lf.status === 200 && lp.reasons.length === 0 && lp.places.length === 0 && lp.place === null && lp.remind_at === null && lp.reschedules === 0, 'v4: legacy proposals (no v4 fields) render with empty reasons/places');
  ok((await call('GET', `/circles/${LG.code}/board`)).j.code === 'not_public' && (await call('GET', `/circles/${LG.code}/board`, { token: LG.token })).j.plans[0].reasons.length === 0, 'v4: legacy circles default to private');
  const lr = (await call('POST', `/proposals/abcdef12/respond`, { token: LG2.token, body: { answer: 'yes', today: T } })).j;
  ok(lr.proposal.status === 'accepted' && lr.proposal.place === null && lr.proposal.remind_at === '2026-10-30T18:00:00', 'v4: legacy proposal can still be accepted (remind_at added)');

  // ---- no raw tokens anywhere ----
  const stored = JSON.stringify([...(await m4.collection('log').find({ circle_code: v4 }).toArray()), ...(await m4.collection('proposals').find({ circle_code: v4 }).toArray()), ...(await m4.collection('signals').find({ circle_code: v4 }).toArray()), ...(await m4.collection('circles').find({ code: v4 }).toArray())]);
  ok(tokens4.every((t) => !seen4.join('\n').includes(t) && !stored.includes(t)), 'v4: raw tokens never appear in any v4 response or stored log/proposal/signal/circle document');
  await mc4.close();
}

// ===================== v5: music (consent, now-playing, jam nudges, playlists, vibe) =====================
{
  const mc5 = await MongoClient.connect(process.env.MONGODB_URI);
  const m5 = mc5.db('orbit_test');
  const seen5 = []; // every v5 response body, scanned for raw tokens and taste leaks at the end
  const c5 = async (...a) => { const r = await call(...a); seen5.push(JSON.stringify(r.j)); return r; };
  const T5 = '2026-10-26'; // Monday: today's windows are mon-*
  const SECRET = 'SECRETBAND';
  const tokens5 = [];
  const join = async (name, circle) => {
    // joins hand back the member's own token by design, so they are not recorded in seen5
    const r = circle ? (await call('POST', `/circles/${circle}/join`, { body: { member_name: name } })).j : (await call('POST', '/circles', { body: { name: 'Music Crew', member_name: name } })).j;
    tokens5.push(r.token);
    return r;
  };
  const P = await join('Pia');
  const code5 = P.code;
  const V = await join('Vik', code5);
  const G = await join('Gus', code5);
  const D = await join('Dev', code5);
  const N = await join('Nia', code5);
  const sig5 = (m, body) => c5('PUT', `/circles/${code5}/signal`, { token: m.token, body: { week_of: T5, busy: 'light', free: ['mon-morning', 'mon-evening', 'tue-evening'], ...body } });
  const dbm = (m) => m5.collection('members').findOne({ circle_code: code5, member_id: m.member_id });
  const post = (m, body) => c5('POST', `/circles/${code5}/now-playing`, { token: m.token, body });
  const feedOf = async (m, now = '19:00') => (await c5('GET', `/circles/${code5}/feed?today=${T5}&now=${now}`, { token: m.token })).j;

  // ---- consent gating ----
  ok((await post(N, { artist: 'Radiohead' })).status === 403 && (await post(N, { artist: 'Radiohead' })).j.code === 'no_music_consent', 'v5: now-playing without music consent -> 403 no_music_consent');
  ok(!(await dbm(N)).tastes && !(await dbm(N)).music_consent, 'v5: nothing music-related stored for a member without consent');
  ok((await sig5(N, { busy: 'busy' })).j.music === false, 'v5: a signal without music reports music false');
  ok((await sig5(V, { music: { artists: Array.from({ length: 16 }, (_, i) => `band ${i}`), genres: [] } })).status === 400, 'v5: more than 15 artists -> 400');
  ok((await sig5(V, { music: { artists: ['x'.repeat(41)] } })).status === 400 && (await sig5(V, { music: { genres: Array.from({ length: 9 }, (_, i) => `g${i}`) } })).status === 400, 'v5: artist over 40 chars and more than 8 genres -> 400');
  ok((await sig5(V, { music: 'Radiohead' })).status === 400 && (await sig5(V, { music: { artists: [''] } })).status === 400, 'v5: music must be an object of lists (no empty entries)');
  ok((await dbm(V)).tastes === undefined || !(await dbm(V)).tastes, 'v5: rejected music never stored');
  const sv = await sig5(V, { music: { artists: ['The Arctic Monkeys', 'Radiohead', SECRET], genres: ['lo-fi', 'indie rock'] } });
  ok(sv.status === 200 && sv.j.music === true && (await dbm(V)).music_consent === true, 'v5: sending tastes is the yes; signal reports music true');
  const sp = await sig5(P, { music: { artists: ['Arctic Monkeys', 'Phoebe Bridgers'], genres: ['indie rock', 'punk'] } });
  ok(sp.j.music === true, 'v5: Pia shares tastes');
  await sig5(P, { busy: 'packed' });
  ok(JSON.stringify((await dbm(P)).tastes.artists) === '["Arctic Monkeys","Phoebe Bridgers"]', 'v5: a signal without music keeps stored tastes');
  ok((await sig5(P, { music: null })).j.music === false && (await dbm(P)).tastes === null && (await dbm(P)).music_consent === true, 'v5: music null clears tastes and keeps consent');
  ok((await c5('POST', `/circles/${code5}/music`, { token: P.token, body: { on: 'yes' } })).status === 400, 'v5: consent endpoint wants a boolean');
  ok((await c5('POST', `/circles/${code5}/music`, { token: P.token, body: { on: true } })).j.music_consent === true, 'v5: consent on via /music');
  await sig5(P, { music: { artists: ['Arctic Monkeys', 'Phoebe Bridgers'], genres: ['indie rock', 'punk'] } });
  await sig5(G, { music: { artists: ['Boards of Canada'], genres: ['ambient', 'lo-fi'] } });
  await sig5(D, { music: { artists: ['Drake'], genres: ['rap'] } });
  ok((await dbm(N)).tastes === undefined || (await dbm(N)).tastes === null, 'v5: a member who never shared music has no tastes');

  // ---- now-playing: post, replace, url rules, expiry-by-field, delete ----
  const np1 = await post(P, { artist: 'Arctic Monkeys', track: 'Do I Wanna Know?', url: 'https://open.spotify.com/track/7abcXYZ?si=zzz' });
  const until = Date.parse(np1.j.now_playing.until) - Date.now();
  ok(np1.status === 200 && np1.j.now_playing.artist === 'Arctic Monkeys' && np1.j.now_playing.url === 'https://open.spotify.com/track/7abcXYZ' && until > 29 * 60e3 && until <= 30 * 60e3 + 2000, 'v5: now-playing lasts 30 min, url canonical (query dropped)');
  const lg5 = (await c5('GET', `/circles/${code5}/log?limit=5`, { token: P.token })).j.entries[0];
  ok(lg5.type === 'playing' && lg5.kind === 'agent' && lg5.text === "Pia's Cubbie shared what he's playing 🎧" && !/Arctic|Monkeys/.test(lg5.text), 'v5: log says the Cubbie shared what it is playing, never the artist');
  const np2 = await post(P, { artist: 'Phoebe Bridgers', track: 'Motion Sickness' });
  const row = await dbm(P);
  ok(np2.status === 200 && row.now_playing.artist === 'Phoebe Bridgers' && row.now_playing.url === null && row.now_playing.expires_at > new Date(Date.now() + 29 * 60e3), 'v5: a new post replaces the old one and refreshes the 30 min');
  const badUrls = ['http://open.spotify.com/track/abc', 'https://evil.com/open.spotify.com/track/abc', 'https://open.spotify.com.evil.com/track/abc', 'https://open.spotify.com/user/abc', 'javascript:alert(1)', 'https://open.spotify.com/track/', 'https://open.spotify.com/track/abc def', 42];
  ok((await Promise.all(badUrls.map((u) => post(P, { artist: 'X', url: u })))).every((r) => r.status === 400), 'v5: only https://open.spotify.com/<kind>/<id> links are accepted');
  ok((await post(P, { artist: 'Phoebe Bridgers', url: 'https://open.spotify.com/intl-de/track/abc' })).j.now_playing.url === 'https://open.spotify.com/track/abc', 'v5: intl- Spotify links are accepted and canonicalized');
  ok((await post(P, {})).status === 400 && (await post(P, { artist: 'a'.repeat(41) })).status === 400 && (await post(P, { artist: 'Z', genre: 'g'.repeat(25) })).status === 400, 'v5: artist required, artist <= 40, genre <= 24');
  ok((await c5('POST', `/circles/${code5}/now-playing`, { body: { artist: 'Z' } })).status === 401, 'v5: now-playing needs a bearer token');
  ok((await c5('GET', `/circles/${code5}/board`, { token: P.token })).j.members.find((m) => m.name === 'Pia').now_playing.artist === 'Phoebe Bridgers', 'v5: board shows the current post');
  ok((await c5('DELETE', `/circles/${code5}/now-playing`, { token: P.token })).j.cleared === true && (await c5('DELETE', `/circles/${code5}/now-playing`, { token: P.token })).j.cleared === false, 'v5: DELETE clears now-playing (cleared true then false)');
  ok(!('now_playing' in (await c5('GET', `/circles/${code5}/board`, { token: P.token })).j.members.find((m) => m.name === 'Pia')), 'v5: after DELETE the board has no now_playing for Pia');
  await post(G, { artist: 'Boards of Canada', genre: 'Lo-Fi' });
  await post(D, { artist: 'Drake', genre: 'rap' });
  await post(P, { artist: 'Arctic Monkeys', track: 'Do I Wanna Know?', url: 'https://open.spotify.com/track/7abcXYZ' });

  // ---- board: now_playing only with consent + active; paused members hidden ----
  const bd5 = (await c5('GET', `/circles/${code5}/board`, { token: V.token })).j;
  const bp = bd5.members.find((m) => m.name === 'Pia');
  ok(bp.now_playing && bp.now_playing.artist === 'Arctic Monkeys' && bp.now_playing.track === 'Do I Wanna Know?' && !('url' in bp.now_playing) && bp.now_playing.until, 'v5: board now_playing has artist, track and until only');
  ok(!('now_playing' in bd5.members.find((m) => m.name === 'Nia')) && !('now_playing' in bd5.members.find((m) => m.name === 'Vik')), 'v5: members without consent or a post have no now_playing key');
  await c5('POST', `/circles/${code5}/pause`, { token: P.token });
  ok(!('now_playing' in (await c5('GET', `/circles/${code5}/board`, { token: V.token })).j.members.find((m) => m.name === 'Pia')), 'v5: a paused member is not shown playing');
  await c5('POST', `/circles/${code5}/resume`, { token: P.token });
  await sig5(P, {});

  // ---- jam suggestions ----
  const fv = await feedOf(V);
  const jams = fv.suggestions.filter((s) => s.type === 'jam');
  const jp = jams.find((s) => s.friend_name === 'Pia');
  ok(jp && jp.artist === 'Arctic Monkeys' && jp.match === 'artist' && jp.window === 'mon-evening' && jp.track === 'Do I Wanna Know?' && jp.url === 'https://open.spotify.com/track/7abcXYZ' && jp.friend_id === P.member_id, 'v5: jam suggestion when artist matches tastes, both free, today');
  ok(jp && jp.text === "Pia is playing Arctic Monkeys right now, one of your favorites. You're both free this evening. Jam session?", 'v5: jam text matches the spec');
  ok(fv.suggestions[0].type === 'jam' && fv.me.music === true, 'v5: jam comes first (no check_on here) and feed says I have music on');
  const jg = jams.find((s) => s.friend_name === 'Gus');
  ok(jg && jg.match === 'genre' && /in a genre you like/.test(jg.text), 'v5: genre match when the artist is not in my list but the genre is');
  ok(!jams.some((s) => s.friend_name === 'Dev'), 'v5: no jam when nothing matches my tastes (rap)');
  ok(!jams.some((s) => s.friend_name === 'Nia'), 'v5: no jam from a member without music consent');
  ok((await feedOf(V, '09:00')).suggestions.find((s) => s.type === 'jam' && s.friend_name === 'Pia').text.includes('free this morning'), 'v5: window follows the viewer local time (morning)');
  const fn = await feedOf(N);
  ok(!fn.suggestions.some((s) => s.type === 'jam') && fn.me.music === false, 'v5: a member without music consent gets no jam suggestion');
  // expired now-playing: nothing shows anywhere
  await m5.collection('members').updateOne({ circle_code: code5, member_id: P.member_id }, { $set: { 'now_playing.expires_at': new Date(Date.now() - 1000) } });
  ok(!(await feedOf(V)).suggestions.some((s) => s.type === 'jam' && s.friend_name === 'Pia') && !('now_playing' in (await c5('GET', `/circles/${code5}/board`, { token: V.token })).j.members.find((m) => m.name === 'Pia')), 'v5: an expired post shows nowhere (feed or board)');
  await post(P, { artist: 'Arctic Monkeys', track: 'Do I Wanna Know?', url: 'https://open.spotify.com/track/7abcXYZ' });
  // no common window left for today -> no jam
  await sig5(V, { free: ['tue-evening'] });
  ok(!(await feedOf(V)).suggestions.some((s) => s.type === 'jam' && s.friend_name === 'Pia'), 'v5: no jam when there is no window free for both today');
  await sig5(V, { music: { artists: ['The Arctic Monkeys', 'Radiohead', SECRET], genres: ['lo-fi', 'indie rock'] } });

  // ---- inbox: a jam nudge is sent once per post ----
  const ib1 = (await c5('GET', `/circles/${code5}/inbox?since=1970-01-01T00:00:00Z&today=${T5}&now=19:00`, { token: V.token })).j;
  ok(ib1.new_nudges.some((n) => n.type === 'jam' && n.friend_name === 'Pia') && ib1.new_nudges.some((n) => n.type === 'jam' && n.friend_name === 'Gus'), 'v5: inbox new_nudges carry the jam nudges');
  const ib2 = (await c5('GET', `/circles/${code5}/inbox?since=${encodeURIComponent(ib1.now)}&today=${T5}&now=19:00`, { token: V.token })).j;
  ok(!ib2.new_nudges.some((n) => n.type === 'jam'), 'v5: the same post is not nudged twice');
  await post(P, { artist: 'Arctic Monkeys', track: 'R U Mine?' });
  const ib3 = (await c5('GET', `/circles/${code5}/inbox?since=${encodeURIComponent(ib2.now)}&today=${T5}&now=19:00`, { token: V.token })).j;
  ok(ib3.new_nudges.some((n) => n.type === 'jam' && n.friend_name === 'Pia' && n.track === 'R U Mine?') && !ib3.new_nudges.some((n) => n.type === 'jam' && n.friend_name === 'Gus'), 'v5: a new post nudges again, only for the friend who posted');
  ok((await c5('GET', `/circles/${code5}/feed?today=${T5}&now=25:00`, { token: V.token })).status === 400, 'v5: now must be HH:MM');

  // ---- jam proposal: playlist, negotiation, lock ----
  const jp1 = await c5('POST', `/circles/${code5}/proposals`, { token: P.token, body: { to: [V.member_id], kind: 'jam', windows: ['mon-evening', 'tue-evening'], course: 'CSE 576', today: T5, playlist: { url: 'https://open.spotify.com/playlist/37i9dQZF1DX8', name: 'Indie jam mix' } } });
  const JP = jp1.j;
  ok(jp1.status === 200 && JP.kind === 'jam' && JP.course === null && JP.playlist.name === 'Indie jam mix' && JP.playlist.url === 'https://open.spotify.com/playlist/37i9dQZF1DX8' && JP.to_names.join() === 'Vik', 'v5: jam proposal carries a playlist and no course');
  ok((await c5('POST', `/circles/${code5}/proposals`, { token: P.token, body: { to: [V.member_id], kind: 'jam', windows: ['mon-evening'], today: T5, playlist: { url: 'https://open.spotify.com/artist/abc' } } })).status === 400, 'v5: playlist must be a playlist, album or track link');
  ok((await c5('POST', `/circles/${code5}/proposals`, { token: P.token, body: { to: [V.member_id], kind: 'party', windows: ['mon-evening'], today: T5 } })).status === 400, 'v5: kind must be study, hangout or jam');
  ok((await c5('POST', `/circles/${code5}/proposals`, { token: P.token, body: { to: [V.member_id], kind: 'jam', windows: ['mon-evening'], today: T5, playlist: 'https://open.spotify.com/playlist/x' } })).status === 400, 'v5: playlist must be an object');
  ok(!(await feedOf(V)).suggestions.some((s) => s.type === 'jam' && s.friend_name === 'Pia'), 'v5: no jam nudge for a friend within 6 h of a jam proposal between us');
  await m5.collection('proposals').updateOne({ id: JP.id }, { $set: { created_at: new Date(Date.now() - 7 * 3600e3) } });
  ok((await feedOf(V)).suggestions.some((s) => s.type === 'jam' && s.friend_name === 'Pia'), 'v5: a jam proposal 7 h old no longer blocks the nudge');
  const jbusy = (await c5('POST', `/proposals/${JP.id}/respond`, { token: V.token, body: { answer: 'busy', free_windows: ['tue-evening'], today: T5 } })).j;
  ok(jbusy.moved === true && jbusy.proposal.window === 'tue-evening' && jbusy.proposal.kind === 'jam' && jbusy.proposal.playlist.name === 'Indie jam mix', 'v5: busy moves a jam like any plan and keeps the playlist');
  const jyes = (await c5('POST', `/proposals/${JP.id}/respond`, { token: V.token, body: { answer: 'yes', playlist: { url: 'https://open.spotify.com/playlist/other', name: 'Other' } } })).j;
  ok(jyes.proposal.status === 'accepted' && jyes.proposal.playlist.name === 'Indie jam mix' && jyes.proposal.date === '2026-10-27' && jyes.proposal.time === '19:00', 'v5: yes locks the jam; a playlist in a yes does not replace the existing one');
  const lockLog = (await m5.collection('log').findOne({ circle_code: code5, type: 'accepted', text: /Jam session/ }));
  ok(lockLog && lockLog.text === "Vik said yes. Plan set: Jam session · Tue Oct 27 · 7:00 PM · 🎧 Indie jam mix", 'v5: lock log line names the jam and its playlist');
  ok((await c5('POST', `/proposals/${JP.id}/respond`, { token: V.token, body: { answer: 'yes' } })).status === 409, 'v5: a locked jam cannot be answered again');
  const bdj = (await c5('GET', `/circles/${code5}/board`, { token: P.token })).j;
  const bj = bdj.plans.find((p) => p.id === JP.id);
  ok(bj && bj.kind === 'jam' && bj.label === '🎸 Jam session' && bj.playlist.name === 'Indie jam mix' && bj.playlist.url === 'https://open.spotify.com/playlist/37i9dQZF1DX8' && bdj.stats.jams === 1, 'v5: board plan has the jam label, playlist, and stats.jams counts it');
  ok(bdj.plans.every((p) => typeof p.label === 'string'), 'v5: every board plan has a label');
  // playlist on a plan: only the proposer, only while open or locked
  ok((await c5('POST', `/proposals/${JP.id}/playlist`, { token: V.token, body: { url: 'https://open.spotify.com/album/abc' } })).status === 403, 'v5: only the proposer can change the playlist (403 not_proposer)');
  ok((await c5('POST', `/proposals/${JP.id}/playlist`, { token: P.token, body: { url: 'https://evil.com/album/abc' } })).status === 400, 'v5: playlist url validated on update');
  const pl2 = await c5('POST', `/proposals/${JP.id}/playlist`, { token: P.token, body: { url: 'https://open.spotify.com/album/abc', name: 'Late set' } });
  ok(pl2.status === 200 && pl2.j.proposal.playlist.name === 'Late set', 'v5: the proposer can replace the playlist of a locked plan');
  ok((await c5('POST', `/proposals/ffffffff/playlist`, { token: P.token, body: { url: 'https://open.spotify.com/album/abc' } })).status === 404, 'v5: playlist on an unknown plan -> 404');
  const jdec = (await c5('POST', `/circles/${code5}/proposals`, { token: P.token, body: { to: [G.member_id], kind: 'jam', windows: ['tue-evening'], today: T5 } })).j;
  await c5('POST', `/proposals/${jdec.id}/respond`, { token: G.token, body: { answer: 'busy', free_windows: [], today: T5 } });
  ok((await c5('POST', `/proposals/${jdec.id}/playlist`, { token: P.token, body: { url: 'https://open.spotify.com/album/abc' } })).status === 409, 'v5: a declined plan cannot get a playlist (409)');
  // group jam: first playlist wins across yeses
  const gj = (await c5('POST', `/circles/${code5}/proposals`, { token: P.token, body: { to: [V.member_id, G.member_id], kind: 'jam', windows: ['mon-evening'], today: T5 } })).j;
  await c5('POST', `/proposals/${gj.id}/respond`, { token: V.token, body: { answer: 'yes', playlist: { url: 'https://open.spotify.com/playlist/first', name: 'First pick' } } });
  const gl = (await c5('POST', `/proposals/${gj.id}/respond`, { token: G.token, body: { answer: 'yes', playlist: { url: 'https://open.spotify.com/playlist/second', name: 'Second pick' } } })).j;
  ok(gl.proposal.status === 'accepted' && gl.proposal.playlist.name === 'First pick', 'v5: group jam locks; the first playlist offered is kept');

  // ---- vibe: intersection only ----
  await sig5(V, { music: { artists: ['The Arctic Monkeys', 'Radiohead', SECRET], genres: ['lo-fi', 'indie rock'] } });
  await sig5(G, { music: { artists: ['Boards of Canada'], genres: ['ambient', 'lo-fi'] } });
  const vj = (await c5('GET', `/circles/${code5}/vibe?with=${P.member_id}&kind=jam`, { token: V.token })).j;
  ok(JSON.stringify(vj) === JSON.stringify({ kind: 'jam', genres: ['indie rock'], artists: ['The Arctic Monkeys'], mood: 'upbeat' }), 'v5: vibe with a friend returns only the shared artists and genres; jam default mood upbeat');
  const vs = (await c5('GET', `/circles/${code5}/vibe?with=${P.member_id}`, { token: V.token })).j;
  ok(vs.kind === 'study' && vs.mood === 'focus' && vs.genres.join() === 'indie rock', 'v5: study defaults to focus when no shared genre hints a mood');
  const vg = (await c5('GET', `/circles/${code5}/vibe?with=${G.member_id}&kind=study`, { token: V.token })).j;
  ok(vg.mood === 'focus' && vg.genres.join() === 'lo-fi' && vg.artists.length === 0, 'v5: a shared lo-fi genre sets focus');
  ok(!seen5.some((s) => /SECRETBAND/.test(s)) && (await c5('GET', `/circles/${code5}/vibe?with=${N.member_id}&kind=jam`, { token: V.token })).j.genres.length === 0, 'v5: vibe with a member who has no music consent is empty; secret taste never leaves');
  ok((await c5('GET', `/circles/${code5}/vibe?with=${V.member_id}`, { token: V.token })).status === 400 && (await c5('GET', `/circles/${code5}/vibe?with=${P.member_id}&kind=party`, { token: V.token })).status === 400 && (await c5('GET', `/circles/${code5}/vibe?with=deadbeef`, { token: V.token })).status === 400 && (await c5('GET', `/circles/${code5}/vibe?with=${P.member_id}`)).status === 401, 'v5: vibe validation (self, kind, unknown, auth)');

  // ---- consent off: tastes, now-playing and jam all go; nothing is logged ----
  const logBefore = (await m5.collection('log').countDocuments({ circle_code: code5 }));
  ok((await c5('POST', `/circles/${code5}/music`, { token: V.token, body: { on: false } })).j.music_consent === false, 'v5: consent off via /music');
  const dv = await dbm(V);
  ok(dv.music_consent === false && dv.tastes === null && (await m5.collection('log').countDocuments({ circle_code: code5 })) === logBefore, 'v5: consent off clears tastes and logs nothing');
  ok((await feedOf(V)).me.music === false && !(await feedOf(V)).suggestions.some((s) => s.type === 'jam'), 'v5: after consent off the viewer gets no jam and music false');
  ok((await post(V, { artist: 'Radiohead' })).status === 403, 'v5: after consent off now-playing is refused');
  ok((await c5('GET', `/circles/${code5}/vibe?with=${P.member_id}&kind=jam`, { token: V.token })).j.genres.length === 0, 'v5: vibe is empty once consent is off');

  // ---- stats, privacy, tokens ----
  const st5 = (await c5('GET', '/stats')).j;
  ok(typeof st5.jams === 'number' && st5.jams >= 0, 'v5: public stats include jams');
  ok(tokens5.every((t) => !seen5.join('\n').includes(t)), 'v5: raw tokens never appear in any v5 response');
  const stored5 = JSON.stringify([...(await m5.collection('log').find({ circle_code: code5 }).toArray()), ...(await m5.collection('proposals').find({ circle_code: code5 }).toArray()), ...(await m5.collection('members').find({ circle_code: code5 }).toArray())]);
  ok(tokens5.every((t) => !stored5.includes(t)) && !/SECRETBAND/.test(JSON.stringify(await m5.collection('log').find({ circle_code: code5 }).toArray())), 'v5: taste strings never reach the log or proposals');
  const O = await join('Ola', code5);
  const po = await post(O, { artist: 'Radiohead', consent: true });
  ok(po.status === 200 && (await dbm(O)).music_consent === true, 'v5: now-playing with consent: true grants consent in the same call');
  await mc5.close();
}

// leave
const lv = await call('POST', `/circles/${code}/leave`, { token: C.token });
ok(lv.status === 200 && lv.j.deleted === true, 'leave');
const client = await MongoClient.connect(process.env.MONGODB_URI);
const db = client.db('orbit_test');
ok((await db.collection('members').countDocuments({ member_id: C.member_id })) === 0, 'member deleted');
ok((await db.collection('signals').countDocuments({ member_id: C.member_id })) === 0, 'signal deleted');
ok((await db.collection('proposals').countDocuments({ $or: [{ from_id: C.member_id }, { to_ids: C.member_id }] })) === 0, 'proposals involving leaver gone');
const allLog = JSON.stringify(await db.collection('log').find({ circle_code: code }).toArray());
ok(!/Priya/.test(allLog) && /a former member/.test(allLog), 'log names scrubbed');
ok((await call('GET', `/circles/${code}`, { token: C.token })).status === 401, 'leaver token now 401');
const keep = await db.collection('proposals').findOne({ id: P1.j.id }); ok(keep && keep.to_ids.join() === B.member_id && !(C.member_id in keep.responses), 'multi-party proposal by others kept, leaver removed from it');
const idx = await db.collection('circles').indexes(); ok(idx.some((i) => i.unique && i.key.code), 'unique circles.code index');
const sidx = await db.collection('signals').indexes(); ok(sidx.some((i) => i.expireAfterSeconds === 0), 'TTL index');
// everyone leaves -> circle deleted
await call('POST', `/circles/${code}/leave`, { token: A.token });
const last = await call('POST', `/circles/${code}/leave`, { token: B.token });
ok(last.status === 200 && (await db.collection('circles').countDocuments({ code })) === 0 && (await db.collection('log').countDocuments({ circle_code: code })) === 0, 'last leave deletes circle+log');
// CORS / options
const op = await fetch(base + '/circles', { method: 'OPTIONS' });
ok(op.status === 204 && /PUT/.test(op.headers.get('access-control-allow-methods')), 'OPTIONS/CORS');
ok((await call('GET', '/nothing')).status === 404, 'unknown route 404');
console.log(`\nALL ${pass} CHECKS PASSED`);
await client.close(); server.close(); await mongo.stop(); process.exit(0);
