# FoundIt

Your notes are in your camera roll somewhere. FoundIt finds them.

FoundIt is a Cubbie Skill. With the student's yes, Cubbie looks through their photo gallery, keeps a private index of only the photos that are study material (lecture notes, whiteboards, slides, handouts, circuits, diagrams), and finds the right one when the student describes it in their own words.

"I took a picture last Wednesday of a motor circuit" -> the H-bridge photo from Oct 14.

## What it does

1. Asks first. One yes/no question before Cubbie looks at any photo. No means it never looks.
2. Reads the gallery. Cubbie looks at new photos in small batches, skips everything that is not study material (kept only as an unreadable key, so it is not looked at twice), and saves the rest with what is written on them, the kind, the course, topic tags and a one-line summary.
3. Understands the ask. Day words (yesterday, last Wednesday, last week), the kind of photo (circuit, whiteboard, slides), course codes and topic words all count. If the student misremembers the day, it falls back to the closest match from other days and says so.
4. Shows it the right way.
   - Notes, boards, slides: sends the photo. If it cannot send the photo, it tells the student what was written on it.
   - Circuits, schematics, diagrams, graphs: always shows the photo, because words do not replace a circuit. Without image sending, it gives the photo link and a one-line summary.
5. Forgets on request. One note, all notes, or gallery access off (deletes everything).

## Privacy

- Nothing leaves the student's side. The index lives in `~/.config/foundit/index.json` (mode 600) and is never sent to any server.
- Only study photos are saved. Nothing about people or faces is ever saved or described.

## Install

Text Cubbie the link to the `foundit/` folder of this repo and reply yes when it asks to install it.

## Repo layout

```
foundit/
  SKILL.md            what Cubbie follows
  scripts/foundit.py  stdlib-only client (Python 3.8+)
  README.md
tests/foundit/run.sh  client checks, no network
```

## Run the tests

```bash
bash tests/foundit/run.sh                 # uses python3
PYTHON=python bash tests/foundit/run.sh   # or pick the interpreter
```
