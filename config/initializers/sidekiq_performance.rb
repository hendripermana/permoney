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

    # Rails 8.1: Sidekiq queue monitoring moved to SidekiqQueueMonitoringJob
    # This job runs every minute via Sidekiq Cron (see config/schedule.yml)
    # Replaced Thread.new to avoid issues with Puma's worker forking
    # See app/jobs/sidekiq_queue_monitoring_job.rb
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
