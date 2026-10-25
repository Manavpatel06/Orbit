#!/usr/bin/env bash
# Client tests for orbit.py against the local stub server (stub.py). Run: bash run.sh
set -u
T="$(cd "$(dirname "$0")" && pwd)"
ORB="$T/../../orbit"
PORT=8765
cd "$ORB" || exit 1
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy
export NO_PROXY=127.0.0.1
python3 "$T/stub.py" "$PORT" assets/sample_feed.json & SP=$!
trap 'kill $SP 2>/dev/null' EXIT
sleep 1

PASS=0; FAIL=0
OUTLOG=$(mktemp)
export HOME=$(mktemp -d) ORBIT_SERVER=http://127.0.0.1:$PORT/
STATE=$HOME/.config/orbit/state.json
O=(python3 -I scripts/orbit.py)

# check NAME WANT_RC PATTERN CMD...   PATTERN: ERE that must match output, "SILENT" = empty output, "" = any
check() {
  local name=$1 want=$2 pat=$3; shift 3
  local out rc
  out=$("$@" 2>&1); rc=$?
  printf '%s\n' "$out" >> "$OUTLOG"
  local good=1
  [ "$rc" = "$want" ] || good=0
  if [ "$pat" = SILENT ]; then [ -z "$out" ] || good=0
  elif [ -n "$pat" ]; then printf '%s' "$out" | grep -Eq -- "$pat" || good=0; fi
  if [ $good = 1 ]; then PASS=$((PASS+1)); echo "ok    $name"
  else FAIL=$((FAIL+1)); echo "FAIL  $name (rc=$rc want $want)"; printf '      %s\n' "$out" | head -4; fi
}
# nope NAME PATTERN CMD...  : exit 0 and output must NOT match
nope() {
  local name=$1 pat=$2; shift 2
  local out rc
  out=$("$@" 2>&1); rc=$?
  printf '%s\n' "$out" >> "$OUTLOG"
  if [ $rc = 0 ] && ! printf '%s' "$out" | grep -Eq -- "$pat"; then PASS=$((PASS+1)); echo "ok    $name"
  else FAIL=$((FAIL+1)); echo "FAIL  $name (rc=$rc)"; printf '      %s\n' "$out" | head -4; fi
}
# file NAME PATTERN FILE : file content must match
file() {
  local name=$1 pat=$2 f=$3
  if grep -Eq -- "$pat" "$f" 2>/dev/null; then PASS=$((PASS+1)); echo "ok    $name"
  else FAIL=$((FAIL+1)); echo "FAIL  $name ($f does not match $pat)"; fi
}
LAST=$T/last.json
# pyck NAME FILE EXPR : EXPR is evaluated with s = parsed JSON file
pyck() {
  local name=$1 f=$2 expr=$3
  if python3 -c "import json,sys; s=json.load(open(sys.argv[1])); sys.exit(0 if ($expr) else 1)" "$f" 2>/dev/null
  then PASS=$((PASS+1)); echo "ok    $name"
  else FAIL=$((FAIL+1)); echo "FAIL  $name"; fi
}

echo "== sample mode (no saved state) =="
check "sample inbox lines"        0 "^Needs you: Manas wants to study CSE 576 · Thu Oct 29 · 7:00 PM \(id 3fa2c1d9\)$" "${O[@]}" --sample inbox
check "sample inbox lists update" 0 "^Locked in: Study CSE 576 · Fri Oct 30 · 2:00 PM \(id 9b1e4f20\)$" "${O[@]}" --sample inbox
check "sample inbox nudge"        0 "^Manas has a big day tomorrow.$" "${O[@]}" --sample inbox
check "sample inbox json"         0 '"needs_answer"' "${O[@]}" --sample inbox --json
check "sample feed new-only"      0 "^Waiting on you: Manas wants to study CSE 576" "${O[@]}" --sample feed --new-only
check "sample feed new-only again (nothing saved, shows again)" 0 "Waiting on you" "${O[@]}" --sample feed --new-only
check "sample mark-added saves nothing" 0 "nothing saved" "${O[@]}" --sample mark-added --id 3fa2c1d9
[ -e "$STATE" ] && { FAIL=$((FAIL+1)); echo "FAIL  sample run wrote state"; } || { PASS=$((PASS+1)); echo "ok    sample run wrote no state file"; }

