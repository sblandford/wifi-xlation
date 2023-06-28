#!/bin/bash
RUNNING=true
NGINX_SSL_DIR="/etc/nginx/cert"
JS_SETTINGS_DIR="/var/www/html/json"
JS_SETTINGS="$JS_SETTINGS_DIR/settings.json"

CERTS_FILE="$NGINX_SSL_DIR/fullchain.pem"
KEY_FILE="$NGINX_SSL_DIR/privkey.pem"

ssl_check () {
    [[ "$1" == "cert" ]] && grep -Fq "BEGIN CERTIFICATE" "$2" && grep -Fq "END CERTIFICATE" "$2" && return 0
    [[ "$1" == "key" ]] && grep -Fq "BEGIN PRIVATE KEY" "$2" && grep -Fq "END PRIVATE KEY" "$2" && return 0
    return 1
}

ssl_copy () {
    # Note that AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_DEFAULT_REGION are set as global
    # variables that will be picked up by the s3cmd command
    ssl_changed=false
    mkdir -p "$NGINX_SSL_DIR"
    if [[ -e "$SSL_CHAIN" ]]; then
        cp -f "$SSL_CHAIN" "$CERTS_FILE""_tmp"
    elif [[ "${SSL_CHAIN,,}" =~ ^s3:// ]]; then
        s3cmd -qf get "$SSL_CHAIN" "$CERTS_FILE""_tmp"
    fi
    if ssl_check "cert" "$CERTS_FILE""_tmp"; then
        cmp -s "$CERTS_FILE""_tmp" "$CERTS_FILE" || ssl_changed=true
        mv -f "$CERTS_FILE""_tmp" "$CERTS_FILE"
    else
        echo "Invalid certs file : $SSL_CHAIN"
        HTTPS_ENABLE=false
    fi
    if [[ -e "$SSL_KEY" ]]; then
        cp -f "$SSL_KEY" "$KEY_FILE""_tmp"
    elif [[ "${SSL_KEY,,}" =~ ^s3:// ]]; then
        s3cmd -qf get "$SSL_KEY" "$KEY_FILE""_tmp"
    fi
    if ssl_check "key" "$KEY_FILE""_tmp"; then
        cmp -s "$KEY_FILE""_tmp" "$KEY_FILE" || ssl_changed=true
        mv -f "$KEY_FILE""_tmp" "$KEY_FILE"
    else
        echo "Invalid key file : $SSL_KEY"
        HTTPS_ENABLE=false
    fi    
}


# Check SSL files for updates approx every day
ssl_renew () {
    while [[ $RUNNING ]]; do
        for (( i = 0; i < ( 24 * 60 * 60 ); i++ )); do
            sleep 1
            [[ $RUNNING ]] || return
        done
        ssl_copy
        [[ "$ssl_changed" == "true" ]] && echo "SSL certs updated so reloading Nginx" && nginx -s reload
    done
}

# Update stats aprox every 10 seconds
stats_update () {
    while [[ $RUNNING ]]; do
        for (( i = 0; i < 5; i++ )); do
            sleep 1
            [[ $RUNNING ]] || return
        done
        /usr/local/bin/stats.sh
    done
}

param () {
    local key=$1 value=$2
    sed -i -r "s|^(\s*)#?($key\s*=\s*).*|\1\2$value|g;" "$file"
}

if [[ ${#BIND_IP4} -gt 4 ]]; then
    nginx_bind_ip="$BIND_IP4:"
fi

# SSL certs
if [[ "${HTTPS_ENABLE,,}" =~ true ]]; then
    ssl_copy
    if [[ "${HTTPS_ENABLE,,}" =~ true ]]; then
        echo "SSL enabled"
        ssl_renew &
    else
        echo "SSL disabled"
    fi
fi

# Configure Janus
file="/etc/janus/janus.jcfg"
param "admin_secret" "\"$ADMIN_PASSWORD\""
param "debug_level" "$JANUS_DEBUG_LEVEL"
param "server_name" "\"$DOMAIN\""
if [[ ${#NAT_1_1_MAPPING} -gt 0 ]]; then
    param "nat_1_1_mapping" "\"$NAT_1_1_MAPPING\""
    param "keep_private_host" "false"
    param "ice_lite" "false"
fi
param "ignore_mdns" "$IGNORE_MDNS"
if [[ ${#STUN_SERVER} -gt 0 ]] && [[ ${#STUN_PORT} -gt 0 ]]; then
    param "stun_server" "\"$STUN_SERVER\""
    param "stun_port" "\"$STUN_PORT\""
fi
if [[ "${STUN_IGNORE_FAIL,,}" =~ true ]]; then
    param "ignore_unreachable_ice_server" "true"
else
    param "ignore_unreachable_ice_server" "false"
fi


file="/etc/janus/janus.transport.http.jcfg"
param "ip" "\"127.0.0.1\""
param "interface" "\"lo\""
param "admin_http" "true"
param "admin_ip" "\"127.0.0.1\""
param "admin_interface" "\"lo\""
param "enforce_cors" "false"
param "mhd_connection_limit" "$MAX_HTTP_CONNS"

# Configure the websockets transport if enabled
if [[ "${WEBSOCKETS,,}" =~ true ]]; then
    file="/etc/janus/janus.transport.websockets.jcfg"
    param "enforce_cors" "false"
    if [[ "${HTTPS_ENABLE,,}" =~ true ]]; then
        param "ws" "false"
        param "wss" "true"
        param "cert_pem" "\"$CERTS_FILE\""
        param "cert_key" "\"$KEY_FILE\""
    fi
fi

# Configure NGinx
echo "user www-data;

# Enhancements based on https://gist.github.com/denji/8359866

# you must set worker processes based on your CPU cores, nginx does not benefit from setting more than that
worker_processes auto;
pid /run/nginx.pid;
include /etc/nginx/modules-enabled/*.conf;

# number of file descriptors used for nginx
# the limit for the maximum FDs on the server is usually set by the OS.
# if you don't set FD's then OS settings will be used which is by default 2000
worker_rlimit_nofile 100000;

# only log critical errors
error_log /var/log/nginx/error.log crit;

events {
        # determines how much clients will be served per worker
        # max clients = worker_connections * worker_processes
        # max clients is also limited by the number of socket connections available on the system (~64k)
        worker_connections 4000;

        # optimized to serve many clients with each thread, essential for linux
        use epoll;
        
        # accept as many connections as possible, may flood worker connections if set too low
        multi_accept on;
}

http {

        ##
        # Basic Settings
        ##

        sendfile on;
        tcp_nopush on;
        types_hash_max_size 2048;
        # server_tokens off;

        # server_names_hash_bucket_size 64;
        # server_name_in_redirect off;

        include /etc/nginx/mime.types;
        default_type application/octet-stream;
        
        ##
        # SSL Settings
        ##

        ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3; # Dropping SSLv3, ref: POODLE
        ssl_prefer_server_ciphers on;

        ##
        # Logging Settings
        ##

        access_log /var/log/nginx/access.log;
        error_log /var/log/nginx/error.log;

        ##
        # Gzip Settings
        ##

        gzip on;

        # gzip_vary on;
        # gzip_proxied any;
        # gzip_comp_level 6;
        # gzip_buffers 16 8k;
        # gzip_http_version 1.1;
        # gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;

        ##
        # Virtual Host Configs
        ##

        include /etc/nginx/conf.d/*.conf;
        include /etc/nginx/sites-enabled/*;
}" >/etc/nginx/nginx.conf

if [[ "${HTTPS_ENABLE,,}" =~ true ]]; then
    echo "server {
        listen "$nginx_bind_ip"$HTTP_STATIC_PORT default_server;
        listen [::]:$HTTP_STATIC_PORT default_server;
        
        return 301 https://\$host\$request_uri;
        
        root /var/www/html;
        
        index index.html;
        
        server_name _;
}" >/etc/nginx/sites-enabled/default
        
    echo "server {
        listen "$nginx_bind_ip"$HTTPS_STATIC_PORT ssl http2 default_server;
        listen [::]:$HTTPS_STATIC_PORT ssl http2 default_server;

        root /var/www/html;

        index index.html;

        server_name _;
        
        add_header Access-Control-Allow-Origin *;

        # Settings based on https://gist.github.com/denji/8359866
        open_file_cache max=200000 inactive=20s;
        open_file_cache_valid 30s;
        open_file_cache_min_uses 2;
        open_file_cache_errors on;

        # to boost I/O on HDD we can disable access logs
        access_log off;

        # copies data between one FD and other from within the kernel
        # faster than read() + write()
        sendfile on;

        # send headers in one piece, it is better than sending them one by one
        tcp_nopush on;

        # don't buffer data sent, good for small data bursts in real time
        tcp_nodelay on;        
        
        # allow the server to close connection on non responding client, this will free up memory
        reset_timedout_connection on;

        # request timed out -- default 60
        client_body_timeout 10;

        # if client stop responding, free up memory -- default 60
        send_timeout 2;

        # server will close connection after this time -- default 75
        keepalive_timeout 30;

        # number of requests client can make over keep-alive -- for testing environment
        keepalive_requests 100000;
    
        location / {
                try_files \$uri \$uri/ =404;
        }

        location ~ ^/janus($|/) {
            proxy_pass http://127.0.0.1:8088;
            proxy_set_header   Upgrade \$http_upgrade;
            proxy_set_header   Connection keep-alive;
            proxy_set_header   Host \$host;
            proxy_cache_bypass \$http_upgrade;
            proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto \$scheme;
        }
        location ~ ^/admin($|/) {
            proxy_pass http://127.0.0.1:7088;
            proxy_set_header   Upgrade \$http_upgrade;
            proxy_set_header   Connection keep-alive;
            proxy_set_header   Host \$host;
            proxy_cache_bypass \$http_upgrade;
            proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto \$scheme;
        }
        
        ssl_certificate \"$CERTS_FILE\";
        ssl_certificate_key \"$KEY_FILE\";
        ssl_session_cache shared:SSL:1m;
        ssl_session_timeout  10m;
}" > /etc/nginx/sites-enabled/default_ssl
else
    echo "server {
        listen "$nginx_bind_ip"$HTTP_STATIC_PORT default_server;
        listen [::]:$HTTP_STATIC_PORT default_server;
                
        root /var/www/html;
        
        index index.html;
        
        server_name _;

        add_header Access-Control-Allow-Origin *;

        # No 'performance boosting' settings here since non-https mode
        # can only be for testing due to WebRTC SSL requirements
        access_log off;
        
        location / {
                try_files \$uri \$uri/ =404;
        }
        
        location ~ ^/janus($|/) {
            proxy_pass http://127.0.0.1:8088;
            proxy_set_header   Upgrade \$http_upgrade;
            proxy_set_header   Connection keep-alive;
            proxy_set_header   Host \$host;
            proxy_cache_bypass \$http_upgrade;
            proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto \$scheme;
        }
        location ~ ^/admin($|/) {
            proxy_pass http://127.0.0.1:7088;
            proxy_set_header   Upgrade \$http_upgrade;
            proxy_set_header   Connection keep-alive;
            proxy_set_header   Host \$host;
            proxy_cache_bypass \$http_upgrade;
            proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto \$scheme;
        }
}" >/etc/nginx/sites-enabled/default
fi

# Make streaming config backup if first time running
if [[ ! -f "/etc/janus/janus.plugin.streaming.jcfg_orig" ]]; then
    mv -f "/etc/janus/janus.plugin.streaming.jcfg" "/etc/janus/janus.plugin.streaming.jcfg_orig"
fi
echo >"/etc/janus/janus.plugin.streaming.jcfg"
# Make audiobridge config backup if first time running
if [[ ! -f "/etc/janus/janus.plugin.audiobridge.jcfg.jcfg_orig" ]]; then
    mv -f "/etc/janus/janus.plugin.audiobridge.jcfg" "/etc/janus/janus.plugin.audiobridge.jcfg_orig"
fi
echo >"/etc/janus/janus.plugin.audiobridge.jcfg"

rtp_host_ip="0.0.0.0"
if [[ ${#MULTICAST_IP4} -gt 4 ]]; then
    rtp_host_ip="$MULTICAST_IP4"
    audiomcast="audiomcast = \"$MULTICAST_IP4\""$'\n'"    "

fi
# Create the language stream entries
IFS=$'\n'
id=0
for line in $( grep -P -v "^\s*#" /etc/languages.conf | tr -d "\r" ); do
    port=$( echo "$line" | cut -d "," -f 1 )
    lang=$( echo "$line" | cut -d "," -f 2 )
    pin=$( echo "$line"  | cut -d "," -f 3 )
    if [[ ${#port} -lt 4 ]] || [[ ${#lang} -lt 1 ]] || [[ ${#pin} -lt 1 ]]; then
        continue
    fi
    # "secret" line must come after "id" line for stats.sh to work
    # The secret must also be in quotes
    echo "
Language-$(( id + 1 )): {
    type = \"rtp\"
    id = $(( id + 1 ))
    secret = \"$RANDOM\"
    description = \"$lang\"
    audio = true
    video = false
    audioport = $port
    $audiomcast""audiopt = 111
    audiofmtp = \"sprop-stereo=1\"
    audiortpmap = \"opus/48000/2\"
}" >> /etc/janus/janus.plugin.streaming.jcfg
    echo "
room-$(( id + 1 )): {
    description = \"$lang\"
    secret = \"$RANDOM\"
    pin = \"$pin\"
    sampling_rate = 48000
    record = false
    default_expectedloss = 5
    default_bitrate = 32768
    audio_level_average = 10
    rtp_forward_host = \"$rtp_host_ip\"
    rtp_forward_host_family = \"ipv4\"
    rtp_forward_port = $port
    rtp_forward_codec = \"opus\"
    rtp_forward_ptype = 111
}" >> /etc/janus/janus.plugin.audiobridge.jcfg
    id=$(( id + 1 ))
done

# Disable unwanted plugins
sed -i -r "s/^(\s*)#?(disable\s*=\s*).*libjanus_voicemail.*/\1\2\"libjanus_voicemail.so,libjanus_echotest.so,libjanus_duktape.so,libjanus_textroom.so,libjanus_sip.so,libjanus_recordplay.so,libjanus_videocall.so,libjanus_lua.so,libjanus_videoroom.so,libjanus_nosip.so\"/" /etc/janus/janus.jcfg
# Disable unwanted transports
[[ "${WEBSOCKETS,,}" =~ true ]] || websockets_exlude="libjanus_websockets.so,"
sed -i -r "s/^(\s*)#?(disable\s*=\s*).*libjanus_rabbitmq.*/\1\2\"$websockets_exlude""libjanus_pfunix.so,libjanus_nanomsg.so,libjanus_mqtt.so,libjanus_rabbitmq.so\"/" /etc/janus/janus.jcfg

# Create settings file for player application
mkdir -p "$JS_SETTINGS_DIR"
chown --reference=/var/www/html "$JS_SETTINGS_DIR"
echo "{" >"$JS_SETTINGS"
echo "    \"qrCodeUrl\":\"$QR_CODE_URL\"," >>"$JS_SETTINGS"
if [[ "${WEBSOCKETS,,}" =~ true ]]; then
    if [[ "${HTTPS_ENABLE,,}" =~ true ]]; then
        echo "    \"ws\":\"wss\"," >>"$JS_SETTINGS"
    else
        echo "    \"ws\":\"ws\"," >>"$JS_SETTINGS"
    fi
else
    echo "    \"ws\":false," >>"$JS_SETTINGS"
fi

if [[ ${#STUN_SERVER} -gt 0 ]] && [[ ${#STUN_PORT} -gt 0 ]]; then
    echo "    \"iceServers\":[{\"urls\": \"stun:$STUN_SERVER:$STUN_PORT\"}]," >>"$JS_SETTINGS"
else
    echo "    \"iceServers\":null," >>"$JS_SETTINGS"
fi

if [[ "${VIDEO_SCREEN_KEEPER_RX,,}" =~ true ]]; then
    echo "    \"videoScreenKeeperRx\":true," >>"$JS_SETTINGS"
else
    echo "    \"videoScreenKeeperRx\":false," >>"$JS_SETTINGS"
fi
if [[ "${VIDEO_SCREEN_KEEPER_TX,,}" =~ true ]]; then
    echo "    \"videoScreenKeeperTx\":true," >>"$JS_SETTINGS"
else
    echo "    \"videoScreenKeeperTx\":false," >>"$JS_SETTINGS"
fi
if [[ ${#TIMOUT_URL} -gt 2 ]]; then
    echo "    \"timeoutUrl\":\"$TIMOUT_URL\"," >>"$JS_SETTINGS"
else
    echo "    \"timeoutUrl\":false," >>"$JS_SETTINGS"
fi
if [[ "${HIDE_MIC,,}" =~ true ]]; then
    echo "    \"hideMicDefault\":true," >>"$JS_SETTINGS"
else
    echo "    \"hideMicDefault\":false," >>"$JS_SETTINGS"
fi
# Dummy end property just to be the one without a comma
echo "    \"end\":true" >>"$JS_SETTINGS"
echo "}" >>"$JS_SETTINGS"
# Prevent nasty root-owned file in development environments
chown --reference=/var/www/html/index.html "$JS_SETTINGS"

# Start the stats polling
stats_update &

# Start the web server (which detaches) and then the Janus server (which runs in foreground)
nginx
janus

unset RUNNING
