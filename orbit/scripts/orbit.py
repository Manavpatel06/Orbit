#!/usr/bin/env python3
"""Orbit client: lets a student's Cubbie share small opt-in signals with a friend circle.

Talks to the Orbit relay (JSON over HTTPS). State (circles, tokens, consent, and small
bookkeeping such as seen items) is kept in ~/.config/orbit/state.json with mode 600. The
token is never printed, except inside the old-server fallback log-link URL fragment. Keys added after v1 are
created lazily, so an existing v1 state file keeps working unchanged.

Exit codes: 0 ok, 2 not in a circle, 3 circle/proposal not found, 4 server unreachable,
5 auth rejected, 6 bad input, 7 other server error.
"""

from __future__ import annotations

import argparse
from http.client import HTTPException
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

DEFAULT_SERVER = "https://orbit-cubbie.vercel.app"
SAMPLE = Path(__file__).resolve().parent.parent / "assets" / "sample_feed.json"
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
PARTS = ["morning", "afternoon", "evening"]
CONSENT_KEYS = ["busy", "big_days", "free", "courses", "help", "wins", "music"]
MAX_WINDOWS = 5        # windows per proposal, ranked best first
MAX_PLACES = 3         # places per proposal
MAX_PLACE_LEN = 40
MAX_SHOWN = 5          # suggestions printed per feed
MAX_WAITING = 3        # proposals waiting on the student printed per feed
MAX_ACCEPTED = 2       # accepted plans printed per feed
MAX_ARTISTS = 15       # music tastes shared per circle
MAX_GENRES = 8
SPOTIFY_NOW_RE = re.compile(r"https://open\.spotify\.com/(?:intl-[a-z]{2}/)?(track|album|playlist|artist|episode|show)/[A-Za-z0-9]{1,64}(?:[?#]\S*)?")
SPOTIFY_PLAYLIST_RE = re.compile(r"https://open\.spotify\.com/(?:intl-[a-z]{2}/)?(playlist|album|track)/[A-Za-z0-9]{1,64}(?:[?#]\S*)?")
SEEN_DAYS = 7          # a shown item stays hidden from --new-only and inbox for this long
CALENDAR_DAYS = 30     # mark-added remembers a plan for this long
MAX_SEEN = 500
MAX_REMEMBERED = 100   # proposal id -> window cache, so a busy answer can say what was busy
DEFAULT_LOOKBACK = timedelta(hours=24)  # first inbox run, when nothing was read before


def fail(message: str, code: int):
    print(f"orbit: {message}", file=sys.stderr)
    sys.exit(code)


class Parser(argparse.ArgumentParser):
    def error(self, message):  # argparse would exit 2, which means "not in a circle"
        fail(message, 6)


# ---------- state ----------

def state_path() -> Path:
    return Path.home() / ".config" / "orbit" / "state.json"


def load_state() -> dict:
    try:
        st = json.loads(state_path().read_text())
        if isinstance(st, dict):
            st.setdefault("circles", {})
            return st
    except (OSError, ValueError):
        pass
    return {"circles": {}}


def save_state(st: dict) -> None:
    p = state_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(p.parent, 0o700)
    except OSError:
        pass
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(st, f, indent=2)
    os.chmod(p, 0o600)


def server_url(st: dict) -> str:
    url = os.environ.get("ORBIT_SERVER") or st.get("server") or DEFAULT_SERVER
    return url.rstrip("/")


def pick_circle(st: dict, wanted: str | None):
    """Return (code, circle dict) or exit 2."""
    circles = st.get("circles", {})
    code = (wanted or st.get("default") or "").strip().upper()
    if not code and len(circles) == 1:
        code = next(iter(circles))
    if not code or code not in circles:
        if wanted:
            fail(f"you are not in circle {wanted.upper()}. Run join --code {wanted.upper()} --me \"<name>\".", 2)
        fail("not in a circle yet. Run create --name \"<circle>\" --me \"<name>\" or join --code <CODE> --me \"<name>\".", 2)
    return code, circles[code]


# ---------- http ----------

def http(method: str, base: str, path: str, body=None, token: str | None = None, query: dict | None = None):
    url = base + "/api" + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Accept": "application/json", "User-Agent": "orbit-cubbie/1.0"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    try:
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode("utf-8", "replace")).get("error")
        except Exception:
            msg = None
        msg = msg or f"server returned HTTP {e.code}"
        if e.code == 401:
            fail(f"{msg} (token invalid or removed; run join again).", 5)
        if e.code == 404:
            fail(msg, 3)
        if e.code in (400, 409):
            fail(msg, 6)
        fail(msg, 7)
    except (urllib.error.URLError, HTTPException, TimeoutError, OSError, ValueError) as e:
        reason = getattr(e, "reason", e)
        fail(f"cannot reach the Orbit server at {base} ({reason}).", 4)
    try:
        return json.loads(raw) if raw.strip() else {}
    except ValueError:
        fail("server sent a response that is not JSON.", 7)


# ---------- helpers ----------