echo "== first use =="
check "create circle"             0 "Created circle Night Owls" "${O[@]}" create --name "Night Owls" --me Manav
[ "$(stat -c %a "$STATE")" = 600 ] && { PASS=$((PASS+1)); echo "ok    state file is mode 600"; } || { FAIL=$((FAIL+1)); echo "FAIL  state mode"; }
check "inbox silent when all lists empty" 0 SILENT "${O[@]}" inbox --today 2000-01-01
check "inbox json prints even when empty" 0 '"updates": \[\]' "${O[@]}" inbox --today 2000-01-01 --json

echo "== inbox =="
check "inbox prints needs/updates/nudges" 0 "Needs you: Manas wants" "${O[@]}" inbox --today 2026-10-24
file  "inbox sent a 24h-or-saved since"  "inbox\?since=[0-9T%3A-]+Z&today=2026-10-24" "$LAST"
pyck "inbox saved last_inbox per circle" "$STATE" "s['last_inbox']['ABC234']=='2026-10-24T12:00:00Z'"
pyck "inbox saved seen key for the request" "$STATE" "any(k.startswith('needs|3fa2c1d9|thu-evening') for k in s['seen'])"
check "second inbox uses saved last_inbox" 0 "" "${O[@]}" inbox --today 2026-10-24
file  "second inbox sent saved since" "inbox\?since=2026-10-24T12%3A00%3A00Z" "$LAST"
nope  "second inbox does not repeat the request" "Needs you" "${O[@]}" inbox --today 2026-10-24

echo "== feed --new-only =="
check "first new-only shows suggestion" 0 "^- Manas has a big day tomorrow.$" "${O[@]}" feed --new-only --today 2026-10-24
check "second new-only is silent"        0 SILENT "${O[@]}" feed --new-only --today 2026-10-24
check "plain feed still shows waiting"   0 "Waiting on you: Manas wants to study CSE 576 · Thu Oct 29 · 7:00 PM \(id 3fa2c1d9\)" "${O[@]}" feed --today 2026-10-24

echo "== mark-added =="
check "mark-added stores id"     0 "Marked 9b1e4f20" "${O[@]}" mark-added --id 9b1e4f20
check "mark-added rejects bad id" 6 "bad --id" "${O[@]}" mark-added --id ZZZ
pyck "calendar_added saved" "$STATE" "'9b1e4f20' in s['calendar_added']"
check "feed marks already-added plan" 0 "Locked in: Study CSE 576 · Fri Oct 30 · 2:00 PM \(id 9b1e4f20, already on your calendar\)" "${O[@]}" feed --today 2026-10-24
check "inbox marks already-added plan" 0 "" "${O[@]}" inbox --today 2026-10-24

echo "== propose =="
check "propose ranked windows"   0 "^Proposed Study CSE 576 to Manas: .* \(id deadbeef\)\. Backups: Thu evening\.$" "${O[@]}" propose --to manas --kind study --course "CSE 576" --windows tue-evening,thu-evening --today 2026-10-24
file  "propose sent windows list" '"windows": \["tue-evening", "thu-evening"\]' "$LAST"
file  "propose sent today"        '"today": "2026-10-24"' "$LAST"
check "propose --window alias"   0 "^Proposed Hangout to Manas" "${O[@]}" propose --to manas --kind hangout --window thu-evening
check "propose bad token"        6 "bad window 'thu-night'" "${O[@]}" propose --to manas --kind study --windows thu-night
check "propose too many windows" 6 "at most 5" "${O[@]}" propose --to manas --kind study --windows mon-morning,tue-morning,wed-morning,thu-morning,fri-morning,sat-morning
check "propose bad time"         6 "bad --time" "${O[@]}" propose --to manas --kind study --windows thu-evening --time 7pm
check "propose unknown friend"   6 "no friend named" "${O[@]}" propose --to nobody --kind study --windows thu-evening
check "propose bad kind"         6 "bad --kind" "${O[@]}" propose --to manas --kind party --windows thu-evening

