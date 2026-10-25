#!/usr/bin/env python3
"""Orbit client: lets a student's Cubbie share small opt-in signals with a friend circle.

Talks to the Orbit relay (JSON over HTTPS). State (circles, tokens, consent) is kept in
~/.config/orbit/state.json with mode 600. The token is never printed except inside the
log-link URL fragment.

Exit codes: 0 ok, 2 not in a circle, 3 circle/proposal not found, 4 server unreachable,
5 auth rejected, 6 bad input, 7 other server error.
"""

from __future__ import annotations

import argparse
from http.client import HTTPException
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

DEFAULT_SERVER = "https://orbit-circle.vercel.app"
SAMPLE = Path(__file__).resolve().parent.parent / "assets" / "sample_feed.json"
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
PARTS = ["morning", "afternoon", "evening"]
CONSENT_KEYS = ["busy", "big_days", "free", "courses", "help", "wins"]


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


# ---------- sample mode ----------

def load_sample() -> dict:
    try:
        return json.loads(SAMPLE.read_text())
    except (OSError, ValueError):
        fail(f"cannot read sample file {SAMPLE}.", 7)


# ---------- rendering ----------

def render_feed(name: str, count: int, feed: dict) -> None:
    print(f"Circle: {name} ({count} friends)")
    sugg = feed.get("suggestions") or []
    for s in sugg[:5]:
        print(f"- {s.get('text', '')}")
    me_id = (feed.get("me") or {}).get("member_id")
    waiting, accepted = [], []
    for p in feed.get("proposals") or []:
        if p.get("status") == "accepted":
            accepted.append(p)
        elif p.get("status") == "open" and me_id in (p.get("to_ids") or []) and not p.get("my_response"):
            waiting.append(p)
    for p in waiting[:3]:
        bits = [p.get("course"), pretty_window(p.get("window")) + (" " + p["time"] if p.get("time") else "")]
        detail = ", ".join(b for b in bits if b)
        print(f"Waiting on you: {p.get('from_name', 'Someone')} proposed {p.get('kind', 'a plan')}, {detail} (id {p['id']})")
    for p in accepted[:2]:
        who = p.get("from_name") if p.get("from_id") != me_id else ", ".join(p.get("to_names") or [])
        print(f"Plan set: {p.get('kind', 'plan')} with {who}, {pretty_window(p.get('window'))}"
              + (f" {p['time']}" if p.get("time") else "") + ".")
    if not sugg and not waiting and not accepted:
        print("Nothing new from your circle right now.")


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


# ---------- commands ----------

def cmd_sample(args) -> None:
    sample = load_sample()
    c = args.command
    circle = sample.get("circle", {})
    if c == "feed":
        if args.json:
            emit({k: sample.get(k) for k in ("me", "friends", "proposals", "suggestions")})
        else:
            render_feed(circle.get("name", "Sample"), len(sample.get("friends", [])), sample)
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
             "courses": args.courses, "help": args.help, "wins": args.wins}
    given = {k: v for k, v in flags.items() if v is not None}
    if given:
        cur = st.get("consent") or {k: False for k in CONSENT_KEYS}
        for k, v in given.items():
            cur[k] = yesno(v, "--" + k.replace("_", "-"))
        st["consent"] = cur
        save_state(st)
    cur = st.get("consent")
    if args.json:
        emit({"consent": cur})
    elif cur is None:
        print("No consent saved yet (nothing is shared). Set it with consent --busy yes --free yes ...")
    else:
        print(("Consent saved: " if given else "Consent: ") + consent_line(cur))


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
    if not wanted:
        fail("nothing to share: pass at least one of --busy, --big-days, --free, --courses-file, "
             "--can-help, --want-help, --win.", 6)

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
    base = server_url(st)
    feed = http("GET", base, f"/circles/{code}/feed", token=circ["token"], query={"today": today.isoformat()})
    if args.json:
        emit(feed)
        return
    count = len(feed.get("friends") or [])
    try:
        info = get_members(st, code, circ)
        count = max(len(info.get("members", [])) - 1, 0)
    except SystemExit:
        pass
    render_feed(circ.get("name") or code, count, feed)


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
    if args.kind not in ("study", "hangout"):
        fail(f"bad --kind '{args.kind}': use study or hangout.", 6)
    window = check_window(args.window)
    if args.time:
        try:
            hh, mm = args.time.split(":")
            assert 0 <= int(hh) <= 23 and 0 <= int(mm) <= 59 and len(mm) == 2
        except (ValueError, AssertionError):
            fail(f"bad --time '{args.time}': use HH:MM, e.g. 19:00.", 6)
    members = get_members(st, code, circ).get("members", [])
    to = resolve_targets(members, circ["member_id"], args.to)
    body = {"to": to, "kind": args.kind, "window": window}
    if args.course:
        body["course"] = args.course.strip()
    if args.time:
        body["time"] = args.time
    if args.note:
        body["note"] = args.note.strip()
    p = http("POST", server_url(st), f"/circles/{code}/proposals", body, token=circ["token"])
    if args.json:
        emit(p)
        return
    who = ", ".join(names_of(members, to))
    when = pretty_window(window) + (f" {args.time}" if args.time else "")
    print(f"Proposed {args.kind} to {who}: {when} (id {p.get('id')})")


def cmd_respond(args, st: dict) -> None:
    code, circ = pick_circle(st, args.circle)
    ans = args.answer.strip().lower()
    if ans not in ("yes", "no"):
        fail(f"bad --answer '{args.answer}': use yes or no.", 6)
    today = parse_today(args.today)
    res = http("POST", server_url(st), f"/proposals/{args.id}/respond",
               {"answer": ans, "today": today.isoformat()}, token=circ["token"])
    if args.json:
        emit(res)
        return
    prop = res.get("proposal") or {}
    print(f"You said {ans} to proposal {args.id}. Status: {prop.get('status', 'unknown')}.")
    c = res.get("counter")
    if c:
        print(f"Counter proposed for {pretty_window(c.get('window'))}"
              + (f" {c['time']}" if c.get("time") else "") + f" (id {c.get('id')}).")


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
    for k in ("busy", "big-days", "free", "courses", "help", "wins"):
        s.add_argument("--" + k)
    s = add("share")
    s.add_argument("--today")
    s.add_argument("--busy")
    s.add_argument("--big-days")
    s.add_argument("--free")
    s.add_argument("--courses-file")
    s.add_argument("--courses-json")
    s.add_argument("--can-help", action="append")
    s.add_argument("--want-help", action="append")
    s.add_argument("--win", action="append")
    s = add("feed")
    s.add_argument("--today")
    s = add("propose")
    s.add_argument("--to", action="append", required=True)
    s.add_argument("--kind", required=True)
    s.add_argument("--course")
    s.add_argument("--window", required=True)
    s.add_argument("--time")
    s.add_argument("--note")
    s = add("respond")
    s.add_argument("--id", required=True)
    s.add_argument("--answer", required=True)
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
        {"share": cmd_share, "feed": cmd_feed, "propose": cmd_propose, "respond": cmd_respond,
         "members": cmd_members, "log": cmd_log, "log-link": cmd_log_link, "pause": cmd_toggle,
         "resume": cmd_toggle, "leave": cmd_leave, "status": cmd_status}[c](args, st)


if __name__ == "__main__":
    main()
