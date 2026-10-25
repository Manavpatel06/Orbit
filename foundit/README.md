# FoundIt

Describe a photo however you remember it. Cubbie finds every match in your gallery.

FoundIt is a Cubbie Skill. You text what you remember, vague or exact, with or without a date:

- "a purple flower pic with a man behind it"
- "I took a picture last Wednesday of a motor circuit"
- "the whiteboard about pipelining hazards"

Cubbie searches your gallery and sends back every photo that matches.

## How it works

1. Asks first. One yes/no before Cubbie looks at any photo, then which service your photos are in (Google Photos or iCloud Photos). That answer is the only thing remembered.
2. Plans the search. `scripts/foundit.py` turns your words into search words, the kind of photo, the course and, if you gave one, the exact date range ("last Wednesday" becomes Wed Oct 21). Language models often get relative dates wrong, so this step is a script.
3. Searches and looks. Cubbie searches the gallery in its browser (Google Photos search finds things, colors and text in photos), then looks at the results and keeps every photo that fits the whole description, including what a search box can't take, like "a man behind it".
4. Sends them back. All matches, newest first, 10 at a time. Circuits and diagrams always come back as the photo itself. For notes and whiteboards, if a photo can't be sent, Cubbie texts what's written on it.

If nothing matches, Cubbie widens the dates, drops search words, then asks for one more detail.

## Privacy

- Nothing is stored. No photos, no copies, no index, nothing about what is on them. A photo is downloaded only to a temporary file to attach it, and deleted right after.
- The script is stateless: no files, no network, standard library only.
- People are matched only by what you described. Cubbie never tries to work out who someone is.
- Nothing changes in your library: no albums, edits or share links without your yes.

## Install

Text Cubbie the link to this folder: https://github.com/Manavpatel06/Orbit/tree/reya/foundit

## Files

```
foundit/
  SKILL.md                    what Cubbie follows
  scripts/foundit.py          the search planner (Python 3.8+, standard library)
  assets/sample_request.json  example for plan --sample
tests/foundit/test_foundit.py
```

## Try it and test it

```bash
python3 foundit/scripts/foundit.py plan --said "a purple flower pic with a man behind it" --today 2026-10-25
python3 foundit/scripts/foundit.py plan --sample --json
python3 -m unittest discover -s tests/foundit
```
