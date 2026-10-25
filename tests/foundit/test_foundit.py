"""Tests for the FoundIt Skill's planner. Run: python3 -m unittest discover -s tests/foundit"""

from __future__ import annotations

import ast
import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "foundit" / "scripts" / "foundit.py"
spec = importlib.util.spec_from_file_location("foundit", SCRIPT)
foundit = importlib.util.module_from_spec(spec)
sys.modules["foundit"] = foundit  # dataclasses look the module up while building Plan
spec.loader.exec_module(foundit)

SUNDAY = date(2026, 10, 25)
WEDNESDAY = date(2026, 10, 21)


def plan(said: str, today: date = SUNDAY, **kw):
    return foundit.make_plan(said, today, **kw)


def taken(said: str, today: date = SUNDAY):
    p = plan(said, today)
    return p.date_from, p.date_to


def run(*args: str, env: dict = None):
    return subprocess.run([sys.executable, "-I", str(SCRIPT), *args], capture_output=True, text=True,
                          encoding="utf-8", env=env)


class TheStudentsOwnWords(unittest.TestCase):
    def test_motor_circuit_last_wednesday(self):
        p = plan("I had taken a picture last wednesday of a motor circuit")
        self.assertEqual((p.kind, p.visual, p.topics), ("circuit", True, ["motor"]))
        self.assertEqual((p.date_from, p.date_to), ("2026-10-21", "2026-10-21"))
        self.assertEqual(p.search, "motor circuit")

    def test_vague_description_without_a_date(self):
        p = plan("a purple flower pic with a man behind it")
        self.assertEqual((p.kind, p.visual, p.course, p.date_from), (None, False, None, None))
        self.assertEqual(p.search, "purple flower man")
        self.assertFalse(p.empty)

    def test_any_photo_not_only_class_photos(self):
        self.assertEqual(plan("the sunset at the beach with my dog, kinda orange").search, "sunset beach dog orange")
        self.assertEqual(plan("selfie in front of the red car last weekend").topics, ["selfie", "red", "car"])

    def test_notes_on_a_topic(self):
        p = plan("I took notes on forwarding in 340")
        self.assertEqual((p.kind, p.visual, p.topics, p.course), ("notes", False, ["forwarding"], None))
        self.assertIsNone(p.date_from)

    def test_first_kind_named_wins_and_other_kinds_stay_topics(self):
        p = plan("my notes on the circuit lab")
        self.assertEqual(p.kind, "notes")
        self.assertIn("circuit", p.topics)

    def test_whiteboard_with_course_and_day(self):
        p = plan("pic of the board in CSE-340 on tuesday about pipelining hazards")
        self.assertEqual((p.kind, p.course, p.topics), ("whiteboard", "CSE 340", ["pipelining", "hazards"]))
        self.assertEqual(taken("on tuesday"), ("2026-10-20", "2026-10-20"))

    def test_course_forms(self):
        for said in ("cse340 notes", "CSE 340 notes", "cse-340 notes"):
            self.assertEqual(plan(said).course, "CSE 340", said)
        self.assertEqual(plan("eee202 lab circuit").course, "EEE 202")

    def test_not_courses(self):
        for said in ("notes from room 204", "slides on page 112", "photo from oct 14", "pic from my 340 class",
                     "board in the 101 lecture"):
            self.assertIsNone(plan(said).course, said)

    def test_ordinary_words_are_not_days(self):
        for said in ("notes from when I sat in the sun", "the slides I took"):
            self.assertIsNone(plan(said).date_from, said)

    def test_chat_filler_is_not_a_topic(self):
        p = plan("hey can u find the pic i snapped of the whiteboard, it said something about hazards")
        self.assertEqual((p.kind, p.topics), ("whiteboard", ["hazards"]))
        self.assertEqual(plan("photo of my friend's chem notes on titration").topics, ["chem", "titration"])

    def test_nothing_to_search_on(self):
        self.assertTrue(plan("can you find it for me please").empty)

    def test_long_messages_are_cut(self):
        self.assertLessEqual(len(plan("notes " * 400).said), foundit.MAX_SAID)