echo "== respond =="
check "busy needs --free"          6 "busy needs --free" "${O[@]}" respond --id 3fa2c1d9 --answer busy --today 2026-10-24
check "--free only with busy"      6 "only goes with" "${O[@]}" respond --id 3fa2c1d9 --answer yes --free fri-evening --today 2026-10-24
check "respond bad free token"     6 "bad window 'thu-night'" "${O[@]}" respond --id 3fa2c1d9 --answer busy --free thu-night --today 2026-10-24
check "respond bad answer"         6 "bad --answer" "${O[@]}" respond --id 3fa2c1d9 --answer maybe --today 2026-10-24
check "busy moves plan (cached window)" 0 "^Your Cubbie said busy for Thu evening. Moved to Fri evening \(round 2\)\.$" "${O[@]}" respond --id 3fa2c1d9 --answer busy --free "fri-evening,sat-afternoon" --today 2026-10-24
file  "busy sent free_windows"     '"free_windows": \["fri-evening", "sat-afternoon"\]' "$LAST"
check "busy with nothing left"     0 "^Your Cubbie said busy for Fri afternoon. No shared time this week.$" "${O[@]}" respond --id 9b1e4f20 --answer busy --free "" --today 2026-10-24
file  "empty --free sends empty list" '"free_windows": \[\]' "$LAST"
check "yes locks in"               0 "^Locked in: Study CSE 576 · Thu Oct 29 · 7:00 PM$" "${O[@]}" respond --id 3fa2c1d9 --answer yes --today 2026-10-24
check "no shows counter"           0 "Counter proposed: Fri Oct 30 · 7:00 PM \(id c0ffee00\)\." "${O[@]}" respond --id 3fa2c1d9 --answer no --today 2026-10-24
check "respond --json"             0 '"proposal"' "${O[@]}" respond --id 3fa2c1d9 --answer yes --today 2026-10-24 --json


