# Sidekiq Performance Monitoring and Configuration
# This initializer configures Sidekiq monitoring and optimization features

if defined?(Sidekiq)
  # Configure Sidekiq server
  Sidekiq.configure_server do |config|
    # Redis connection configuration
    redis_url = ENV.fetch("REDIS_URL", "redis://localhost:6379/0")
    config.redis = {
      url: redis_url,
      pool_timeout: 5,
      network_timeout: 5
    }

    # Add custom monitoring
    if Rails.env.production? && defined?(Sentry)
      # Monitor queue depths
      Thread.new do
        loop do
          sleep 60 # Every minute

          begin
            stats = Sidekiq::Stats.new

            # Alert on high queue depth
            if stats.enqueued > 1000
              Sentry.capture_message(
                "High Sidekiq Queue Depth",
                level: "warning",
                extra: {
                  enqueued: stats.enqueued,
                  processed: stats.processed,
                  failed: stats.failed,
                  retry_size: stats.retry_size,
                  dead_size: stats.dead_size
                },
                tags: {
                  resource_type: "sidekiq_queue"
                }
              )
            end

            # Alert on high retry queue
            if stats.retry_size > 100
              Sentry.capture_message(
                "High Sidekiq Retry Queue",
                level: "warning",
                extra: {
                  retry_size: stats.retry_size,
                  enqueued: stats.enqueued
                },
                tags: {
                  resource_type: "sidekiq_retry"
                }
              )
            end

            # Alert on dead jobs
            if stats.dead_size > 50
              Sentry.capture_message(
                "High Sidekiq Dead Job Count",
                level: "error",
                extra: {
                  dead_size: stats.dead_size
                },
                tags: {
                  resource_type: "sidekiq_dead"
                }
              )
            end
          rescue => e
            Rails.logger.error("Sidekiq monitoring error: #{e.message}")
          end
        end
      end if defined?(Thread)
    end
  end

  # Configure Sidekiq client
  Sidekiq.configure_client do |config|
    redis_url = ENV.fetch("REDIS_URL", "redis://localhost:6379/0")
    config.redis = {
      url: redis_url,
      pool_timeout: 5,
      network_timeout: 5
    }
  end

  # Add job performance tracking
  if Rails.env.production? && defined?(Sentry)
    Sidekiq.configure_server do |config|
      config.server_middleware do |chain|
        chain.add(Class.new do
          def call(worker, job, queue)
            start_time = Time.current

            begin
              yield
            ensure
              duration = Time.current - start_time

              # Track slow jobs (>30 seconds)
              if duration > 30
                Sentry.capture_message(
                  "Slow Sidekiq Job",
                  level: "warning",
                  extra: {
                    worker: worker.class.name,
                    queue: queue,
                    duration_seconds: duration.round(2),
                    jid: job["jid"],
                    args: job["args"]
                  },
                  tags: {
                    job_type: "slow_job",
                    queue: queue
                  }
                )
              end
            end
          end
        end)
      end
    end
  end
end
