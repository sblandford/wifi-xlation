#!/bin/bash
RUNNING=true
NGINX_SSL_DIR="/etc/nginx/cert"

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


#Check SSL files for updates approx every day
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


param () {
    local key=$1 value=$2
    sed -i -r "s|^(\s*)#?($key\s*=\s*).*|\1\2$value|g;" "$file"
}

# Bind to a different IP if specified
if [[ ${#BIND_IP_AND_PREFIX_LENGTH} -gt 10 ]] && [[ "$BIND_IP_AND_PREFIX_LENGTH" != "0.0.0.0/24" ]] && [[ "$BIND_IP_AND_PREFIX_LENGTH" =~ / ]]; then
    ifs=$( ip link sh | grep -P "^[0-9]+" | awk '{print $2}' )
    # A real host would have more than just two interfaces if running docker
    if [[ $( echo "$ifs" | wc -l ) -le 2 ]]; then
        echo "We can only bind to a different IP with network in \"host\" mode"
    else
        host_ip=$( ip route get 1.2.3.4 | awk '{print $7}' )
        host_dev=$( ip route get 1.2.3.4 | awk '{print $5}' )
        echo "Host IP : $host_ip"
        echo "Host Dev : $host_dev"
        if ! ip ad sh $host_dev | grep -qF "$BIND_IP_AND_PREFIX_LENGTH"; then
            echo "Adding IP to host : $BIND_IP_AND_PREFIX_LENGTH"
            if ip ad ad "$BIND_IP_AND_PREFIX_LENGTH" dev "$host_dev"; then
                bind_ip=$( echo "$BIND_IP_AND_PREFIX_LENGTH" | grep -Po "^[^/]+" )
                nginx_bind_ip="$bind_ip:"
            else
                echo "Adding IP failed : $BIND_IP_AND_PREFIX_LENGTH"
                echo "Container must be run with NET_ADMIN capability"
            fi
        else
            echo "Binding to specific IP : $BIND_IP_AND_PREFIX_LENGTH"
            bind_ip=$( echo "$BIND_IP_AND_PREFIX_LENGTH" | grep -Po "^[^/]+" )
            nginx_bind_ip="$bind_ip:"
        fi
    fi
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
if [[ $bind_ip ]]; then
    param "nat_1_1_mapping" "\"$bind_ip\""
    param "keep_private_host" "false"
fi
param "ignore_mdns" "$IGNORE_MDNS"

file="/etc/janus/janus.transport.http.jcfg"
param "ip" "\"127.0.0.1\""
param "interface" "\"lo\""
param "admin_http" "true"
param "admin_ip" "\"127.0.0.1\""
param "admin_interface" "\"lo\""
param "enforce_cors" "false"


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

        location / {
                try_files \$uri \$uri/ =404;
        }

        location /janus {
            proxy_pass http://127.0.0.1:8088/janus;
            proxy_set_header Host \$host;
        }
        location /admin {
            proxy_pass http://127.0.0.1:7088/admin;
            proxy_set_header Host \$host;
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
        
        location / {
                try_files \$uri \$uri/ =404;
        }
        
        location /janus {
            proxy_pass http://127.0.0.1:8088/janus;
            proxy_set_header Host \$host;
        }
        location /admin {
            proxy_pass http://127.0.0.1:7088/admin;
            proxy_set_header Host \$host;
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
# Create the language stream entries
IFS=$'\n'
id=0
for line in $( grep -P -v "^\s*#" /etc/languages.conf ); do
    port=$( echo "$line" | tr -d "\r" | cut -d "," -f 1 )
    lang=$( echo "$line" | tr -d "\r" | cut -d "," -f 2 )
    pin=$( echo "$line" | tr -d "\r" | cut -d "," -f 3- )
    if [[ ${#port} -lt 4 ]] || [[ ${#lang} -lt 1 ]] || [[ ${#pin} -lt 1 ]]; then
        continue
    fi
    echo "
Language-$(( id + 1 )): {
    type = \"rtp\"
    id = $(( id + 1 ))
    secret = \"$RANDOM\"
    description = \"$lang\"
    audio = true
    video = false
    audioport = $port
    audiopt = 111
    audiortpmap = \"opus/48000/2\"
}" >> /etc/janus/janus.plugin.streaming.jcfg
    echo "
room-$(( id + 1 )): {
    description = \"$lang\"
    secret = \"$RANDOM\"
    pin = \"$pin\"
    sampling_rate = 48000
    record = false
    rtp_forward_host = \"localhost\"
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
sed -i -r "s/^(\s*)#?(disable\s*=\s*).*libjanus_rabbitmq.*/\1\2\"libjanus_websockets.so,libjanus_pfunix.so,libjanus_nanomsg.so,libjanus_mqtt.so,libjanus_rabbitmq.so\"/" /etc/janus/janus.jcfg



nginx
janus

unset RUNNING
