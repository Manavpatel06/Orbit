#!/usr/bin/env bash
# Client tests for foundit.py (FoundIt Skill). No network. Run: bash run.sh
set -u
T="$(cd "$(dirname "$0")" && pwd)"
cd "$T/../../foundit" || exit 1

PASS=0; FAIL=0
export HOME=$(mktemp -d)
# Windows Python reads the home folder from USERPROFILE and needs a C:/ style path
command -v cygpath >/dev/null && export HOME=$(cygpath -m "$HOME") USERPROFILE=$(cygpath -w "$HOME")
IX=$HOME/.config/foundit/index.json
PY=${PYTHON:-python3}
N=("$PY" -I scripts/foundit.py)
G=$HOME/gallery
mkdir -p "$G/2026/10"
for f in board selfie circuit slide; do printf '%s' "$f" > "$G/2026/10/$f.jpg"; done
printf 'x' > "$G/2026/10/readme.txt"
touch -d 2026-10-20 "$G/2026/10/board.jpg"; touch -d 2026-10-21 "$G/2026/10/selfie.jpg"
touch -d 2026-10-22 "$G/2026/10/circuit.jpg"; touch -d 2026-09-01 "$G/2026/10/slide.jpg"

# check NAME WANT_RC PATTERN CMD...   PATTERN: ERE that must match output, "" = any
check() {
  local name=$1 want=$2 pat=$3; shift 3
  local out rc
  out=$("$@" 2>&1); rc=$?
  local good=1
  [ "$rc" = "$want" ] || good=0
  if [ -n "$pat" ]; then printf '%s' "$out" | grep -Eq -- "$pat" || good=0; fi
  if [ $good = 1 ]; then PASS=$((PASS+1)); echo "ok    $name"
  else FAIL=$((FAIL+1)); echo "FAIL  $name (rc=$rc want $want)"; printf '      %s\n' "$out" | head -4; fi
}
# nope NAME PATTERN CMD...  : exit 0 and output must NOT match
nope() {
  local name=$1 pat=$2; shift 2
  local out rc
  out=$("$@" 2>&1); rc=$?
  if [ $rc = 0 ] && ! printf '%s' "$out" | grep -Eq -- "$pat"; then PASS=$((PASS+1)); echo "ok    $name"
  else FAIL=$((FAIL+1)); echo "FAIL  $name (rc=$rc)"; printf '      %s\n' "$out" | head -4; fi
}
# pyck NAME EXPR : EXPR is evaluated with s = parsed index file
pyck() {
  local name=$1 expr=$2
  if "$PY" -c "import json,sys; s=json.load(open(sys.argv[1], encoding='utf-8')); sys.exit(0 if ($expr) else 1)" "$IX" 2>/dev/null
  then PASS=$((PASS+1)); echo "ok    $name"
  else FAIL=$((FAIL+1)); echo "FAIL  $name"; fi
}

echo "== gallery access =="
check "status without access exits 2"    2 "Gallery access: no" "${N[@]}" status
check "scan without access exits 2"      2 "gallery access not given" "${N[@]}" scan --dir "$G"
check "find without access exits 2"      2 "consent --gallery yes" "${N[@]}" find circuit
check "bad consent value"                6 "use yes or no" "${N[@]}" consent --gallery maybe
check "consent yes"                      0 "Gallery access: yes" "${N[@]}" consent --gallery yes
check "status with access"               0 "Notes saved: 0" "${N[@]}" status

