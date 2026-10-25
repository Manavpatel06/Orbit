#!/usr/bin/env python3
"""Turn whatever a student remembers about a photo into a search of their gallery.

The description can be anything, however vague ("a purple flower pic with a man behind it"), with or
without a day. FoundIt is stateless on purpose: it saves nothing, reads no photos and contacts no
server. Cubbie passes the student's own words and local date; the script prints the date range to look
in (if the student gave one), the kind of photo, the course and the search words. Cubbie then searches
the gallery and looks at the photos with its own abilities, because scripts cannot call them.

    python3 scripts/foundit.py plan --said "a purple flower pic with a man behind it" --today 2026-10-25
    python3 scripts/foundit.py plan --said "I took a picture last Wednesday of a motor circuit" --today 2026-10-25
    python3 scripts/foundit.py plan --sample

Exit codes: 0 ok, 2 bad arguments, 3 nothing to search on (ask the student for one detail).
"""

from __future__ import annotations

import argparse
import calendar
import json
import re
import sys
from dataclasses import asdict, dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import List, Optional, Set, Tuple

SAMPLE = Path(__file__).resolve().parent.parent / "assets" / "sample_request.json"
MAX_SAID = 500   # characters of the student's message that are read
MAX_WIDEN = 60   # days added on each side of the range, at most
MAX_TOPICS = 8

# English names written out: calendar.day_name and month_name follow the sandbox locale.
FULL_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
FULL_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september",
               "october", "november", "december"]
WEEKDAYS = {name: i for i, name in enumerate(FULL_WEEKDAYS)}
# Short forms, leaving out "sat" and "sun", which are also ordinary words.
WEEKDAYS.update({"mon": 0, "tue": 1, "tues": 1, "wed": 2, "weds": 2, "thu": 3, "thur": 3, "thurs": 3, "fri": 4})
MONTHS = {name: i for i, name in enumerate(FULL_MONTHS, 1)}
MONTHS.update({name[:3]: i for i, name in enumerate(FULL_MONTHS, 1)})
MONTHS["sept"] = 9
NUMBERS = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
           "eight": 8, "nine": 9, "ten": 10}
FUZZY_COUNTS = {"couple": (1, 3), "few": (2, 5), "several": (3, 7)}

# Kinds whose meaning is in the drawing, not the words: Cubbie always shows these as the photo.
VISUAL_KINDS = {"circuit", "schematic", "diagram", "graph", "chart", "map", "drawing"}
KIND_WORDS = {
    "notes": "notes", "note": "notes", "notebook": "notes",
    "whiteboard": "whiteboard", "board": "whiteboard", "blackboard": "whiteboard", "chalkboard": "whiteboard",
    "slide": "slide", "slides": "slide", "powerpoint": "slide", "projector": "slide",
    "handout": "handout", "worksheet": "handout", "syllabus": "handout", "textbook": "page", "page": "page",
    "formula": "formula", "formulas": "formula", "equation": "formula", "equations": "formula",
    "code": "code",
    "circuit": "circuit", "circuits": "circuit", "breadboard": "circuit", "wiring": "circuit",
    "schematic": "schematic", "schematics": "schematic",
    "diagram": "diagram", "diagrams": "diagram", "flowchart": "diagram",
    "graph": "graph", "graphs": "graph", "plot": "graph",
    "chart": "chart", "charts": "chart", "map": "map",
    "drawing": "drawing", "sketch": "drawing", "doodle": "drawing",
}
# Words that say nothing about which photo it is.
FILLER = set("""
a about after again all also am an and any are around as at back be been before but by can cant could
did didnt do does dont during earlier else ever find for found from get give go got had has have help
here how i id ill im in into is it its just know last like look looking lost me might mine my need
near of off on one or our out photo photos pic pics picture pictures please pull remember retrieve
saw send show showing snap some something somewhere that the them then there these thing think
this those to took take taken taking up was we were what when where which while who with wrote written
you your gallery camera roll phone image images screenshot shot class lecture lab ago day days week
weeks month months morning afternoon evening night tonight today yesterday weekend recently other
past previous next semester time early late mid since sometime someday hey hi hello yo u ur pls plz
thanks thx say said says tell told photograph photographed photographing snapped captured capture
friend friends classmate classmates kind sort type sorta kinda maybe probably think guess
behind front beside next under over above below top bottom left right background foreground inside
outside middle center corner holding wearing standing sitting
""".split())
# Where things are in the photo ("a man behind the flower") helps Cubbie pick the photo by looking,
# but is noise in a gallery search box, so those words stay out of the search words.
COURSE_RE = re.compile(r"\b([A-Za-z]{2,4})[ -]?(\d{3}[A-Za-z]?)\b")
NOT_COURSES = {"room", "page", "unit", "part", "exam", "test", "quiz", "chap", "pg", "ch", "hw", "no", "num"}
WORD_RE = re.compile(r"[a-z0-9]+")
WEEKDAY_NAMES = "|".join(sorted(WEEKDAYS, key=len, reverse=True))
MONTH_NAMES = "|".join(sorted(MONTHS, key=len, reverse=True))
FULL_MONTH_NAMES = "|".join(name for name in FULL_MONTHS if name != "may")
COUNT_WORDS = r"\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten|couple|few|several"