def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def ts_str(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(s) -> datetime | None:
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def parse_today(s: str | None) -> date:
    if not s:
        return date.today()
    try:
        return date.fromisoformat(s)
    except ValueError:
        fail(f"bad --today '{s}': use YYYY-MM-DD.", 6)


def parse_iso(s: str, what: str) -> str:
    try:
        return date.fromisoformat(s.strip()).isoformat()
    except ValueError:
        fail(f"bad {what} '{s}': use YYYY-MM-DD.", 6)


def check_window(tok: str) -> str:
    t = tok.strip().lower()
    day, _, part = t.partition("-")
    if day not in DAYS or part not in PARTS:
        fail(f"bad window '{tok}': use <mon..sun>-<morning|afternoon|evening>, e.g. thu-evening.", 6)
    return t


def pretty_window(w: str | None) -> str:
    if not w:
        return ""
    return w.replace("-", " ").capitalize()


def fmt_date(iso) -> str:
    try:
        d = date.fromisoformat(str(iso))
    except ValueError:
        return ""
    return f"{d:%a} {d:%b} {d.day}"


def fmt_time(hhmm) -> str:
    try:
        h, m = (int(x) for x in str(hhmm).split(":"))
    except ValueError:
        return ""
    return f"{h % 12 or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


def when_text(p: dict) -> str:
    """'Thu Oct 29 · 7:00 PM', or 'Thu evening · 7:00 PM' when the server sent no date."""
    parts = [fmt_date(p.get("date")) or pretty_window(p.get("window")), fmt_time(p.get("time"))]
    return " · ".join(x for x in parts if x)


def what_text(p: dict) -> str:
    if p.get("kind") == "study":
        return f"Study {p['course']}" if p.get("course") else "Study session"
    if p.get("kind") == "hangout":
        return "Hangout"
    if p.get("kind") == "jam":
        return "Jam session"
    return "Plan"


def ask_text(p: dict) -> str:
    if p.get("kind") == "study":
        return f"study {p['course']}" if p.get("course") else "study"
    if p.get("kind") == "hangout":
        return "hang out"
    if p.get("kind") == "jam":
        return "jam"
    return "make a plan"


def place_text(p: dict) -> str:
    """' · Hayden Library' for the set place (or ' · A or B' for open options), then ' · 🎧 Deep Focus' for a playlist. Empty when none."""
    place = p.get("place") or " or ".join(p.get("places") or [])
    pl = p.get("playlist") if isinstance(p.get("playlist"), dict) else {}
    parts = [x for x in (place, f"🎧 {pl['name']}" if pl.get("name") else "") if x]
    return "".join(f" · {x}" for x in parts)


def remind_text(p: dict) -> str:
    """' · remind 6:00 PM' (with the date when it is not the plan's day)."""
    ra = p.get("remind_at")
    if not ra or "T" not in str(ra):
        return ""
    day, _, clock = str(ra).partition("T")
    t = fmt_time(clock[:5])
    if not t:
        return ""
    return f" · remind {t}" if day == p.get("date") else f" · remind {fmt_date(day)} {t}"


def reason_text(p: dict) -> str:
    """' (before your quiz Fri)': the top reason the relay gave for this time. Empty when there is none."""
    reasons = [r for r in (p.get("reasons") or []) if isinstance(r, str) and r]
    if not reasons:
        return ""
    r = reasons[0]
    if p.get("change") == "rescheduled":
        r = "rescheduled: " + next((x for x in reasons if "no longer free" in x), r)
    course = p.get("course")
    if course and r.startswith(f"before {course} "):
        r = "before your " + r[len(f"before {course} "):]
    return f" ({r})"


def csv(s: str | None) -> list[str]:
    return [x.strip() for x in (s or "").split(",") if x.strip()]


def yesno(v: str, flag: str) -> bool:
    low = v.strip().lower()
    if low in ("yes", "y", "true", "1", "on"):
        return True
    if low in ("no", "n", "false", "0", "off"):
        return False
    fail(f"bad value '{v}' for {flag}: use yes or no.", 6)


def emit(obj) -> None:
    print(json.dumps(obj, indent=2))


def names_of(members: list, ids: list) -> list:
    by_id = {m["member_id"]: m["name"] for m in members}
    return [by_id.get(i, i) for i in ids]


def parse_help(items: list[str], flag: str) -> list[dict]:
    out = []
    for it in items:
        course, sep, topic = it.partition(":")
        if not sep or not course.strip() or not topic.strip():
            fail(f"bad {flag} '{it}': use \"COURSE:topic\", e.g. \"CSE 576:attention\".", 6)
        out.append({"course": course.strip(), "topic": topic.strip()})
    return out


# ---------- seen / calendar / window bookkeeping (state keys added after v1) ----------

def prune_seen(seen: dict, now: datetime) -> dict:
    keep = {}
    for key, ts in seen.items():
        dt = parse_ts(ts)
        if dt and now - dt < timedelta(days=SEEN_DAYS):
            keep[key] = ts
    return dict(sorted(keep.items(), key=lambda kv: kv[1])[-MAX_SEEN:])


def prune_added(added: dict, now: datetime) -> dict:
    keep = {}
    for pid, ts in added.items():
        dt = parse_ts(ts)
        if dt and now - dt < timedelta(days=CALENDAR_DAYS):
            keep[pid] = ts
    return keep


def remember_windows(st: dict, proposals: list) -> None:
    cache = st.setdefault("proposal_windows", {})
    for p in proposals:
        if isinstance(p, dict) and p.get("id") and p.get("window"):
            cache.pop(p["id"], None)  # re-insert so the newest sit at the end
            cache[p["id"]] = p["window"]
    while len(cache) > MAX_REMEMBERED:
        cache.pop(next(iter(cache)))


def suggestion_key(s: dict) -> str:
    ev = s.get("event") or {}
    parts = [s.get("type"), s.get("friend_id"), s.get("course"), s.get("window"), ev.get("date") or s.get("date")]
    if s.get("type") == "jam":  # a new song from the same friend is a new nudge
        parts += [s.get("artist"), s.get("track")]
    return "|".join(str(x or "") for x in parts)


def needs_key(p: dict) -> str:
    return f"needs|{p.get('id')}|{p.get('window')}|{p.get('round') or 1}"


def locked_key(p: dict) -> str:
    return f"locked|{p.get('id')}"


def id_tag(st: dict, pid) -> str:
    if pid and pid in (st.get("calendar_added") or {}):
        return f"(id {pid}, already on your calendar)"
    if pid and pid in (st.get("calendar_stale") or {}):
        return f"(id {pid}, move the old calendar entry)"
    return f"(id {pid})"


def stale_calendar(st: dict, pid) -> None:
    """A plan that was on the calendar got a new time: forget it was added, and remember the old entry needs moving."""
    added = st.get("calendar_added") or {}
    if pid and pid in added:
        st.setdefault("calendar_stale", {})[pid] = added.pop(pid)


def check_hhmm(raw: str | None, flag: str = "--now") -> str:
    if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", raw or ""):
        fail(f"bad {flag} '{raw}': use HH:MM (24h), e.g. 19:00.", 6)
    return raw


def check_url(raw: str, pattern, flag: str) -> str:
    url = (raw or "").strip()
    if not pattern.fullmatch(url):
        fail(f"bad {flag} '{url[:40]}': use a Spotify link like https://open.spotify.com/track/<id>.", 6)
    return url


def taste_items(raw: str | None, max_items: int, max_len: int, flag: str) -> list[str]:
    """--artists "A|B": up to max_items names of max_len characters each; repeats dropped."""
    out: list[str] = []
    for item in (raw or "").split("|"):
        item = " ".join(item.split())
        if not item:
            continue
        if len(item) > max_len:
            fail(f"{flag} item '{item[:20]}...' is too long (max {max_len} characters).", 6)
        if item.lower() not in [x.lower() for x in out]:
            out.append(item)
    if len(out) > max_items:
        fail(f"at most {max_items} items for {flag}.", 6)
    return out


def clear_music(st: dict) -> list[str]:
    """Turning music off also deletes the tastes kept on the server. Returns the circles it could not reach."""
    failed = []
    for code, circ in (st.get("circles") or {}).items():
        try:
            http("POST", server_url(st), f"/circles/{code}/music", {"on": False}, token=circ["token"])
        except SystemExit:
            failed.append(code)
    return failed


# ---------- sample mode ----------

def load_sample() -> dict:
    try:
        return json.loads(SAMPLE.read_text())
    except (OSError, ValueError):
        fail(f"cannot read sample file {SAMPLE}.", 7)


# ---------- rendering ----------

def select_feed(st: dict, feed: dict, now: datetime, new_only: bool):
    """Pick what a feed run prints. With new_only, drop items already shown (and mark the printed ones)."""
    seen = prune_seen(st.get("seen") or {}, now)
    me_id = (feed.get("me") or {}).get("member_id")
    sugg = feed.get("suggestions") or []
    waiting, accepted = [], []
    for p in feed.get("proposals") or []:
        if p.get("status") == "accepted":
            accepted.append(p)
        elif p.get("status") == "open" and me_id in (p.get("to_ids") or []) and not p.get("my_response"):
            waiting.append(p)
    if new_only:
        sugg = [s for s in sugg if suggestion_key(s) not in seen]
        waiting = [p for p in waiting if needs_key(p) not in seen]
        accepted = [p for p in accepted if locked_key(p) not in seen]
    sugg, waiting, accepted = sugg[:MAX_SHOWN], waiting[:MAX_WAITING], accepted[:MAX_ACCEPTED]
    if new_only:
        for s in sugg:
            seen[suggestion_key(s)] = ts_str(now)
        for p in waiting:
            seen[needs_key(p)] = ts_str(now)
        for p in accepted:
            seen[locked_key(p)] = ts_str(now)
        st["seen"] = prune_seen(seen, now)
    return sugg, waiting, accepted


def render_feed(st: dict, name: str, count: int, sugg, waiting, accepted, quiet: bool) -> None:
    lines = [f"- {s.get('text', '')}" for s in sugg]
    lines += [f"Waiting on you: {p.get('from_name', 'Someone')} wants to {ask_text(p)} · {when_text(p)}{place_text(p)}{reason_text(p)} {id_tag(st, p.get('id'))}"
              for p in waiting]
    lines += [f"Locked in: {what_text(p)} · {when_text(p)}{place_text(p)}{remind_text(p)} {id_tag(st, p.get('id'))}" for p in accepted]
    if not lines:
        if not quiet:
            print("Nothing new from your circle right now.")
        return
    print(f"Circle: {name} ({count} friends)")
    for line in lines:
        print(line)


def update_line(st: dict, u: dict) -> str:
    pid = u.get("id")
    status = u.get("status")
    if status == "accepted":
        return f"Locked in: {what_text(u)} · {when_text(u)}{place_text(u)}{remind_text(u)} {id_tag(st, pid)}"
    if status == "declined":
        return f"No shared time for {what_text(u)} this week."
    if status == "countered":
        return f"Countered: {what_text(u)} ({when_text(u)}) needs a new time."
    if status == "open":  # still open but moved to another window
        mover = u.get("moved_by_name") or "Your friend"
        verb = "rescheduled" if u.get("change") == "rescheduled" else "moved"
        return f"Update: {mover}'s Cubbie {verb} your plan to {when_text(u)}{place_text(u)}."
    return f"Update: {what_text(u)} · {when_text(u)} is {status or 'updated'}."


def inbox_lines(st: dict, res: dict, now: datetime) -> list[str]:
    """Lines for an inbox answer. A pending request is printed once per window/round, so a
    quiet check-in does not repeat it; updates are already limited to what changed since last time."""
    seen = prune_seen(st.get("seen") or {}, now)
    needs = res.get("needs_answer") or []
    updates = res.get("updates") or []
    lines = []
    for p in needs:
        key = needs_key(p)
        if key in seen:
            continue
        seen[key] = ts_str(now)
        if p.get("change") == "rescheduled":
            stale_calendar(st, p.get("id"))
        lines.append(f"Needs you: {p.get('from_name', 'Someone')} wants to {ask_text(p)} · {when_text(p)}{place_text(p)}{reason_text(p)} {id_tag(st, p.get('id'))}")
    for u in updates:
        if u.get("change") == "rescheduled":
            stale_calendar(st, u.get("id"))
    lines += [update_line(st, u) for u in updates]
    lines += [n["text"] for n in res.get("new_nudges") or [] if n.get("text")]
    st["seen"] = prune_seen(seen, now)
    remember_windows(st, needs + updates)
    return lines


def respond_lines(ans: str, prop: dict, res: dict, prev: str | None) -> list[str]:
    counter = res.get("counter")
    status = prop.get("status")
    if ans == "busy":
        said = "Your Cubbie said busy" + (f" for {pretty_window(prev)}" if prev else "")
        if res.get("moved"):
            rnd = f" (round {prop['round']})" if prop.get("round") else ""
            return [f"{said}. Moved to {pretty_window(prop.get('window'))}{rnd}."]
        if status == "declined":
            return [f"{said}. No shared time this week."]
        return [f"{said}."]
    if ans == "yes":
        if status == "accepted":
            return [f"Locked in: {what_text(prop)} · {when_text(prop)}{place_text(prop)}{remind_text(prop)}"]
        return [f"Said yes to {what_text(prop)} · {when_text(prop)}. Waiting on the others."]
    lines = [f"You said no to {what_text(prop)} · {when_text(prop)}."]
    if counter:
        lines.append(f"Counter proposed: {when_text(counter)} (id {counter.get('id')}).")
    elif status == "declined":
        lines.append("No shared time this week.")
    return lines


def render_members(members: list) -> None:
    for m in members:
        flags = []
        if m.get("paused"):
            flags.append("paused")
        if not m.get("has_signal"):
            flags.append("no signal yet")
        print(f"- {m['name']}" + (f" ({', '.join(flags)})" if flags else ""))


def render_log(entries: list, limit: int) -> None:
    if not entries:
        print("No activity yet.")
    for e in entries[:limit]:
        print(f"{str(e.get('ts', ''))[:16].replace('T', ' ')} {e.get('text', '')}")


def consent_line(c: dict) -> str:
    return ", ".join(f"{k.replace('_', '-')} {'yes' if c.get(k) else 'no'}" for k in CONSENT_KEYS)


# ---------- feed core (shared by the server path and --sample) ----------

def show_feed(args, st: dict, name: str, count: int, feed: dict) -> None:
    now = now_utc()
    sugg, waiting, accepted = select_feed(st, feed, now, args.new_only)
    remember_windows(st, feed.get("proposals") or [])
    if args.json:
        emit({**feed, "suggestions": sugg})
    else:
        render_feed(st, name, count, sugg, waiting, accepted, quiet=args.new_only)


# ---------- commands ----------

def cmd_sample(args) -> None:
    """--sample: fixtures only. Works on an in-memory state, never reads or writes the saved one."""
    sample = load_sample()
    c = args.command
    circle = sample.get("circle", {})
    st: dict = {}
    if c == "feed":
        show_feed(args, st, circle.get("name", "Sample"), len(sample.get("friends", [])), sample)
    elif c == "inbox":
        res = sample.get("inbox") or {}
        if args.json:
            emit(res)
        else:
            for line in inbox_lines(st, res, now_utc()):
                print(line)
    elif c == "mark-added":
        print(f"sample mode: nothing saved (would mark {args.id} as on your calendar).")
    elif c == "members":
        if args.json:
            emit({"code": circle.get("code"), "name": circle.get("name"), "members": sample.get("members", [])})
        else:
            render_members(sample.get("members", []))
    elif c == "log":
        limit = getattr(args, "limit", 10)
        if args.json:
            emit({"name": circle.get("name"), "entries": sample.get("log", [])[:limit]})
        else:
            render_log(sample.get("log", []), limit)
    elif c == "status":
        me = sample.get("me", {})
        if args.json:
            emit({"sample": True, "circle": circle, "me": me})
        else:
            print(f"Circle: {circle.get('name')} ({circle.get('code')})")
            print(f"You: {me.get('name')}")
            print("Sample mode: no server or saved state used.")
    else:
        print(f"sample mode: {c} would call the server")


def cmd_create_join(args, st: dict) -> None:
    base = server_url(st)
    name = (args.me or "").strip()
    if not name:
        fail("--me \"<your name>\" is required.", 6)
    if args.command == "create":
        if not (args.name or "").strip():
            fail("--name \"<circle name>\" is required.", 6)
        res = http("POST", base, "/circles", {"name": args.name.strip(), "member_name": name})
    else:
        code = (args.code or "").strip().upper()
        if not code:
            fail("--code <CODE> is required.", 6)
        res = http("POST", base, f"/circles/{code}/join", {"member_name": name})
    code = res["code"]
    st["server"] = base
    st.setdefault("circles", {})[code] = {
        "name": res.get("name"), "member_id": res["member_id"],
        "token": res["token"], "member_name": name,
    }
    st["default"] = code
    save_state(st)
    if args.json:
        emit({"code": code, "name": res.get("name"), "member_id": res["member_id"]})
        return
    verb = "Created" if args.command == "create" else "Joined"
    print(f"{verb} circle {res.get('name')} as {name}. Code: {code}")
    if "consent" not in st:
        print("Next: run consent to choose what Orbit may share.")


def cmd_consent(args, st: dict) -> None:
    flags = {"busy": args.busy, "big_days": args.big_days, "free": args.free,
             "courses": args.courses, "help": args.help, "wins": args.wins, "music": args.music}
    given = {k: v for k, v in flags.items() if v is not None}
    failed: list[str] = []
    if given:
        cur = st.get("consent") or {k: False for k in CONSENT_KEYS}
        for k, v in given.items():
            cur[k] = yesno(v, "--" + k.replace("_", "-"))
        st["consent"] = cur
        save_state(st)
        if "music" in given and not cur.get("music"):
            failed = clear_music(st)
    cur = st.get("consent")
    if args.json:
        emit({"consent": cur, **({"music_not_cleared": failed} if failed else {})})
        return
    if cur is None:
        print("No consent saved yet (nothing is shared). Set it with consent --busy yes --free yes ...")
    else:
        print(("Consent saved: " if given else "Consent: ") + consent_line(cur))
    if failed:
        print("Could not delete your music from the server yet. Run consent --music no again when you are online.")


def cmd_share(args, st: dict) -> None:
    code, circ = pick_circle(st, args.circle)
    consent = st.get("consent")
    if consent is None:
        fail("no consent stored: run consent first (e.g. consent --busy yes --free yes).", 6)
    today = parse_today(args.today)
    week_of = (today - timedelta(days=today.weekday())).isoformat()

    wanted: dict = {}  # field -> (consent key, value)
    if args.busy:
        b = args.busy.strip().lower()
        if b not in ("light", "busy", "packed"):
            fail(f"bad --busy '{args.busy}': use light, busy or packed.", 6)
        wanted["busy"] = ("busy", b)
    if args.big_days:
        days = [parse_iso(d, "big day") for d in csv(args.big_days)]
        if len(days) > 7:
            fail("too many --big-days (max 7).", 6)
        wanted["big_days"] = ("big_days", days)
    if args.free:
        wins = [check_window(t) for t in csv(args.free)]
        wanted["free"] = ("free", wins)
    if args.prefers:
        parts = [t.strip().lower() for t in csv(args.prefers)]
        for t in parts:
            if t not in PARTS:
                fail(f"bad --prefers '{t}': use morning, afternoon or evening.", 6)
        wanted["prefers"] = ("free", list(dict.fromkeys(parts)))
    if args.avoid_days:
        days_off = [t.strip().lower() for t in csv(args.avoid_days)]
        for t in days_off:
            if t not in DAYS:
                fail(f"bad --avoid-days '{t}': use mon..sun, e.g. fri,sat.", 6)
        wanted["avoid_days"] = ("free", list(dict.fromkeys(days_off)))
    raw_courses = None
    if args.courses_file:
        try:
            raw_courses = json.loads(Path(args.courses_file).read_text())
        except OSError as e:
            fail(f"cannot read --courses-file: {e.strerror or e}.", 6)
        except ValueError:
            fail("--courses-file is not valid JSON.", 6)
    elif args.courses_json:
        try:
            raw_courses = json.loads(args.courses_json)
        except ValueError:
            fail("--courses-json is not valid JSON.", 6)
    if raw_courses is not None:
        if not isinstance(raw_courses, list):
            fail("courses must be a JSON list like [{\"code\":\"CSE 576\",\"events\":[...]}].", 6)
        for c in raw_courses:
            if not isinstance(c, dict) or not isinstance(c.get("code"), str) or not c["code"].strip():
                fail("each course needs a \"code\" string.", 6)
            for ev in c.get("events") or []:
                if not isinstance(ev, dict):
                    fail(f"bad event in {c['code']}: expected an object.", 6)
                parse_iso(str(ev.get("date", "")), f"event date in {c['code']}")
        wanted["courses"] = ("courses", raw_courses)
    if args.can_help:
        wanted["can_help"] = ("help", parse_help(args.can_help, "--can-help"))
    if args.want_help:
        wanted["want_help"] = ("help", parse_help(args.want_help, "--want-help"))
    if args.win:
        wanted["wins"] = ("wins", [w.strip() for w in args.win if w.strip()])
    if args.artists is not None or args.genres is not None:
        artists = taste_items(args.artists, MAX_ARTISTS, 40, "--artists")
        genres = taste_items(args.genres, MAX_GENRES, 24, "--genres")
        wanted["music"] = ("music", {"artists": artists, "genres": genres} if (artists or genres) else None)
    if not wanted:
        fail("nothing to share: pass at least one of --busy, --big-days, --free, --courses-file, "
             "--prefers, --avoid-days, --can-help, --want-help, --win.", 6)

    signal = {"week_of": week_of}
    shared, withheld = [], []
    for field, (ckey, value) in wanted.items():
        if consent.get(ckey):
            signal[field] = value
            shared.append(field)
        else:
            withheld.append(field)
    if shared:
        http("PUT", server_url(st), f"/circles/{code}/signal", signal, token=circ["token"])
    if args.json:
        emit({"ok": bool(shared), "shared": shared, "withheld": withheld, "week_of": week_of})
        return
    print("Shared: " + (", ".join(shared) if shared else "nothing (no server call made)"))
    if withheld:
        print("Withheld (no consent): " + ", ".join(withheld))


def get_members(st: dict, code: str, circ: dict) -> dict:
    return http("GET", server_url(st), f"/circles/{code}", token=circ["token"])


def cmd_feed(args, st: dict) -> None:
    code, circ = pick_circle(st, args.circle)
    today = parse_today(args.today)
    query = {"today": today.isoformat()}
    if args.now:
        query["now"] = check_hhmm(args.now)
    feed = http("GET", server_url(st), f"/circles/{code}/feed", token=circ["token"], query=query)
    count = len(feed.get("friends") or [])
    if not args.json:
        try:
            info = get_members(st, code, circ)
            count = max(len(info.get("members", [])) - 1, 0)
        except SystemExit:
            pass
    show_feed(args, st, circ.get("name") or code, count, feed)
    save_state(st)


def cmd_inbox(args, st: dict) -> None:
    code, circ = pick_circle(st, args.circle)
    today = parse_today(args.today)
    since = ((st.get("last_inbox") or {}).get(code)) or ts_str(now_utc() - DEFAULT_LOOKBACK)
    query = {"since": since, "today": today.isoformat()}
    if args.now:
        query["now"] = check_hhmm(args.now)
    res = http("GET", server_url(st), f"/circles/{code}/inbox", token=circ["token"], query=query)
    if args.json:
        emit(res)
    else:
        for line in inbox_lines(st, res, now_utc()):
            print(line)
    # Only after printing, so a failed or interrupted run is retried next time.
    st.setdefault("last_inbox", {})[code] = res.get("now") or ts_str(now_utc())
    save_state(st)


def cmd_mark_added(args, st: dict) -> None:
    pid = (args.id or "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{8}", pid):
        fail(f"bad --id '{args.id}': use the 8 character proposal id from inbox or feed.", 6)
    now = now_utc()
    added = prune_added(st.get("calendar_added") or {}, now)
    added[pid] = ts_str(now)
    st["calendar_added"] = added
    (st.get("calendar_stale") or {}).pop(pid, None)
    save_state(st)
    if args.json:
        emit({"id": pid, "marked": True})
    else:
        print(f"Marked {pid} as on your calendar. It will not be added again.")


def parse_places(raw: str | None) -> list[str]:
    """--places "Hayden Library 2nd floor|Zoom": up to 3 places, 40 characters each."""
    if raw is None:
        return []
    out = []
    for item in raw.split("|"):
        item = " ".join(item.split())
        if not item:
            continue
        if len(item) > MAX_PLACE_LEN:
            fail(f"place '{item[:20]}...' is too long (max {MAX_PLACE_LEN} characters).", 6)
        if item not in out:
            out.append(item)
    if len(out) > MAX_PLACES:
        fail(f"at most {MAX_PLACES} places per proposal.", 6)
    return out


def parse_playlist(url: str | None, name: str | None) -> dict | None:
    """--playlist-url (a Spotify playlist, album or track) with an optional --playlist-name (max 60 characters)."""
    if url is None:
        if name is not None:
            fail("--playlist-name needs --playlist-url.", 6)
        return None
    out = {"url": check_url(url, SPOTIFY_PLAYLIST_RE, "--playlist-url")}
    clean = " ".join((name or "").split())
    if len(clean) > 60:
        fail("--playlist-name is too long (max 60 characters).", 6)
    if clean:
        out["name"] = clean
    return out


def resolve_targets(members: list, me_id: str, targets: list[str]) -> list[str]:
    others = [m for m in members if m["member_id"] != me_id]
    ids = []
    for t in targets:
        key = t.strip().lower()
        hit = [m for m in others if m["member_id"].lower() == key]
        if not hit:
            hit = [m for m in others if m["name"].lower() == key]
        if not hit:
            hit = [m for m in others if m["name"].lower().startswith(key)]
        if not hit:
            fail(f"no friend named '{t}'. Members: {', '.join(m['name'] for m in others) or 'none'}.", 6)
        if len(hit) > 1:
            fail(f"'{t}' is ambiguous: {', '.join(m['name'] for m in hit)}. Use the full name or member id.", 6)
        if hit[0]["member_id"] not in ids:
            ids.append(hit[0]["member_id"])
    return ids


def cmd_propose(args, st: dict) -> None:
    code, circ = pick_circle(st, args.circle)
    if args.kind not in ("study", "hangout", "jam"):
        fail(f"bad --kind '{args.kind}': use study, hangout or jam.", 6)
    if args.kind == "jam" and args.course:
        fail("a jam session has no course: drop --course.", 6)
    windows: list[str] = []
    for tok in csv(args.windows):
        w = check_window(tok)
        if w not in windows:
            windows.append(w)
    if not windows:
        fail("--windows needs at least one window, e.g. --windows thu-evening,tue-evening.", 6)
    if len(windows) > MAX_WINDOWS:
        fail(f"at most {MAX_WINDOWS} windows per proposal (best first).", 6)
    if args.time:
        try:
            hh, mm = args.time.split(":")
            assert 0 <= int(hh) <= 23 and 0 <= int(mm) <= 59 and len(mm) == 2
        except (ValueError, AssertionError):
            fail(f"bad --time '{args.time}': use HH:MM, e.g. 19:00.", 6)
    places = parse_places(args.places)
    playlist = parse_playlist(args.playlist_url, args.playlist_name)
    today = parse_today(args.today)
    members = get_members(st, code, circ).get("members", [])
    to = resolve_targets(members, circ["member_id"], args.to)
    body = {"to": to, "kind": args.kind, "windows": windows, "today": today.isoformat()}
    if places:
        body["places"] = places
    if playlist:
        body["playlist"] = playlist
    if args.course:
        body["course"] = args.course.strip()
    if args.time:
        body["time"] = args.time
    if args.note:
        body["note"] = args.note.strip()
    p = http("POST", server_url(st), f"/circles/{code}/proposals", body, token=circ["token"])
    remember_windows(st, [p])
    save_state(st)
    if args.json:
        emit(p)
        return
    who = ", ".join(names_of(members, to))
    msg = f"Proposed {what_text(p)} to {who}: {when_text(p)} (id {p.get('id')})."
    if len(windows) > 1:
        msg += f" Backups: {', '.join(pretty_window(w) for w in windows[1:])}."
    if places:
        msg += f" Places: {' or '.join(places)}."
    if isinstance(p.get("playlist"), dict) and p["playlist"].get("name"):
        msg += f" Playlist: {p['playlist']['name']}."
    why = reason_text(p).strip()
    if why:
        msg += f" Why: {why[1:-1]}."
    print(msg)


def cmd_respond(args, st: dict) -> None:
    code, circ = pick_circle(st, args.circle)
    ans = args.answer.strip().lower()
    if ans not in ("yes", "no", "busy"):
        fail(f"bad --answer '{args.answer}': use yes, no or busy.", 6)
    body: dict = {"answer": ans, "today": parse_today(args.today).isoformat()}
    if ans == "busy":
        if args.free is None:
            fail("busy needs --free with your student's current free windows (use --free \"\" for none).", 6)
        body["free_windows"] = [check_window(t) for t in csv(args.free)]
    elif args.free is not None:
        fail("--free only goes with --answer busy.", 6)
    playlist = parse_playlist(args.playlist_url, args.playlist_name)
    if playlist:
        if ans != "yes":
            fail("--playlist-url only goes with --answer yes.", 6)
        body["playlist"] = playlist
    if args.place is not None or args.place_suggest is not None:
        if ans != "yes":
            fail("--place and --place-suggest only go with --answer yes.", 6)
        if args.place is not None and args.place_suggest is not None:
            fail("use either --place <number> or --place-suggest \"<text>\", not both.", 6)
        if args.place is not None:
            if args.place < 0:
                fail("--place is the number of a proposed place, starting at 0.", 6)
            body["place_choice"] = args.place
        else:
            text = " ".join(args.place_suggest.split())
            if not text or len(text) > MAX_PLACE_LEN:
                fail(f"--place-suggest needs 1 to {MAX_PLACE_LEN} characters.", 6)
            body["place_suggest"] = text
    prev = (st.get("proposal_windows") or {}).get(args.id)
    res = http("POST", server_url(st), f"/proposals/{args.id}/respond", body, token=circ["token"])
    prop = res.get("proposal") or {}
    prop.setdefault("id", args.id)
    remember_windows(st, [prop])
    save_state(st)
    if args.json:
        emit(res)
        return
    for line in respond_lines(ans, prop, res, prev):
        print(line)


def cmd_conflict(args, st: dict) -> None:
    """The student's calendar no longer fits a locked plan: ask the relay for the next common time."""
    code, circ = pick_circle(st, args.circle)
    pid = (args.id or "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{8}", pid):
        fail(f"bad --id '{args.id}': use the 8 character proposal id from inbox or plans.", 6)
    if args.free is None:
        fail("conflict needs --free with your student's current free windows (use --free \"\" for none).", 6)
    body = {"free_windows": [check_window(t) for t in csv(args.free)], "today": parse_today(args.today).isoformat()}
    res = http("POST", server_url(st), f"/proposals/{pid}/conflict", body, token=circ["token"])
    prop = res.get("proposal") or {}
    prop.setdefault("id", pid)
    if res.get("rescheduled"):
        stale_calendar(st, pid)
        remember_windows(st, [prop])
    save_state(st)
    if args.json:
        emit(res)
        return
    if res.get("rescheduled"):
        waiting = ", ".join(prop.get("to_names") or []) or "your friends"
        print(f"Rescheduled: {what_text(prop)} · {when_text(prop)}{place_text(prop)}. Waiting for {waiting} to confirm {id_tag(st, pid)}")
    else:
        print({"limit": "Not rescheduled: this plan was already moved twice.",
               "no_window": "No other shared time found. The plan stays as it is.",
               "not_locked": "Nothing to reschedule: the plan is not locked in yet."}.get(res.get("reason"), "Not rescheduled."))


def cmd_cheered(args, st: dict) -> None:
    code, circ = pick_circle(st, args.circle)
    members = get_members(st, code, circ).get("members", [])
    fid = resolve_targets(members, circ["member_id"], [args.friend])[0]
    res = http("POST", server_url(st), f"/circles/{code}/cheer", {"friend_id": fid}, token=circ["token"])
    if args.json:
        emit(res)
        return
    who = names_of(members, [fid])[0]
    print(f"Logged: you checked on {who}." if res.get("logged", True) else f"Already logged that you checked on {who}.")


def cmd_public(args, st: dict) -> None:
    code, circ = pick_circle(st, args.circle)
    on = args.state == "on"
    res = http("POST", server_url(st), f"/circles/{code}/public", {"on": on}, token=circ["token"])
    if args.json:
        emit(res)
        return
    if on:
        url = res.get("watch_url") or f"{server_url(st)}/circle?c={code}"
        print(f"Watchable by code: on. Anyone with the code {code} can watch names, plans and the agent log, never free times or courses.")
        print(url)
    else:
        print("Watchable by code: off. The board needs a view link again.")


def cmd_suggest(args, st: dict) -> None:
    code, circ = pick_circle(st, args.circle)
    today = parse_today(args.today)
    members = get_members(st, code, circ).get("members", [])
    targets = [t for chunk in args.with_ for t in csv(chunk)]
    if not targets:
        fail("--with needs at least one friend's name.", 6)
    ids = resolve_targets(members, circ["member_id"], targets)
    query = {"with": ",".join(ids), "today": today.isoformat()}
    if args.course:
        query["course"] = args.course.strip()
    res = http("GET", server_url(st), f"/circles/{code}/suggest-times", token=circ["token"], query=query)
    if args.json:
        emit(res)
        return
    wins = res.get("windows") or []
    if not wins:
        missing = res.get("missing") or []
        print("No shared time this week yet." + (f" No availability yet from: {', '.join(missing)}." if missing else ""))
        return
    for i, w in enumerate(wins, 1):
        reasons = [r for r in (w.get("reasons") or []) if isinstance(r, str) and r]
        top = reason_text({"reasons": reasons, "course": res.get("course")}).strip()[1:-1]
        why = "; ".join(([top] if top else []) + reasons[1:3])
        print(f"{i}. {pretty_window(w.get('window'))} · {when_text(w)}" + (f" - {why}" if why else ""))


def cmd_plans(args, st: dict) -> None:
    """Locked plans in the next few days, so the quick check can re-check them against the student's calendar."""
    code, circ = pick_circle(st, args.circle)
    today = parse_today(args.today)
    last = (today + timedelta(days=args.within)).isoformat()
    feed = http("GET", server_url(st), f"/circles/{code}/feed", token=circ["token"], query={"today": today.isoformat()})
    plans = [p for p in feed.get("proposals") or []
             if p.get("status") == "accepted" and today.isoformat() <= str(p.get("date") or "") <= last]
    plans.sort(key=lambda p: (str(p.get("date")), str(p.get("time"))))
    if args.json:
        emit({"plans": plans})
        return
    for p in plans:
        print(f"Locked: {what_text(p)} · {when_text(p)}{place_text(p)}{remind_text(p)} {id_tag(st, p.get('id'))}")


def cmd_playing(args, st: dict) -> None:
    """What the student's Cubbie is playing, shared with the circle for 30 minutes. Needs music consent."""
    code, circ = pick_circle(st, args.circle)
    if args.clear:
        if args.artist or args.track or args.genre or args.url:
            fail("--clear goes on its own.", 6)
        res = http("DELETE", server_url(st), f"/circles/{code}/now-playing", token=circ["token"])
        if args.json:
            emit(res)
        else:
            print("Stopped sharing what you're playing.")
        return
    artist = " ".join((args.artist or "").split())
    if not artist:
        fail('playing needs --artist "<artist>" (or --clear).', 6)
    if len(artist) > 40:
        fail("--artist is too long (max 40 characters).", 6)
    track = " ".join((args.track or "").split()) or None
    if track and len(track) > 60:
        fail("--track is too long (max 60 characters).", 6)
    genre = " ".join((args.genre or "").split()) or None
    if genre and len(genre) > 24:
        fail("--genre is too long (max 24 characters).", 6)
    url = check_url(args.url, SPOTIFY_NOW_RE, "--url") if args.url else None
    if not (st.get("consent") or {}).get("music"):
        fail("music sharing is off: run consent --music yes first.", 6)
    body: dict = {"artist": artist, "consent": True}
    if track:
        body["track"] = track
    if genre:
        body["genre"] = genre
    if url:
        body["url"] = url
    res = http("POST", server_url(st), f"/circles/{code}/now-playing", body, token=circ["token"])
    if args.json:
        emit(res)
    else:
        print("Shared with your circle for 30 min 🎧")


def cmd_vibe(args, st: dict) -> None:
    """Shared genres and artists with friends only, plus a mood for a playlist search. Never the rest of anyone's taste."""
    code, circ = pick_circle(st, args.circle)
    kind = (args.kind or "study").strip().lower()
    if kind not in ("study", "jam"):
        fail(f"bad --kind '{args.kind}': use study or jam.", 6)
    targets = [t for chunk in args.with_ for t in csv(chunk)]
    if not targets:
        fail("--with needs at least one friend's name.", 6)
    members = get_members(st, code, circ).get("members", [])
    ids = resolve_targets(members, circ["member_id"], targets)
    res = http("GET", server_url(st), f"/circles/{code}/vibe", token=circ["token"], query={"with": ",".join(ids), "kind": kind})
    if args.json:
        emit(res)
        return
    print(f"Mood: {res.get('mood') or 'focus'}")
    print("Shared genres: " + (", ".join(res.get("genres") or []) or "none"))
    print("Shared artists: " + (", ".join(res.get("artists") or []) or "none"))


def cmd_members(args, st: dict) -> None:
    code, circ = pick_circle(st, args.circle)
    info = get_members(st, code, circ)
    if args.json:
        emit(info)
    else:
        print(f"Circle: {info.get('name', code)}")
        render_members(info.get("members", []))


def cmd_log(args, st: dict) -> None:
    code, circ = pick_circle(st, args.circle)
    res = http("GET", server_url(st), f"/circles/{code}/log", token=circ["token"], query={"limit": args.limit})
    if args.json:
        emit(res)
    else:
        render_log(res.get("entries", []), args.limit)


def cmd_log_link(args, st: dict) -> None:
    code, circ = pick_circle(st, args.circle)
    url = None
    try:  # read-only view link from the server; older servers (or no network) fall back to the private token link
        url = get_members(st, code, circ).get("view_url")
    except SystemExit:
        pass
    if not url:
        url = f"{server_url(st)}/?c={code}#k={circ['token']}"
    if args.json:
        emit({"url": url})
    else:
        print(url)


def cmd_toggle(args, st: dict) -> None:
    code, circ = pick_circle(st, args.circle)
    http("POST", server_url(st), f"/circles/{code}/{args.command}", {}, token=circ["token"])
    if args.json:
        emit({"ok": True})
    elif args.command == "pause":
        print("Paused: friends no longer see your signal.")
    else:
        print("Resumed: share again to update your signal.")


def cmd_leave(args, st: dict) -> None:
    code, circ = pick_circle(st, args.circle)
    http("POST", server_url(st), f"/circles/{code}/leave", {}, token=circ["token"])
    st["circles"].pop(code, None)
    (st.get("last_inbox") or {}).pop(code, None)
    if st.get("default") == code:
        st["default"] = next(iter(st["circles"]), None)
    save_state(st)
    if args.json:
        emit({"ok": True, "deleted": True})
    else:
        print(f"Left {circ.get('name') or code}. Your signal and proposals were deleted.")


def cmd_status(args, st: dict) -> None:
    code, circ = pick_circle(st, args.circle)
    consent = st.get("consent")
    if args.json:
        emit({"circle": code, "name": circ.get("name"), "member_id": circ.get("member_id"),
              "member_name": circ.get("member_name"), "server": server_url(st),
              "circles": list(st["circles"]), "consent": consent})
        return
    print(f"Circle: {circ.get('name')} ({code})")
    print(f"You: {circ.get('member_name')}")
    print(f"Server: {server_url(st)}")
    print("Consent: " + (consent_line(consent) if consent else "not set (run consent)"))
    others = [c for c in st["circles"] if c != code]
    if others:
        print("Other circles: " + ", ".join(others))


# ---------- main ----------

def build_parser() -> argparse.ArgumentParser:
    p = Parser(prog="orbit", description="Orbit circle client for Cubbie.")
    p.add_argument("--circle", help="circle code (default: the saved default)")
    p.add_argument("--json", action="store_true", help="print JSON")
    p.add_argument("--sample", action="store_true", help="use assets/sample_feed.json, no network or saved state")
    sub = p.add_subparsers(dest="command", required=True, parser_class=Parser)

    def add(name, **kw):
        sp = sub.add_parser(name, **kw)
        # also accept the global options after the command
        sp.add_argument("--circle", default=argparse.SUPPRESS)
        sp.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        sp.add_argument("--sample", action="store_true", default=argparse.SUPPRESS)
        return sp

    s = add("create")
    s.add_argument("--name")
    s.add_argument("--me")
    s = add("join")
    s.add_argument("--code")
    s.add_argument("--me")
    s = add("consent", add_help=False)  # --help here means the help-consent flag
    for k in ("busy", "big-days", "free", "courses", "help", "wins", "music"):
        s.add_argument("--" + k, help="yes or no" if k == "music" else None)
    s = add("share")
    s.add_argument("--today")
    s.add_argument("--busy")
    s.add_argument("--big-days")
    s.add_argument("--free")
    s.add_argument("--courses-file")
    s.add_argument("--courses-json")
    s.add_argument("--prefers", help="times of day the student tends to prefer, e.g. evening,morning (needs free consent)")
    s.add_argument("--avoid-days", help="weekdays the student wants to avoid, e.g. fri,sat (needs free consent)")
    s.add_argument("--can-help", action="append")
    s.add_argument("--want-help", action="append")
    s.add_argument("--win", action="append")
    s.add_argument("--artists", help='music artists you like, separated by | (needs music consent)')
    s.add_argument("--genres", help='music genres you like, separated by | (needs music consent)')
    s = add("feed")
    s.add_argument("--today")
    s.add_argument("--now", help="your local time, HH:MM, to pick the window for a jam nudge (default: now)")
    s.add_argument("--new-only", action="store_true",
                   help="hide suggestions and requests already shown; print nothing when there is nothing new")
    s = add("inbox")
    s.add_argument("--today")
    s.add_argument("--now", help="your local time, HH:MM (default: now)")
    s = add("mark-added")
    s.add_argument("--id", required=True)
    s = add("propose")
    s.add_argument("--to", action="append", required=True)
    s.add_argument("--kind", required=True)
    s.add_argument("--course")
    s.add_argument("--windows", "--window", dest="windows", required=True,
                   help="ranked best first, e.g. tue-evening,thu-evening (--window also works)")
    s.add_argument("--time")
    s.add_argument("--note")
    s.add_argument("--places", help='up to 3 places separated by |, e.g. "Hayden Library 2nd floor|Zoom"')
    s.add_argument("--playlist-url", help="a Spotify playlist, album or track link for the plan")
    s.add_argument("--playlist-name", help="what the playlist is called, e.g. \"Indie jam mix\" (max 60)")
    s.add_argument("--today")
    s = add("respond")
    s.add_argument("--id", required=True)
    s.add_argument("--answer", required=True, help="yes, no or busy")
    s.add_argument("--free", help="with busy: your student's current free windows, comma separated")
    s.add_argument("--place", type=int, help="with yes: number (from 0) of the proposed place the student picked")
    s.add_argument("--place-suggest", help="with yes: a different place the student suggests")
    s.add_argument("--playlist-url", help="with yes: a Spotify playlist link (kept only if the plan has none yet)")
    s.add_argument("--playlist-name", help="with yes: the playlist's name")
    s.add_argument("--today")
    s = add("conflict")
    s.add_argument("--id", required=True)
    s.add_argument("--free", help="the student's current free windows, comma separated (\"\" for none)")
    s.add_argument("--today")
    s = add("playing")
    s.add_argument("--artist")
    s.add_argument("--track")
    s.add_argument("--genre")
    s.add_argument("--url", help="a Spotify link for the track, album, playlist or artist")
    s.add_argument("--clear", action="store_true", help="stop sharing what you are playing")
    s = add("vibe")
    s.add_argument("--with", dest="with_", action="append", required=True, help="friend names, comma separated or repeated")
    s.add_argument("--kind", help="study (default) or jam")
    s = add("cheered")
    s.add_argument("--friend", required=True)
    s = add("public")
    s.add_argument("state", choices=["on", "off"])
    s = add("suggest")
    s.add_argument("--with", dest="with_", action="append", required=True, help="friend names, comma separated or repeated")
    s.add_argument("--course")
    s.add_argument("--today")
    s = add("plans")
    s.add_argument("--within", type=int, default=3, help="days ahead to list (default 3)")
    s.add_argument("--today")
    add("members")
    s = add("log")
    s.add_argument("--limit", type=int, default=10)
    for n in ("log-link", "pause", "resume", "leave", "status"):
        add(n)
    return p


def main() -> None:
    args = build_parser().parse_args()
    if getattr(args, "limit", 10) < 1:
        fail("--limit must be at least 1.", 6)
    if args.sample:
        cmd_sample(args)
        return
    st = load_state()
    c = args.command
    if c in ("create", "join"):
        cmd_create_join(args, st)
    elif c == "consent":
        cmd_consent(args, st)
    else:
        {"share": cmd_share, "feed": cmd_feed, "inbox": cmd_inbox, "mark-added": cmd_mark_added,
         "propose": cmd_propose, "respond": cmd_respond, "conflict": cmd_conflict, "cheered": cmd_cheered,
         "public": cmd_public, "suggest": cmd_suggest, "plans": cmd_plans, "members": cmd_members, "log": cmd_log,
         "playing": cmd_playing, "vibe": cmd_vibe,
         "log-link": cmd_log_link, "pause": cmd_toggle, "resume": cmd_toggle, "leave": cmd_leave,
         "status": cmd_status}[c](args, st)


if __name__ == "__main__":
    main()
