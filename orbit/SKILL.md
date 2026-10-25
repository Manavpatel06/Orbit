---
name: orbit
description: Lets your Cubbie coordinate with your friends' Cubbies in a private circle to match study sessions, plan hangouts and check on friends with big days. Unlike a solo study plan, it adds coordination with friends' Cubbies. Use when the student says study with friends, who's free, study buddy, who's in my class, check on my friends, my circle, orbit, join circle code, start a circle, a friend has an exam or a big day, make my circle watchable, or wants to show up for friends on a busy week.
---

# Orbit

Orbit makes Cubbie multiplayer. Your Cubbie and your friends' Cubbies share a few coarse signals in a private circle, so you can study together and look out for each other on busy weeks. Cubbie only ever texts its own student. Friends are reached by the student sending a text themselves.

## When to use

- "Start an Orbit circle" or "join Orbit circle ABC234"
- "Who can I study with for CSE 576?" or "Is anyone free Thursday evening?"
- "Check on my friends" or "Does anyone have a big week?"
- "Manas has an exam, what should I say to him?"
- "Show me my circle log" or "pause Orbit" or "leave my circle"
- "Make my circle watchable" or "let judges watch my circle by its code"

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
7. Offer scheduled check-ins, one yes/no each:
   - "Want me to refresh your circle twice a day, 8:30 am and 6 pm? yes?"
   - "Want a quick check every 30 minutes from 9 am to 11 pm? It only texts you when a friend needs you. yes?"
   Create each one only after the student says yes, using the wording in Scheduled check-ins.
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
8. Preferences (only if the student agreed to share free windows, and only when the calendar shows a clear pattern): the parts of the day they usually keep free, like evening, as `--prefers evening`, and weekdays they usually keep clear of plans, like Friday, as `--avoid-days fri`. These help Orbit pick better times and are never shown to friends. Work them out from the last few weeks of the calendar. Do not ask.
9. Always pass the student's local date as `--today YYYY-MM-DD`.

Run: `python3 scripts/orbit.py share --today <date> --busy <level> --big-days <dates> --free <tokens> --prefers <parts> --avoid-days <days> --courses-file <path> ...`

Delete the temp courses file afterwards. During a scheduled check-in, share silently; when the student asked, say one line: "Updated what your circle sees."

## Checking the circle

Run `python3 scripts/orbit.py feed --today <date>`. It prints suggestions and any open proposals waiting on the student.

Pick at most 2 nudges, highest value first: a proposal waiting on the student, then a check-on, then a study match (one with a help match first), then celebrate, then hangout. Skip hangout nudges when the student's own busy level is packed. If nothing is useful, say nothing in a scheduled check-in, and say "All quiet in your circle" if the student asked.

In a scheduled check-in, run `feed --new-only` instead. It prints only what has not been shown before, and nothing at all when there is nothing new.

## Proposing

1. Get ranked times from Orbit, with no question to the student: `python3 scripts/orbit.py suggest --with "<name>" --course "CSE 576" --today <date>` (leave out `--course` for a hangout, repeat names with commas for a group). It prints up to 5 windows, best first, each with the reason, for example "1. Thu evening · Thu Oct 29 · 7:00 PM - before your quiz Fri; free for Manav and Manas". It already counts everyone's free windows, preferences and the shared exam date. If it prints "No shared time this week yet.", tell the student that and stop. If the friend already has an open proposal for this course, skip it and say nothing.
2. Choose up to 3 places yourself, never ask for them: a place from the student's past study events on the calendar, their campus library, or Zoom as the backup. For a hangout, a cafe near campus.
3. Never propose without the student's yes. Ask one question with a default that names the time, the place and the reminder: "Ask Manas to study CSE 576 Tue 7 PM at Hayden Library? If it locks I'll add it to your calendar and remind you an hour before. I'll try Thu if Tue is taken. yes?" Remember whether they said yes to the reminder.
4. After yes: `python3 scripts/orbit.py propose --to "<name>" --kind study --course "CSE 576" --windows tue-evening,thu-evening --places "Hayden Library 2nd floor|Zoom" --today <date>`. Use the window tokens from `suggest` (run it with `--json` to read them), best first. Use `--kind hangout` for non-study plans, without `--course`. Leave out `--time` (the server picks the time) unless the student gave one. Add `--note` only if the student gave one.
5. Say: "Asked. I will tell you when they answer." Never text the friend.

