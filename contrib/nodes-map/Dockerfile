# Bitcoin Nodes World Map for the StartOS and Umbrel packages: page + hourly crawler in one
# process (service.js). Pure JavaScript, so it builds for any architecture quickly.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY crawl.js server.js service.js ./
COPY public ./public
ENV NODES_MAP_DATA_DIR=/data NODES_MAP_BIND=0.0.0.0 NODES_MAP_PORT=3110 TOR_PROXY=none
RUN mkdir -p /data && chown 1000:1000 /data
USER 1000
EXPOSE 3110
CMD ["node", "service.js"]
