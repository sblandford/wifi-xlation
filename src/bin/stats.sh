#/!bin/bash

URL="http://localhost:8088/janus"
CONF="/etc/janus/janus.plugin.streaming.jcfg"
OUT_JSON_DIR="/var/www/html/json"
OUT_JSON="$OUT_JSON_DIR/stats.json"
OUT_JSON_TMP="$OUT_JSON""_tmp"
MAX_AUDIO_AGE_MS=2000

get_ids () {
    grep -P "\s?id\s+?=\s*[0-9]+" "$CONF" | grep -Po "[0-9]+"
}

get_secret () {
    # Secret is always after id, as created by xlation.sh start script
    local stream_id=$1
    grep -P -A1 "id.*=\s*$stream_id([^0-9]|$)" "$CONF" | tail -n 1 | \
        grep -Po '(?<=")[^"]+'
}

janus () {
    local json=$1 path=$2
    curl -s -X POST "$URL$path" -H "Content-Type: application/json" -d "$json"
}

get_session () {
    local json='{"janus":"create","transaction":"stats"}'
    janus "$json" | grep -F '"id"' | grep -Po "[0-9]+"
}

kill_session () {
    local session_id=$1
    local json='{"janus":"destroy","transaction":"stats"}'
    janus "$json" "/$session_id"
}

get_streaming_handle () {
    local session_id=$1
    local json='{"janus":"attach","transaction":"stats","plugin":"janus.plugin.streaming"}'
    janus "$json" "/$session_id" | grep -F '"id"' | grep -Po "[0-9]+"
}

get_list () {
    local session_id=$1 handle_id=$2 id=$3
    local json='{"janus":"message","transaction":"stats","body":{"request":"list"}}'
    janus "$json" "/$session_id/$handle_id"
}

get_info () {
    local session_id=$1 handle_id=$2 id=$3 secret=$4
    local json='{"janus":"message","transaction":"stats","body":{"request":"info","id":'$id',"secret":"'$secret'"}}'
    janus "$json" "/$session_id/$handle_id"
}

mkdir -p "$OUT_JSON_DIR"
chown --reference=/var/www/html/js "$OUT_JSON_DIR"
touch "$OUT_JSON_TMP"
chown --reference=/var/www/html/index.html "$OUT_JSON_TMP"

# Open a session, get a handle for the streaming plugin then poll the stream info

session_id=$( get_session )
handle_id=$( get_streaming_handle $session_id )

echo '[' > "$OUT_JSON_TMP"
for stream_id in $( get_ids ); do
    secret=$( get_secret $stream_id )
    info=$( get_info $session_id $handle_id $stream_id $secret )
    name=$( echo "$info" | grep -F '"description"' | grep -Po '(?<=")[^"]+(?=",\s*$)' )
    age_ms=$( echo "$info" | grep -F '"age_ms"' | grep -Po '[0-9]+' | tail -n 1 )
    active="false"
    [[ ${#age_ms} -gt 0 ]] && [[ $age_ms -lt $MAX_AUDIO_AGE_MS ]] && active="true"
    listeners=$( echo "$info" | grep -F '"viewers"' | grep -Po '[0-9]+' || echo "0" )

    [[ $first_line ]] && echo ',' >> "$OUT_JSON_TMP"
    first_line=true

    echo '  {' >> "$OUT_JSON_TMP"
    echo '    "id" : '$stream_id',' >> "$OUT_JSON_TMP"
    echo '    "name" : "'"$name"'",' >> "$OUT_JSON_TMP"
    echo '    "active" : '"$active"',' >> "$OUT_JSON_TMP"
    echo '    "listeners" : '$listeners >> "$OUT_JSON_TMP"
    echo -n '  }' >> "$OUT_JSON_TMP"
done
echo >> "$OUT_JSON_TMP"
echo ']' >> "$OUT_JSON_TMP"
mv -f "$OUT_JSON_TMP" "$OUT_JSON"

kill_session $session_id >/dev/null

