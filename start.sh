#!/bin/bash
# Startet Icecast (nur intern) und die Node-App in einem Container.
# SENDE_TOKEN kommt aus dem Kubernetes-Secret, das Icecast-Passwort wird bei
# jedem Start neu gewürfelt (es verlässt den Container nie).
set -e
zufall() { head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
export ICECAST_SOURCE_PW="${ICECAST_SOURCE_PW:-$(zufall)}"
sed -e "s#@SOURCE_PW@#$ICECAST_SOURCE_PW#" -e "s#@RELAY_PW@#$(zufall)#" -e "s#@ADMIN_PW@#$(zufall)#" \
  /app/icecast.xml.vorlage > /tmp/icecast.xml
icecast2 -b -c /tmp/icecast.xml
# Kurz warten, bis Icecast lauscht
i=0; while [ $i -lt 20 ] && ! (echo > /dev/tcp/127.0.0.1/8000) 2>/dev/null; do i=$((i+1)); sleep 0.25; done
mkdir -p /app/daten/medien
exec node app.js