echo "== v4: places, reasons, reminders, reschedule, suggest, public, cheered, plans =="
check "inbox shows places + top reason" 0 "^Needs you: Manas wants to study CSE 576 · Thu Oct 29 · 7:00 PM · Hayden Library 2nd floor or Zoom \(before your quiz Fri\) \(id 4a4a4a4a\)$" "${O[@]}" inbox --today 2001-01-01
pyck  "reschedule marks the old calendar entry stale" "$STATE" "'9b1e4f20' in s.get('calendar_stale', {}) and '9b1e4f20' not in s['calendar_added']"
file  "rescheduled request line" "Needs you: Manas wants to study CSE 576 · Sat Oct 31 · 2:00 PM · Zoom \(rescheduled: Thu evening no longer free for Manas\)" "$OUTLOG"
file  "locked update shows place and reminder" "Locked in: Study CSE 576 · Thu Oct 29 · 7:00 PM · Zoom · remind 6:00 PM \(id 5b5b5b5b\)" "$OUTLOG"
file  "stale entry tagged in the line" "\(id 9b1e4f20, move the old calendar entry\)" "$OUTLOG"
check "mark-added clears stale" 0 "Marked 9b1e4f20" "${O[@]}" mark-added --id 9b1e4f20
pyck  "stale cleared by mark-added" "$STATE" "'9b1e4f20' not in s.get('calendar_stale', {}) and '9b1e4f20' in s['calendar_added']"
check "propose with places" 0 "Places: Hayden Library 2nd floor or Zoom\. Why: before your quiz Fri\.$" "${O[@]}" propose --to manas --kind study --course "CSE 576" --windows thu-evening --places "Hayden Library 2nd floor|Zoom|Hayden Library 2nd floor" --today 2026-10-24
file  "propose sent places (deduped)" '"places": \["Hayden Library 2nd floor", "Zoom"\]' "$LAST"
check "propose too many places" 6 "at most 3 places" "${O[@]}" propose --to manas --kind study --windows thu-evening --places "a|b|c|d"
check "propose place too long"  6 "too long" "${O[@]}" propose --to manas --kind study --windows thu-evening --places "$(printf 'x%.0s' $(seq 1 41))"
check "respond yes with place number" 0 "^Locked in: Study CSE 576 · Thu Oct 29 · 7:00 PM · Zoom · remind 6:00 PM$" "${O[@]}" respond --id 3fa2c1d9 --answer yes --place 1 --today 2026-10-24
file  "respond sent place_choice" '"place_choice": 1' "$LAST"
check "respond yes with suggested place" 0 "Locked in: .* · Kiwi Cafe" "${O[@]}" respond --id 3fa2c1d9 --answer yes --place-suggest "Kiwi Cafe" --today 2026-10-24
file  "respond sent place_suggest" '"place_suggest": "Kiwi Cafe"' "$LAST"
check "place and suggest together" 6 "not both" "${O[@]}" respond --id 3fa2c1d9 --answer yes --place 0 --place-suggest X --today 2026-10-24
check "place only with yes" 6 "only go with --answer yes" "${O[@]}" respond --id 3fa2c1d9 --answer no --place 0 --today 2026-10-24
check "place must be non-negative" 6 "starting at 0" "${O[@]}" respond --id 3fa2c1d9 --answer yes --place -1 --today 2026-10-24
check "conflict reschedules" 0 "^Rescheduled: Study CSE 576 · Sat Oct 31 · 2:00 PM · Zoom\. Waiting for Manas to confirm \(id 3fa2c1d9\)$" "${O[@]}" conflict --id 3fa2c1d9 --free "sat-afternoon" --today 2026-10-24
file  "conflict sent free_windows + today" '"free_windows": \["sat-afternoon"\]' "$LAST"
check "conflict at the limit"   0 "already moved twice" "${O[@]}" conflict --id 9b1e4f20 --free "" --today 2026-10-24
check "conflict with no window" 0 "No other shared time found" "${O[@]}" conflict --id aaaaaaaa --free "" --today 2026-10-24
check "conflict not locked"     0 "not locked in yet" "${O[@]}" conflict --id bbbbbbbb --free "" --today 2026-10-24
check "conflict needs --free"   6 "conflict needs --free" "${O[@]}" conflict --id 3fa2c1d9 --today 2026-10-24
check "conflict bad id"         6 "bad --id" "${O[@]}" conflict --id nope --free ""
check "conflict --json"         0 '"rescheduled": true' "${O[@]}" conflict --id 3fa2c1d9 --free sat-afternoon --today 2026-10-24 --json
check "suggest ranked with reasons" 0 "^1\. Thu evening · Thu Oct 29 · 7:00 PM - before your quiz Fri; free for Manav and Manas; matches preferred evenings for Manav and Manas$" "${O[@]}" suggest --with manas --course "CSE 576" --today 2026-10-24
file  "suggest sent ids, course, today" "suggest-times\?with=b2c3d4e5&today=2026-10-24&course=CSE\+576" "$LAST"
check "suggest second line" 0 "^2\. Sat afternoon · Sat Oct 31 · 2:00 PM - free for Manav and Manas$" "${O[@]}" suggest --with manas --today 2026-10-24
check "suggest nothing shared" 0 "^No shared time this week yet\. No availability yet from: Manasi\.$" "${O[@]}" suggest --with manasi --today 2026-10-24
check "suggest ambiguous name" 6 "ambiguous" "${O[@]}" suggest --with mana --today 2026-10-24
check "suggest --json" 0 '"windows"' "${O[@]}" suggest --with manas --today 2026-10-24 --json
check "public on"  0 "^Watchable by code: on\. Anyone with the code ABC234 can watch names, plans and the agent log, never free times or courses\.$" "${O[@]}" public on
file  "public on sent" '"on": true' "$LAST"
check "public on prints the watch link" 0 "^https://orbit-cubbie.vercel.app/circle\?c=ABC234$" "${O[@]}" public on
check "public off" 0 "^Watchable by code: off" "${O[@]}" public off
file  "public off sent" '"on": false' "$LAST"
check "public needs on|off" 6 "invalid choice" "${O[@]}" public maybe
check "cheered logs" 0 "^Logged: you checked on Manas\.$" "${O[@]}" cheered --friend manas
file  "cheered sent friend_id only" '"b": \{"friend_id": "b2c3d4e5"\}' "$LAST"
check "cheered repeat" 0 "^Already logged that you checked on Manasi\.$" "${O[@]}" cheered --friend manasi
check "cheered unknown friend" 6 "no friend named" "${O[@]}" cheered --friend nobody
check "plans lists locked plans in range" 0 "^Locked: Study CSE 576 · Fri Oct 30 · 2:00 PM \(id 9b1e4f20, already on your calendar\)$" "${O[@]}" plans --today 2026-10-28
check "plans silent when none"  0 SILENT "${O[@]}" plans --today 2026-10-20 --within 1
check "plans --json" 0 '"plans"' "${O[@]}" plans --today 2026-10-28 --json
check "consent for share tests" 0 "Consent saved" "${O[@]}" consent --busy yes --free yes
check "share sends prefers + avoid days under free consent" 0 "Shared: .*prefers.*avoid_days" "${O[@]}" share --today 2026-10-26 --prefers evening,morning --avoid-days fri,sat
file  "share body has prefers" '"prefers": \["evening", "morning"\]' "$LAST"
check "share bad prefers" 6 "bad --prefers" "${O[@]}" share --today 2026-10-26 --prefers night
check "share bad avoid-days" 6 "bad --avoid-days" "${O[@]}" share --today 2026-10-26 --avoid-days funday

