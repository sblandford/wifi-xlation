# Variables

## DOMAIN
#### Default: xlation.example.com
The domain that will used for the application. This must be a public domain for which you have control of the DNS records. Normally this domain will be over-ridden by a local DNS server on the LAN to access this application. Any public access of this domain could just be a holding page reminding people to connect via WiFi when inside the venue.

## QR_CODE_URL
The URL that the QR code shown by the QR button will point to. If left blank then it simply shows the current URL

## HTTPS_ENABLE
#### Default: false
Enable SSL if possible. This is possible when valid SSL certificate files are supplied

## SSL_CHAIN
User supplied SSL certificate chain. This can be a file on a mounted directory or an S3 location in s3:// format

## SSL_KEY
User supplied SSL certificate key. This can be a file on a mounted directory or an S3 location in s3:// format

## AWS_ACCESS_KEY_ID
Access key used for fetching SSL_CHAIN and SSL_KEY from an s3:// bucket location

## AWS_SECRET_ACCESS_KEY
Secret key used for fetching SSL_CHAIN and SSL_KEY from an s3:// bucket location

## AWS_DEFAULT_REGION
Region in which S3 bucket is located

## ADMIN_PASSWORD
#### Default: xlationoverlord
The Janus /admin password. It is recommended to set this to a non-default value in venues to keep Janus safe from mischievous people sneaking in who have studied the Dockerfile.

## HTTP_STATIC_PORT
#### Default: 80
Web server http listening port

## HTTPS_STATIC_PORT
#### Default: 443
Web server https listening port

## BIND_IP4
#### Default: 0.0.0.0
IP for Nginx to bind to

## JANUS_DEBUG_LEVEL
#### Default: 4
Verbosity of Janus output. 0=none, 7=verbose

## IGNORE_MDNS
#### Default: false
Useful to set true if clients aren't in the same local network

## STUN_SERVER
#### Default: stun.l.google.com
Stun server hostname

## STUN_PORT
#### Default: 19302
Stun server port

## STUN_IGNORE_FAIL
#### Default: true
Do not produce a fatal error on start if stun server can not be reached

## MAX_HTTP_CONNS
#### Default: 32768
Open connections limit in libmicrohttpd used by janus.transport.http

## WEBSOCKETS
#### Default: false
Use Websockets instead of REST API to contact Janus

## VIDEO_SCREEN_KEEPER_RX
#### Default: false
Play a looped video while audio is playing to prevent screen going to sleep

## VIDEO_SCREEN_KEEPER_TX
#### Default: true
Play a looped video while translating to prevent screen going to sleep

## TIMOUT_URL
URL to jump to when server becomes unresponsive e.g. when leaving venue & WiFi

## MULTICAST_IP4
Multicast IP4 address to use as the output of the translation rooms and the input to the streaming server

## HIDE_MIC
#### Default: false
Hide the translator microphone icon by default which can then be changed by /xlator.html

## NAT_1_1_MAPPING
If set, the nat_1_1_mapping is set to the given IP address and keep_private_host is set to "false". This is useful for EC2 instances that are configured with a 1:1 NAT, in which case, set this variable to the public IP address

# Useful mount points
## /etc/languages.conf
#### Default:  
```
#RTP Port,Language,Translator password
5006,English,secret
5008,Français,secret
5010,Deutsch,secret
5012,Español,secret
```

The file that specifies the languages and passwords. It is highly recommended to at least change the passwords from "secret" otherwise, by default, anyone can become an instant translator resulting in chaos.

