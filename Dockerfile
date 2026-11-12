# Production image for Dokploy: a standalone Next.js server on Node 22.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
# Static pages bake the site address into their link previews at build time.
ARG SITE_URL=https://nobletxnancy.com
ENV NEXT_TELEMETRY_DISABLED=1 \
    SITE_URL=$SITE_URL
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Next signs each server action (the RSVP, wishes and admin forms) with a key. A key that stays the
# same from build to build keeps a form that was open across a deploy working. CI's main build
# passes it as the next_actions_key secret, read here for the build only, so it never sits in an
# environment variable or the image's history. Next writes it into the build's server manifest,
# which is all the server needs at runtime. With no secret, or an empty one, Next makes a random
# key, as every build did before.
RUN --mount=type=secret,id=next_actions_key \
    if [ -s /run/secrets/next_actions_key ]; then \
      NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(cat /run/secrets/next_actions_key)" npm run build; \
    else \
      npm run build; \
    fi

FROM node:22-alpine AS run
LABEL org.opencontainers.image.source=https://github.com/thenoblet/nona
# The commit this image was built from, reported by /api/healthz.
ARG GIT_SHA=dev
ENV APP_VERSION=$GIT_SHA
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/drizzle ./drizzle
USER nextjs
EXPOSE 3000
# Alpine has no curl, so the check uses Node's fetch against the no-I/O health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
