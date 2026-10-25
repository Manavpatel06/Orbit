---
name: foundit
description: Finds the notes a student photographed and lost in their gallery (lecture notes, whiteboards, slides, handouts, circuits, diagrams) and brings them back. Sends the photo, or reads out what was written when a photo cannot be sent, and always shows circuits and diagrams as the photo. Use when the student says find my notes, I took a picture of the board, where is that photo of my notes, what did the whiteboard say, find the circuit I photographed, my notes from Tuesday's lecture, or asks for anything they remember photographing for a class.
---

# FoundIt

Students photograph the board, a friend's notes or a circuit in lab, and the photo disappears under hundreds of others in the gallery. With the student's yes, Cubbie looks through the gallery, keeps a private index of only the photos that are notes, and finds the right one when the student asks in their own words.

Everything stays on the student's side. The index is never sent to friends or to any server.

## When to use

- "I took a picture last Wednesday of a motor circuit"
- "I took notes on forwarding in 340, where are they?"
- "Find my CSE 340 notes from Tuesday"
- "I took a pic of the board about the Viterbi algorithm, can you find it?"
- "Where's that circuit I photographed in EEE 202 lab?"
- "What did the whiteboard say about HMMs?"
- "Show me the diagram from last week's lecture"
- "Stop looking at my photos" or "forget my notes"

The student describes the photo they took (when, what was on it, which class), not a lost object. FoundIt finds photos, it is not a lost-and-found for things.

Do not use it for photos that are not study material (selfies, food, memes), or to send a note to a friend for the student.

## Setup

None. The script uses only Python's standard library. No keys, no sign-in. Run every command from this Skill's folder as `python3 scripts/foundit.py ...`. It prints short plain text.

## First time: ask for gallery access

If `python3 scripts/foundit.py status` exits with 2, Cubbie does not have gallery access yet.

1. Ask one question, yes or no: "Your notes get lost in your camera roll. Can I look through your photos and keep a private list of the ones that are notes, boards or circuits? I skip everything else and nothing leaves Cubbie. yes?"
2. No: say "Okay, I won't look at your photos." and stop. Do not ask again unless the student brings it up.
3. Yes: run `python3 scripts/foundit.py consent --gallery yes`.
4. If the photos are not connected yet, ask the student to connect them, one line: "Connect your photos (Google Photos or iCloud Photos) in Cubbie so I can look for your notes." Do not ask them to send photos one by one instead. If they send a photo in chat anyway, index it as in Reading the gallery.
5. Right away, do a first read of the gallery (see Reading the gallery), newest first, without asking anything more. Then say one line, like "Done. I found 14 photos of notes. Ask me for any of them."
6. Offer once: "Want me to check new photos for notes every night at 11 pm? yes?" Create it only after yes, with the wording in Scheduled check-in.

## Reading the gallery

Look at the photos in small batches and save only the ones that are study material. Never ask the student anything here.

1. List the photos Cubbie has not looked at yet:
   - Photos synced to a folder: `python3 scripts/foundit.py scan --dir "<photos folder>"`.
   - Photos from a photos connector: write one photo link per line to a temp file and run `python3 scripts/foundit.py scan --refs-file <path>`.
   Add `--since <YYYY-MM-DD>` for the first read to start with the last 90 days. It prints up to 25 photos, newest first, and says how many are left. It already leaves out every photo looked at before.
2. Look at each printed photo.
   - Not study material (people, food, screenshots of chats, memes, scenery): run `python3 scripts/foundit.py skip --ref "<photo>"` (repeat `--ref` for a batch). Save nothing about what it shows.
   - Study material: work out
     - kind: notes, whiteboard, slide, handout, board, page, formula, code, or, when the drawing is the point, circuit, schematic, diagram, graph, chart, map or drawing. A circuit, breadboard or wiring photo is always circuit or schematic, even when it has labels.
     - course: the course code if it is written on the photo or clear from the topic and the student's Canvas courses. Leave it out if unsure, never guess.
     - title: a short name like "Viterbi algorithm" or "RC low-pass filter".
     - text: everything that is written, transcribed as it is, line by line, including equations. Write it to a temp file. Mark words you cannot read as [unclear]. Never invent text.
     - summary: one line on what it shows. Required for circuits and diagrams, e.g. "RC low-pass filter, 1k resistor and 10uF capacitor, output across the capacitor".
     - tags: up to 15 topic words a student might ask with, comma separated.
   - Run `python3 scripts/foundit.py add --ref "<photo>" --kind <kind> --course "<code>" --title "<title>" --summary "<line>" --tags "<a,b>" --text-file <path>`. Leave out what you do not know. Delete the temp file afterwards.
