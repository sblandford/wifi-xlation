#!/bin/bash
DOCKER_NAME="wifi-xlation"
IMAGE_TAG="simonblandford/wifi-xlation:latest"
path=$( pwd )

usage () {
    echo "$( basename "$0" ) <start|stop|status|remove> [--letsencript|acme <domain> <email> | --ssl] [--ip <ip address> | --portshift <integer>] [--dev] [--custom] [--daemon] [-dummy]
        start
            Start a new or existing $DOCKER_NAME docker.
            If starting an existing docker then all further command line options will be ignored.
        stop
            Stop a running $DOCKER_NAME docker.
        status
            Show the status of the $DOCKER_NAME docker.
        remove
            Delete a running or stopped $DOCKER_NAME docker. Required to run under different command line arguments.
        --letsencript <domain> <email>
            Invoke Letsencyrpt to create a certificate for <domain> with a contact email <email>.
            This is invoked for renewal if an existing certificate is found.
            Once the docker is started, the renewal status can be checked at http(s)://<domain>/acme.
            If there is no existing certificate then instructions for the required DNS TXT message are displayed.
        --ssl
            Use user-supplied fullchain and key from cust/ssl/fullchain.crt and cust/ssl/private.key.
        --ip
            Try to add a virtual IP to the host and listen on that instead of the host IP.
            This is intended for hosts where port 80 and 443 are already occupied and
            a friendly URL without a port number in it are required.
        --portshift <integer>
            If port 80 and 443 are occupied then add an integer e.g. 8000 for ports 8080 and 8443.
        --dev
            Development mode.
            Instead of using the HTML files built with the docker mount the src/html directory.
            This enables real-time fiddling of the web frontend without having to rebuild the docker
            after every change.
        --custom
            Use a custom language file cust/conf/languages.conf instead of the default internal languages.conf.
            This enables the list of languages and language passwords to be set up.
        --daemon
            Don't attach the terminal to the docker. It will run in the background
        --dummy
            Don't actually run the docker but just print out the command that would run the docker.
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
        --letsencrypt|--acme)
            [[ "$options" =~ HTTPS_ENABLE ]] && dupe
            domain=$1
            email=$2
            shift
            shift
            if ! [[ "${domain,,}" =~ ^[0-9a-z-]+\.[0-9a-z.-]+$ ]]; then
                echo "Invalid domain name : $domain"
                usage
            fi
            if ! [[ "${email,,}" =~ ^[0-9a-z.-]+@[0-9a-z.-]+$ ]]; then
                echo "Invalid email address : $email"
                usage
            fi
            acme=true
            ;;
        --ip)
            [[ "$options" =~ net=host ]] && dupe
            ippl=$1
            shift
            if ! [[ "$ippl" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}\/[0-9]{1,2}$ ]]; then
                echo "Invalid IPv4 address : $ippl"
                usage
            fi
            options="$options --net=host --cap-add NET_ADMIN "
            options="$options -e BIND_IP_AND_PREFIX_LENGTH=$ippl "
            ;;
        --portshift)
            [[ $offset ]] && dupe
            offset=$1
            if ! [[ "$offset" =~ ^[0-9]{3,4}$ ]]; then
                echo "Invalid port offset : $offset"
                usage
            fi
            ;;
        --dev)
            [[ "$options" =~ src/html ]] && dupe
            options="$options -v $path/src/bin/xlation.sh:/usr/local/bin/xlation.sh "
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
            if [[ -f cust/ssl/fullchain.crt ]] && [[ -f cust/ssl/private.key ]]; then
                options="$options SSL_CHAIN=cust/ssl/fullchain.crt "
                options="$options SSL_KEY=cust/ssl/private.key "
                options="$options -e HTTPS_ENABLE=true "
            else
                echo "Unable to find cust/ssl/fullchain.crt and cust/ssl/private.key"
                usage
            fi
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

# If just one domain exists then re-activate letencrypt automatically
if [[ ! $domain ]] && [[ ! $email ]] && [[ $( ls -1 cust/ssl | grep -P "^[0-9a-z-]+\.[0-9a-z\.-]+$" | wc -l ) -eq 1 ]]; then
    domain=$( ls -1 cust/ssl | grep -P "^[0-9a-z-]+\.[0-9a-z\.-]+$" )
    email=$( grep -Po "(?<=CA_EMAIL=')[^']+" cust/ssl/ca/*/directory/ca.conf | head -n 1)
    acme=true
fi

if [[ $acme ]]; then
    options="$options -e EMAIL=$email "
    options="$options -e DOMAIN=$domain -e HTTPS_ENABLE=true "
    mkdir -p cust/ssl
    options="$options -v $path/cust/ssl:/etc/ssl/acme"
fi

if [[ $offset ]]; then
    if [[ ! "$options" =~ net=host ]]; then
        echo "Portshift can not be specified with --ip option"
        usage
    fi
else
    offset=0
    options="$options -p $(( offset + 80)):80/tcp -p $(( offset + 443)):443/tcp "
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
            if [[ $acmetrigger ]]; then
                echo "Re-using Letsencyrpt for $domain"
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


#ffmpeg -re -f lavfi -i sine=frequency=216 -c:a libopus -ac 1 -b:a 32k -ar 48000 -f rtp rtp://0.0.0.0:5000

# Admin interface query of listeners and translators
# sess=$( curl --silent http://localhost:7088/admin --data '{"janus":"list_sessions","transaction":"'$RANDOM'","admin_secret":"xlationoverlord"}' -H "Content-Type: application/json" | grep -Po "[0-9]{8,}" )
# handles=$( for i in $( echo "$sess" ); do echo -n "$i/"; curl --silent http://localhost:7088/admin/$i --data '{"janus":"list_handles","transaction":"'$RANDOM'","admin_secret":"xlationoverlord"}' -H "Content-Type: application/json" | grep -A 1 -F "handles" | grep -Po "[0-9]{8,}"; done )
# lang_ids=$( for i in $( echo "$handles" ); do curl --silent http://localhost:7088/admin/$i --data '{"janus":"handle_info","transaction":"'$RANDOM'","admin_secret":"xlationoverlord"}' -H "Content-Type: application/json" | grep -P '"mountpoint_id"|"room"'; done | sort )

# Video loop creation
# ffmpeg -y -f lavfi -i color=size=130x36:rate=25:color=red -vf "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontsize=30:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:text='ON AIR'" -pix_fmt yuv420p -t 5 on-air.m4v

# ffmpeg -y -f lavfi -i color=size=130x36:duration=5:rate=25:color=ffbf00 -vf "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontsize=30:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:text='MUTED'" -pix_fmt yuv420p -t 5 muted.m4v

#ffmpeg -re -f lavfi -i testsrc=size=640x320:rate=30 -f lavfi -i sine=f=220:b=1 -af volume=0.1 -c:a libopus -b:a 64k -vn -f rtp rtp://0.0.0.0:5006 -c:v vp8 -b:v 800000 -an -f rtp rtp://0.0.0.0:5008
