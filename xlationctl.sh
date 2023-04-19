#!/bin/bash
DOCKER_NAME="wifi-xlation"
IMAGE_TAG="wifi-xlation:latest"
path=$( pwd )

usage () {
    echo "$( basename "$0" ) <start|stop|status|remove> --ssl [--ip <ip address> | --portshift <integer>] [--dev] [--custom] [--daemon] [-dummy]
        start
            Start a new or existing $DOCKER_NAME docker.
            If starting an existing docker then all further command line options will be ignored.
        stop
            Stop a running $DOCKER_NAME docker.
        status
            Show the status of the $DOCKER_NAME docker.
        remove
            Delete a running or stopped $DOCKER_NAME docker. Required to run under different command line arguments.
        --ssl
            Use user-supplied fullchain and key from cust/ssl/fullchain.crt and cust/ssl/private.key or
            cust/ssl/s3.txt with the following lines:
                s3://<fullchain url>
                s3://<privkey url>
                <AWS_ACCESS_KEY>
                <AWS_SECRET_KEY>
                <AWS_REGION>
        --wss
            Use Websockets instead of REST API to contact Janus
        --host
            Use host network
        --macvlan <macvlan network name> <ip address>
            Use a macvlan network that has already been defined with a specific static IP address
        --bindip4 <ip address>
            Bind Nginx to a specific IP
        --multicast_address <multicast ip address>
            Use a multicast address as the output of the translation rooms and the input to the streaming server
        --portshift <integer>
            If port 80 and 443 are occupied then add an integer e.g. 8000 for ports 8080 and 8443.
        --rtpforward
            Forward UDP port range 5006-5050 for external audio input
            To test, try running this command on the host...
            ffmpeg -re -f lavfi -i sine=frequency=216 -c:a libopus -ac 1 -b:a 32k -ar 48000 -f rtp rtp://0.0.0.0:5006
        --verbosity <integer 0-7>
            Sets the value of debug_level for Janus. 0 is none, 7 is full
        --qrurl <URL>
            Fix the URL that is pointed to by the QR code button
        --dev
            Development mode.
            Instead of using the HTML files built with the docker mount the src/html directory.
            This enables real-time fiddling of the web frontend without having to rebuild the docker
            after every change.
        --custom
            Use a custom language file cust/conf/languages.conf instead of the default internal languages.conf.
            This enables the list of languages and language passwords to be set up.
        --domain
            Hostname as it will appear in a Janus info request
        --hidemic
            Hide the translator mic icon unless activated by /xlator.html page
        --timeouturl
            URL to jump to once contact has been lost with the server
        --stunserver
            Hostname and port of a stun server separated by colon e.g. stun.l.google.com:19302
        --daemon
            Don't attach the terminal to the docker. It will run in the background
        --dummy
            Don't actually run the docker but just print out the command that would run the docker.
        --ignoremdns
            Ignore MDNS. Useful if not on LAN.
"
    exit
}

dupe () {
    echo "Option $switch appears twice"
    usage
}

printcommand () {
    echo "docker run $interactive --name=\"$DOCKER_NAME\" $options -t \"$IMAGE_TAG\""
}

check_ip () {
    [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]
}

if [[ "$path" =~ " " ]]; then
    echo "Path can not have spaces in it : $path"
    exit
fi

verb=$1
shift