DateRange = Tuple[date, date]


class Parser(argparse.ArgumentParser):
    def error(self, message):  # exit 2 for any bad argument, with one line on stderr
        fail(message, 2)


def fail(message: str, code: int):
    print(f"foundit: {message}", file=sys.stderr)
    sys.exit(code)


@dataclass
class Plan:
    said: str
    today: str
    kind: Optional[str] = None
    visual: bool = False
    course: Optional[str] = None
    topics: List[str] = field(default_factory=list)
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    when_said: Optional[str] = None
    widened: int = 0

    @property
    def search(self) -> str:
        words = self.topics + ([self.kind] if self.kind and self.kind not in self.topics else [])
        return " ".join(words)

    @property
    def empty(self) -> bool:
        return not (self.kind or self.course or self.topics or self.date_from)


# ---------- dates ----------

def most_recent(today: date, month: int, day: int) -> date:
    """The latest date with this month and day that is not after today (Feb 29 goes back to a leap year)."""
    for year in range(today.year, today.year - 8, -1):
        try:
            d = date(year, month, day)
        except ValueError:
            continue
        if d <= today:
            return d
    fail(f"there is no date with month {month} and day {day}.", 2)


def exact_date(year: int, month: int, day: int) -> date:
    try:
        return date(year, month, day)
    except ValueError:
        fail(f"there is no date {year:04d}-{month:02d}-{day:02d}.", 2)


def past_weekday(today: date, weekday: int, strictly_before: bool) -> date:
    back = (today.weekday() - weekday) % 7
    if back == 0 and strictly_before:
        back = 7
    return today - timedelta(days=back)


def month_range(year: int, month: int) -> DateRange:
    return date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1])


def explicit_day(t: str, today: date) -> Optional[Tuple[date, str]]:
    """2026-10-14, Oct 14, October 14th 2026, 14 October, 10/14, 10/14/26. A day without a year is the most recent one."""
    m = re.search(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b", t)
    if m:
        y, mo, d = (int(x) for x in m.groups())
        return exact_date(y, mo, d), m.group(0)
    m = (re.search(rf"\b({MONTH_NAMES})\.? (\d{{1,2}})(?:st|nd|rd|th)?\b(?:,? (\d{{4}}))?", t)
         or re.search(rf"\b(\d{{1,2}})(?:st|nd|rd|th)? (?:of )?({MONTH_NAMES})\b(?:,? (\d{{4}}))?", t))
    if m:
        a, b, y = m.groups()
        mo, d = (MONTHS[a], int(b)) if a in MONTHS else (MONTHS[b], int(a))
        return (exact_date(int(y), mo, d) if y else most_recent(today, mo, d)), m.group(0)
    m = re.search(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2}|\d{4}))?\b", t)
    if m:
        mo, d = int(m.group(1)), int(m.group(2))
        if mo > 12 >= d:  # 14/10 can only be day/month
            mo, d = d, mo
        y = m.group(3)
        if y:
            return exact_date(int(y) + (2000 if len(y) == 2 else 0), mo, d), m.group(0)
        return most_recent(today, mo, d), m.group(0)
    m = re.search(r"\bthe (\d{1,2})(?:st|nd|rd|th)\b", t)
    if m and 1 <= int(m.group(1)) <= 31:  # "on the 14th": the most recent 14th
        d = int(m.group(1))
        year, month = today.year, today.month
        for _ in range(12):
            if d <= calendar.monthrange(year, month)[1] and date(year, month, d) <= today:
                return date(year, month, d), m.group(0)
            year, month = (year, month - 1) if month > 1 else (year - 1, 12)
    return None