echo "== v5: music, now-playing, jam nudges, playlists, vibe =="
check "music off turns the server copy off too" 0 "Consent saved: .*music no" "${O[@]}" consent --music no
file  "music off sends /music on:false" '"on": false' "$LAST"
check "share keeps music out while consent is no" 0 "Withheld \(no consent\): music" "${O[@]}" share --today 2026-10-26 --artists "Arctic Monkeys|Radiohead" --genres "indie rock"
nope  "share never echoes tastes" "Radiohead|Arctic Monkeys" "${O[@]}" share --today 2026-10-26 --artists "Arctic Monkeys|Radiohead"
check "music yes" 0 "Consent saved: .*music yes" "${O[@]}" consent --music yes
check "share sends tastes once consented" 0 "Shared: music" "${O[@]}" share --today 2026-10-26 --artists "Arctic Monkeys|the Strokes|arctic monkeys" --genres "indie rock|lo-fi"
file  "share body has deduped tastes" '"music": \{"artists": \["Arctic Monkeys", "the Strokes"\], "genres": \["indie rock", "lo-fi"\]\}' "$LAST"
check "too many artists" 6 "at most 15 items" "${O[@]}" share --today 2026-10-26 --artists "$(for i in $(seq 1 16); do printf 'band%s|' $i; done)"
check "artist name too long" 6 "too long" "${O[@]}" share --today 2026-10-26 --artists "$(printf 'x%.0s' $(seq 1 41))"
check "playing needs an artist" 6 "needs --artist" "${O[@]}" playing
check "playing shares now" 0 "^Shared with your circle for 30 min 🎧$" "${O[@]}" playing --artist "Arctic Monkeys" --track "Do I Wanna Know?" --url "https://open.spotify.com/track/7abcXYZ?si=abc"
file  "playing sends the track and consent" '"consent": true, "track": "Do I Wanna Know\?"' "$LAST"
file  "playing sends the spotify url" '"url": "https://open.spotify.com/track/7abcXYZ\?si=abc"' "$LAST"
check "playing rejects other sites" 6 "bad --url" "${O[@]}" playing --artist X --url "https://evil.com/open.spotify.com/track/abc"
check "playing rejects http" 6 "bad --url" "${O[@]}" playing --artist X --url "http://open.spotify.com/track/abc"
check "playing rejects user pages" 6 "bad --url" "${O[@]}" playing --artist X --url "https://open.spotify.com/user/abc"
check "playing genre too long" 6 "too long" "${O[@]}" playing --artist X --genre "$(printf 'g%.0s' $(seq 1 25))"
check "playing clear" 0 "^Stopped sharing what you're playing\.$" "${O[@]}" playing --clear
file  "playing clear sends DELETE" '"m": "DELETE"' "$LAST"
check "playing clear goes on its own" 6 "goes on its own" "${O[@]}" playing --clear --artist X
check "music off blocks playing" 0 "Consent saved: .*music no" "${O[@]}" consent --music no
check "playing refused without music consent" 6 "music sharing is off" "${O[@]}" playing --artist "Arctic Monkeys"
check "music yes again" 0 "Consent saved: .*music yes" "${O[@]}" consent --music yes
check "vibe with a friend (jam)" 0 "^Mood: upbeat$" "${O[@]}" vibe --with manas --kind jam
check "vibe lists only what both share" 0 "^Shared genres: indie rock$" "${O[@]}" vibe --with manas --kind jam
check "vibe study defaults to focus" 0 "^Mood: focus$" "${O[@]}" vibe --with manas
check "vibe friend without consent is empty" 0 "^Shared genres: none$" "${O[@]}" vibe --with manasi
check "vibe json" 0 '"mood"' "${O[@]}" vibe --with manas --json
check "vibe bad kind" 6 "bad --kind" "${O[@]}" vibe --with manas --kind party
check "vibe needs --with" 6 "required" "${O[@]}" vibe
check "propose a jam with a playlist" 0 "^Proposed Jam session to Manas: .* \(id deadbeef\)\. Playlist: Indie jam mix\.$" "${O[@]}" propose --to manas --kind jam --windows thu-evening --playlist-url "https://open.spotify.com/playlist/37i9dQZF1DX8" --playlist-name "Indie jam mix" --today 2026-10-24
file  "jam proposal body" '"kind": "jam"' "$LAST"
file  "jam proposal sends the playlist" '"playlist": \{"url": "https://open.spotify.com/playlist/37i9dQZF1DX8", "name": "Indie jam mix"\}' "$LAST"
check "a jam has no course" 6 "no course" "${O[@]}" propose --to manas --kind jam --course "CSE 576" --windows thu-evening
check "playlist must be a Spotify playlist" 6 "bad --playlist-url" "${O[@]}" propose --to manas --kind jam --windows thu-evening --playlist-url "https://open.spotify.com/artist/abc"
check "playlist name needs a url" 6 "needs --playlist-url" "${O[@]}" propose --to manas --kind jam --windows thu-evening --playlist-name "Indie"
check "kind list includes jam" 6 "study, hangout or jam" "${O[@]}" propose --to manas --kind party --windows thu-evening
check "yes can carry a playlist" 0 "Locked in: " "${O[@]}" respond --id 3fa2c1d9 --answer yes --playlist-url "https://open.spotify.com/playlist/37i9dQZF1DX8" --playlist-name "Indie jam mix" --today 2026-10-24
file  "respond sends the playlist" '"playlist": \{"url": "https://open.spotify.com/playlist/37i9dQZF1DX8", "name": "Indie jam mix"\}' "$LAST"
check "playlist only with yes" 6 "only goes with --answer yes" "${O[@]}" respond --id 3fa2c1d9 --answer no --playlist-url "https://open.spotify.com/playlist/37i9dQZF1DX8"
check "feed --now (json, so the last request is the feed)" 0 '"suggestions"' "${O[@]}" feed --now 19:00 --today 2026-10-24 --json
file  "feed sends the local time" "feed\?today=2026-10-24&now=19%3A00" "$LAST"
check "bad --now" 6 "bad --now" "${O[@]}" feed --now 25:00 --today 2026-10-24
check "inbox --now" 0 "" "${O[@]}" inbox --now 19:00 --today 2026-10-24
file  "inbox sends the local time" "inbox\?since=.*now=19%3A00" "$LAST"
check "sample feed shows the jam nudge" 0 "^- Manas is playing Arctic Monkeys right now, one of your favorites\. You're both free this evening\. Jam session\?$" "${O[@]}" --sample feed
check "sample feed shows a locked jam with its playlist" 0 "^Locked in: Jam session · Tue Oct 27 · 7:00 PM · 🎧 Indie's Top 50 \(id 6a6a6a6a\)$" "${O[@]}" --sample feed
check "sample inbox shows the jam nudge" 0 "Jam session\?" "${O[@]}" --sample inbox
nope  "no taste strings in any output" "Radiohead|the Strokes" cat "$OUTLOG"

