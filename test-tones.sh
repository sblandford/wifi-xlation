#!/bin/bash

MAX_CHANNELS=20
IP="0.0.0.0"

if [[ ${#2} -gt 4 ]]; then
  IP=$2
fi

start_all () {
  for (( i=0; i < MAX_CHANNELS; i++ )); do
    ffmpeg -re -f lavfi -i sine=frequency=$(( 216 + (i * 100) )) -c:a libopus -ac 1 -b:a 32k -ar 48000 -f rtp -payload_type 96 rtp://$IP:$(( 5006 + (i * 2) )) &>/dev/null &
  done
}

stop_all () {
  if ps aux | grep "ffmpeg" | grep -q "sine=frequency"; then
    kill -KILL $( ps aux | grep "ffmpeg" | grep "sine=frequency" | awk '{print $2}' )
  fi
}

cleanup () {
  stop_all

  trap - SIGINT
  exit
}

trap cleanup SIGINT

case $1 in
  "start")
    stop_all
    start_all
    ;;
  "stop")
    cleanup
    ;;
  *)
    echo "Usage:"
    echo "$( basename "$0") <start|stop> [<bind IP>]"
    ;;
esac