## Group plans

For "find a time for all of us", propose to several friends at once with repeated `--to`: `python3 scripts/orbit.py propose --to "Manas" --to "Reya" --kind study --course "CSE 576" --windows tue-evening,thu-evening --today <date>`. Take the windows from `suggest --with "Manas,Reya"`, which only lists times everyone has free, and ask the student the same one yes/no question first, naming everyone.

- Each friend's Cubbie checks its own student's calendar and answers on its own. A busy answer moves the plan to the next time that works for everyone.
- The plan locks when all of them say yes.
- If someone has not answered after 24 hours and at least one friend said yes, the plan is set for the rest. If nobody said yes it expires. Tell the student in one line when either happens.

## Answering requests

A line "Needs you: ... (id X)" from `inbox` or `feed` is a request from a friend. It shows the day, time, place options and the top reason, for example "Needs you: Manav wants to study CSE 576 · Thu Oct 29 · 7:00 PM · Hayden Library 2nd floor or Zoom (before your quiz Fri) (id X)". Handle it in this order, without asking the student anything you can check yourself.

1. Check the student's own Google Calendar for that day and time (the line shows both; the window is the fallback). Read it the way Sharing step 1 does.
2. Not free: run `python3 scripts/orbit.py respond --id X --answer busy --free <current free windows, comma separated> --today <date>`. Use the free windows from Sharing step 1, or an empty value if there are none. Do not ask the student and do not text anyone. Say nothing to the student unless a new time lands (it then shows up as another "Needs you" line).
3. Free: ask once, yes or no, with the day, time, first place and course from the line: "Manav wants to study CSE 576 Thu 7 PM at Hayden Library 2nd floor. You're free then. Lock it in and remind you an hour before? yes?" A line that says "(rescheduled: ...)" means the friend's calendar changed: ask "Manas's calendar changed. Move Study CSE 576 to Sat 2 PM at Zoom? Lock it in and remind you an hour before? yes?"
   - Yes: `python3 scripts/orbit.py respond --id X --answer yes --place 0 --today <date>`. The number is the place the student agreed to, counting from 0 in the order shown on the line (leave out `--place` if the line has no place). If the student's yes names a different place, use `--place-suggest "<their place>"` instead; do not ask for one. If the reply starts with "Locked in:", handle it under Plans and updates. Otherwise say nothing more.
   - No: `python3 scripts/orbit.py respond --id X --answer no --today <date>`. If the reply includes a counter, say one line: "Passed. Suggested Fri afternoon to Manas instead." Ask nothing else.

## Plans and updates

Lines from `inbox` and `feed` that start with "Locked in:" or "Update:" are plan news. Handle them like this.

- "Locked in: ... (id X)": add the plan to the student's Google Calendar once, using the date, time and place on the line, then run `python3 scripts/orbit.py mark-added --id X`. Text one line, such as "Locked in: Study CSE 576 with Manas, Thu 7 PM at Hayden Library." Leave out the friend's name if the line does not give it. After a yes that returned "Locked in:", use the id you answered.
- Reminder: the line ends with "remind 6:00 PM" before the id. Set ONE Cubbie reminder at that time ("Study CSE 576 with Manas at Hayden Library in 1 hour"), but only if the student said yes to the reminder when they locked or proposed it. If you do not know, skip the reminder and do not ask again.
- "(id X, move the old calendar entry)": this plan was on the calendar at an earlier time. Move that calendar event and its reminder to the new time instead of adding a second one, run `mark-added --id X`, and text one line: "Moved: Study CSE 576 with Manas is now Sat 2 PM."
- If the line says "(id X, already on your calendar)", do not add it again and do not text it again.
- "Update: ... moved your plan ..." or "Countered: ...": if the student proposed the plan and nothing is needed from them, text one line such as "Manas's Cubbie moved your study time to Thu evening. Nothing needed from you." Otherwise say nothing. A new time that needs an answer arrives as a "Needs you" line.
- "No shared time for ... this week.": if the student proposed the plan, text one line saying so.
- Nudge lines (check-on, celebrate) follow Check-on and celebrate nudges below.

