#!/usr/bin/env python3
"""FoundIt client: lets a student's Cubbie find note photos buried in their gallery.

Everything stays on the student's side. The index (consent, the note photos Cubbie has read,
and the keys of photos it looked at and skipped) is kept in ~/.config/foundit/index.json
with mode 600. Nothing is ever sent to a server. Skipped photos (selfies, memes, food) are kept
only as an opaque key so they are not looked at again; nothing about what they show is saved.

Exit codes: 0 ok, 2 gallery access not given, 3 note not found, 6 bad input.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# Kinds whose meaning is in the drawing, not the words: always show the photo itself.
VISUAL_KINDS = ["circuit", "diagram", "graph", "chart", "map", "drawing", "schematic"]
# Kinds that are mostly writing: send the photo, and the text works when a photo cannot be sent.
TEXT_KINDS = ["notes", "whiteboard", "slide", "handout", "board", "page", "formula", "code", "other"]
KINDS = TEXT_KINDS + VISUAL_KINDS
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
MAX_TEXT = 20000       # characters of transcription kept per photo
MAX_SUMMARY = 160
MAX_TITLE = 80
MAX_TAGS = 15
MAX_SCAN = 25          # photos printed per scan, so Cubbie reads them in small batches
MAX_RESULTS = 3        # matches printed per find
MAX_SKIPPED = 20000
COURSE_RE = re.compile(r"\b([A-Za-z]{2,4})\s?-?(\d{3}[A-Za-z]?)\b")
WORD_RE = re.compile(r"[a-z0-9]+")
STOP = set("""a an and are about any at be can could did do does find for from get give had has have
help how i im in is it its just last look looking me my need of on or out photo photos pic pics picture
pictures please retrieve send show some take taken that the them these this those to took up was we what
where which with you your gallery camera roll image images note notes wrote written""".split())
# query words that point at a kind of photo
KIND_WORDS = {
    "circuit": "circuit", "circuits": "circuit", "breadboard": "circuit", "resistor": "circuit",
    "resistors": "circuit", "schematic": "schematic", "schematics": "schematic", "wiring": "circuit",
    "diagram": "diagram", "diagrams": "diagram", "flowchart": "diagram", "fsm": "diagram",
    "graph": "graph", "graphs": "graph", "plot": "graph", "chart": "chart", "charts": "chart",
    "map": "map", "drawing": "drawing", "sketch": "drawing",
    "whiteboard": "whiteboard", "board": "board", "slide": "slide", "slides": "slide",
    "handout": "handout", "worksheet": "handout", "formula": "formula", "formulas": "formula",
    "equation": "formula", "equations": "formula", "code": "code",
}
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def fail(message: str, code: int):
    print(f"foundit: {message}", file=sys.stderr)
    sys.exit(code)


class Parser(argparse.ArgumentParser):
    def error(self, message):  # argparse would exit 2, which means "no gallery access"
        fail(message, 6)


# ---------- index ----------

def index_path() -> Path:
    return Path.home() / ".config" / "foundit" / "index.json"


def load_index() -> dict:
    try:
        ix = json.loads(index_path().read_text(encoding="utf-8"))
        if isinstance(ix, dict):
            ix.setdefault("notes", [])
            ix.setdefault("skipped", [])
            ix.setdefault("next_id", 1)
            return ix
    except (OSError, ValueError):
        pass
    return {"notes": [], "skipped": [], "next_id": 1}


def save_index(ix: dict) -> None:
    p = index_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(p.parent, 0o700)
    except OSError:
        pass
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(ix, f, indent=2, ensure_ascii=False)
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass


def need_access(ix: dict) -> None:
    if not ix.get("gallery"):
        fail("gallery access not given yet. Ask the student, then run consent --gallery yes.", 2)


# ---------- helpers ----------

def emit(obj) -> None:
    print(json.dumps(obj, indent=2, ensure_ascii=False))


def yesno(v: str, flag: str) -> bool:
    low = v.strip().lower()
    if low in ("yes", "y", "true", "1", "on"):
        return True
    if low in ("no", "n", "false", "0", "off"):
        return False
    fail(f"bad value '{v}' for {flag}: use yes or no.", 6)


def parse_today(s: str | None) -> date:
    if not s:
        return date.today()
    try:
        return date.fromisoformat(s)
    except ValueError:
        fail(f"bad --today '{s}': use YYYY-MM-DD.", 6)


def parse_day(s: str | None, flag: str) -> str | None:
    if not s:
        return None
    try:
        return date.fromisoformat(s.strip()[:10]).isoformat()
    except ValueError:
        fail(f"bad {flag} '{s}': use YYYY-MM-DD.", 6)


def fmt_date(iso) -> str:
    try:
        d = date.fromisoformat(str(iso))
    except ValueError:
        return ""
    return f"{d:%b} {d.day}"


def words(s: str) -> list[str]:
    return WORD_RE.findall((s or "").lower())


def stem(w: str) -> str:
    for suf in ("ing", "es", "s"):
        if len(w) > len(suf) + 2 and w.endswith(suf):
            return w[: -len(suf)]
    return w


def norm_course(s: str | None) -> str:
    m = COURSE_RE.search(s or "")
    return f"{m.group(1).upper()} {m.group(2).upper()}" if m else (s or "").strip().upper()


def ref_key(ref: str) -> str:
    """Opaque key for a photo: path + size + mtime for local files, else the ref itself."""
    p = Path(ref)
    try:
        stt = p.stat()
        raw = f"{p.resolve()}|{stt.st_size}|{int(stt.st_mtime)}"
    except OSError:
        raw = ref.strip()
    return hashlib.sha256(raw.encode("utf-8", "replace")).hexdigest()[:24]


def taken_of(ref: str) -> str | None:
    try:
        return datetime.fromtimestamp(Path(ref).stat().st_mtime).date().isoformat()
    except (OSError, ValueError, OverflowError):
        return None


def is_visual(n: dict) -> bool:
    return n.get("kind") in VISUAL_KINDS


def read_text(args) -> str:
    text = args.text or ""
    if args.text_file:
        try:
            text = Path(args.text_file).read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            fail(f"cannot read --text-file ({e.strerror}).", 6)
    return text.strip()[:MAX_TEXT]


def find_note(ix: dict, nid: int) -> dict:
    for n in ix["notes"]:
        if n["id"] == nid:
            return n
    fail(f"no saved note with id {nid}.", 3)


def label(n: dict) -> str:
    parts = [n.get("course"), n.get("title") or n.get("kind")]
    head = " ".join(x for x in parts if x)
    tail = [fmt_date(n.get("taken")), n.get("kind")]
    return " · ".join([head] + [x for x in tail if x])


def how_to_show(n: dict) -> str:
    if is_visual(n):
        return f"show the photo (it is a {n['kind']}, the drawing is the point)"
    if n.get("text"):
        return "send the photo, or read the text if you cannot send photos"
    return "send the photo"


# ---------- search ----------

def date_window(q: str, today: date):
    """(start, end) dates implied by words like yesterday, last week, monday. None when there are none."""
    q = q.lower()
    if "today" in q:
        return today, today
    if "yesterday" in q:
        d = today - timedelta(days=1)
        return d, d
    if "last week" in q or "past week" in q:
        return today - timedelta(days=13), today - timedelta(days=today.weekday() + 1)
    if "this week" in q:
        return today - timedelta(days=today.weekday()), today
    if "last month" in q or "past month" in q:
        return today - timedelta(days=45), today
    for i, wd in enumerate(WEEKDAYS):
        if re.search(rf"\b{wd}\b", q):
            back = (today.weekday() - i) % 7 or 7 if "last" in q else (today.weekday() - i) % 7
            d = today - timedelta(days=back)
            return d, d
    return None


def score(n: dict, terms: list[str], kinds: set, course: str, window) -> float:
    if course and norm_course(n.get("course")) != course:
        return 0.0
    if window and n.get("taken"):
        try:
            t = date.fromisoformat(n["taken"])
        except ValueError:
            t = None
        if t and not (window[0] - timedelta(days=1) <= t <= window[1] + timedelta(days=1)):
            return 0.0
    fields = {
        "title": (set(stem(w) for w in words(n.get("title"))), 3.0),
        "tags": (set(stem(w) for t in n.get("tags") or [] for w in words(t)), 3.0),
        "summary": (set(stem(w) for w in words(n.get("summary"))), 2.0),
        "text": (set(stem(w) for w in words(n.get("text"))), 1.0),
    }
    s = 0.0
    for t in terms:
        st = stem(t)
        best = 0.0
        for vocab, weight in fields.values():
            if st in vocab:
                best = max(best, weight)
            elif len(st) >= 4 and any(v.startswith(st) for v in vocab):
                best = max(best, weight * 0.5)
        s += best
    if kinds:
        if n.get("kind") in kinds:
            s += 4.0
        elif terms:
            s *= 0.5
        else:
            return 0.0
    if (terms or kinds) and s == 0:
        return 0.0  # the day or course alone is not a match for something the student described
    if course:
        s += 4.0
    if window:
        s += 1.0
    return s


def search(ix: dict, query: str, kind: str | None, course: str | None, today: date, use_dates: bool = True):
    """Notes matching what the student described, best first. Day words narrow it to that day (plus or minus one)."""
    q = query or ""
    kinds = {KIND_WORDS[w] for w in words(q) if w in KIND_WORDS}
    if kind:
        kinds = {kind}
    m = COURSE_RE.search(q)
    want_course = norm_course(course) if course else (norm_course(m.group(0)) if m else "")
    course_words = set(words(want_course))
    window = date_window(q, today) if use_dates else None
    skip = STOP | set(KIND_WORDS) | course_words | set(WEEKDAYS) | {"yesterday", "today", "week", "month", "past", "last", "ago", "day", "days"}
    terms = [w for w in words(q) if w not in skip]
    scored = []
    for n in ix["notes"]:
        s = score(n, terms, kinds, want_course, window)
        if s > 0 and (s >= 1.0 or not terms):
            scored.append((s, n.get("taken") or "", n))
    scored.sort(key=lambda x: x[1], reverse=True)  # newer first among equal scores (sort is stable)
    scored.sort(key=lambda x: -x[0])
    return [n for _, _, n in scored]


# ---------- commands ----------

def cmd_consent(args, ix: dict) -> None:
    if args.gallery is not None:
        ok = yesno(args.gallery, "--gallery")
        if ok:
            ix["gallery"] = True
            save_index(ix)
        else:
            had = len(ix["notes"])
            ix = {"gallery": False, "notes": [], "skipped": [], "next_id": 1}
            save_index(ix)
            if args.json:
                emit({"gallery": False, "deleted": had})
            else:
                print(f"Gallery access off. Deleted {had} saved note{'s' if had != 1 else ''}.")
            return
    on = bool(ix.get("gallery"))
    if args.json:
        emit({"gallery": on})
    else:
        print("Gallery access: " + ("yes" if on else "no (nothing is read)"))


def cmd_scan(args, ix: dict) -> None:
    need_access(ix)
    refs: list[str] = []
    if args.dir:
        for d in args.dir:
            root = Path(d).expanduser()
            if not root.is_dir():
                fail(f"no folder at {d}.", 6)
            for p in root.rglob("*"):
                if p.is_file() and p.suffix.lower() in IMAGE_EXTS and not p.name.startswith("."):
                    refs.append(str(p))
    if args.refs_file:
        try:
            refs += [x.strip() for x in Path(args.refs_file).read_text(encoding="utf-8").splitlines() if x.strip()]
        except OSError as e:
            fail(f"cannot read --refs-file ({e.strerror}).", 6)
    if not args.dir and not args.refs_file:
        fail("give --dir <photo folder> or --refs-file <file with one photo link per line>.", 6)
    since = parse_day(args.since, "--since")
    known = set(ix["skipped"]) | {n["key"] for n in ix["notes"]}
    new = []
    for r in refs:
        k = ref_key(r)
        if k in known:
            continue
        known.add(k)
        t = taken_of(r)
        if since and t and t < since:
            continue
        new.append((t or "", r))
    new.sort(reverse=True)  # newest first: recent notes are the ones people ask about
    total = len(new)
    shown = new[: args.limit]
    if args.json:
        emit({"new": [{"ref": r, "taken": t or None} for t, r in shown], "remaining": total - len(shown)})
        return
    if not shown:
        print("No new photos to look at.")
        return
    for t, r in shown:
        print(f"{r}" + (f"  ({fmt_date(t)})" if t else ""))
    if total > len(shown):
        print(f"{total - len(shown)} more after these. Run scan again when done.")


def cmd_add(args, ix: dict) -> None:
    need_access(ix)
    kind = (args.kind or "").strip().lower()
    if kind not in KINDS:
        fail(f"bad --kind '{args.kind}': use one of {', '.join(KINDS)}.", 6)
    text = read_text(args)
    summary = (args.summary or "").strip()[:MAX_SUMMARY]
    if kind in VISUAL_KINDS and not summary:
        fail(f"a {kind} needs --summary, one line saying what it shows.", 6)
    if not text and not summary and not args.title:
        fail("give --text or --text-file (what is written), or --summary for a drawing.", 6)
    tags = [t.strip()[:30] for t in (args.tags or "").split(",") if t.strip()][:MAX_TAGS]
    key = ref_key(args.ref)
    old = next((n for n in ix["notes"] if n["key"] == key), None)
    note = {
        "id": old["id"] if old else ix["next_id"],
        "key": key,
        "ref": args.ref.strip(),
        "kind": kind,
        "course": norm_course(args.course) if args.course else None,
        "title": (args.title or "").strip()[:MAX_TITLE] or None,
        "summary": summary or None,
        "tags": tags,
        "text": text or None,
        "taken": parse_day(args.taken, "--taken") or taken_of(args.ref),
        "added": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if old:
        ix["notes"] = [note if n is old else n for n in ix["notes"]]
    else:
        ix["notes"].append(note)
        ix["next_id"] += 1
    ix["skipped"] = [k for k in ix["skipped"] if k != key]
    save_index(ix)
    if args.json:
        emit({"ok": True, "id": note["id"], "updated": bool(old)})
    else:
        print(("Updated" if old else "Saved") + f": {label(note)} (id {note['id']})")


def cmd_skip(args, ix: dict) -> None:
    need_access(ix)
    have = set(ix["skipped"])
    for r in args.ref:
        k = ref_key(r)
        if k not in have:
            ix["skipped"].append(k)
            have.add(k)
    ix["skipped"] = ix["skipped"][-MAX_SKIPPED:]
    save_index(ix)
    if args.json:
        emit({"ok": True, "skipped": len(args.ref)})
    else:
        print(f"Skipped {len(args.ref)} photo{'s' if len(args.ref) != 1 else ''}.")


def cmd_find(args, ix: dict) -> None:
    need_access(ix)
    kind = args.kind.strip().lower() if args.kind else None
    if kind and kind not in KINDS:
        fail(f"bad --kind '{args.kind}': use one of {', '.join(KINDS)}.", 6)
    query, today = " ".join(args.query), parse_today(args.today)
    hits = search(ix, query, kind, args.course, today)[: args.limit]
    other_day = False
    if not hits and date_window(query, today):
        # people misremember the day more often than what was in the photo
        hits = search(ix, query, kind, args.course, today, use_dates=False)[: args.limit]
        other_day = bool(hits)
    if args.json:
        emit({"other_day": other_day, "matches": [{"id": n["id"], "ref": n["ref"], "kind": n["kind"], "course": n.get("course"),
                           "title": n.get("title"), "taken": n.get("taken"), "visual": is_visual(n),
                           "has_text": bool(n.get("text"))} for n in hits]})
        return
    if not hits:
        print("No matching notes found." if ix["notes"] else "No notes saved yet. Run scan first.")
        return
    if other_day:
        print("Nothing from that day. Closest from other days:")
    for i, n in enumerate(hits, 1):
        print(f"{i}. {label(n)} (id {n['id']}) - {how_to_show(n)}")


def cmd_get(args, ix: dict) -> None:
    need_access(ix)
    n = find_note(ix, args.id)
    if args.json:
        emit({**{k: v for k, v in n.items() if k != "key"}, "visual": is_visual(n)})
        return
    print(f"Note: {label(n)} (id {n['id']})")
    print(f"Photo: {n['ref']}")
    if is_visual(n):
        print(f"Show: send this photo. It is a {n['kind']}, so words alone do not cover it.")
        print("If you cannot send photos: give the photo link above and this one line.")
    elif n.get("text"):
        print("Show: send this photo. If you cannot send photos, read the text below.")
    else:
        print("Show: send this photo.")
    if n.get("summary"):
        print(f"What it shows: {n['summary']}")
    if n.get("text"):
        print("Text:")
        print(n["text"])


def cmd_list(args, ix: dict) -> None:
    need_access(ix)
    notes = sorted(ix["notes"], key=lambda n: n.get("taken") or "", reverse=True)
    if args.course:
        notes = [n for n in notes if norm_course(n.get("course")) == norm_course(args.course)]
    notes = notes[: args.limit]
    if args.json:
        emit({"notes": [{k: v for k, v in n.items() if k not in ("key", "text")} for n in notes]})
        return
    if not notes:
        print("No notes saved yet.")
        return
    for n in notes:
        print(f"{label(n)} (id {n['id']})")


def cmd_forget(args, ix: dict) -> None:
    if args.all:
        had = len(ix["notes"])
        ix["notes"], ix["skipped"] = [], []
        save_index(ix)
        if args.json:
            emit({"ok": True, "deleted": had})
        else:
            print(f"Forgot all {had} saved notes.")
        return
    if args.id is None:
        fail("give --id N or --all.", 6)
    n = find_note(ix, args.id)
    ix["notes"] = [x for x in ix["notes"] if x is not n]
    ix["skipped"].append(n["key"])  # do not read it again on the next scan
    save_index(ix)
    if args.json:
        emit({"ok": True, "deleted": 1})
    else:
        print(f"Forgot {label(n)}.")


def cmd_status(args, ix: dict) -> None:
    on = bool(ix.get("gallery"))
    visual = sum(1 for n in ix["notes"] if is_visual(n))
    if args.json:
        emit({"gallery": on, "notes": len(ix["notes"]), "visual": visual, "skipped": len(ix["skipped"])})
        return
    print("Gallery access: " + ("yes" if on else "no"))
    print(f"Notes saved: {len(ix['notes'])} ({visual} drawings or circuits)")
    print(f"Photos skipped: {len(ix['skipped'])}")
    if not on:
        sys.exit(2)


# ---------- main ----------

def build_parser() -> argparse.ArgumentParser:
    p = Parser(prog="foundit", description="Find note photos in the student's gallery.")
    p.add_argument("--json", action="store_true", help="print JSON")
    sub = p.add_subparsers(dest="command", parser_class=Parser)

    def add(name, **kw):
        sp = sub.add_parser(name, **kw)
        sp.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        return sp

    s = add("consent")
    s.add_argument("--gallery", help="yes or no (no deletes everything saved)")
    s = add("scan")
    s.add_argument("--dir", action="append", help="a photo folder to look through (repeatable)")
    s.add_argument("--refs-file", help="a file with one photo path or link per line (from a photos connector)")
    s.add_argument("--since", help="only photos taken on or after YYYY-MM-DD")
    s.add_argument("--limit", type=int, default=MAX_SCAN)
    s = add("add")
    s.add_argument("--ref", required=True, help="the photo's path or link")
    s.add_argument("--kind", required=True, help=", ".join(KINDS))
    s.add_argument("--course")
    s.add_argument("--title")
    s.add_argument("--summary", help="one line on what it shows (required for circuits and diagrams)")
    s.add_argument("--tags", help="comma separated topics, e.g. hmm,viterbi")
    s.add_argument("--text", help="what is written on it")
    s.add_argument("--text-file", help="a file with what is written on it")
    s.add_argument("--taken", help="YYYY-MM-DD the photo was taken (default: file date)")
    s = add("skip")
    s.add_argument("--ref", action="append", required=True)
    s = add("find")
    s.add_argument("query", nargs="*")
    s.add_argument("--kind")
    s.add_argument("--course")
    s.add_argument("--today")
    s.add_argument("--limit", type=int, default=MAX_RESULTS)
    s = add("get")
    s.add_argument("--id", type=int, required=True)
    s = add("list")
    s.add_argument("--course")
    s.add_argument("--limit", type=int, default=20)
    s = add("forget")
    s.add_argument("--id", type=int)
    s.add_argument("--all", action="store_true")
    add("status")
    return p


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # the · separator, on consoles that default to cp1252
    except (AttributeError, ValueError):
        pass
    args = build_parser().parse_args()
    if not args.command:
        fail("give a command: consent, scan, add, skip, find, get, list, forget or status.", 6)
    if getattr(args, "limit", 1) < 1:
        fail("--limit must be at least 1.", 6)
    ix = load_index()
    {"consent": cmd_consent, "scan": cmd_scan, "add": cmd_add, "skip": cmd_skip, "find": cmd_find,
     "get": cmd_get, "list": cmd_list, "forget": cmd_forget, "status": cmd_status}[args.command](args, ix)


if __name__ == "__main__":
    main()
