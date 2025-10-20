# This configuration file will be evaluated by Puma. The top-level methods that
# are invoked here are part of Puma's configuration DSL. For more information
# about methods provided by the DSL, see https://puma.io/puma/Puma/DSL.html.
#
# Puma starts a configurable number of processes (workers) and each process
# serves each request in a thread from an internal thread pool.
#
# PERFORMANCE OPTIMIZATION:
# - Workers: Set to number of CPU cores for true parallelism
# - Threads: 3-5 per worker balances throughput and latency
# - Total capacity: workers × threads concurrent requests
# - Database pool must be >= (workers × threads) + Sidekiq concurrency

# Thread configuration
# Optimal: 3-5 threads per worker for Rails apps with ~50% I/O time
threads_count = ENV.fetch("RAILS_MAX_THREADS", 5).to_i
threads threads_count, threads_count

# Worker configuration
# Development: 2-4 workers, Production: 1 per CPU core
# Set WEB_CONCURRENCY=0 to disable cluster mode (single process)
workers_count = ENV.fetch("WEB_CONCURRENCY", 0).to_i
workers workers_count if workers_count > 0

# Preload application for memory efficiency via copy-on-write
# Only enable in cluster mode (workers > 0)
if workers_count > 0
  preload_app!

  # Reconnect to database after fork
  before_fork do
    ActiveRecord::Base.connection_pool.disconnect! if defined?(ActiveRecord)
  end

  on_worker_boot do
    ActiveRecord::Base.establish_connection if defined?(ActiveRecord)
  end
end

# Worker timeout configuration
# Kills workers that don't respond within timeout period
worker_timeout ENV.fetch("PUMA_WORKER_TIMEOUT", 60).to_i if workers_count > 0

# Worker boot timeout
# Time to wait for worker to boot before killing it
worker_boot_timeout ENV.fetch("PUMA_WORKER_BOOT_TIMEOUT", 60).to_i if workers_count > 0

# Specifies the `port` that Puma will listen on to receive requests; default is 3000.
port ENV.fetch("PORT", 3000)

# Specifies the `environment` that Puma will run in.
environment ENV.fetch("RAILS_ENV", "development")

# Allow puma to be restarted by `bin/rails restart` command.
plugin :tmp_restart

# Run the Solid Queue supervisor inside of Puma for single-server deployments
plugin :solid_queue if ENV["SOLID_QUEUE_IN_PUMA"]

# Specify the PID file. Defaults to tmp/pids/server.pid in development.
# In other environments, only set the PID file if requested.
pidfile ENV["PIDFILE"] if ENV["PIDFILE"]

# Logging
# Quiet mode reduces log verbosity in production
quiet if ENV["RAILS_ENV"] == "production"