## Scheduled check-ins

Each check-in runs later on its own, so it names this Skill and what to run.

- Two daily refreshes (if the student said yes in First time): "Orbit check-in: follow the Orbit Skill's Sharing steps to refresh my circle signals from my calendar, Gmail and Canvas, then from the Orbit Skill folder run python3 scripts/orbit.py feed --new-only --today <today>. Text me at most two nudges, only what it prints. If it prints nothing, stay silent."
- Quick check (if the student said yes): "Orbit quick check, every 30 minutes from 9 am to 11 pm: from the Orbit Skill folder run python3 scripts/orbit.py inbox --today <today>. If it prints nothing, stay silent. For each line, follow the Orbit Skill's Answering requests and Plans and updates sections. Then follow the Orbit Skill's Locked plans that break section for the next 3 days. Text me only for a line that needs my yes or no, a Locked in line, or an update that needs nothing from me."

## Locked plans that break

In every quick check, after the inbox, re-check the locked plans against the calendar. Never ask the student anything here.

1. Run `python3 scripts/orbit.py plans --today <date>`. It prints nothing when no plan is locked in the next 3 days. Each line looks like "Locked: Study CSE 576 · Thu Oct 29 · 7:00 PM · Hayden Library (id X)".
2. For each plan, read the student's Google Calendar at that date and time. Ignore the event you added for this plan. If something else now takes that time, the plan no longer works.
3. Then run silently: `python3 scripts/orbit.py conflict --id X --free <current free windows, comma separated> --today <date>`. Use the free windows from Sharing step 1. Orbit finds the next time that works for everyone, and the friends' Cubbies are asked to confirm it. Say nothing to the student yet.
4. If it prints "Rescheduled: ...", do nothing more now. When the new time is confirmed, a "Locked in: ... (id X, move the old calendar entry)" line arrives and Plans and updates tells you what to do; then send the one line to the student. If it prints "No other shared time found", "already moved twice" or "not locked in yet", stay silent too.

## Check-on and celebrate nudges

Nudges only repeat what a friend posted, like "Manas: big day tomorrow". Never guess how a friend feels and never use words like stressed or struggling.

1. Say the fact in one line and offer: "Manas has a big day tomorrow. Want a short text to send him?"
2. After yes, write one short line in the student's own voice, like "Big day tomorrow, you got this. Study after?" Show it as a draft.
3. The student sends it themselves. Never send it for them, and never contact the friend.
4. Optional, only after the student says they sent it: run `python3 scripts/orbit.py cheered --friend "<name>"`. It adds "Manav checked on Reya" to the circle log. It never records what the message said.

## Make my circle watchable

When the student asks to let judges or friends watch the circle live, or you are setting up a demo:

1. Ask one question: "Want your circle watchable by its code? Anyone with the code can watch names, plans and what the Cubbies did, but never free times or courses. yes?"
2. After yes run `python3 scripts/orbit.py public on`. It prints the code and a watch link. Text the code on its own line, then the link on its own line.
3. To turn it off, after the student asks run `python3 scripts/orbit.py public off`.

## Circle log link

Run `python3 scripts/orbit.py log-link` and text the link on its own line. It is a view-only page of the circle: who is in it, the plans, and what each Cubbie did, with no free times, courses or other signal contents. It cannot be used to share, propose or answer, so it is safe to send to judges and friends.

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

On exit 4 or 7, retry once, then give the line. Never retry silently more than once. In a scheduled check-in, a failure with exit 4 or 7 is not texted: try again at the next check.

## Not connected cases

- Google Calendar not connected: ask once, "Connect Google Calendar in Cubbie so I can share when you're free." Until then share without free windows. Do not ask the student to list free times. Answering requests needs the calendar: when it is not connected, ask the student once, yes or no, "Is the time on that line free for you? yes?"
- Gmail not connected: skip step 3 of Sharing; Canvas and the calendar are enough.
- Canvas not connected: share without courses and say once "Connect Canvas to unlock study matches." Do not make up or ask for course codes.
- Nothing matches: say "No matches yet. Want to invite more friends with your code?"
