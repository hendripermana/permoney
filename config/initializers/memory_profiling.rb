# Memory Profiling and Monitoring
# This initializer monitors memory usage and detects potential leaks

if Rails.env.production? && defined?(Sentry)
  # Monitor memory usage periodically
  Thread.new do
    loop do
      sleep 300 # Every 5 minutes

      begin
        # Get memory statistics
        if defined?(GC)
          gc_stat = GC.stat

          # Calculate memory usage
          memory_mb = `ps -o rss= -p #{Process.pid}`.to_i / 1024.0

          # Add breadcrumb with memory stats
          Sentry.add_breadcrumb(
            Sentry::Breadcrumb.new(
              category: "memory",
              message: "Memory statistics",
              data: {
                memory_mb: memory_mb.round(2),
                gc_count: gc_stat[:count],
                heap_live_slots: gc_stat[:heap_live_slots],
                heap_free_slots: gc_stat[:heap_free_slots],
                total_allocated_objects: gc_stat[:total_allocated_objects],
                major_gc_count: gc_stat[:major_gc_count],
                minor_gc_count: gc_stat[:minor_gc_count]
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
        Rails.logger.error("Memory profiling error: #{e.message}")
      end
    end
  end if defined?(Thread)

  # Monitor GC performance
  GC::Profiler.enable if defined?(GC::Profiler)

  # Log GC statistics after each major GC
  if defined?(GC)
    # This is a simplified approach - in production you might want to use a gem like gc_tracer
    at_exit do
      if GC::Profiler.enabled?
        gc_report = GC::Profiler.report

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

# Configure jemalloc if available
if defined?(Jemalloc)
  # jemalloc is automatically used when the gem is loaded
  # No additional configuration needed
  Rails.logger.info("jemalloc memory allocator enabled")

  # Add jemalloc stats to Sentry context
  if Rails.env.production? && defined?(Sentry)
    Sentry.set_context(:memory_allocator, {
      allocator: "jemalloc",
      version: Jemalloc::VERSION
    })
  end
end