[[ $# -gt 0 ]] && params=true
interactive="-it"
while [[ $# -gt 0 ]]; do
    switch=$1
    shift
    case $switch in
        --host)
            [[ "$options" =~ net=host ]] && dupe
            if [[ "$options" =~ 5006-5050 ]]; then
                echo "--rtpforward is redundant in --host mode"
                usage
            fi
            options="$options --net=host "
            ;;
        --macvlan)
            [[ "$options" =~ net=macvlan ]] && dupe
            macvlan_name=$1
            if ! docker network ls | grep -F macvlan | grep -F "$macvlan_name"; then
                echo "Macvlan name not valid"
                usage
            fi
            shift
            macvlan_ip=$1
            if ! check_ip "$macvlan_ip"; then
                echo "Macvlan IP not valid"
                usage
            fi
            shift
            options="$options --net=$macvlan_name --ip=$macvlan_ip "
            ;;
        --bindip4)
            [[ "$options" =~ BIND_IP4 ]] && dupe
            bind_ip4=$1
            options="$options -e BIND_IP4=$bind_ip4 "
            shift
            ;;
        --multicast_ip4)
            [[ "$options" =~ MULTICAST_IP4 ]] && dupe
            multicast_ip4=$1
            options="$options -e MULTICAST_IP4=$multicast_ip4 "
            shift
            ;;
        --portshift)
            [[ $offset ]] && dupe
            offset=$1
            if ! [[ "$offset" =~ ^[0-9]{3,4}$ ]]; then
                echo "Invalid port offset : $offset"
                usage
            fi
            shift
            ;;
        --rtpforward)
            [[ "$options" =~ 5006-5050 ]] && dupe
            if [[ "$options" =~ net=host ]]; then
                echo "--rtpforward can not be speciied in --host mode"
                usage
            fi
            options="$options -p 5006-5050:5006-5050/udp "
            ;;
        --verbosity)
            [[ $verbosity ]] && dupe
                verbosity=$1
            if ! [[ "$verbosity" =~ ^[0-9]$ ]] || [[ $verbosity -gt 7 ]]; then
                echo "Invalid verbosity level : $verbosity"
                usage
            fi
            options="$options -e JANUS_DEBUG_LEVEL=$verbosity"
            shift
            ;;
        --qrurl)
            options="$options -e QR_CODE_URL=$1 "
            shift
            ;;
        --dev)
            [[ "$options" =~ src/html ]] && dupe
            options="$options -v $path/src/bin/xlation.sh:/usr/local/bin/xlation.sh "
            options="$options -v $path/src/bin/stats.sh:/usr/local/bin/stats.sh "
            options="$options -v $path/src/html:/var/www/html"
            ;;
        --custom)
            [[ "$options" =~ languages.conf ]] && dupe
            if [[ ! -f $path/cust/conf/languages.conf ]]; then
                echo "File required for custom languages not found : cust/conf/languages.conf"
                exit
            fi
            options="$options -v $path/cust/conf/languages.conf:/etc/languages.conf"
            ;;
        --ssl)
            [[ "$options" =~ SSL_CHAIN ]] && dupe
            if [[ -f cust/ssl/s3.txt ]]; then
                options="$options -e SSL_CHAIN=$( sed -n "1p" cust/ssl/s3.txt) "
                options="$options -e SSL_KEY=$( sed -n "2p" cust/ssl/s3.txt) "
                options="$options -e AWS_ACCESS_KEY_ID=$( sed -n "3p" cust/ssl/s3.txt) "
                options="$options -e AWS_SECRET_ACCESS_KEY=$( sed -n "4p" cust/ssl/s3.txt) "
                options="$options -e AWS_DEFAULT_REGION=$( sed -n "5p" cust/ssl/s3.txt) "
                options="$options -e HTTPS_ENABLE=true "
            elif [[ -f cust/ssl/fullchain.crt ]] && [[ -f cust/ssl/private.key ]]; then
                options="$options -e SSL_CHAIN=cust/ssl/fullchain.crt "
                options="$options -e SSL_KEY=cust/ssl/private.key "
                options="$options -e HTTPS_ENABLE=true "
            else
                echo "Unable to find cust/ssl/fullchain.crt, cust/ssl/private.key or cust/ssl/s3.txt"
                usage
            fi
            ;;
        --wss)
            options="$options -e WEBSOCKETS=true "
            ;;
        --domain)
            options="$options -e DOMAIN=$1 "
            shift
            ;;
        --hidemic)
            options="$options -e HIDE_MIC=true "
            ;;
        --timeouturl)
            options="$options -e TIMOUT_URL=$1 "
            shift
            ;;
        --stunserver)
            stunhost=$( echo "$1" | cut -d ":" -f 1 )
            stunport=$( echo "$1" | cut -d ":" -f 2 )
            options="$options -e STUN_SERVER=$stunhost "
            options="$options -e STUN_PORT=$stunport "
            shift
            ;;
        --ignoremdns)
            options="$options -e IGNORE_MDNS=true "
            ;;
        --daemon)
            interactive="-d"
            ;;
        --dummy)
            dummy=true;
            ;;
        --help)
            usage
            ;;
        *)
            echo "Unknown parameter : $switch"
            usage
            ;;
    esac