echo "== v1 state compatibility =="
V1=$(mktemp -d); mkdir -p "$V1/.config/orbit"
cat > "$V1/.config/orbit/state.json" <<'J'
{"server": "http://127.0.0.1:8765/", "circles": {"ABC234": {"name": "Night Owls", "member_id": "a1b2c3d4", "token": "SECRETTOKEN", "member_name": "Manav"}}, "default": "ABC234", "consent": {"busy": true, "big_days": true, "free": true, "courses": true, "help": false, "wins": true}}
J
V1STATE=$V1/.config/orbit/state.json
cp "$V1STATE" "$V1/before.json"
check "v1 state: status"        0 "Circle: Night Owls" env HOME="$V1" "${O[@]}" status
check "v1 state: sample leaves it untouched" 0 "" env HOME="$V1" "${O[@]}" --sample feed --new-only
cmp -s "$V1STATE" "$V1/before.json" && { PASS=$((PASS+1)); echo "ok    v1 state unchanged by sample"; } || { FAIL=$((FAIL+1)); echo "FAIL  v1 state changed by sample"; }
check "v1 state: inbox works"   0 "" env HOME="$V1" "${O[@]}" inbox --today 2000-01-01
check "v1 state: feed new-only" 0 "Waiting on you" env HOME="$V1" "${O[@]}" feed --new-only --today 2026-10-24
check "v1 state: propose"       0 "Proposed" env HOME="$V1" "${O[@]}" propose --to manas --kind study --windows thu-evening --today 2026-10-24
file  "v1 state keeps circles"  '"ABC234"' "$V1STATE"
pyck "v1 state gained new keys lazily" "$V1STATE" "'proposal_windows' in s and 'ABC234' in s['circles']"

