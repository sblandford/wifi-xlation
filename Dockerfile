FROM debian:sid-slim

ENV DOMAIN=xlation.example.com
ENV HTTPS_ENABLE=false
ENV SSL_CHAIN=
ENV SSL_KEY=
ENV AWS_ACCESS_KEY_ID=
ENV AWS_SECRET_ACCESS_KEY=
ENV AWS_DEFAULT_REGION=
ENV ADMIN_PASSWORD=xlationoverlord
ENV HTTP_STATIC_PORT=80
ENV HTTPS_STATIC_PORT=443
ENV JANUS_DEBUG_LEVEL=4
ENV IGNORE_MDNS=false

COPY src/html/ /var/www/html/
COPY src/conf/languages.conf /etc/languages.conf
COPY src/bin/xlation.sh /usr/local/bin/xlation.sh
RUN chmod 0755 /usr/local/bin/xlation.sh
RUN apt update -y && apt install -y \
    janus \
    libjs-janus-gateway \
    nginx \
    curl \
    iproute2 \
    less \
    nano \
    s3cmd \
    && rm -rf /var/lib/apt/lists/*
RUN cp /usr/share/javascript/janus-gateway/janus.js /var/www/html/js/janus.js

EXPOSE 80/tcp
EXPOSE 443/tcp
EXPOSE 5006-5050/udp

CMD /usr/local/bin/xlation.sh

