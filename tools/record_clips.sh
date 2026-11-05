#!/usr/bin/env bash
# Records short clips straight from the webcam (camera's own MJPEG bitstream, no re-encode)
# under several forced camera states, then restores the camera. Windows only (dshow + camctl).
set -u
CAM="${CAM:-Integrated Webcam}"; OUT="${1:-data/clips}"; CTL="tools/bin/camctl.exe"; SECS=8
mkdir -p "$OUT"
restore() { "$CTL" set amp 13 2 2; "$CTL" set amp 0 -24 2; "$CTL" set amp 9 1 2; "$CTL" set cam 19 1 2; "$CTL" set cam 4 -6 1; "$CTL" set amp 7 4600 1; }
rec() { # name, then camctl "iface prop val flags" settings applied 1.5 s after the camera opens
  local name="$1"; shift
  ffmpeg -hide_banner -loglevel error -y -f dshow -video_size 1280x720 -framerate 30 -vcodec mjpeg -i video="$CAM" -t "$SECS" -c:v copy "$OUT/$name.raw.avi" &
  local pid=$!; sleep 1.5
  for s in "$@"; do "$CTL" set $s >/dev/null; done
  wait $pid
  # drop the first 3.5 s (camera start + settling after the control change)
  ffmpeg -hide_banner -loglevel error -y -ss 3.5 -i "$OUT/$name.raw.avi" -c:v copy "$OUT/$name.avi" && rm "$OUT/$name.raw.avi"
  echo "recorded $name"
  restore >/dev/null; sleep 1
}
trap 'restore >/dev/null' EXIT
rec asfound_auto
rec aeprio0_auto        "cam 19 0 2"
rec aeprio0_50hz        "cam 19 0 2" "amp 13 1 2"
rec dim_exp-5_gain1     "cam 4 -5 2" "amp 9 1 2"
rec dark_exp-6_gain1    "cam 4 -6 2" "amp 9 1 2"
rec vdark_exp-7_gain1   "cam 4 -7 2" "amp 9 1 2"
rec dark_exp-7_gain8    "cam 4 -7 2" "amp 9 8 2"
rec cast_warm_wb6500    "cam 19 0 2" "amp 7 6500 2"
rec cast_cool_wb2800    "cam 19 0 2" "amp 7 2800 2"
restore; "$CTL" list
