# Synthetic Linux Chromium lifecycle test image (CI only, never deployed).
# Mirrors the production worker's runtime: same pinned base image digest as
# Dockerfile.worker, the same Playwright version (1.59.1, package.json), the same
# `npx playwright install --with-deps chromium`, and an exec-form CMD so node runs
# as PID 1 with no init process (as the worker does, Dockerfile.worker:85).
# No secrets, no application code, no network access beyond 127.0.0.1 at test time.
FROM node:22-bookworm-slim@sha256:6ed70fbf60557fb3a2faea5657d4105bace34c93449c2571919a1589fae30153
WORKDIR /t
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm init -y >/dev/null && npm install --no-audit --no-fund playwright@1.59.1
RUN npx playwright install --with-deps chromium
COPY lifecycle.js child.js ./
CMD ["node", "lifecycle.js"]