class Dates(unittest.TestCase):
    def test_relative_days(self):
        cases = {
            "today": ("2026-10-25", "2026-10-25"),
            "this morning": ("2026-10-25", "2026-10-25"),
            "yesterday": ("2026-10-24", "2026-10-24"),
            "last night": ("2026-10-24", "2026-10-24"),
            "the day before yesterday": ("2026-10-23", "2026-10-23"),
            "3 days ago": ("2026-10-22", "2026-10-22"),
            "a few days ago": ("2026-10-20", "2026-10-23"),
            "a couple of days ago": ("2026-10-22", "2026-10-24"),
            "two weeks ago": ("2026-10-08", "2026-10-14"),
            "the other day": ("2026-10-18", "2026-10-25"),
        }
        for said, want in cases.items():
            self.assertEqual(taken(said), want, said)

    def test_weekdays(self):
        self.assertEqual(taken("wednesday"), ("2026-10-21", "2026-10-21"))
        self.assertEqual(taken("last wednesday"), ("2026-10-21", "2026-10-21"))
        self.assertEqual(taken("wednesday", WEDNESDAY), ("2026-10-21", "2026-10-21"))
        self.assertEqual(taken("last wednesday", WEDNESDAY), ("2026-10-14", "2026-10-14"))
        self.assertEqual(taken("on thurs"), ("2026-10-22", "2026-10-22"))

    def test_weeks_weekends_months(self):
        self.assertEqual(taken("last week"), ("2026-10-12", "2026-10-18"))
        self.assertEqual(taken("this week"), ("2026-10-19", "2026-10-25"))
        self.assertEqual(taken("this weekend"), ("2026-10-24", "2026-10-25"))
        self.assertEqual(taken("last weekend"), ("2026-10-17", "2026-10-18"))
        self.assertEqual(taken("last weekend", WEDNESDAY), ("2026-10-17", "2026-10-18"))
        self.assertEqual(taken("last month"), ("2026-09-01", "2026-09-30"))
        self.assertEqual(taken("this month"), ("2026-10-01", "2026-10-25"))
        self.assertEqual(taken("back in march"), ("2026-03-01", "2026-03-31"))
        self.assertEqual(taken("in december"), ("2025-12-01", "2025-12-31"))
        self.assertEqual(taken("in october"), ("2026-10-01", "2026-10-25"))
        self.assertEqual(taken("from september"), ("2026-09-01", "2026-09-30"))
        self.assertEqual(taken("chem notes september"), ("2026-09-01", "2026-09-30"))
        self.assertIsNone(taken("it may be notes")[0])

    def test_explicit_dates(self):
        cases = {
            "on oct 14": "2026-10-14",
            "October 14th, 2025": "2025-10-14",
            "the 14th of october": "2026-10-14",
            "on december 3": "2025-12-03",
            "on 10/14": "2026-10-14",
            "on 14/10": "2026-10-14",
            "on 10/14/25": "2025-10-14",
            "on the 14th": "2026-10-14",
            "on the 31st": "2026-08-31",
            "2026-10-14": "2026-10-14",
        }
        for said, day in cases.items():
            self.assertEqual(taken(said), (day, day), said)

    def test_feb_29_goes_back_to_a_leap_year(self):
        self.assertEqual(taken("feb 29"), ("2024-02-29", "2024-02-29"))

    def test_impossible_and_future_dates_exit_2(self):
        for said in ("on feb 30", "on 10/14/27", "2027-01-01"):
            with self.assertRaises(SystemExit) as cm, contextlib.redirect_stderr(io.StringIO()):
                plan(said)
            self.assertEqual(cm.exception.code, 2, said)

    def test_huge_counts_do_not_crash(self):
        self.assertEqual(taken("999 days ago"), ("2024-01-30", "2024-01-30"))
        self.assertIsNone(taken("9999999 days ago")[0])

    def test_widen_never_goes_past_today(self):
        self.assertEqual(plan("last wednesday", widen=3).date_from, "2026-10-18")
        self.assertEqual(plan("last wednesday", widen=3).date_to, "2026-10-24")
        self.assertEqual(plan("yesterday", widen=3).date_to, "2026-10-25")

    def test_any_date_drops_the_date(self):
        p = plan("last wednesday motor circuit", any_date=True)
        self.assertIsNone(p.date_from)
        self.assertEqual(p.search, "motor circuit")


class CommandLine(unittest.TestCase):
    def test_text_output(self):
        r = run("plan", "--said", "I took a picture last Wednesday of a motor circuit", "--today", "2026-10-25")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), [
            "Kind: circuit (show the photo itself)",
            "Course: any",
            "Topic: motor",
            "Taken: Wed Oct 21 2026",
            "Search words: motor circuit",
        ])

    def test_json_output(self):
        r = run("plan", "--said", "cse 340 slides from last week", "--today", "2026-10-25", "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual((out["kind"], out["course"], out["date_from"], out["date_to"]),
                         ("slide", "CSE 340", "2026-10-12", "2026-10-18"))
        self.assertEqual(out["search"], "slide")

    def test_sample(self):
        r = run("plan", "--sample")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("Taken: Wed Oct 21 2026", r.stdout)

    def test_bad_arguments_exit_2(self):
        for args in (["plan", "--said", "notes"],
                     ["plan", "--said", "notes", "--today", "10/25"],
                     ["plan", "--said", "notes", "--today", "2026-10-25", "--widen", "99"],
                     ["plan", "--said", "   ", "--today", "2026-10-25"],
                     ["plan", "--bogus"],
                     []):
            r = run(*args)
            self.assertEqual(r.returncode, 2, args)
            self.assertTrue(r.stderr.startswith("foundit: "), args)
            self.assertEqual(r.stdout, "", args)

    def test_nothing_to_search_on_exits_3(self):
        r = run("plan", "--said", "can you find it", "--today", "2026-10-25")
        self.assertEqual(r.returncode, 3)
        self.assertIn("ask the student", r.stderr)

    def test_saves_nothing(self):
        with tempfile.TemporaryDirectory() as home:
            env = {**os.environ, "HOME": home, "USERPROFILE": home}
            r = run("plan", "--said", "motor circuit last wednesday", "--today", "2026-10-25", env=env)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(os.listdir(home), [])

    def test_runs_on_python_3_8(self):
        ast.parse(SCRIPT.read_text(encoding="utf-8"), feature_version=(3, 8))


if __name__ == "__main__":
    unittest.main()
