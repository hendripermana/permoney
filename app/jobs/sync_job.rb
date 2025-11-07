require "timeout"

# PERMANENT SOLUTION: Production-ready SyncJob dengan idempotency, error handling, dan performance optimization
# Best Practices:
# 1. Fully idempotent - bisa dijalankan berkali-kali tanpa side effects
# 2. Comprehensive error handling dengan proper retry strategy
# 3. Timeout protection untuk mencegah stuck jobs
# 4. State validation sebelum dan sesudah execution
# 5. Proper logging untuk monitoring dan debugging
class SyncJob < ApplicationJob
  queue_as :high_priority

  # Retry strategy sesuai Sidekiq best practices
  # Deadlocks: retry dengan exponential backoff
  retry_on ActiveRecord::Deadlocked, wait: :exponentially_longer, attempts: 5
  retry_on ActiveRecord::LockWaitTimeout, wait: :exponentially_longer, attempts: 3
  retry_on ActiveRecord::ConnectionNotEstablished, wait: 2.seconds, attempts: 3
  retry_on Redis::ConnectionError, wait: 2.seconds, attempts: 3

  # Discard jobs yang tidak bisa di-deserialize (sync sudah dihapus)
  discard_on ActiveJob::DeserializationError do |job, error|
    Rails.logger.warn("Discarding SyncJob - sync record no longer exists: #{error.message}")
  end

  # Timeout untuk mencegah sync stuck selamanya
  # Menggunakan Sidekiq timeout (90 detik) + buffer untuk finalization
  TIMEOUT_THRESHOLD = 85.seconds

  # IDEMPOTENCY: Job ini fully idempotent - bisa dijalankan berkali-kali tanpa masalah
  # State validation memastikan sync hanya dijalankan jika dalam state yang valid
  def perform(sync)
    # Reload sync untuk memastikan state terbaru (idempotency check)
    sync_record = load_sync_record(sync)
    return unless sync_record

    # IDEMPOTENCY CHECK: Cek state sebelum execution
    unless sync_record.may_start?
      Rails.logger.info("Sync #{sync_record.id} already processed (status: #{sync_record.status}). Skipping (idempotent).")
      return
    end

    # Execute dengan timeout protection
    execute_with_timeout(sync_record)
  rescue Timeout::Error => e
    handle_timeout(sync_record, e)
  rescue => e
    handle_error(sync_record, e)
  end

  private
    def load_sync_record(sync)
      sync_record = sync.is_a?(Sync) ? Sync.find_by(id: sync.id) : Sync.find_by(id: sync.id)
      unless sync_record
        Rails.logger.warn("Sync record not found, job may be stale")
        return nil
      end
      sync_record
    end

    def execute_with_timeout(sync_record)
      Timeout.timeout(TIMEOUT_THRESHOLD) do
        sync_record.perform
      end
    end

    def handle_timeout(sync_record, error)
      Rails.logger.error("Sync #{sync_record.id} timed out after #{TIMEOUT_THRESHOLD} seconds")
      sync_record.reload

      # IDEMPOTENCY: Hanya update jika masih dalam state yang bisa di-update
      if sync_record.syncing? && sync_record.may_fail?
        sync_record.fail!
        sync_record.update(error: "Sync timed out after #{TIMEOUT_THRESHOLD} seconds")
        sync_record.report_error(error) if sync_record.respond_to?(:report_error)
      end

      # Re-raise untuk Sidekiq retry mechanism
      raise error
    end

    def handle_error(sync_record, error)
      Rails.logger.error("Sync #{sync_record.id} failed: #{error.class} - #{error.message}")
      Rails.logger.error(error.backtrace.first(5).join("\n")) if error.backtrace

      # Reload untuk mendapatkan state terbaru
      sync_record = Sync.find_by(id: sync_record.id)
      return unless sync_record

      # IDEMPOTENCY: Hanya update jika masih dalam state yang bisa di-update
      if sync_record.syncing? && sync_record.may_fail?
        sync_record.fail!
        sync_record.update(error: "#{error.class}: #{error.message}")
        sync_record.report_error(error) if sync_record.respond_to?(:report_error)
      end

      # Re-raise untuk Sidekiq retry mechanism
      raise error
    end
end