def parse_when(t: str, today: date) -> Optional[Tuple[DateRange, str]]:
    """The date range a phrase like 'last Wednesday' or 'a few days ago' points at, and the phrase itself.

    `t` is lowercase. The most specific phrase wins. Ranges never end after today.
    """
    found = explicit_day(t, today)
    if found:
        return (found[0], found[0]), found[1]

    m = re.search(r"\bday before yesterday\b", t)
    if m:
        d = today - timedelta(days=2)
        return (d, d), m.group(0)
    m = re.search(r"\b(?:yesterday|last night)\b", t)
    if m:
        d = today - timedelta(days=1)
        return (d, d), m.group(0)
    m = re.search(r"\b(?:today|this morning|this afternoon|this evening|tonight)\b", t)
    if m:
        return (today, today), m.group(0)

    m = re.search(rf"\b({COUNT_WORDS})(?: of)? (day|week|month)s? ago\b", t)
    if m:
        word = m.group(1)
        lo, hi = (int(word), int(word)) if word.isdigit() else FUZZY_COUNTS.get(word) or (NUMBERS[word],) * 2
        unit = {"day": 1, "week": 7, "month": 30}[m.group(2)]
        slack = unit // 2  # "2 weeks ago" is roughly, "2 days ago" is exactly
        start = today - timedelta(days=hi * unit + slack)
        end = today - timedelta(days=max(lo * unit - slack, 0))
        return (start, end), m.group(0)

    m = re.search(r"\b(?:(last|this|past) )?weekend\b", t)
    if m:
        sat = past_weekday(today, 5, strictly_before=False)
        if m.group(1) == "last" and today.weekday() >= 5:
            sat -= timedelta(days=7)
        return (sat, min(sat + timedelta(days=1), today)), m.group(0)

    m = re.search(rf"\b(?:(last|this|on|past) )?({WEEKDAY_NAMES})\b", t)
    if m:
        d = past_weekday(today, WEEKDAYS[m.group(2)], strictly_before=m.group(1) == "last")
        return (d, d), m.group(0)

    m = re.search(r"\b(?:last|past|previous) week\b", t)
    if m:
        monday = today - timedelta(days=today.weekday() + 7)
        return (monday, monday + timedelta(days=6)), m.group(0)
    m = re.search(r"\bthis week\b", t)
    if m:
        return (today - timedelta(days=today.weekday()), today), m.group(0)

    m = re.search(r"\b(?:last|past|previous) month\b", t)
    if m:
        prev = today.replace(day=1) - timedelta(days=1)
        return month_range(prev.year, prev.month), m.group(0)
    m = re.search(r"\bthis month\b", t)
    if m:
        return (today.replace(day=1), today), m.group(0)

    # A month after a preposition, or a full month name on its own ("may" alone is too often a verb).
    m = (re.search(rf"\b(?:in|from|during|since|back in|early|late|mid) ({MONTH_NAMES})\b", t)
         or re.search(rf"\b({FULL_MONTH_NAMES})\b", t))
    if m:
        month = MONTHS[m.group(1)]
        start, end = month_range(today.year if month <= today.month else today.year - 1, month)
        return (start, min(end, today)), m.group(0)

    m = re.search(r"\b(?:the other day|recently|a few days back)\b", t)
    if m:
        return (today - timedelta(days=7), today), m.group(0)
    return None


# ---------- what, which course ----------

def find_course(text: str) -> Tuple[Optional[str], Set[str]]:
    """'CSE 340' from 'cse340', 'CSE-340' or 'cse 340', and the words it used up."""
    for m in COURSE_RE.finditer(text):
        letters, number = m.group(1).lower(), m.group(2).lower()
        if letters in NOT_COURSES or letters in FILLER or letters in MONTHS or letters in WEEKDAYS:
            continue
        return f"{letters.upper()} {number.upper()}", {letters, number, letters + number}
    return None, set()


def find_kind(words: List[str]) -> Optional[str]:
    """The first kind of photo named: 'notes on the circuit' is notes, 'a motor circuit' is a circuit."""
    return next((KIND_WORDS[w] for w in words if w in KIND_WORDS), None)


def find_topics(words: List[str], used: Set[str], kind: Optional[str]) -> List[str]:
    """Words that say what was on the photo. Kind words stay, except the ones naming the photo's own kind."""
    topics: List[str] = []
    for w in words:
        skip = (w in used or w in FILLER or (kind and KIND_WORDS.get(w) == kind) or w in WEEKDAYS
                or w in MONTHS or w in NUMBERS or w.isdigit() or len(w) < 2)
        if not skip and w not in topics:
            topics.append(w)
    return topics[:MAX_TOPICS]