echo "== scan =="
check "scan needs a source"              6 "give --dir" "${N[@]}" scan
check "scan missing folder"              6 "no folder" "${N[@]}" scan --dir "$G/nope"
check "scan lists images newest first"   0 "circuit.jpg  \(Oct 22\)" "${N[@]}" scan --dir "$G"
nope  "scan ignores non-images"          "readme.txt" "${N[@]}" scan --dir "$G"
check "scan --since drops older photos"  0 "" "${N[@]}" scan --dir "$G" --since 2026-10-01
nope  "scan --since leaves out slide"    "slide.jpg" "${N[@]}" scan --dir "$G" --since 2026-10-01
check "scan --limit shows remaining"     0 "3 more after these" "${N[@]}" scan --dir "$G" --limit 1
check "scan json"                        0 '"remaining": 0' "${N[@]}" scan --dir "$G" --json
FIRST=$("${N[@]}" scan --dir "$G" --limit 1 | head -1 | sed 's/  (.*//')
case "$FIRST" in *circuit.jpg) PASS=$((PASS+1)); echo "ok    newest photo first";; *) FAIL=$((FAIL+1)); echo "FAIL  newest photo first ($FIRST)";; esac

echo "== add and skip =="
printf 'Viterbi algorithm\ndelta_t(j) = max_i delta_{t-1}(i) a_ij b_j(o_t)\nbacktrack with psi\n' > "$HOME/board.txt"
check "add a whiteboard"                 0 "Saved: CSE 576 Viterbi algorithm · Oct 20 · whiteboard \(id 1\)" \
  "${N[@]}" add --ref "$G/2026/10/board.jpg" --kind whiteboard --course "cse576" --title "Viterbi algorithm" --tags "hmm,dynamic programming" --text-file "$HOME/board.txt"
check "circuit needs a summary"          6 "needs --summary" "${N[@]}" add --ref "$G/2026/10/circuit.jpg" --kind circuit
check "bad kind"                         6 "bad --kind" "${N[@]}" add --ref "$G/2026/10/circuit.jpg" --kind selfie --text hi
check "add needs some content"           6 "give --text" "${N[@]}" add --ref "$G/2026/10/circuit.jpg" --kind notes
check "add a circuit"                    0 "Saved: EEE 202 RC low-pass filter · Oct 22 · circuit \(id 2\)" \
  "${N[@]}" add --ref "$G/2026/10/circuit.jpg" --kind circuit --course "EEE 202" --title "RC low-pass filter" --summary "1k resistor, 10uF capacitor, output across the capacitor" --tags "lab 4,filter" --text "R1 1k C1 10uF Vout"
check "add a slide with a link ref"      0 "Saved: CSE 340 Pipelining hazards · Oct 23 · slide \(id 3\)" "${N[@]}" add --ref "https://photos.example/p/abc" --kind slide --title "Pipelining hazards" --course "CSE 340" --text "data hazards stall the pipeline; forwarding fixes most" --taken 2026-10-23
check "skip a selfie"                    0 "Skipped 1 photo" "${N[@]}" skip --ref "$G/2026/10/selfie.jpg"
pyck  "skipped photo kept only as a key" "len(s['skipped'])==1 and 'selfie' not in json.dumps(s)"
nope  "scan leaves out read and skipped" "board|circuit|selfie" "${N[@]}" scan --dir "$G"
check "scan still shows the unread one"  0 "slide.jpg" "${N[@]}" scan --dir "$G"
check "re-add updates, same id"          0 "Updated: .*\(id 1\)" \
  "${N[@]}" add --ref "$G/2026/10/board.jpg" --kind whiteboard --course "CSE 576" --title "Viterbi algorithm" --tags "hmm,viterbi,dynamic programming" --text-file "$HOME/board.txt"
pyck  "update kept three notes"          "len(s['notes'])==3 and s['next_id']==4"
printf 'motor' > "$G/2026/10/motor.jpg"
check "add a motor circuit"              0 "Saved: EEE 202 H-bridge motor driver · Oct 14 · circuit \(id 4\)"   "${N[@]}" add --ref "$G/2026/10/motor.jpg" --kind circuit --course "EEE 202" --title "H-bridge motor driver" --summary "four MOSFETs around a DC motor, 9V supply" --tags "motor,dc motor,h-bridge" --taken 2026-10-14

