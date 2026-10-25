// Pure logic for the Orbit relay: validation, privacy filtering, suggestions, windows.

export const WINDOW_RE = /^(mon|tue|wed|thu|fri|sat|sun)-(morning|afternoon|evening)$/;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const PARTS = ['morning', 'afternoon', 'evening'];
const BUSY = ['light', 'busy', 'packed'];
const EVENT_KINDS = ['exam', 'quiz', 'deadline'];
const DAY_MS = 86400000;

export class InputError extends Error {}

// ---------- dates ----------
export function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export function addDays(iso, n) {
  return new Date(new Date(iso + 'T00:00:00Z').getTime() + n * DAY_MS).toISOString().slice(0, 10);
}
/** Monday = 0 ... Sunday = 6 */
export function dow(iso) {
  return (new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7;
}
export function weekMonday(iso) {
  return addDays(iso, -dow(iso));
}
/** Days from `today` until the weekday in token (0 = today; earlier weekdays roll to next week). */
export function windowOffset(token, today) {
  const d = DAYS.indexOf(token.split('-')[0]);
  return (d - dow(today) + 7) % 7;
}
export function windowDate(token, today) {
  return addDays(today, windowOffset(token, today));
}
/** Chronological sort key for a window token relative to today. */
export function windowKey(token, today) {
  return windowOffset(token, today) * 3 + PARTS.indexOf(token.split('-')[1]);
}
export function prettyWindow(token) {
  const t = String(token).replace('-', ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
export const CANON_TIME = { morning: '10:00', afternoon: '14:00', evening: '19:00' };
export const MAX_ROUNDS = 4;
export const MAX_RESCHEDULES = 2;
export function canonTime(token) {
  return CANON_TIME[token.split('-')[1]];
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** "Thu Oct 30" */
export function prettyDate(iso) {
  return `${DAY_NAMES[dow(iso)]} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
}
/** "19:00" -> "7:00 PM" */
export function prettyTime(hhmm) {
  const h = Number(hhmm.slice(0, 2));
  return `${h % 12 || 12}:${hhmm.slice(3, 5)} ${h < 12 ? 'AM' : 'PM'}`;
}

// ---------- strings ----------
export function cleanStr(v, max, field, { required = false } = {}) {
  if (typeof v !== 'string') {
    if (required) throw new InputError(`${field} is required.`);
    throw new InputError(`${field} must be a string.`);
  }
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (required && !s) throw new InputError(`${field} is required.`);
  if (s.length > max) throw new InputError(`${field} must be at most ${max} characters.`);
  return s;
}
export function sanitizeName(v, max, field) {
  return cleanStr(v, max, field, { required: true });
}
export function optStr(v, max, field) {
  if (v === undefined || v === null) return '';
  return cleanStr(v, max, field);
}

export function normalizeCourse(input) {
  if (typeof input !== 'string') return null;
  const t = input.toUpperCase().replace(/\s+/g, ' ').trim();
  const m = /^([A-Z]{2,6}) ?-? ?(\d{2,4}[A-Z]?)$/.exec(t);
  if (m) return `${m[1]} ${m[2]}`;
  return /^[A-Z0-9 &\-]{2,16}$/.test(t) ? t : null;
}
function needCourse(v, field) {
  const c = normalizeCourse(v);
  if (!c) throw new InputError(`${field} is not a valid course code (try "CSE 576").`);
  return c;
}

// ---------- signal ----------
function arr(v, max, field) {
  if (!Array.isArray(v)) throw new InputError(`${field} must be a list.`);
  if (v.length > max) throw new InputError(`${field} can have at most ${max} items.`);
  return v;
}
function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}
function helpList(v, field) {
  return arr(v, 5, field).map((it, i) => {
    if (!isObj(it)) throw new InputError(`${field}[${i}] must be an object.`);
    return { course: needCourse(it.course, `${field}[${i}].course`), topic: cleanStr(it.topic, 40, `${field}[${i}].topic`, { required: true }) };
  });
}

/** Validates and returns only known fields. Throws InputError on bad shapes/caps. */
export function sanitizeSignal(body) {
  if (!isObj(body)) throw new InputError('Signal must be a JSON object.');
  const out = {};
  if (body.week_of !== undefined) {
    if (!isISODate(body.week_of)) throw new InputError('week_of must be an ISO date (YYYY-MM-DD).');
    out.week_of = body.week_of;
  }
  if (body.busy !== undefined) {
    if (!BUSY.includes(body.busy)) throw new InputError('busy must be light, busy or packed.');
    out.busy = body.busy;
  }
  if (body.big_days !== undefined) {
    const days = arr(body.big_days, 7, 'big_days');
    for (const d of days) if (!isISODate(d)) throw new InputError('big_days must be ISO dates (YYYY-MM-DD).');
    out.big_days = [...new Set(days)].sort();
  }
  if (body.free !== undefined) {
    const f = arr(body.free, 21, 'free');
    for (const w of f) if (typeof w !== 'string' || !WINDOW_RE.test(w)) throw new InputError(`free windows must look like "thu-evening" (got ${JSON.stringify(String(w)).slice(0, 30)}).`);
    out.free = [...new Set(f)];
  }
  if (body.prefers !== undefined) {
    const p = arr(body.prefers, 3, 'prefers');
    for (const x of p) if (!PARTS.includes(x)) throw new InputError('prefers must list morning, afternoon or evening.');
    out.prefers = [...new Set(p)];
  }
  if (body.avoid_days !== undefined) {
    const d = arr(body.avoid_days, 7, 'avoid_days');
    for (const x of d) if (!DAYS.includes(x)) throw new InputError('avoid_days must list days like mon, tue, ... sun.');
    out.avoid_days = [...new Set(d)];
  }
  if (body.courses !== undefined) {
    const seen = new Map();
    arr(body.courses, 10, 'courses').forEach((c, i) => {
      if (!isObj(c)) throw new InputError(`courses[${i}] must be an object.`);
      const code = needCourse(c.code, `courses[${i}].code`);
      const events = arr(c.events === undefined ? [] : c.events, 10, `courses[${i}].events`).map((e, j) => {
        if (!isObj(e)) throw new InputError(`courses[${i}].events[${j}] must be an object.`);
        if (!EVENT_KINDS.includes(e.kind)) throw new InputError('event kind must be exam, quiz or deadline.');
        if (!isISODate(e.date)) throw new InputError('event date must be an ISO date (YYYY-MM-DD).');
        return { kind: e.kind, title: cleanStr(e.title === undefined ? '' : e.title, 60, 'event title'), date: e.date };
      });
      if (seen.has(code)) seen.get(code).events.push(...events);
      else seen.set(code, { code, events });
    });
    const list = [...seen.values()];
    for (const c of list) if (c.events.length > 10) throw new InputError('A course can have at most 10 events.');
    out.courses = list;
  }
  if (body.can_help !== undefined) out.can_help = helpList(body.can_help, 'can_help');
  if (body.want_help !== undefined) out.want_help = helpList(body.want_help, 'want_help');
  if (body.wins !== undefined) {
    out.wins = arr(body.wins, 3, 'wins').map((w, i) => cleanStr(w, 80, `wins[${i}]`, { required: true }));
  }
  if (body.music !== undefined) out.music = sanitizeMusic(body.music);
  return out;
}

// ---------- music (v5): tastes only feed matching; now-playing is shared with the circle ----------
export const TASTE_LIMITS = { artists: { max: 15, len: 40 }, genres: { max: 8, len: 24 } };
export const SPOTIFY_NOW = 'track|album|playlist|artist|episode|show';
export const SPOTIFY_PLAYLIST = 'playlist|album|track';
export const JAM_GAP_MS = 6 * 3600 * 1000;
const PART_WORD = { morning: 'this morning', afternoon: 'this afternoon', evening: 'this evening' };
/** Mood hints from shared genres (normalized). The first shared genre with a hint wins. */
const MOOD_HINTS = {
  focus: ['lo-fi', 'lofi', 'ambient', 'classical', 'instrumental', 'piano', 'focus'],
  chill: ['chill', 'acoustic', 'bossa nova', 'folk', 'indie folk', 'jazz', 'soul', 'r&b'],
  upbeat: ['pop', 'dance', 'edm', 'house', 'hip hop', 'rap', 'punk', 'funk', 'disco', 'rock', 'metal', 'latin'],
};

/** Matching key: lowercase, trimmed, single spaces, leading "the " dropped. */
export function normTaste(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/^the /, '');
}
function tasteList(v, { max, len }, field) {
  if (v === undefined || v === null) return [];
  const seen = new Map();
  arr(v, max, field).forEach((x, i) => {
    const s = cleanStr(x, len, `${field}[${i}]`, { required: true });
    if (!seen.has(normTaste(s))) seen.set(normTaste(s), s);
  });
  return [...seen.values()];
}
/** null clears the stored tastes; otherwise {artists, genres} (either list may be empty). */
export function sanitizeMusic(v) {
  if (v === null) return null;
  if (!isObj(v)) throw new InputError('music must be an object with artists and genres lists, or null.');
  return { artists: tasteList(v.artists, TASTE_LIMITS.artists, 'music.artists'), genres: tasteList(v.genres, TASTE_LIMITS.genres, 'music.genres') };
}
/** Only https://open.spotify.com/<kind>/<id> links (optional intl- segment and ?query dropped). Returns the canonical link. */
export function spotifyUrl(v, kinds, field) {
  const s = typeof v === 'string' ? v.trim() : '';
  const m = s.length <= 200 ? new RegExp(`^https://open\\.spotify\\.com/(?:intl-[a-z]{2}/)?(${kinds})/([A-Za-z0-9]{1,64})(?:[?#]\\S*)?$`).exec(s) : null;
  if (!m) throw new InputError(`${field} must be a Spotify link like https://open.spotify.com/${kinds.split('|')[0]}/<id>.`);
  return `https://open.spotify.com/${m[1]}/${m[2]}`;
}
/** A now-playing post. `consent: true` grants music consent in the same call. */
export function sanitizeNowPlaying(body) {
  if (!isObj(body)) throw new InputError('Body must be a JSON object.');
  if (body.consent !== undefined && typeof body.consent !== 'boolean') throw new InputError('consent must be true or false.');
  const artist = cleanStr(body.artist, 40, 'artist', { required: true });
  const track = optStr(body.track, 60, 'track') || null;
  const genre = optStr(body.genre, 24, 'genre') || null;
  const url = body.url === undefined || body.url === null || body.url === '' ? null : spotifyUrl(body.url, SPOTIFY_NOW, 'url');
  return { artist, track, genre, url, consent: body.consent === true };
}
/** A playlist for a plan: {url, name?} -> {url, name} (name defaults to "Playlist"). */
export function sanitizePlaylist(v) {
  if (v === undefined || v === null || v === '') return null;
  if (!isObj(v)) throw new InputError('playlist must be an object like {"url": "https://open.spotify.com/playlist/<id>"}.');
  const url = spotifyUrl(v.url, SPOTIFY_PLAYLIST, 'playlist.url');
  return { url, name: optStr(v.name, 60, 'playlist.name') || 'Playlist' };
}
/** Items present in every list (matched with normTaste), shown in the first list's wording. */
export function sharedItems(lists, max = 5) {
  const keyed = lists.map((l) => new Set(l.map(normTaste)));
  const out = [];
  for (const item of lists[0] || []) {
    const k = normTaste(item);
    if (keyed.every((s) => s.has(k)) && !out.some((x) => normTaste(x) === k)) out.push(item);
  }
  return out.slice(0, max);
}
export function moodFor(kind, sharedGenres) {
  for (const g of sharedGenres) {
    for (const [mood, words] of Object.entries(MOOD_HINTS)) if (words.includes(normTaste(g))) return mood;
  }
  return kind === 'jam' ? 'upbeat' : 'focus';
}
/** Time of day for a HH:MM clock time: morning before 12, afternoon before 18, else evening. */
export function partAt(hhmm) {
  const h = Number(String(hhmm).slice(0, 2));
  return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
}

export function isLive(sig, now = new Date()) {
  return !!sig && (!sig.expires_at || new Date(sig.expires_at) > now);
}

// ---------- proposal input ----------
/** Validated, de-duplicated list of window tokens (order kept). */
export function windowList(v, max, field) {
  const list = arr(v, max, field);
  for (const w of list) if (typeof w !== 'string' || !WINDOW_RE.test(w)) throw new InputError(`${field} must look like "thu-evening" (got ${JSON.stringify(String(w)).slice(0, 30)}).`);
  return [...new Set(list)];
}
export function sanitizeProposalInput(body, selfId) {
  if (!isObj(body)) throw new InputError('Body must be a JSON object.');
  const to = arr(body.to, 11, 'to');
  if (!to.length) throw new InputError('to must list at least one member_id.');
  for (const t of to) if (typeof t !== 'string' || !/^[0-9a-f]{8}$/.test(t)) throw new InputError('to must be a list of member_ids.');
  const ids = [...new Set(to)];
  if (ids.includes(selfId)) throw new InputError('You cannot propose to yourself.');
  if (!['study', 'hangout', 'jam'].includes(body.kind)) throw new InputError('kind must be study, hangout or jam.');
  let windows;
  if (body.windows !== undefined && body.windows !== null) {
    windows = windowList(body.windows, 5, 'windows');
    if (!windows.length) throw new InputError('windows must list at least one window.');
  } else {
    if (typeof body.window !== 'string' || !WINDOW_RE.test(body.window)) throw new InputError('window must look like "thu-evening".');
    windows = [body.window];
  }
  const p = { to: ids, kind: body.kind, window: windows[0], windows };
  // a jam session has no course
  if (body.course !== undefined && body.course !== null && body.course !== '' && body.kind !== 'jam') p.course = needCourse(body.course, 'course');
  if (body.time !== undefined && body.time !== null && body.time !== '') {
    if (typeof body.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) throw new InputError('time must be HH:MM (24h).');
    p.time = body.time;
  }
  p.note = optStr(body.note, 80, 'note');
  p.places = sanitizePlaces(body.places);
  p.playlist = sanitizePlaylist(body.playlist);
  return p;
}

// ---------- places ----------
export function sanitizePlaces(v) {
  if (v === undefined || v === null || v === '') return [];
  const out = [];
  arr(v, 3, 'places').forEach((x, i) => {
    const s = cleanStr(x, 40, `places[${i}]`);
    if (s && !out.includes(s)) out.push(s);
  });
  return out;
}
export function sanitizePlace(v, field) {
  return cleanStr(v, 40, field, { required: true });
}
/** The place a plan locks with: most-voted answer (ties go to the earliest vote), else a previously set place, else the first option. */
export function pickPlace(p) {
  const votes = Object.values(p.place_votes || {}).filter(Boolean);
  if (votes.length) {
    const n = new Map();
    for (const v of votes) n.set(v, (n.get(v) || 0) + 1);
    let best = votes[0];
    for (const [v, c] of n) if (c > n.get(best)) best = v;
    return best;
  }
  return p.place || (p.places && p.places[0]) || null;
}
/** One hour before the plan, as a local (no zone) ISO timestamp such as 2026-10-29T18:00:00. */
export function remindAt(date, time) {
  return new Date(new Date(`${date}T${time}:00Z`).getTime() - 3600000).toISOString().slice(0, 19);
}

// ---------- windows ----------
export function commonWindows(sigs, today, exclude) {
  if (!sigs.length || sigs.some((s) => !s || !Array.isArray(s.free))) return [];
  let common = sigs[0].free.filter((w) => sigs.every((s) => s.free.includes(w)));
  const ex = [].concat(exclude || []);
  common = common.filter((w) => !ex.includes(w));
  return [...new Set(common)].sort((a, b) => windowKey(a, today) - windowKey(b, today));
}

/** Deterministic next-best window for a set of live signals; prefers windows before `beforeDate`. */
export function nextBestWindow(sigs, { declined, today, beforeDate }) {
  const common = commonWindows(sigs, today, declined);
  if (!common.length) return null;
  if (beforeDate) {
    const before = common.find((w) => windowDate(w, today) < beforeDate);
    if (before) return before;
  }
  return common[0];
}

// ---------- ranking + reasons ----------
const PART_PLURAL = { morning: 'mornings', afternoon: 'afternoons', evening: 'evenings' };
export function joinNames(names) {
  return names.length <= 1 ? names[0] || '' : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
const partOf = (w) => w.split('-')[1];
const dayOf = (w) => w.split('-')[0];
function dayLabel(iso, today) {
  const off = (Date.parse(iso) - Date.parse(today)) / DAY_MS;
  return off >= 0 && off < 7 ? DAY_NAMES[dow(iso)] : prettyDate(iso);
}
/** Earliest exam/quiz/deadline on or after `today` for `course` across the given signals. */
export function findDeadline(sigs, course, today) {
  if (!course) return null;
  const evs = sigs.filter(Boolean).flatMap((s) => (s.courses || []).filter((c) => c.code === course).flatMap((c) => c.events || []))
    .filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  return evs.length ? { course, kind: evs[0].kind, date: evs[0].date } : null;
}
/**
 * Short human reasons why `w` suits `people` ([{name, sig}]; sig may be missing). `note` (e.g. "Tue evening busy for Manas")
 * goes after the free-for line; `soonest` adds the earliest-slot reason.
 */
export function explainWindow(people, w, { today, course, note, soonest } = {}) {
  const r = [];
  const dl = findDeadline(people.map((p) => p.sig), course, today);
  if (dl && windowDate(w, today) < dl.date) r.push(`before ${dl.course} ${dl.kind} ${dayLabel(dl.date, today)}`);
  const free = people.filter((p) => p.sig && Array.isArray(p.sig.free) && p.sig.free.includes(w)).map((p) => p.name);
  if (free.length) r.push(`free for ${joinNames(free)}`);
  if (note) r.push(note);
  const pref = people.filter((p) => p.sig && (p.sig.prefers || []).includes(partOf(w))).map((p) => p.name);
  if (pref.length === 1) r.push(`matches ${pref[0]}'s preferred ${PART_PLURAL[partOf(w)]}`);
  else if (pref.length > 1) r.push(`matches preferred ${PART_PLURAL[partOf(w)]} for ${joinNames(pref)}`);
  const avoiders = people.filter((p) => p.sig && (p.sig.avoid_days || []).length).map((p) => p.name);
  if (avoiders.length && !people.some((p) => p.sig && (p.sig.avoid_days || []).includes(dayOf(w)))) {
    r.push(`avoids ${avoiders.length > 1 ? 'no-go days' : 'a no-go day'} for ${joinNames(avoiders)}`);
  }
  if (soonest) r.push('soonest shared time');
  return r.slice(0, 5).map((x) => x.slice(0, 80));
}
/**
 * Windows free for everyone, best first: before the shared deadline, matching more preferences, avoiding avoid_days, then sooner.
 * people: [{name, sig}]. Returns [{window, reasons}] (empty when anyone has no free list).
 */
export function rankWindows(people, { today, course, exclude = [], limit = 5 }) {
  const sigs = people.map((p) => p.sig);
  const common = commonWindows(sigs, today, exclude);
  if (!common.length) return [];
  const dl = findDeadline(sigs, course, today);
  const score = (w) => ({
    before: dl && windowDate(w, today) < dl.date ? 0 : 1,
    pref: -people.filter((p) => (p.sig.prefers || []).includes(partOf(w))).length,
    avoid: people.filter((p) => (p.sig.avoid_days || []).includes(dayOf(w))).length,
    key: windowKey(w, today),
  });
  const cmp = (a, b) => { const x = score(a); const y = score(b); return x.before - y.before || x.pref - y.pref || x.avoid - y.avoid || x.key - y.key; };
  const ranked = [...common].sort(cmp);
  const soonest = common[0]; // commonWindows is already chronological
  return ranked.slice(0, limit).map((w) => ({ window: w, reasons: explainWindow(people, w, { today, course, soonest: common.length > 1 && w === soonest }) }));
}

// ---------- privacy filter ----------
function topicMatch(a, b) {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

/** What `me` may see of `friend`'s signal. Non-shared course codes never leave this function. */
export function friendView(mySig, friend, sig) {
  const mine = new Set(((mySig && mySig.courses) || []).map((c) => c.code));
  const shared = (sig.courses || []).filter((c) => mine.has(c.code)).map((c) => ({ code: c.code, events: c.events }));
  const ok = new Set(shared.map((c) => c.code));
  const keep = (l) => (l || []).filter((h) => ok.has(h.course)).map((h) => ({ course: h.course, topic: h.topic }));
  return {
    member_id: friend.member_id,
    name: friend.name,
    busy: sig.busy || null,
    big_days: sig.big_days || [],
    free: sig.free || [],
    shared_courses: shared,
    can_help: keep(sig.can_help),
    want_help: keep(sig.want_help),
    wins: sig.wins || [],
    updated_at: sig.updated_at instanceof Date ? sig.updated_at.toISOString() : sig.updated_at || null,
  };
}

// ---------- suggestions ----------
/**
 * entries: [{member, signal}] for visible friends (unpaused, live signal).
 * proposals: all circle proposals (any status). Returns max 5, priority ordered.
 */
export function buildSuggestions({ meId, mySig: mySigIn, entries, proposals, today, limit = 5, now = new Date(), nowHHMM = '12:00', music = null }) {
  const mySig = mySigIn || {};
  const tomorrow = addDays(today, 1);
  const horizon = addDays(today, 7);
  const out = { check_on: [], jam: [], study_match: [], help_match: [], celebrate: [], hangout: [] };
  const helpCovered = new Set();
  const cutoff = addDays(today, -7);
  // music: my tastes as sets (only when I consent), and each friend's active now-playing (consent, not expired)
  const tastes = music && music.tastes ? { artists: new Set(music.tastes.artists.map(normTaste)), genres: new Set(music.tastes.genres.map(normTaste)) } : null;
  const jamRecent = (friendId) => proposals.some((p) => p.kind === 'jam' && [p.from_id, ...p.to_ids].includes(meId) && [p.from_id, ...p.to_ids].includes(friendId)
    && now - new Date(p.created_at) <= JAM_GAP_MS);
  const myCourses = new Map(((mySig && mySig.courses) || []).map((c) => [c.code, c]));
  // no repeats: skip (friend, kind, course) pairs that already have an open/accepted proposal from the last 7 days
  const iso10 = (d) => String(d instanceof Date ? d.toISOString() : d).slice(0, 10);
  const planned = (friendId, kind, course) => proposals.some((p) => ['open', 'accepted'].includes(p.status) && iso10(p.created_at) >= cutoff
    && p.kind === kind && (kind === 'hangout' || (p.course || null) === course)
    && [p.from_id, ...p.to_ids].includes(meId) && [p.from_id, ...p.to_ids].includes(friendId));

  for (const { member, signal } of entries) {
    const f = member.name;
    const base = { friend_id: member.member_id, friend_name: f };

    // 1. check_on
    const bd = (signal.big_days || []).find((d) => d === today || d === tomorrow);
    if (bd) out.check_on.push({ type: 'check_on', ...base, text: `${f} has a big day ${bd === today ? 'today' : 'tomorrow'}.` });

    const view = friendView(mySig, member, signal);
    const common = commonWindows([mySig, signal], today);

    // 1b. jam: a friend is playing something from my tastes, and we are both free the rest of today
    const np = tastes && music.playing ? music.playing.get(member.member_id) : null;
    if (np && !jamRecent(member.member_id)) {
      const artistHit = tastes.artists.has(normTaste(np.artist));
      const genreHit = !artistHit && !!np.genre && tastes.genres.has(normTaste(np.genre));
      const todayTok = DAYS[dow(today)];
      const part = PARTS.slice(PARTS.indexOf(partAt(nowHHMM))).find((pt) => common.includes(`${todayTok}-${pt}`));
      if ((artistHit || genreHit) && part) {
        out.jam.push({
          type: 'jam', ...base, artist: np.artist, track: np.track || null, url: np.url || null, genre: np.genre || null,
          window: `${todayTok}-${part}`, match: artistHit ? 'artist' : 'genre',
          text: `${f} is playing ${np.artist} right now, ${artistHit ? 'one of your favorites' : 'in a genre you like'}. You're both free ${PART_WORD[part]}. Jam session?`,
        });
      }
    }

    for (const sc of view.shared_courses) {
      const mine = myCourses.get(sc.code);
      // 2. study_match
      const seen = new Set();
      const events = [...sc.events, ...(mine ? mine.events : [])]
        .filter((e) => e.date >= today && e.date <= horizon)
        .filter((e) => { const k = `${e.kind}|${e.date}|${e.title}`; if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => a.date.localeCompare(b.date));
      const helpTopic = (signal.can_help || []).find((h) => h.course === sc.code && (mySig.want_help || []).some((w) => w.course === sc.code && topicMatch(w.topic, h.topic)));
      if (events.length && common.length && !planned(member.member_id, 'study', sc.code)) {
        const ev = events[0];
        const window = common.find((w) => windowDate(w, today) < ev.date) || common[0];
        const item = { type: 'study_match', ...base, course: sc.code, event: { kind: ev.kind, title: ev.title, date: ev.date }, window };
        if (helpTopic) {
          item.help_topic = helpTopic.topic;
          helpCovered.add(`${member.member_id}|${sc.code}|${helpTopic.topic}`);
          item.text = `${f} can help with ${helpTopic.topic} in ${sc.code}, and you're both free ${prettyWindow(window)}.`;
        } else {
          item.text = `${f} also has a ${sc.code} ${ev.kind} on ${ev.date}. You're both free ${prettyWindow(window)}.`;
        }
        out.study_match.push(item);
      }
      // 3. help_match
      const helpPlanned = planned(member.member_id, 'study', sc.code);
      for (const h of helpPlanned ? [] : (signal.can_help || []).filter((x) => x.course === sc.code)) {
        if (helpCovered.has(`${member.member_id}|${sc.code}|${h.topic}`)) continue;
        if ((mySig.want_help || []).some((w) => w.course === sc.code && topicMatch(w.topic, h.topic))) {
          out.help_match.push({ type: 'help_match', ...base, course: sc.code, help_topic: h.topic, text: `${f} can help with ${h.topic} in ${sc.code}.` });
        }
      }
      for (const w of helpPlanned ? [] : (signal.want_help || []).filter((x) => x.course === sc.code)) {
        if ((mySig.can_help || []).some((h) => h.course === sc.code && topicMatch(h.topic, w.topic))) {
          out.help_match.push({ type: 'help_match', ...base, course: sc.code, help_topic: w.topic, text: `${f} wants help with ${w.topic} in ${sc.code}, and you can help.` });
        }
      }
    }

    // 4. celebrate
    const upd = signal.updated_at instanceof Date ? signal.updated_at.toISOString().slice(0, 10) : String(signal.updated_at || '').slice(0, 10);
    if ((signal.wins || []).length && upd >= addDays(today, -2)) {
      out.celebrate.push({ type: 'celebrate', ...base, text: `${f} shared a win: ${signal.wins[0]}` });
    }

    // 5. hangout
    if (common.length && (!mySig || mySig.busy !== 'packed') && !planned(member.member_id, 'hangout', null)) {
      const talked = proposals.some((p) => String(p.created_at instanceof Date ? p.created_at.toISOString() : p.created_at).slice(0, 10) >= cutoff
        && [p.from_id, ...p.to_ids].includes(meId) && [p.from_id, ...p.to_ids].includes(member.member_id));
      if (!talked) out.hangout.push({ type: 'hangout', ...base, window: common[0], text: `You and ${f} are both free ${prettyWindow(common[0])}.` });
    }
  }

  out.study_match.sort((a, b) => (b.help_topic ? 1 : 0) - (a.help_topic ? 1 : 0) || a.event.date.localeCompare(b.event.date));
  return [...out.check_on, ...out.jam, ...out.study_match, ...out.help_match, ...out.celebrate, ...out.hangout].slice(0, limit);
}

// ---------- log scrubbing ----------
export function scrubText(text, name, replacement = 'a former member') {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'gu'), replacement);
}
