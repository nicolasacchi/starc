# syntax=docker/dockerfile:1
# check=error=true

# This Dockerfile is designed for production. The build context is the REPOSITORY
# ROOT, not server/, because one image has to be assembled from all three trees:
# server/ (Rails), client/ (the vite SPA) and shared/ (the roster both sides read).
#
#   docker build -f server/Dockerfile -t starc .
#   docker run -d -p 3000:3000 -e RAILS_MASTER_KEY=<value from server/config/master.key> --name starc starc
#
# For a containerized dev environment, see Dev Containers: https://guides.rubyonrails.org/getting_started_with_devcontainer.html

# Make sure RUBY_VERSION matches the Ruby version in server/.ruby-version
ARG RUBY_VERSION=3.4.10

# ---------------------------------------------------------------------------
# Client build. `bun run build` (tsc && vite build) emits client/dist, which the
# final stage drops into the Rails app's public/ so this same process serves the
# SPA, the API and the cable on one origin.
# ---------------------------------------------------------------------------
FROM docker.io/oven/bun:1 AS client

WORKDIR /client

# client/bun.lock is a bun lockfile, so bun is the package manager here — npm
# cannot install from it. Manifests first, sources second, so an edit under
# src/ reuses the dependency layer.
COPY client/package.json client/bun.lock ./
RUN bun install --frozen-lockfile

COPY client/ ./
# vite.config.ts and tsconfig.json alias @data to ../shared/game-data.json and
# @data/maps to ../shared/data/maps.json. Those are relative to the client
# directory, so shared/ has to sit next to it at /shared for both the aliases
# and the build to resolve.
COPY shared/ /shared/

RUN bun run build

# ---------------------------------------------------------------------------
# Rails base image, shared by the gem build stage and the final image.
# ---------------------------------------------------------------------------
FROM docker.io/library/ruby:$RUBY_VERSION-slim AS base

# Rails app lives here
WORKDIR /rails

# Install base packages
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y curl libjemalloc2 sqlite3 && \
    ln -s /usr/lib/$(uname -m)-linux-gnu/libjemalloc.so.2 /usr/local/lib/libjemalloc.so && \
    rm -rf /var/lib/apt/lists /var/cache/apt/archives

# Set production environment variables and enable jemalloc for reduced memory usage and latency.
ENV RAILS_ENV="production" \
    BUNDLE_DEPLOYMENT="1" \
    BUNDLE_PATH="/usr/local/bundle" \
    BUNDLE_WITHOUT="development" \
    LD_PRELOAD="/usr/local/lib/libjemalloc.so"

# Throw-away build stage to reduce size of final image
FROM base AS build

# Install packages needed to build gems
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential git libyaml-dev pkg-config && \
    rm -rf /var/lib/apt/lists /var/cache/apt/archives

# Install application gems. server/.bundle is excluded by .dockerignore, so the
# BUNDLE_PATH above — not the checked-in vendor/bundle — decides where they land.
COPY server/vendor/ ./vendor/
COPY server/Gemfile server/Gemfile.lock ./

RUN bundle install && \
    rm -rf ~/.bundle/ "${BUNDLE_PATH}"/ruby/*/cache "${BUNDLE_PATH}"/ruby/*/bundler/gems/*/.git && \
    # -j 1 disable parallel compilation to avoid a QEMU bug: https://github.com/rails/bootsnap/issues/495
    bundle exec bootsnap precompile -j 1 --gemfile

# Copy application code: server/ only, so client/ and shared/ do not end up in
# /rails alongside the Rails app.
COPY server/ ./

# Precompile bootsnap code for faster boot times.
# -j 1 disable parallel compilation to avoid a QEMU bug: https://github.com/rails/bootsnap/issues/495
RUN bundle exec bootsnap precompile -j 1 app/ lib/

# ---------------------------------------------------------------------------
# Final stage for app image
# ---------------------------------------------------------------------------
FROM base

# Run and own only the runtime files as a non-root user for security
RUN groupadd --system --gid 1000 rails && \
    useradd rails --uid 1000 --gid 1000 --create-home --shell /bin/bash

# Copy built artifacts: gems, application. These run as root, so the chown of
# the runtime directories below still works.
COPY --chown=rails:rails --from=build "${BUNDLE_PATH}" "${BUNDLE_PATH}"
COPY --chown=rails:rails --from=build /rails /rails

# The built SPA. Copied after /rails so it is not overwritten; client/public
# (favicon.svg, icons.svg) is already in the build stage's public/, and
# config.public_file_server.enabled serves the whole directory.
COPY --chown=rails:rails --from=client /client/dist/ /rails/public/

# The roster, for Starc::GameData and Starc::Maps. Both resolve it as
# Rails.root.join("..", "shared"), which from /rails is /shared at the
# filesystem root — so it has to be at /shared, not /rails/shared.
COPY --chown=rails:rails shared/ /shared/

# The app runs as uid 1000 and the entrypoint runs `db:prepare` before the
# server boots, so every directory it writes to has to belong to that user:
# storage/ holds storage/production.sqlite3, log/ the tagged log, tmp/ the
# bootsnap cache, db/ the schema dump. storage/ and log/ contents are excluded
# by .dockerignore, hence the mkdir.
RUN mkdir -p db log storage tmp && \
    chown -R rails:rails db log storage tmp

USER 1000:1000

# Entrypoint prepares the database.
ENTRYPOINT ["/rails/bin/docker-entrypoint"]

# Start the Rails server by default; this can be overwritten at runtime.
# config/puma.rb reads `port ENV.fetch("PORT", 3000)`, so this is the port the
# process listens on inside the container — traefik targets it from outside.
EXPOSE 3000
CMD ["./bin/rails", "server"]