3. Run scan again until it prints "No new photos to look at."

## Finding a note

1. Understand what the student is describing. Pass their words, or a short query with the course, the topic words, the kind and the day they gave. "I took a picture last Wednesday of a motor circuit" becomes `python3 scripts/foundit.py find last wednesday motor circuit --today <date>`; "find my notes from Tuesday's 340 lecture on pipelining" becomes `python3 scripts/foundit.py find CSE 340 pipelining tuesday --today <date>`. Day words it understands: today, yesterday, a weekday, last <weekday>, this week, last week, last month. Pass `--kind circuit` (or another kind) when the student asked for one, and always pass the student's local date as `--today`.
2. If it starts with "Nothing from that day. Closest from other days:", the student remembered the day wrong; say so in the reply ("Found it, it was from Oct 14, not Wednesday."). It prints up to 3 matches, best first, like "1. CSE 340 Pipelining hazards · Oct 20 · whiteboard (id 7) - send the photo, or read the text if you cannot send photos".
3. No match: first read the photos added since the last read (Reading the gallery), then run find once more. Still nothing: say "I couldn't find that in your photos. Do you remember roughly when you took it?" and use the answer as a date word in one more find.
4. One clear match: deliver it (see Showing a note) without asking. Two close matches: ask one question naming both, "The Oct 20 whiteboard or the Oct 22 slides? first?"

## Showing a note

Run `python3 scripts/foundit.py get --id X`. It prints the photo, how to show it, the one-line summary and the text.

- Circuits, schematics, diagrams, graphs and other drawings ("Show: send this photo. It is a circuit..."): always send the photo itself. Words do not replace a circuit. If Cubbie cannot attach photos here, send the photo link on its own line and the one-line summary: "Here's your EEE 202 circuit: RC low-pass filter, 1k and 10uF." Never send only a transcription for a drawing.
- Notes, whiteboards, slides and other writing: send the photo. If Cubbie cannot attach photos, or the photo is no longer in the gallery, text what was written instead, from the Text part: start with one line naming it ("Your CSE 340 whiteboard from Oct 20 said:"), then the text in short messages. If it is long, send the part that answers the question first and offer the rest: "Want the rest? yes?"
- If the student asked a question about the note ("what did the board say about hazards?"), answer from the text in one or two lines and offer the photo.
- Never edit, crop or share the photo with anyone but the student.

## Scheduled check-in

If the student said yes: "FoundIt nightly check, 11 pm: from the FoundIt Skill folder, follow the Skill's Reading the gallery steps for photos taken since yesterday. Stay silent. Text me only if I asked for a note earlier today that you could not find and it has now turned up."

## Forgetting

- "Forget that note": `python3 scripts/foundit.py forget --id X`. It is not read again.
- "Forget all my notes": warn first, "This deletes your whole notes list. Your photos stay in your gallery. Sure?" After yes, `python3 scripts/foundit.py forget --all`.
- "Stop looking at my photos": `python3 scripts/foundit.py consent --gallery no`. It deletes everything saved. Also remove the nightly check-in. Say "Done. I won't look at your photos and your notes list is deleted."

## Privacy

- Only photos of study material are saved, with the text and a one-line summary. Every other photo is kept only as an unreadable key, so it is never looked at twice.
- Never describe, save or mention people, faces or anything personal in a photo, even in a note photo.
- The notes list is never shared with friends or any server.

## Replies

Keep each reply to a few short lines, plain text, no Markdown. Put links on their own line. Do not show ids, exit codes, JSON, file paths or commands.

## Failure table

When a command fails, it prints one line on stderr and exits with a code. Reply with one line:

| Exit code | Reply |
| --- | --- |
| 2 | "Can I look through your photos for your notes? yes?" then follow First time. |
| 3 | "I couldn't find that note anymore. Want me to look through your photos again?" |
| 6 | Fix the command from the script's message yourself; ask the student only if it needs something only they know. |
