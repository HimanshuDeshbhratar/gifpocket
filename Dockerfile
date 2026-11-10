# Works on any Docker host (Railway, Fly.io, a Hostinger VPS…).
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# ffmpeg-static downloads its Linux ffmpeg binary during install.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
