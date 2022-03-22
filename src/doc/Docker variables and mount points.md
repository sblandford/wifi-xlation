# Variables


## EMAIL
#### Default: my@example.com
The valid contact email required for the Let's Encrypt certificate request.

## DOMAIN
#### Default: xlation.example.com
The domain that will used for the application. This must be a public domain for which you have control of the DNS records. Normally this domain will be over-ridden by a local DNS server on the LAN to access this application. Any public access of this domain could just be a holding page reminding people to connect via WiFi when inside the venue.

## HTTPS_ENABLE
#### Default: false
Enable SSL if possible. This is possible when either valid SSL certificate files are supplied or when Let's Encrypt has supplied the requested certificate files.

## SSL_CHAIN
User supplied SSL certificate chain

## SSL_KEY
User supplied SSL certificate key

## ADMIN_PASSWORD
#### Default: xlationoverlord
The Janus /admin password. It is recommended to set this to a non-default value in venues to keep Janus safe from mischievous people sneaking in who have studied the Dockerfile.

## HTTP_STATIC_PORT
#### Default: 80
Web server http listening port

## HTTPS_STATIC_PORT
#### Default: 443
Web server https listening port

## RTP_BASE_PORT
#### Default: 5000
First RTP port used for sending the Opus/RTP stream for broadcast to the listeners. An application such as ffmpeg can use this to send audio to a language channel instead of using the web interface to send audio. Each language increments the port number by 2 in the order in which they appear in the languages.conf file.

## BIND_IP_AND_PREFIX_LENGTH
#### Default: 0.0.0.0/24
Bind to a different IP to the Docker host. This is useful if the host is already listening on port 80/443 and you would like to still use these default ports for the application. One scenario where this may apply is when running this Docker container on a NAS that has an admin interface on the standard ports.

To use a different IP address this Docker container must be run with --net=host and --cap-add NET_ADMIN options.


# Useful mount points
## /etc/languages.conf
#### Default:  
```
#RTP Port,Language,Translator password
5000,English,secret
5002,Français,secret
5004,Deutsch,secret
5006,Español,secret
```

The file that specifies the languages and passwords. It is highly recommended to at least change the passwords from "secret" otherwise, by default, anyone can become an instant translator resulting in chaos.
