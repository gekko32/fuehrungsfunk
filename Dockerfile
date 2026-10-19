# Führungsfunk: Node-App + ffmpeg (Umwandlung) + Icecast (nur intern) in einem Container.
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg icecast2 bash \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY app.js guide.js hoeren.html senden.html guide.html verwalten.html icecast.xml.vorlage start.sh ./
RUN chmod +x start.sh && mkdir -p /app/daten && chown -R node:node /app/daten
USER node
ENV PORT=8090
EXPOSE 8090
CMD ["bash", "/app/start.sh"]
