# Memory Monitoring Job
# Runs periodically to monitor memory usage and detect potential leaks
# Replaces Thread.new monitoring from config/initializers/memory_profiling.rb
#
# This job is production-safe and works correctly with Puma's worker forking
class MemoryMonitoringJob < ApplicationJob
  queue_as :low_priority

  # Rails 8.1: Job runs every 5 minutes via Sidekiq Cron
  # See config/schedule.yml for cron configuration
  def perform
    return unless Rails.env.production?
    return unless defined?(Sentry)

    begin
      # Get memory statistics
      memory_mb = get_memory_usage_mb

      # Get GC statistics
      gc_stat = GC.stat if defined?(GC)

      # Add breadcrumb with memory stats
      Sentry.add_breadcrumb(
        Sentry::Breadcrumb.new(
          category: "memory",
          message: "Memory statistics",
          data: {
            memory_mb: memory_mb.round(2),
            gc_count: gc_stat&.dig(:count),
            heap_live_slots: gc_stat&.dig(:heap_live_slots),
            heap_free_slots: gc_stat&.dig(:heap_free_slots),
            total_allocated_objects: gc_stat&.dig(:total_allocated_objects),
            major_gc_count: gc_stat&.dig(:major_gc_count),
            minor_gc_count: gc_stat&.dig(:minor_gc_count)
          },
          level: "info"
        )
      )

      # Alert on high memory usage (>1GB)
      if memory_mb > 1024
        Sentry.capture_message(
          "High Memory Usage",
          level: "warning",
          extra: {
            memory_mb: memory_mb.round(2),
            gc_stat: gc_stat
          },
          tags: {
            resource_type: "memory"
          }
        )
      end

      # Alert on potential memory leak (>2GB)
      if memory_mb > 2048
        Sentry.capture_message(
          "Potential Memory Leak",
          level: "error",
          extra: {
            memory_mb: memory_mb.round(2),
            gc_stat: gc_stat,
            process_id: Process.pid
          },
          tags: {
            resource_type: "memory",
            alert_type: "memory_leak"
          }
        )
      end

      # Monitor YJIT statistics if available
      if defined?(RubyVM::YJIT) && RubyVM::YJIT.enabled?
        yjit_stats = RubyVM::YJIT.runtime_stats

        Sentry.add_breadcrumb(
          Sentry::Breadcrumb.new(
            category: "yjit",
            message: "YJIT statistics",
            data: {
              compiled_iseq_count: yjit_stats[:compiled_iseq_count],
              compiled_block_count: yjit_stats[:compiled_block_count],
              invalidation_count: yjit_stats[:invalidation_count],
              inline_code_size: yjit_stats[:inline_code_size],
              outlined_code_size: yjit_stats[:outlined_code_size]
            },
            level: "info"
          )
        )
      end
    rescue => e
      Rails.logger.error("Memory monitoring error: #{e.message}")
      Sentry.capture_exception(e) if defined?(Sentry)
    end
  end

  private

    # Get current memory usage in MB
    def get_memory_usage_mb
      # Use ps command to get RSS (Resident Set Size) for current process
      rss_kb = `ps -o rss= -p #{Process.pid}`.to_i
      rss_kb / 1024.0
    rescue => e
      Rails.logger.warn("Failed to get memory usage: #{e.message}")
      0
    end
end

