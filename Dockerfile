# Immutable image for the static site, ask endpoint and its gateway.
#
# The release id is baked in at build time and reported by the liveness path, which is what
# lets scripts/release.mjs prove that the traffic switch actually took effect
# rather than assuming it did.

FROM node:22.23.2-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: an extracted app must not run arbitrary postinstall code on a
# production build host. Anything genuinely needed belongs in an explicit step.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22.23.2-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=127.0.0.1 PORT=5372
ARG RELEASE_ID=local-v1
ENV APP_RELEASE_ID=$RELEASE_ID
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/gateway/identity.mjs ./gateway/identity.mjs
# The model connections the admin page saves, and the usage log. A volume in
# production (deploy/compose.yaml); created here, owned by node, so a new named
# volume starts with the right owner.
ENV LOCAL_PLAN_NAVIGATOR_STATE_DIR=/var/lib/local-plan-navigator
RUN mkdir -p /var/lib/local-plan-navigator && chown node:node /var/lib/local-plan-navigator
USER node
EXPOSE 5372
CMD ["node", "server/start.mjs"]
