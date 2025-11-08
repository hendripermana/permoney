# syntax = docker/dockerfile:1

# Make sure RUBY_VERSION matches the Ruby version in .ruby-version and Gemfile
ARG RUBY_VERSION=3.4.7
FROM registry.docker.com/library/ruby:$RUBY_VERSION-slim AS base

# Rails app lives here
WORKDIR /rails

# Install base packages with performance optimizations
RUN apt-get update -qq \
    && apt-get install --no-install-recommends -y \
        curl \
        libvips \
        postgresql-client \
        libyaml-0-2 \
        procps \
        libjemalloc2 \
        build-essential \
        libpq-dev \
    && rm -rf /var/lib/apt/lists /var/cache/apt/archives

# Set production environment with performance optimizations
ARG BUILD_COMMIT_SHA
ENV RAILS_ENV="production" \
    BUNDLE_DEPLOYMENT="1" \
    BUNDLE_PATH="/usr/local/bundle" \
    BUNDLE_WITHOUT="development" \
    BUILD_COMMIT_SHA=${BUILD_COMMIT_SHA} \
    # Performance optimizations
    RUBY_YJIT_ENABLE="1" \
    RUBY_GC_HEAP_OLDOBJECT_LIMIT_FACTOR="1.5" \
    RUBY_GC_MALLOC_LIMIT="900*10000" \
    MALLOC_ARENA_MAX="2" \
    LD_PRELOAD="/usr/lib/x86_64-linux-gnu/libjemalloc.so.2" \
    # TailwindCSS optimizations
    RAILS_MASTER_KEY="" \
    SECRET_KEY_BASE_DUMMY="1"
    
# Throw-away build stage to reduce size of final image
FROM base AS build

# Install additional packages needed to build gems (already installed in base, but keeping explicit)
# This is a no-op in our optimized version since they're installed in the base stage

# Update to Bundler 2.7.2 to match Gemfile.lock
RUN gem update --system --no-document && \
    gem install bundler:2.7.2 --no-document

# Install application gems with production optimizations
COPY .ruby-version Gemfile Gemfile.lock ./
RUN bundle install --jobs=4 --retry=3 \
    && rm -rf ~/.bundle/ "${BUNDLE_PATH}"/ruby/*/cache "${BUNDLE_PATH}"/ruby/*/bundler/gems/*/.git \
    && bundle exec bootsnap precompile --gemfile -j 4

# Copy application code
COPY . .

# Precompile bootsnap code for faster boot times
RUN bundle exec bootsnap precompile -j 4 app/ lib/

# Precompiling assets for production with optimizations
# Use parallel compilation and disable unnecessary features for faster builds
RUN SECRET_KEY_BASE_DUMMY=1 \
    RAILS_ENV=production \
    RAILS_LOG_LEVEL=error \
    ./bin/rails assets:precompile \
    && echo "Assets precompiled successfully"

# Clean up build artifacts to reduce image size
RUN rm -rf tmp/cache tmp/pids tmp/sessions spec test \
    && rm -rf log/*.log log/*_test* log/*development*

# Final stage for app image
FROM base

# Run and own only the runtime files as a non-root user for security
RUN groupadd --system --gid 1000 rails && \
    useradd rails --uid 1000 --gid 1000 --create-home --shell /bin/bash
USER 1000:1000

# Copy built artifacts: gems, application
COPY --chown=rails:rails --from=build "${BUNDLE_PATH}" "${BUNDLE_PATH}"
COPY --chown=rails:rails --from=build /rails /rails

# Entrypoint prepares the database.
ENTRYPOINT ["/rails/bin/docker-entrypoint"]

# Start the server by default, this can be overwritten at runtime
EXPOSE 3000
CMD ["./bin/rails", "server"]
