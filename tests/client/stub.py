import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

MEM = [{"member_id": "a1b2c3d4", "name": "Manav", "paused": False, "has_signal": True, "updated_at": "x"},
       {"member_id": "b2c3d4e5", "name": "Manas", "paused": False, "has_signal": True, "updated_at": "x"},
       {"member_id": "b2c3d4ff", "name": "Manasi", "paused": False, "has_signal": False, "updated_at": None},
       {"member_id": "d4e5f6a7", "name": "Reya", "paused": True, "has_signal": False, "updated_at": None}]
sample = json.load(open(sys.argv[2]))
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "last.json")
EMPTY_INBOX = "2000-01-01"  # magic --today value that makes the stub return an empty inbox


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def handle_any(self, m):
        u = urlparse(self.path)
        p = u.path
        q = parse_qs(u.query)
        b = self.body() if m in ("POST", "PUT") else None
        with open(LOG, "w") as f:
            json.dump({"m": m, "p": self.path, "b": b, "auth": self.headers.get("Authorization")}, f)
        if p == "/api/circles" and m == "POST":
            return self.send(200, {"code": "ABC234", "name": b["name"], "member_id": "a1b2c3d4", "token": "SECRETTOKEN"})
        if p.endswith("/join"):
            if "/ZZZZZZ/" in p:
                return self.send(404, {"error": "No circle with that code.", "code": "code_not_found"})
            return self.send(200, {"code": "ABC234", "name": "Night Owls", "member_id": "a1b2c3d4", "token": "SECRETTOKEN"})
        if self.headers.get("Authorization") != "Bearer SECRETTOKEN":
            return self.send(401, {"error": "Token rejected.", "code": "unauthorized"})
        if p == "/api/circles/ABC234":
            return self.send(200, {"code": "ABC234", "name": "Night Owls", "members": MEM,
                                   "view_url": "https://orbit-cubbie.vercel.app/circle?c=ABC234&v=0123456789abcdef01234567"})
        if p.endswith("/signal"):
            return self.send(200, {"ok": True, "updated_at": "now"})
        if p.endswith("/feed"):
            return self.send(200, {k: sample[k] for k in ("me", "friends", "proposals", "suggestions")})
        if p.endswith("/inbox"):
            if q.get("today") == ["2001-01-01"]:  # v4 shapes: place, reason, reschedule
                return self.send(200, {"needs_answer": [
                    {"id": "4a4a4a4a", "from_name": "Manas", "kind": "study", "course": "CSE 576", "window": "thu-evening", "round": 1,
                     "date": "2026-10-29", "time": "19:00", "places": ["Hayden Library 2nd floor", "Zoom"], "place": None,
                     "reasons": ["before CSE 576 quiz Fri", "free for Manav and Manas"], "change": None},
                    {"id": "9b1e4f20", "from_name": "Manas", "kind": "study", "course": "CSE 576", "window": "sat-afternoon", "round": 3,
                     "date": "2026-10-31", "time": "14:00", "places": ["Zoom"], "place": "Zoom",
                     "reasons": ["Thu evening no longer free for Manas", "free for Manav and Manas"], "change": "rescheduled"}],
                    "updates": [{"id": "5b5b5b5b", "status": "accepted", "kind": "study", "course": "CSE 576", "window": "thu-evening",
                                 "date": "2026-10-29", "time": "19:00", "place": "Zoom", "remind_at": "2026-10-29T18:00:00", "round": 1}],
                    "new_nudges": [], "now": "2026-10-24T12:00:00Z"})
            if q.get("today") == [EMPTY_INBOX]:
                return self.send(200, {"needs_answer": [], "updates": [], "new_nudges": [], "now": "2026-10-24T12:00:00Z"})
            return self.send(200, sample["inbox"])
        if p.endswith("/public"):
            return self.send(200, {"ok": True, "public_board": b["on"], "watch_url": "https://orbit-cubbie.vercel.app/circle?c=ABC234"})
        if p.endswith("/cheer"):
            return self.send(200, {"ok": True, "logged": b["friend_id"] != "b2c3d4ff"})
        if p.endswith("/suggest-times"):
            if "b2c3d4ff" in q.get("with", [""])[0]:
                return self.send(200, {"course": None, "with": ["Manasi"], "missing": ["Manasi"], "windows": []})
            return self.send(200, {"course": "CSE 576", "with": ["Manas"], "missing": [], "windows": [
                {"window": "thu-evening", "date": "2026-10-29", "time": "19:00",
                 "reasons": ["before CSE 576 quiz Fri", "free for Manav and Manas", "matches preferred evenings for Manav and Manas", "soonest shared time"]},
                {"window": "sat-afternoon", "date": "2026-10-31", "time": "14:00", "reasons": ["free for Manav and Manas"]}]})
        if p.endswith("/conflict"):
            pid = p.split("/")[-2]
            base = {"id": pid, "kind": "study", "course": "CSE 576", "window": "sat-afternoon", "date": "2026-10-31", "time": "14:00",
                    "round": 3, "to_names": ["Manas"], "place": "Zoom", "status": "open", "change": "rescheduled"}
            if pid == "3fa2c1d9":
                return self.send(200, {"proposal": base, "rescheduled": True})
            reason = {"9b1e4f20": "limit", "aaaaaaaa": "no_window"}.get(pid, "not_locked")
            return self.send(200, {"proposal": {**base, "status": "accepted"}, "rescheduled": False, "reason": reason})
        if p.endswith("/proposals"):
            w = b.get("windows") or []
            if b.get("places"):
                return self.send(200, {"id": "deadbeef", "status": "open", "kind": b["kind"], "course": b.get("course"),
                                       "window": w[0], "windows": w, "time": "19:00", "date": "2026-10-29", "round": 1,
                                       "to_ids": b["to"], "places": b["places"], "reasons": ["before CSE 576 quiz Fri"]})
            return self.send(200, {"id": "deadbeef", "status": "open", "kind": b["kind"], "course": b.get("course"),
                                   "window": w[0], "windows": w, "time": b.get("time") or "19:00",
                                   "date": "2026-10-29", "round": 1, "to_ids": b["to"]})
        if p.endswith("/respond"):
            a = b["answer"]
            pid = p.split("/")[-2]
            if a == "busy" and pid == "9b1e4f20":  # nothing else free this week
                return self.send(200, {"proposal": {"id": pid, "status": "declined", "kind": "study", "course": "CSE 576",
                                                    "window": "fri-afternoon", "round": 1},
                                       "counter": None, "moved": False})
            if a == "busy":
                return self.send(200, {"proposal": {"id": pid, "status": "open", "kind": "study", "course": "CSE 576",
                                                    "window": "fri-evening", "time": "19:00", "date": "2026-10-30",
                                                    "round": 2},
                                       "counter": None, "moved": True})
            if a == "yes":
                place = b.get("place_suggest") or ("Zoom" if b.get("place_choice") is not None else None)
                return self.send(200, {"proposal": {"id": pid, "status": "accepted", "kind": "study", "course": "CSE 576",
                                                    "window": "thu-evening", "time": "19:00", "date": "2026-10-29",
                                                    "round": 1, **({"place": place, "remind_at": "2026-10-29T18:00:00"} if place else {})},
                                       "counter": None, "moved": False})
            return self.send(200, {"proposal": {"id": pid, "status": "open", "kind": "study", "course": "CSE 576",
                                                "window": "thu-evening", "time": "19:00", "date": "2026-10-29", "round": 1},
                                   "counter": {"id": "c0ffee00", "window": "fri-evening", "time": "19:00",
                                               "date": "2026-10-30"},
                                   "moved": False})
        if p.endswith("/log"):
            return self.send(200, {"name": "Night Owls", "entries": sample["log"]})
        if p.endswith(("/pause", "/resume")):
            return self.send(200, {"ok": True})
        if p.endswith("/leave"):
            return self.send(200, {"ok": True, "deleted": True})
        self.send(500, {"error": "boom"})

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def do_PUT(self):
        self.handle_any("PUT")


HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
