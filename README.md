# Orbit

Your Cubbie and your friends' Cubbies look out for each other.

Orbit is a Cubbie Skill that makes Cubbie multiplayer. Your friends join a private circle, each Cubbie shares a few coarse signals the student agrees to, and the Cubbies help you show up for each other on busy weeks. Built for Track 1 of the Cubbie Hackathon.

## What it does

1. Study match. Shared course plus overlapping free time.
   "CSE 576 exam Friday and Manas is free Thu evening. Study together?"
2. Plans both sides agree on. One Cubbie proposes, the other asks its student, both say yes, and each Cubbie adds it to its own student's Google Calendar.
   "Manas said yes. 7 pm Thu, added to your calendar."
3. Conflicts. If someone says no, Orbit suggests the next best common window.
   "Mansi can't do Thu. Fri afternoon works for both. Suggest it?"
4. Check-on nudges. A friend posted a big day, so Cubbie drafts a short text for you to send yourself.
   "Reya has a big day tomorrow. Draft: 'Big day tomorrow, you got this.'"
5. Circle log. A page showing every proposal, yes and no in the circle.

## Install

1. Text Cubbie this link:
   https://github.com/Manavpatel06/Orbit
2. Reply yes when Cubbie asks to install it.
3. Say "start an Orbit circle", or "join Orbit circle ABC234" with a friend's code.

## Privacy

- Every field is opt-in, one question at a time.
- Busy level (light, busy, packed) is estimated from deadlines and calendar. It is never a stress or mood label.
- Nudges repeat only what a friend posted. Orbit never guesses feelings.
- Free time is shared only as coarse windows like thu-evening. The exact time is picked privately from each student's own calendar after both agree.
- Friends see only the courses you both take.
- No grades, assignment content or messages are ever shared.
- Cubbie never texts your friends. You send the texts.
- Pause stops sharing. Leaving deletes your data from the server.

## How it works

A Skill Cubbie follows, plus a tiny relay that stores the shared signals.

```
Your Cubbie  --Skill + orbit.py-->  Relay (Vercel + MongoDB)  <--  Friend's Cubbie
     |                                       |                          |
 Canvas + Calendar                    circle log page            Canvas + Calendar
     |                                                                  |
 you send the texts                                           friend sends the texts
```

## Repo layout

```
README.md
orbit/            the Cubbie Skill
  SKILL.md        what Cubbie follows
  scripts/orbit.py  stdlib-only client
  assets/sample_feed.json
relay/            Vercel project: API routes, logic, circle log page
```

## Self-hosting the relay

1. Create a MongoDB Atlas cluster and copy its connection string.
2. Import the repo in Vercel with root directory `relay`.
3. Set the environment variable `MONGODB_URI` to the connection string and deploy.
4. Point the Skill at your relay by setting `ORBIT_SERVER` to your Vercel URL.

## Team

Manav Patel, Manas, Mansi, Reya. DevHacks at ASU, Cubbie Hackathon.
