---
name: orbit
description: Lets your Cubbie coordinate with your friends' Cubbies in a private circle to match study sessions, plan hangouts and check on friends with big days. Unlike a solo study plan, it adds coordination with friends' Cubbies. Use when the student says study with friends, who's free, study buddy, who's in my class, check on my friends, my circle, orbit, join circle code, start a circle, a friend has an exam or a big day, or wants to show up for friends on a busy week.
---

# Orbit

Orbit makes Cubbie multiplayer. Your Cubbie and your friends' Cubbies share a few coarse signals in a private circle, so you can study together and look out for each other on busy weeks. Cubbie only ever texts its own student. Friends are reached by the student sending a text themselves.

## When to use

- "Start an Orbit circle" or "join Orbit circle ABC234"
- "Who can I study with for CSE 576?" or "Is anyone free Thursday evening?"
- "Check on my friends" or "Does anyone have a big week?"
- "Manas has an exam, what should I say to him?"
- "Show me my circle log" or "pause Orbit" or "leave my circle"

Do not use it for a solo study plan (use the study plan Skill), for emailing professors, or to message friends directly. Orbit never sends texts for the student.

## How it talks to the Orbit server

This Skill sends the signals the student agrees to share to the Orbit circle server at orbit-cubbie.vercel.app over HTTPS. Nothing else is sent: never grades, assignment content, messages, or exact calendar times.

What can be shared, each only if the student says yes:
- busy level (light, busy or packed), estimated from deadlines and calendar. It is a workload estimate, never a mood or stress label
- big days (dates with an exam or a lot due), with no reason
- coarse free windows such as thu-evening
- course codes with exam, quiz and deadline dates. Friends only see courses they also take
- topics the student can help with or wants help with
- short wins the student wants to share

## Setup

None. The script uses only Python's standard library. No keys, no sign-in. Run every command from this Skill's folder as `python3 scripts/orbit.py ...`. The script saves its state on the student's side and prints short plain text. Never show the student any token.

## First time

If `python3 scripts/orbit.py status` exits with 2, the student is not in a circle yet.

1. Ask: "Start a new circle or join a friend's? If you have a code, send it."
2. Ask one question: "What name should friends see? Your first name works." Use the answer as the display name.
3. New circle: ask for a circle name (default: "<name>'s circle"), then run `python3 scripts/orbit.py create --name "<circle>" --me "<name>"`. Text the 6 character code on its own line and say: "Send this code to friends so they can join."
4. Joining: run `python3 scripts/orbit.py join --code <CODE> --me "<name>"`.
5. Consent. Ask only yes or no questions, one at a time, each with a default the student can accept with "yes". Never ask the student for days, dates, times, levels, course codes or any other data: Orbit works all of that out itself from the student's connected accounts.
   - "Can I share how busy your week looks (light, busy or packed)? I work it out from your Canvas and calendar. yes?"
   - "Can I share which days are big days, like an exam day? Friends see the date only, never the reason. yes?"
   - "Can I share when you're roughly free, like Thu evening, from your calendar? yes?"
   - "Can I share your course codes and exam dates, only with friends in the same class? yes?"
   - "Can I share topics you've asked me for help with, so a friend in the class can help? no?" (default no)
   - "Can I share small wins, like submitting a big project? yes?"
   Save the answers with `python3 scripts/orbit.py consent --busy yes --big-days yes --free yes --courses yes --help no --wins yes`, using the student's real answers.
6. Connections. If the student said yes to something that needs Google Calendar, Gmail or Canvas and that account is not connected, ask them to connect it (one line, e.g. "Connect Google Calendar in Cubbie so I can see when you're free."). Do not ask them to type the information instead.
7. Offer scheduled check-ins: "Want me to keep your circle updated and check in twice a day? 8:30 am and 6 pm? yes?" Create them only after the student says yes, at the times they pick. Word each check-in so it makes sense days later: "Orbit check-in: follow the Orbit Skill's Sharing steps to refresh my circle signals from my calendar, Gmail and Canvas, then run python3 scripts/orbit.py feed --today <today> and text me at most two nudges".
8. Right away, do a first share (see Sharing) without asking anything more, then a first feed (see Checking the circle). Say one line, like "Done. Your circle can now see what you agreed to share."

## Sharing

Sharing is automatic. Never ask the student questions here and never ask them for the values; read them from the connected accounts. Only include what the student consented to, and skip a field quietly if its account is not connected (mention the missing connection once, not every time). Do these in order.

1. Free windows (from Google Calendar). Read the student's Google Calendar for the next 7 days. A window is free if it has at least 2 free hours inside it: morning is 8 am to 12 pm, afternoon is 12 pm to 5 pm, evening is 5 pm to 10 pm. Turn each free window into a token like mon-morning, thu-evening, sat-afternoon, and join them with commas. Never pass event names or exact times.
2. Courses (from Canvas). Read the student's Canvas for upcoming exams, quizzes and deadlines in the next 14 days, leaving out anything already submitted. Write a courses JSON file to a temp path: a list of courses with a code like "CSE 576" and its events, each with kind (exam, quiz or deadline), a short title and an ISO date. No grades, no assignment content. Pass it as `--courses-file <path>`.
3. Other dates (from Gmail and email events). Search the student's synced email for upcoming exams, interviews or deadlines in the next 7 days that are not already in Canvas. Use them only to count toward the busy level and big days; never share the email or what it is about.
4. Busy level, counting exams, quizzes, deadlines and interviews found above, plus how full the calendar is:
   - packed: 3 or more in the next 3 days, or 6 or more in the next 7 days, or fewer than 3 free windows this week
   - busy: 2 or more in the next 3 days, or 3 or more in the next 7 days
   - light: anything else
