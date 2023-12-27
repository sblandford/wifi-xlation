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

## HIDE_OFFAIR
#### Default: false
Hide any RX channels that are not currently active instead of showing them greyed out

## NAT_1_1_MAPPING
If set, the nat_1_1_mapping is set to the given IP address and keep_private_host is set to "false". This is useful for EC2 instances that are configured with a 1:1 NAT, in which case, set this variable to the public IP address

# Useful mount points
## /etc/languages.conf
#### Default:  
```
#RTP Port,Language,Translator password
5006+5008,Video channel,vp8
5010,*Stage,secret
5012,English,secret
5014,Français,secret
5016,Deutsch,secret
5018,Español,secret
```

The file that specifies the languages and passwords. It is highly recommended to at least change the passwords from "secret" otherwise, by default, anyone can become an instant translator resulting in chaos.

If a channel is going to be used for music or if the echo cancellation and noise reduction is not required, then preprend an asterisk to the language name, e.g. *Stage. This will modify the behaviour of the broadcast to switch off the echo cancellation and noise reduction.

If sending external audio to an RTP port then the RTP Payload type must be 96 and the codec must be Opus. See the test-tones.sh script.

#### The video channel

It is possible to send a video channel to the translators so that they can see what is going on if they are not in the same room or operating remotely e.g via a VPN. There are three ways to specify the video channel.

The channel becomes visible to the translator once the translator starts broadcasting.

If the translator is working over a VPN, for example, then it is especially recommended to keep the video picture size small and the video bandwidth low to prevent disruption to the audio to and from the translator. This also applies if the translators are known to be using small devices such as phones where the picture will be small anyway. If, however, the translators are on the same LAN and are using HD monitors then maybe more bandwidth and picture size would be justified.

The video will appear in the Receive part of the web page and has standard HTML5 controls visible including full screen. Most phones will automatically switch to full screen mode if the phone is positioned horizontally.

The video channel is hidden from the channel lists since it is not intended for viewing except by translators.

##### Video RTP the reserved language name, "Video Channel"

The video is sent to the specified port using the codec specified in the Translator Password column. The RTP Payload type must be 98 and the video codec must be VP8 or VP9. See the test-tones.sh script.

```
5016,Video channel,vp8
```

##### Audio and video RTP the reserved language name, "Video Channel"

```
5016+5018,Video channel,vp8
```

The audio is sent to the first specified port and the video is sent to the second specified port. This enables the stage sound and video to appear in sync to the translator, which it might not do if they just watch the video and play the "Stage" audio channel together.

If the translator is not translating from the stage but from another language, in relay, then when they play the language they wish to translate from the audio from the video channel is dimmed so that they can hear it in the background.

##### Video, and optionally audio, pulled from an RTSP server

```
0000,rtsp://localhost:8554/mystream,null
```

If a port number of 0000 is given, then an RTSP location can be specified in the Language name column. This should not be in quotes. The codecs supported are Opus for the audio and VP8/VP9 for the video. Unfortunately, this will not work directly from a streaming camera since they will most likely be streaming using H264/H265 and AAC codecs.