done

if [[ $offset ]]; then
    if [[ "$options" =~ net=host ]]; then
        echo "Portshift can not be specified with --host option"
        usage
    else
        options="$options -p $(( offset + 80)):80/tcp -p $(( offset + 443)):443/tcp "
    fi
else
    offset=0
    if [[ ! "$options" =~ net=host ]]; then
        options="$options -p 80:80/tcp -p 443:443/tcp "
    fi
fi

if [[ $params ]] && [[ "$verb" != "start" ]]; then
    echo "Options have no meaning unless used with the \"start\" command"
    exit
fi

case "$verb" in
    start)
        [[ $dummy ]] && printcommand && exit
        chmod +x src/bin/xlation.sh
        if docker ps | grep "$DOCKER_NAME"; then
            echo "Xlation already running"
            exit
        fi
        if docker ps -a | grep "$DOCKER_NAME"; then
            if [[ $params ]]; then
                echo "An existing container can only be restarted. No further options can be supplied."
                echo "$( basename "$0") start"
                exit            
            fi
            echo "Re-starting existing container"
            echo "(New paramaters have no effect when restarting an existing container)"
            docker start -a -i "$DOCKER_NAME"
        else
            if [[ ! -f "src/html/js/janus.js" ]]; then
                (sleep 5; docker cp $DOCKER_NAME:/usr/share/javascript/janus-gateway/janus.js src/html/js/janus.js ) &
            fi
            if [[ ! -f "cust/conf/languages.conf" ]]; then
                mkdir -p "cust/conf"
                cp "src/conf/languages.conf" "cust/conf/languages.conf"
            fi
            docker run $interactive --name="$DOCKER_NAME" \
                $options \
                -t "$IMAGE_TAG"
        fi
        ;;
    stop)
        echo "Stopping"
        docker stop $DOCKER_NAME
        ;;
    status)
        docker ps -a -f "name=$DOCKER_NAME"
        ;;
    remove)
        echo "Removing"
        docker rm -f $DOCKER_NAME
        ;;
#    prune)
#        docker image prune -f
#        ;;
    *)
        usage
        ;;
esac
exit


#ffmpeg -re -f lavfi -i sine=frequency=216 -c:a libopus -ac 1 -b:a 32k -ar 48000 -f rtp rtp://0.0.0.0:5006

# Admin interface query of listeners and translators
# sess=$( curl --silent http://localhost:7088/admin --data '{"janus":"list_sessions","transaction":"'$RANDOM'","admin_secret":"xlationoverlord"}' -H "Content-Type: application/json" | grep -Po "[0-9]{8,}" )
# handles=$( for i in $( echo "$sess" ); do echo -n "$i/"; curl --silent http://localhost:7088/admin/$i --data '{"janus":"list_handles","transaction":"'$RANDOM'","admin_secret":"xlationoverlord"}' -H "Content-Type: application/json" | grep -A 1 -F "handles" | grep -Po "[0-9]{8,}"; done )
# lang_ids=$( for i in $( echo "$handles" ); do curl --silent http://localhost:7088/admin/$i --data '{"janus":"handle_info","transaction":"'$RANDOM'","admin_secret":"xlationoverlord"}' -H "Content-Type: application/json" | grep -P '"mountpoint_id"|"room"'; done | sort )

# Video loop creation
# ffmpeg -y -f lavfi -i color=size=130x36:rate=25:color=red -vf "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontsize=30:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:text='ON AIR'" -pix_fmt yuv420p -t 5 on-air.m4v

# ffmpeg -y -f lavfi -i color=size=130x36:duration=5:rate=25:color=ffbf00 -vf "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontsize=30:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:text='MUTED'" -pix_fmt yuv420p -t 5 muted.m4v

