# Staging / self-host image: build the static PWA, serve it with nginx.
# Dokku auto-detects this Dockerfile. HTTPS is terminated in front of the
# container (enable `dokku letsencrypt`) — a service worker requires a secure
# origin, so plain HTTP staging will not register the PWA.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Staging build: network-first SW + per-build cache id, so redeploys are always
# picked up on the next open (no stale shell hiding a fix under test).
RUN npm run build:staging

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
