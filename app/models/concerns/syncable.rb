module Syncable
  extend ActiveSupport::Concern

  included do
    has_many :syncs, as: :syncable, dependent: :destroy
  end

  def syncing?
    syncs.visible.any?
  end

  # PERFORMANCE: Smarter debounce window to prevent sync flooding
  # Increased from 2s to 5s for better batching of rapid changes
  SYNC_DEBOUNCE_WINDOW = 5.seconds

  # PERFORMANCE: Smarter debounced sync with window merging
  # Instead of just blocking new syncs, we merge their windows with existing pending sync
  # Use this for user-initiated actions (transaction create/update/delete)
  def sync_later_debounced(**options)
    cache_key = "sync_debounce:#{self.class.name}:#{id}"

    # Check if sync was recently requested
    debounce_data = Rails.cache.read(cache_key)

    if debounce_data
      # Sync recently requested - try to merge with existing sync
      existing_sync_id = debounce_data[:sync_id]
      existing_sync = syncs.find_by(id: existing_sync_id)

      if existing_sync&.pending?
        # SMART MERGE: Expand window of existing sync instead of creating new one
        Rails.logger.info(
          "[Sync Debounce] Merging with existing sync #{existing_sync_id}: " \
          "expanding window to include #{options[:window_start_date]}"
        )

        existing_sync.expand_window_if_needed(
          options[:window_start_date],
          options[:window_end_date]
        )

        return existing_sync
      end
    end

    # Create new sync
    sync = sync_later(**options)

    # Store debounce data with sync ID for smart merging
    Rails.cache.write(
      cache_key,
      { sync_id: sync.id, created_at: Time.current },
      expires_in: SYNC_DEBOUNCE_WINDOW
    )

    sync
  end

  # Schedules a sync for syncable.  If there is an existing sync pending/syncing for this syncable,
  # we do not create a new sync, and attempt to expand the sync window if needed.
  # Detects and recovers from stuck syncs (syncing lebih dari 5 menit tanpa progress)
  def sync_later(parent_sync: nil, window_start_date: nil, window_end_date: nil)
    Sync.transaction do
      with_lock do
        sync = self.syncs.incomplete.first

        if sync
          # Deteksi stuck sync: jika sync sudah syncing lebih dari 5 menit, mark as stale dan buat baru
          if sync.syncing? && sync.syncing_at && sync.syncing_at < 5.minutes.ago
            Rails.logger.warn("Detected stuck sync #{sync.id} (syncing since #{sync.syncing_at}). Marking as stale and creating new sync.")
            sync.mark_stale! if sync.may_mark_stale?
            sync = nil
          # Jika sync pending terlalu lama (lebih dari 10 menit), re-enqueue job atau mark as stale
          elsif sync.pending? && sync.created_at < 10.minutes.ago
            Rails.logger.warn("Detected stale pending sync #{sync.id} (created at #{sync.created_at}). Re-enqueueing job or marking as stale.")
            # Cek apakah job sudah pernah di-enqueue dengan melihat apakah ada job di queue untuk sync ini
            # Jika tidak, re-enqueue job
            begin
              SyncJob.perform_later(sync)
              Rails.logger.info("Re-enqueued sync job for #{sync.id}")
            rescue => e
              Rails.logger.error("Failed to re-enqueue sync #{sync.id}: #{e.message}")
              # Jika gagal re-enqueue, mark as stale dan buat baru
              sync.mark_stale! if sync.may_mark_stale?
              sync = nil
            end
          end
        end

        if sync
          Rails.logger.info("There is an existing sync, expanding window if needed (#{sync.id})")
          sync.expand_window_if_needed(window_start_date, window_end_date)

          # Update parent relationship if one is provided and sync doesn't already have a parent
          if parent_sync && !sync.parent_id
            sync.update!(parent: parent_sync)
          end
        else
          sync = self.syncs.create!(
            parent: parent_sync,
            window_start_date: window_start_date,
            window_end_date: window_end_date
          )

          SyncJob.perform_later(sync)
        end

        sync
      end
    end
  end

  def perform_sync(sync)
    syncer.perform_sync(sync)
  end

  def perform_post_sync
    syncer.perform_post_sync
  end

  def broadcast_sync_complete
    sync_broadcaster.broadcast
  end

  def sync_error
    latest_sync&.error || latest_sync&.children&.map(&:error)&.compact&.first
  end

  def last_synced_at
    latest_sync&.completed_at
  end

  def last_sync_created_at
    latest_sync&.created_at
  end

  private
    def latest_sync
      syncs.ordered.first
    end

    def syncer
      self.class::Syncer.new(self)
    end

    def sync_broadcaster
      self.class::SyncCompleteEvent.new(self)
    end
end