5. Big days: dates with an exam or interview, or with 2 or more deadlines. Pass them as `--big-days`.
6. Help topics (only if consented): use topics the student has recently asked Cubbie to explain or help with for one of their courses, as `--want-help "CSE 576:HMMs"`. Add `--can-help` only for topics the student has said they are good at. If there are none, leave them out. Do not ask.
7. Wins (only if consented): a big project, exam or application the student submitted or finished in the last 2 days (from Canvas submissions or email), as a short phrase like `--win "submitted the CSE 576 project"`. If there are none, leave it out. Do not ask.
8. Always pass the student's local date as `--today YYYY-MM-DD`.

Run: `python3 scripts/orbit.py share --today <date> --busy <level> --big-days <dates> --free <tokens> --courses-file <path> ...`

Delete the temp courses file afterwards. During a scheduled check-in, share silently; when the student asked, say one line: "Updated what your circle sees."

## Checking the circle

Run `python3 scripts/orbit.py feed --today <date>`. It prints suggestions and any open proposals waiting on the student.

Pick at most 2 nudges, highest value first: a proposal waiting on the student, then a check-on, then a study match (one with a help match first), then celebrate, then hangout. Skip hangout nudges when the student's own busy level is packed. If nothing is useful, say nothing in a scheduled check-in, and say "All quiet in your circle" if the student asked.

## Proposing

1. Never propose without the student's yes. Show it first: "Ask Manas to study CSE 576 Thu evening?"
2. After yes: `python3 scripts/orbit.py propose --to "<name>" --kind study --course "CSE 576" --window thu-evening`. Use `--kind hangout` for non-study plans. Add `--note` only if the student gave one.
3. Say: "Asked. I will tell you when they answer."
4. When a plan is accepted by everyone (it shows up in the feed), pick the exact time from the student's own calendar, never from the server. Look at the student's Google Calendar in that window and suggest a start time. Ask "7 pm works. Add it to your calendar? yes?" After yes, add the event to the student's Google Calendar and confirm the exact time. Tell the student they can text the friend the exact time themselves. Remember the plan's id once it is on the calendar, and never add the same plan twice (accepted plans stay in the feed for a week).

## Responding

When the feed shows an open proposal for the student, say it in one line: "Manas wants to study CSE 576 Thu evening. Work for you?" Wait for a clear yes or no.

- Yes: `python3 scripts/orbit.py respond --id <id> --answer yes --today <date>`. If it is now accepted, follow step 4 of Proposing.
- No: `python3 scripts/orbit.py respond --id <id> --answer no --today <date>`. If a counter window comes back, offer it: "Fri afternoon works for both of you. Suggest it?" Treat a yes as accepting the counter proposal.

## Check-on and celebrate nudges

Nudges only repeat what a friend posted, like "Manas: big day tomorrow". Never guess how a friend feels and never use words like stressed or struggling.

1. Say the fact in one line and offer: "Manas has a big day tomorrow. Want a short text to send him?"
2. After yes, write one short line in the student's own voice, like "Big day tomorrow, you got this. Study after?" Show it as a draft.
3. The student sends it themselves. Never send it for them, and never contact the friend.

## Circle log link

Run `python3 scripts/orbit.py log-link` and text the link on its own line. It shows every proposal, yes and no in the circle, with no signal contents. It is good to show friends. Treat the link as private to the circle.

## Pause and leave

- Pause: `python3 scripts/orbit.py pause` stops sharing and hides the student's signals. `python3 scripts/orbit.py resume` turns it back on.
- Leave: warn first: "Leaving deletes all your data from the circle server. Sure?" Only after yes, run `python3 scripts/orbit.py leave`. Confirm it is deleted.
- Changing a consent answer: run the consent command again with the new answers, then share again.

## Replies

Keep each reply to a few short lines, plain text, no Markdown. One idea per message, and send several short texts instead of one long one. Ask one question at a time with a default the student can accept with "yes". Put links and circle codes on their own line. Do not show exit codes, JSON, file paths or tokens.

## Failure table

When a command fails, it prints one line on stderr and exits with a code. Reply with one line:

| Exit code | Reply |
| --- | --- |
| 2 | "You are not in a circle yet. Want to start one or join with a code?" |
| 3 | "I could not find that circle code. Can you check it with your friend?" |
| 4 | "I cannot reach Orbit right now. I will try again in a bit." |
| 5 | "Orbit does not recognize this device anymore. Want to rejoin the circle with the code?" |
| 6 | Say what the script's message says needs fixing, in plain words, and ask for it. |
| 7 | "Orbit hit a problem on its end. Try again in a few minutes." |

On exit 4 or 7, retry once, then give the line. Never retry silently more than once.

## Not connected cases

- Google Calendar not connected: ask once, "Connect Google Calendar in Cubbie so I can share when you're free." Until then share without free windows. Do not ask the student to list free times.
- Gmail not connected: skip step 3 of Sharing; Canvas and the calendar are enough.
- Canvas not connected: share without courses and say once "Connect Canvas to unlock study matches." Do not make up or ask for course codes.
- Nothing matches: say "No matches yet. Want to invite more friends with your code?"
