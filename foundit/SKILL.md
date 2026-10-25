---
name: foundit
description: Finds photos in the student's gallery from whatever they remember, however vague, and sends back every match. Use when the student says I took a picture of, find that photo, where is the pic of, a purple flower pic with a man behind it, the circuit I photographed in lab, my notes from Tuesday, what did the whiteboard say, or describes any photo they cannot find, with or without a date, even if they do not say "gallery". Never saves photos or what is on them.
---

# FoundIt

Photos sink under thousands of others: the whiteboard from last week, a circuit from lab, a purple flower with someone standing behind it. The student says whatever they remember, and Cubbie searches their gallery and sends back every photo that matches.

A date helps but is never needed. "A purple flower pic with a man behind it" is enough.

FoundIt keeps nothing. Every search starts fresh from the student's words. No photo, no copy of one and nothing about what is on one is saved by this Skill or remembered afterwards.

## When to use

- "Find the purple flower pic with a man behind it"
- "I took a picture last Wednesday of a motor circuit"
- "Where's the photo of my CSE 340 notes?"
- "What did the whiteboard say about hazards?"
- "The sunset at the beach with my dog, it was kinda orange"
- "All my pics of the red car from last weekend"

Do not use it to find a lost object, or to send a photo to anyone but the student.

## Setup

None. The script uses only Python's standard library (3.8 or newer) and needs no keys and no network. Run it from this Skill's folder.

## Gallery access (ask every new student once)

Cubbie cannot see the student's phone by itself, so it asks once where to look and remembers only the answer (which service, and that the student said yes). Never remember anything about the photos.

1. Ask one yes/no question: "Want me to search your photos for it? I only look for what you describe and never save a copy. yes?" If the student says no, ask them to send the photos themselves (see Sources, step 4) and stop.
2. Ask one question with a default: "Are your photos in Google Photos or iCloud Photos? Google Photos?"
3. Remember the service and the yes, so later searches go straight to it.

## Steps

1. Plan the search. Pass the student's message as they wrote it and their local date:

   ```bash
   python3 scripts/foundit.py plan --said "<the student's words>" --today <YYYY-MM-DD>
   ```

   It prints the kind of photo, the course, the topic words, the dates it was taken (or "any date") and the search words, for example:

   ```text
   Kind: any photo
   Course: any
   Topic: purple, flower, man
   Taken: any date (newest first)
   Search words: purple flower man
   ```

   Exit 3 means the message has nothing to search on; ask one question: "What was in it, or when did you take it?" and run plan again with both messages joined.
2. Search the gallery with the search words (see Sources). If the search returns nothing, search again with fewer words, the most distinctive ones first (for "purple flower man", try "purple flower", then "flower"). If the plan has dates, keep only photos from those dates; without dates, start from the newest.
3. Look at every result and keep all the photos that match the whole description, including what the search words leave out, such as where things are ("a man behind it") and colors. Look through at most 200 photos for one request.
4. Dates from the plan and nothing matches: run plan again with `--widen 3`, then `--widen 7`, then `--any-date`. Tell the student when the date was off: "Found it, it was from Oct 14, not Wednesday."
5. Still nothing: "I couldn't find it in your photos. Anything else you remember, like when or where you took it?" Run the steps again with the new detail. After a second miss, ask the student to search their Photos app and send it (Sources, step 4).

## Sources

Use the service the student chose. Do not change anything in their library: no albums, no edits, no sharing links unless the student says yes.

1. Google Photos: open https://photos.google.com in the browser. If it asks to sign in, ask the student to sign in through the secure login page or take over the browser for that step; hand the browser to them for a two-factor code. Type the search words into the Google Photos search, which finds things, colors, places and text in photos. If the plan has dates, keep results from those dates, or browse the library to them.
2. iCloud Photos: open https://www.icloud.com/photos in the browser and sign in the same way. Use its search with the search words if it offers one; otherwise browse the library, by the plan's dates when there are some, newest first.
3. Google Drive, when the student keeps photos there and Google is connected: search the student's Drive for image files with the search words, from the plan's dates when there are some. If Google is not connected, ask once to connect it in Cubbie, or use step 4.
4. The student sends them: if no service works or the student said no, ask: "Can you search 'purple flower' in your Photos app and send me the ones that look right?" Use what they send for this search only.

## Sending them back

Send every photo that matches, as images in the conversation, newest first.

- More than 10 matches: send the 10 best and say how many more there are: "Found 14. Here are the 10 closest. Want the other 4? yes?"
- Matches that only fit part of the description go after the full matches, with one line: "These have the flower but no one behind it."

Check what each found photo shows before sending it:

- Circuits, schematics, diagrams, graphs, maps and drawings: always send the photo. Words never replace a circuit. If a photo cannot be sent as an image, send a link to it on its own line (its page in Google Photos, iCloud or Drive) and one line saying what it shows, such as "H-bridge motor driver, Oct 14".
- Notes, whiteboards, slides, handouts and formulas: send the photo. If it cannot be sent as an image, text what is written on it instead: one line naming it ("Your CSE 340 whiteboard from Oct 20 said:"), then the text exactly as written, in short messages. Mark words you cannot read as [unclear] and never invent any. If it is long, send the part the student asked about first and offer the rest.
- Any other photo that cannot be sent as an image: send its link on its own line with one line saying when it was taken.
- If the student asked a question about a photo ("what did the board say about hazards?"), answer it in one or two lines from what is on the photo, then send the photo.

## Never stored

- To attach a photo, download it to a temporary file only, send it, and delete the file right away. Never keep photos in the Skill's folder or anywhere under HOME.
- Never save to memory what a photo shows or says, file names, links to photos or a list of photos. Remember only the photo service and the student's yes.
- Match people only by what the student described ("a man behind it"). Never try to work out who someone is, and never describe people the student did not ask about.
- Never send a photo or what is on it to anyone but the student.

## Replies

Keep each reply to a few short lines, plain text, no Markdown. Lead with the photos. One idea per message. Put links on their own line. Do not show the plan output, commands, exit codes or file paths.

## When something fails

| Exit code | Meaning | What to do |
| --- | --- | --- |
| 2 | Bad arguments (missing `--said` or `--today`, an impossible date) | Fix the command yourself; ask the student only when a date they gave does not exist |
| 3 | Nothing to search on | Ask "What was in it, or when did you take it?" |

If the photo service will not open or the student cannot sign in, ask them to send the photos (Sources, step 4). Never guess what a photo showed or said.
