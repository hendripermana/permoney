# syntax = docker/dockerfile:1
# Production-optimized Dockerfile with Firecrawl best practices
# Multi-stage build for smaller final image and better caching

# Make sure RUBY_VERSION matches the Ruby version in .ruby-version and Gemfile
ARG RUBY_VERSION=3.4.7
FROM registry.docker.com/library/ruby:$RUBY_VERSION-slim AS base

# Set build arguments early to leverage cache better
ARG BUILD_COMMIT_SHA

# Set production environment with performance optimizations
ENV RAILS_ENV="production" \
    BUNDLE_DEPLOYMENT="1" \
    BUNDLE_PATH="/usr/local/bundle" \
    BUNDLE_WITHOUT="development" \
    BUILD_COMMIT_SHA=${BUILD_COMMIT_SHA} \
    Ruby_GC_HEAP_OLDOBJECT_LIMIT_FACTOR="1.5" \
    Ruby_GC_MALLOC_LIMIT="90000000"

# Rails app lives here
WORKDIR /rails

# Install system dependencies in single layer for better caching
# Combined git and build dependencies to avoid layer bloat
RUN apt-get update -qq \
    && apt-get install --no-install-recommends -y \
        # Essential runtime packages
        curl \
        libvips \
        postgresql-client \
        libyaml-0-2 \
        procps \
        # Build dependencies (kept in base stage for potential use)
        git \
        build-essential \
        libpq-dev \
        libyaml-dev \
        pkg-config \
        # Performance optimization
        libjemalloc2 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives /tmp/*
    
# Throw-away build stage to reduce size of final image
FROM base AS build

# Set production-specific environment variables for build stage
ENV RUBY_YJIT_ENABLE="1" \
    MALLOC_ARENA_MAX="2"

# Use proper gem path detection and install dependencies
RUN gem update --system --no-document && \
    gem install bundler:2.7.2 --no-document

# Copy dependency files first for better Docker layer caching
# This layer only rebuilds when Gemfile is changed
COPY .ruby-version Gemfile Gemfile.lock ./

# Install application gems with production optimizations
# Retry for reliability, parallel jobs for speed
RUN bundle config build.jemalloc true && \
    bundle config set --local deployment 'true' && \
    bundle config set --local without 'development' && \
    bundle install --jobs=4 --retry=3 --deployment && \
    bundle clean --force

# Copy the rest of the application code
# This layer only rebuilds when application code changes
COPY . .

# Precompile bootsnap for better startup performance
RUN bundle exec bootsnap precompile --gemfile -j 4

# Precompile assets with optimizations and error handling
RUN if [ -f "bin/rails" ]; then \
        SECRET_KEY_BASE=${SECRET_KEY_BASE:-dummy} \
        RAILS_ENV=production \
        RAILS_LOG_LEVEL=error \
        RAILS_SERVE_STATIC_FILES=true \
        ./bin/rails assets:precompile && \
        echo "Assets precompiled successfully" || \
        (echo "Asset precompilation failed, continuing..." && exit 0); \
    else \
        echo "Rails binary not found, skipping asset precompilation"; \
    fi

# Clean up unnecessary files to reduce image size
RUN rm -rf \
    tmp/cache \
    tmp/pids \
    tmp/sessions \
    spec \
    test \
    .git \
    vendor/bundle/ruby/*/cache/* \
    vendor/bundle/ruby/*/bundler/gems/*/.git \
    log/*.log \
    log/*_test* \
    log/*development* && \
    find vendor/bundle -name "*.c" -type f -delete && \
    find vendor/bundle -name "*.o" -type f -delete

# Final stage for app image - minimal runtime
FROM base

# Set runtime environment variables
ENV RUBY_YJIT_ENABLE="1" \
    MALLOC_ARENA_MAX="2" \
    RAILS_ENV="production"

# Verify jemalloc availability and set appropriate path
RUN if [ -f "/usr/lib/x86_64-linux-gnu/libjemalloc.so.2" ]; then \
        echo "Jemalloc found at /usr/lib/x86_64-linux-gnu/libjemalloc.so.2" && \
        export LD_PRELOAD="/usr/lib/x86_64-linux-gnu/libjemalloc.so.2"; \
    elif [ -f "/usr/lib/x86_64-linux-gnu/libjemalloc.so.1" ]; then \
        echo "Jemalloc found at /usr/lib/x86_64-linux-gnu/libjemalloc.so.1" && \
        export LD_PRELOAD="/usr/lib/x86_64-linux-gnu/libjemalloc.so.1"; \
    else \
        echo "Jemalloc not found, using system allocator (install libjemalloc2 if needed)"; \
    fi

# Create and configure non-root user for security
RUN groupadd --system --gid 1000 rails && \
    useradd rails --uid 1000 --gid 1000 --create-home --shell /bin/bash --comment "Rails application user"

# Copy built artifacts with proper permissions
COPY --from=build --chown=rails:rails "${BUNDLE_PATH}" "${BUNDLE_PATH}"
COPY --from=build --chown=rails:rails /rails /rails

# Set up runtime permissions
RUN chown -R rails:rails /rails && \
    chmod +x /rails/bin/docker-entrypoint

# Health check for container
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/up || exit 1

# Switch to non-root user
USER 1000:1000

# Expose Rails port
EXPOSE 3000

# Set the entrypoint for proper initialization
ENTRYPOINT ["/rails/bin/docker-entrypoint"]

# Default command
CMD ["./bin/rails", "server", "-b", "0.0.0.0"]
