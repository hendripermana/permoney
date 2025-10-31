# Memory Profiling and Monitoring
# This initializer monitors memory usage and detects potential leaks

if Rails.env.production? && defined?(Sentry)
  # Rails 8.1: Memory monitoring moved to MemoryMonitoringJob
  # This job runs every 5 minutes via Sidekiq Cron (see config/schedule.yml)
  # Replaced Thread.new to avoid issues with Puma's worker forking
  # See app/jobs/memory_monitoring_job.rb

  # Monitor GC performance
  GC::Profiler.enable if defined?(GC::Profiler)

  # Log GC statistics after each major GC
  if defined?(GC)
    # This is a simplified approach - in production you might want to use a gem like gc_tracer
    at_exit do
      if GC::Profiler.enabled?
        # Rails 8.1: GC::Profiler.report returns a string but we only need aggregates
        # Removed useless assignment - only total_time and gc_count are used in breadcrumb

        Sentry.add_breadcrumb(
          Sentry::Breadcrumb.new(
            category: "gc",
            message: "GC profiler report",
            data: {
              total_time: GC::Profiler.total_time,
              gc_count: GC.count
            },
            level: "info"
          )
        )
      end
    end
  end
end

# Check if jemalloc is available (compiled with Ruby)
# jemalloc should be configured at Ruby compilation level for optimal performance
# See docs/PERFORMANCE_GUIDE.md for installation instructions
if Rails.env.production? && defined?(Sentry)
  # Detect memory allocator
  allocator = if ENV["LD_PRELOAD"]&.include?("jemalloc") || ENV["DYLD_INSERT_LIBRARIES"]&.include?("jemalloc")
    "jemalloc"
  else
    "system_default"
  end

  Sentry.set_context(:memory_allocator, {
    allocator: allocator,
    ruby_version: RUBY_VERSION,
    platform: RUBY_PLATFORM
  })

  Rails.logger.info("Memory allocator: #{allocator}")
end
