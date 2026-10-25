# Orbit

Your Cubbie and your friends' Cubbies look out for each other.

Orbit is a Cubbie Skill that makes Cubbie multiplayer. Your friends join a private circle, each Cubbie shares a few coarse signals the student agrees to, and the Cubbies help you show up for each other on busy weeks. Built for the Cubbie Hackathon (Track 1: Cubbie Skills, Track 2: Agent-to-Agent Coordination).

## Try it

- Live site: https://orbit-cubbie.vercel.app
- Watch two Cubbies negotiate on the live server: https://orbit-cubbie.vercel.app/demo
- Watch a real circle live: enter its 6-character code on the site (the circle must be made watchable by a member: text Cubbie "make my circle watchable")
- Install on Cubbie: text it https://github.com/Manavpatel06/Orbit/tree/main/orbit

## What it does

1. Study match. Shared course plus overlapping free time.
   "You and Manas both have CSE 576, quiz Friday. Study Tue evening, or Thu if that's taken?"
2. Agents negotiate the time. Your Cubbie proposes ranked times. Your friend's Cubbie checks its own student's calendar first and, if the time is busy, moves the plan to the next time that works for both, without bothering anyone.
3. One question, at the right moment. Each student is asked once, only for a time their calendar already shows free.
   "Manav wants to study CSE 576 Thu 7 PM. You're free then. Lock it in? yes?"
4. Locked in, once. Both Cubbies get the same date and time and add it to their student's Google Calendar exactly once.
5. Check-on nudges. A friend posted a big day, so Cubbie offers a short text for you to send yourself.
   "Reya has a big day tomorrow. Want a short text to send her?"
6. Circle board. A view-only page (safe to share) showing plans and every agent step and student decision.
7. Group plans. Propose to several friends; every Cubbie checks its own student's calendar, and the plan locks when everyone agrees (non-responders are dropped after 24 h if the others said yes).

8. Why this time. Every plan carries its reasons ("before CSE 576 quiz Fri", "free for both", "Tue evening busy for Manas", "matches preferred evenings").
9. Preferences and places. Agents rank times by who prefers mornings or evenings and which days to avoid, and agree on a place the same way as the time.
10. Auto-reschedule. If a calendar changes after a plan is locked, that Cubbie notices, the relay finds the next common time, and the others confirm once (max 2 reschedules).
11. Reminders and cheers. "Lock it in and remind you an hour before?" A check-on text you send counts as a cheer on the board (count only, never the message).
12. Live circle board. Watchable circles stream every agent step live at /circle?c=CODE (names, plans, reasons and the agent log; never free times or courses).
13. Music. Only if you say yes: send a Spotify link and Cubbie shares what you're playing with your circle for 30 min. When a friend is playing an artist you like and you're both free, Cubbie asks "Jam session?". Study and jam plans can carry a public Spotify playlist. Your tastes are never shown to friends.

## Install

1. Text Cubbie this link:
   https://github.com/Manavpatel06/Orbit
2. Reply yes when Cubbie asks to install it.
3. Say "start an Orbit circle", or "join Orbit circle ABC234" with a friend's code.

## Privacy

- Every field is opt-in, one question at a time.
- Busy level (light, busy, packed) is estimated from deadlines and calendar. It is never a stress or mood label.
- Nudges repeat only what a friend posted. Orbit never guesses feelings.
- Free time is shared only as coarse windows like thu-evening. Each agent checks the exact time against its own student's calendar privately.
- Friends see only the courses you both take.
- No grades, assignment content or messages are ever shared.
- Cubbie never texts your friends. You send the texts.
- Pause stops sharing. Leaving deletes your data from the server.

## How the agents coordinate (Track 2)

Each student's Cubbie is that student's agent. The agents never message each other's students; they talk through the circle relay and only ever ask their own student.

What each agent shares (only with consent, refreshed automatically from Calendar, Canvas and Gmail):
- busy level (light / busy / packed) and big-day dates, never the reason
- coarse free windows like thu-evening, never event names or exact times
- course codes with exam and deadline dates, visible only to friends in the same course
- optional help topics and small wins

How a plan gets made:

```
Manav's Cubbie                     Orbit relay                      Manas's Cubbie
  finds shared course + common  ->  proposal: [tue-evening,      ->  inbox (quick check)
  windows, ranks them, asks Manav    thu-evening], time 7:00 PM      checks Manas's calendar
  once: "Ask Manas? yes"                                              tue busy -> answer "busy"
                                   moves SAME proposal to         <-  + current free windows
                                   thu-evening (round 2), logs it
                                                                  ->  Manas is free Thu 7 PM
                                                                      asks Manas once: "Lock it in?"
  "Locked in: Thu Oct 29, 7 PM" <- accepted: date + time fixed    <-  "yes"
  adds to calendar once                                               adds to calendar once
```

Conflicting constraints:
- Ranked windows: the proposer sends up to 5 times, best first (before the shared exam, sooner first).
- Agent-level "busy": a receiving agent that sees a calendar conflict answers for its student and passes its current free windows; the relay moves the proposal to the next time free for everyone, skipping every time already turned down. Up to 4 rounds, then "no shared time this week".
- Student "no": creates a counter proposal at the next common window.
- Group plans: every invitee must say yes; responses are recorded atomically.
- One canonical time per plan (morning 10:00, afternoon 2:00 PM, evening 7:00 PM unless the proposer's calendar picks another), so both calendars match.

When students are asked to confirm: before a proposal is sent, before accepting a time (only when their own calendar is free), and before anything is added to their calendar. Cubbie never texts friends; students send their own texts.

No noise: a quick check every 30 minutes (optional) stays silent unless something needs the student, the same nudge is never repeated, and suggestions stop once a plan exists.

## How it works

A Skill Cubbie follows, plus a small relay that stores shared signals and runs the negotiation.

```
Your Cubbie  --Skill + orbit.py-->  Relay (Vercel + MongoDB)  <--  Friend's Cubbie
     |                                       |                          |
 Canvas + Calendar + Gmail            circle log page          Canvas + Calendar + Gmail
     |                                                                  |
 you send the texts                                           friend sends the texts
```

## Roadmap

- Automatic now-playing: connect a Spotify account so Cubbie can see what you're playing without you sending a link.

## Repo layout

```
README.md
orbit/            the Cubbie Skill
  SKILL.md        what Cubbie follows
  scripts/orbit.py  stdlib-only client
  assets/sample_feed.json
relay/            Vercel project: API, negotiation logic, site (landing, /demo, /circle live board)
tests/            relay tests (in-memory MongoDB) and client tests (stub server)
```

## Run the tests

```bash
cd relay && npm ci && cd ../tests/relay && npm ci && npm test   # 344 relay checks on an in-memory MongoDB
bash tests/client/run.sh                                        # 164 client checks against a local stub server
```

## Self-hosting the relay

1. Create a MongoDB Atlas cluster and copy its connection string.
2. Import the repo in Vercel with root directory `relay`.
3. Set the environment variable `MONGODB_URI` to the connection string and deploy.
4. Point the Skill at your relay by setting `ORBIT_SERVER` to your Vercel URL.

## Team

Manav Patel, Manas, Mansi, Reya. DevHacks at ASU, Cubbie Hackathon.
