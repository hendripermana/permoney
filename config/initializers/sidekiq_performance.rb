# Sidekiq Performance Monitoring and Configuration
# This initializer configures Sidekiq monitoring and optimization features

if defined?(Sidekiq)
  redis_config = begin
    if ENV["REDIS_SENTINEL_HOSTS"].present?
      sentinels = ENV["REDIS_SENTINEL_HOSTS"].split(",").filter_map do |host_port|
        host, port_str = host_port.strip.split(":", 2)
        next if host.blank?

        port = if port_str.present?
          port_int = port_str.to_i
          (port_int > 0 && port_int <= 65_535) ? port_int : 26_379
        else
          26_379
        end

        { host: host.strip, port: port }
      end

      if sentinels.empty?
        Rails.logger.warn("REDIS_SENTINEL_HOSTS is set but no valid sentinel hosts found, falling back to REDIS_URL")
        {
          url: ENV.fetch("REDIS_URL", "redis://localhost:6379/0"),
          pool_timeout: 5,
          network_timeout: 5
        }
      else
        {
          url: "redis://#{ENV.fetch('REDIS_SENTINEL_MASTER', 'mymaster')}/0",
          sentinels: sentinels,
          password: ENV["REDIS_PASSWORD"],
          sentinel_username: ENV.fetch("REDIS_SENTINEL_USERNAME", "default"),
          sentinel_password: ENV["REDIS_PASSWORD"],
          role: :master,
          connect_timeout: 0.2,
          read_timeout: 1,
          write_timeout: 1,
          reconnect_attempts: 3,
          pool_timeout: 5,
          network_timeout: 5
        }
      end
    else
      {
        url: ENV.fetch("REDIS_URL", "redis://localhost:6379/0"),
        pool_timeout: 5,
        network_timeout: 5
      }
    end
  end

  # Configure Sidekiq server
  Sidekiq.configure_server do |config|
    # Redis connection configuration (supports Redis Sentinel for HA)
    config.redis = redis_config

    # Rails 8.1: Sidekiq queue monitoring moved to SidekiqQueueMonitoringJob
    # This job runs every minute via Sidekiq Cron (see config/schedule.yml)
    # Replaced Thread.new to avoid issues with Puma's worker forking
    # See app/jobs/sidekiq_queue_monitoring_job.rb
  end

  # Configure Sidekiq client
  Sidekiq.configure_client do |config|
    config.redis = redis_config
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
