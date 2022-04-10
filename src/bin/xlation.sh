#!/bin/bash
RUNNING=true
ACME_NEWS_DIR="/var/www/html/acme"
ACME_DIR="/root/.acme.sh"
SSL_DIR="/etc/ssl/acme"

. "$ACME_DIR/acme.sh.env"

#Check LetsEncrypt every day
acme_renew () {
    while [[ $RUNNING ]]; do
        sleep $(( 24 * 60 * 60 ))
        "$ACME_DIR/acme.sh" --renew --dns -d "$DOMAIN" \
            --yes-I-know-dns-manual-mode-enough-go-ahead-please \
            --server letsencrypt > "$ACME_NEWS_DIR/good.txt" 2>"$ACME_NEWS_DIR/bad.txt"
    done
}

param () {
    local key=$1 value=$2
    sed -i -r "s|^(\s*)#?($key\s*=\s*).*|\1\2$value|g;" "$file"
}


# This may seem clunky, and acem.sh does provide command line switches to select different directories,
# but I found it wasn't working as expected. So symlinks it is then.
ssl_dir_restore () {
    # Restore Domain and CA directories if saved
    if [[ -d "$SSL_DIR/$DOMAIN" ]]; then
        rm -rf "$ACME_DIR/$DOMAIN"
        ln -s "$SSL_DIR/$DOMAIN" "$ACME_DIR/$DOMAIN"
    fi
    if [[ -d "$SSL_DIR/ca" ]]; then
        rm -rf "$ACME_DIR/ca"
        ln -s "$SSL_DIR/ca" "$ACME_DIR/ca"
    fi
}
ssl_dir_save () {
    # Save any new Domain and CA directories if created
    if [[ -d "$ACME_DIR/$DOMAIN" ]] && [[ ! -L "$ACME_DIR/$DOMAIN" ]]; then
        mv -f "$ACME_DIR/$DOMAIN" "$SSL_DIR/$DOMAIN"
        ln -s "$SSL_DIR/$DOMAIN" "$ACME_DIR/$DOMAIN"
    fi
    if [[ -d "$ACME_DIR/ca" ]] && [[ ! -L "$ACME_DIR/ca" ]]; then
        mv -f "$ACME_DIR/ca" "$SSL_DIR/ca"
        ln -s "$SSL_DIR/ca" "$ACME_DIR/ca"
    fi
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

# Fetch/Check SSL cert from Letsencrypt
if [[ "${HTTPS_ENABLE,,}" =~ true ]]; then    
    # If no certificate and key specified then use LetsEncrypt
    if [[ ${#SSL_CHAIN} -lt 1 ]] || [[ ${#SSL_KEY} -lt 1 ]]; then

    
    
        ssl_dir_restore
        # Set email address for requests
        sed -i -r "s/ACCOUNT_EMAIL=.*/ACCOUNT_EMAIL=$EMAIL/" "$ACME_DIR/account.conf"
        # Try and renew certificate
        acme_out=$( "$ACME_DIR/acme.sh" --renew --dns -d "$DOMAIN" \
            --yes-I-know-dns-manual-mode-enough-go-ahead-please \
            --server letsencrypt 2>"$ACME_NEWS_DIR/bad.txt" | tee "$ACME_NEWS_DIR/good.txt" )
        # If we don't yet have a certificate then issue one
        if [[ "$acme_out" =~ (not an issued domain) ]]; then
            acme_out=$( "$ACME_DIR/acme.sh" --issue --dns -d "$DOMAIN" \
                --yes-I-know-dns-manual-mode-enough-go-ahead-please \
                --server letsencrypt 2>"$ACME_NEWS_DIR/bad.txt" | tee "$ACME_NEWS_DIR/good.txt" )
            # Don't enable SSL until we have our certificate
            export HTTPS_ENABLE="false"
            echo "HTTPS disabled until we have an SSL certificate"
        # If we have a good certificate then enable daily renewal checks
        elif [[ "$acme_out" =~ (Next renewal time|Cert success) ]]; then
            acme_renew &
        else
            # If all else fails, disable SSL
            export HTTPS_ENABLE="false"
            echo "HTTPS disabled due to error"
        fi
        ssl_dir_save
        certs_file="$SSL_DIR/$DOMAIN/fullchain.cer"
        key_file="$SSL_DIR/$DOMAIN/$DOMAIN.key"
        
        cat "$ACME_NEWS_DIR/good.txt"
        cat "$ACME_NEWS_DIR/bad.txt"
    else
        # User-supplied certs
        certs_file=$SSL_CHAIN
        key_file=$SSL_KEY
        echo "Using use supplied SSL certificates"
    fi
fi

# Configure Janus
file="/etc/janus/janus.jcfg"
param "admin_secret" "\"$ADMIN_PASSWORD\""
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
        
        ssl_certificate \"$certs_file\";
        ssl_certificate_key \"$key_file\";
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
    port=$( echo "$line" | cut -d "," -f 1 )
    lang=$( echo "$line" | cut -d "," -f 2 )
    videoport=$( echo "$line" | cut -d "," -f 3 )
    videobw=$( echo "$line" | cut -d "," -f 4 )
    pin=$( echo "$line" | cut -d "," -f 5- )
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
    audioport = $port
    audiopt = 111
    audiortpmap = \"opus/48000/2\"
    audioskew = true
" >> /etc/janus/janus.plugin.streaming.jcfg
if [[ "$videoport" =~ ^[0-9]{4,5}$ ]]; then
    echo -n "    video = true
    videopt = 100
    videoport = $videoport
    videortpmap = \"vp8/$videobw\"
    videoskew = true
" >> /etc/janus/janus.plugin.streaming.jcfg
else
    echo -n "    video = false
" >> /etc/janus/janus.plugin.streaming.jcfg
fi
echo "}" >> /etc/janus/janus.plugin.streaming.jcfg
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