def make_plan(said: str, today: date, widen: int = 0, any_date: bool = False) -> Plan:
    text = " ".join(said.split())[:MAX_SAID]
    lowered = text.lower()
    plan = Plan(said=text, today=today.isoformat())
    used: Set[str] = set()

    when = None if any_date else parse_when(lowered, today)
    if when:
        (start, end), phrase = when
        if start > today:
            fail(f"{phrase!r} is after today ({today.isoformat()}); photos cannot be from the future.", 2)
        plan.date_from = (start - timedelta(days=widen)).isoformat()
        plan.date_to = min(end + timedelta(days=widen), today).isoformat()
        plan.when_said, plan.widened = phrase, widen
        used.update(WORD_RE.findall(phrase))

    plan.course, course_words = find_course(text)
    used |= course_words
    words = WORD_RE.findall(lowered)
    plan.kind = find_kind(words)
    plan.visual = plan.kind in VISUAL_KINDS
    plan.topics = find_topics(words, used, plan.kind)
    return plan


# ---------- output ----------

def fmt_day(iso: str) -> str:
    d = date.fromisoformat(iso)
    return f"{FULL_WEEKDAYS[d.weekday()][:3].title()} {FULL_MONTHS[d.month - 1][:3].title()} {d.day} {d.year}"


def taken_text(plan: Plan) -> str:
    if not plan.date_from:
        return "any date (newest first)"
    if plan.date_from == plan.date_to:
        return fmt_day(plan.date_from)
    return f"{fmt_day(plan.date_from)} to {fmt_day(plan.date_to)}"


def render(plan: Plan) -> str:
    kind = plan.kind or "any photo"
    if plan.visual:
        kind += " (show the photo itself)"
    return "\n".join([
        f"Kind: {kind}",
        f"Course: {plan.course or 'any'}",
        f"Topic: {', '.join(plan.topics) or 'any'}",
        f"Taken: {taken_text(plan)}",
        f"Search words: {plan.search or '(none, browse by date)'}",
    ])


def to_json(plan: Plan) -> str:
    return json.dumps({**asdict(plan), "search": plan.search}, indent=2, ensure_ascii=False)


# ---------- main ----------

def parse_today(raw: Optional[str]) -> date:
    if not raw:
        fail("give --today YYYY-MM-DD, the student's local date (the sandbox clock may be in another time zone).", 2)
    try:
        return date.fromisoformat(raw)
    except ValueError:
        fail(f"bad --today {raw!r}: use YYYY-MM-DD.", 2)


def load_sample() -> Tuple[str, date]:
    try:
        data = json.loads(SAMPLE.read_text(encoding="utf-8"))
        return str(data["said"]), date.fromisoformat(data["today"])
    except (OSError, ValueError, KeyError, TypeError) as exc:
        fail(f"cannot read the sample at {SAMPLE} ({type(exc).__name__}).", 2)


def build_parser() -> argparse.ArgumentParser:
    p = Parser(prog="foundit", description="Plan a search of the student's gallery from what they remember.")
    sub = p.add_subparsers(dest="command", parser_class=Parser)
    s = sub.add_parser("plan", help="turn the student's words into a date range, kind, course and search words")
    s.add_argument("--said", help="the student's message, as they wrote it")
    s.add_argument("--today", help="the student's local date, YYYY-MM-DD")
    s.add_argument("--widen", type=int, default=0, help=f"add this many days on each side of the date range (0-{MAX_WIDEN})")
    s.add_argument("--any-date", action="store_true", help="ignore the date the student gave")
    s.add_argument("--json", action="store_true", help="print JSON")
    s.add_argument("--sample", action="store_true", help="use assets/sample_request.json instead of --said and --today")
    return p


def main(argv: Optional[List[str]] = None) -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # consoles that default to another code page
    except (AttributeError, ValueError):
        pass
    args = build_parser().parse_args(argv)
    if args.command != "plan":
        fail("give a command: plan.", 2)
    if not 0 <= args.widen <= MAX_WIDEN:
        fail(f"--widen must be between 0 and {MAX_WIDEN}.", 2)
    if args.sample:
        said, today = load_sample()
    elif (args.said or "").strip():
        said, today = args.said, parse_today(args.today)
    else:
        fail("give --said with the student's own words.", 2)
    plan = make_plan(said, today, widen=args.widen, any_date=args.any_date)
    if plan.empty:
        fail("nothing to search on: ask the student when they took it, for which class, or what was on it.", 3)
    print(to_json(plan) if args.json else render(plan))


if __name__ == "__main__":
    main()