echo "== log-link =="
check "log-link prints the view-only url" 0 "^https://orbit-cubbie.vercel.app/circle\\?c=ABC234&v=[0-9a-f]{24}$" "${O[@]}" log-link
nope  "log-link has no token" "SECRETTOKEN|#k=" "${O[@]}" log-link
check "log-link json" 0 '"url": "https://orbit-cubbie.vercel.app/circle' "${O[@]}" log-link --json
V3=$(mktemp -d); mkdir -p "$V3/.config/orbit"; sed 's/SECRETTOKEN/BAD/' "$V1STATE" > "$V3/.config/orbit/state.json"
check "log-link falls back to old link when server says no" 0 "/\\?c=ABC234#k=BAD$" env HOME="$V3" "${O[@]}" log-link
nope  "members output unchanged (no view url)" "view_url|circle\\?c=" "${O[@]}" members

echo "== errors and secrecy =="
check "unknown circle"         2 "not in circle ZZZZZZ" "${O[@]}" --circle ZZZZZZ feed
check "join unknown code"      3 "No circle with that code" "${O[@]}" join --code ZZZZZZ --me Manav
V2=$(mktemp -d); mkdir -p "$V2/.config/orbit"; sed 's/SECRETTOKEN/BAD/' "$V1STATE" > "$V2/.config/orbit/state.json"
check "server 401 maps to 5"     5 "token invalid" env HOME="$V2" "${O[@]}" feed --today 2026-10-24
nope  "token never printed"    "SECRETTOKEN" "${O[@]}" status
nope  "token not in any output" "SECRETTOKEN" cat "$OUTLOG"

echo
echo "passed $PASS, failed $FAIL"
rm -f "$OUTLOG"
[ "$FAIL" = 0 ]