echo "== find =="
check "find by topic"                    0 "^1\. CSE 576 Viterbi algorithm .*\(id 1\) - send the photo, or read the text" "${N[@]}" find the viterbi notes --today 2026-10-25
check "find by text word"                0 "^1\. CSE 576 Viterbi" "${N[@]}" find backtrack --today 2026-10-25
check "find a circuit by kind word"      0 "^1\. EEE 202 RC low-pass filter .*show the photo \(it is a circuit" "${N[@]}" find that circuit I took --today 2026-10-25
check "find by course code in query"     0 "^1\. CSE 340 Pipelining" "${N[@]}" find my cse 340 notes --today 2026-10-25
nope  "course filter leaves others out"  "Viterbi|RC low" "${N[@]}" find my cse 340 notes --today 2026-10-25
check "find by course flag"              0 "^1\. EEE 202" "${N[@]}" find filter --course eee202 --today 2026-10-25
check "find by weekday"                  0 "^1\. CSE 576 Viterbi" "${N[@]}" find notes from tuesday --today 2026-10-25
check "find yesterday"                   0 "^1\. CSE 340 Pipelining" "${N[@]}" find yesterday --today 2026-10-24
check "said in own words: last wednesday motor circuit" 0 "^1\. EEE 202 H-bridge motor driver · Oct 14 · circuit \(id 4\) - show the photo"   "${N[@]}" find I had taken a picture last wednesday of a motor circuit --today 2026-10-18
nope  "last wednesday leaves other days out" "RC low|Viterbi|Pipelining" "${N[@]}" find I had taken a picture last wednesday of a motor circuit --today 2026-10-18
check "wrong day falls back to other days" 0 "Nothing from that day" "${N[@]}" find the motor circuit from monday --today 2026-10-25
check "fallback still finds the motor"   0 "^1\. EEE 202 H-bridge" "${N[@]}" find the motor circuit from monday --today 2026-10-25
check "notes about a topic"              0 "^1\. CSE 340 Pipelining" "${N[@]}" find I took notes on forwarding --today 2026-10-25
check "find --kind"                      0 "^1\. EEE 202" "${N[@]}" find --kind circuit --today 2026-10-25
check "no match"                         0 "No matching notes found" "${N[@]}" find quantum chromodynamics --today 2026-10-25
check "find json"                        0 '"visual": true' "${N[@]}" find circuit --json --today 2026-10-25

echo "== get =="
check "get a circuit says show the photo" 0 "Show: send this photo. It is a circuit" "${N[@]}" get --id 2
check "get a circuit gives the summary"   0 "What it shows: 1k resistor" "${N[@]}" get --id 2
check "get a whiteboard gives the text"   0 "read the text below" "${N[@]}" get --id 1
check "get a whiteboard prints the text"  0 "backtrack with psi" "${N[@]}" get --id 1
check "get unknown id"                    3 "no saved note with id 9" "${N[@]}" get --id 9
check "get json has no key"               0 '"ref"' "${N[@]}" get --id 1 --json
nope  "get json hides the key"            '"key"' "${N[@]}" get --id 1 --json

echo "== list, forget, consent off =="
check "list newest first"                0 "^CSE 340 Pipelining" "${N[@]}" list
check "list by course"                   0 "EEE 202" "${N[@]}" list --course "EEE 202"
check "forget one"                       0 "Forgot CSE 340" "${N[@]}" forget --id 3
check "forgotten note not found"         3 "" "${N[@]}" get --id 3
check "forget needs id or all"           6 "give --id" "${N[@]}" forget
check "bad limit"                        6 "at least 1" "${N[@]}" find x --limit 0
check "consent no deletes everything"    0 "Deleted 3 saved notes" "${N[@]}" consent --gallery no
pyck  "index is empty after consent no"  "s['notes']==[] and s['skipped']==[] and s['gallery'] is False"
check "find after consent no exits 2"    2 "" "${N[@]}" find circuit

echo
echo "passed $PASS, failed $FAIL"
[ $FAIL = 0 ]
