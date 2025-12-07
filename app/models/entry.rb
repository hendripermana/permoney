class Entry < ApplicationRecord
  include Monetizable, Enrichable

  monetize :amount

  # Receipt/document attachment for transaction documentation
  # Stored in Cloudflare R2 for zero-egress cost and global CDN delivery
  has_one_attached :receipt do |attachable|
    # Preprocessed variants for instant display (generated immediately after upload)
    attachable.variant :thumbnail, resize_to_fill: [ 100, 100 ], convert: :webp, saver: { quality: 80, strip: true }, preprocessed: true
    attachable.variant :small, resize_to_fill: [ 200, 200 ], convert: :webp, saver: { quality: 85, strip: true }, preprocessed: true
    # On-demand variant for full display
    attachable.variant :display, resize_to_limit: [ 800, 800 ], convert: :webp, saver: { quality: 85, strip: true }
  end

  # Receipt validation
  validate :receipt_content_type_valid, if: -> { receipt.attached? }
  validate :receipt_size_valid, if: -> { receipt.attached? }

  # PERFORMANCE: Counter cache for blazing fast account.entries.count
  # Eliminates N+1 COUNT queries (50-100x faster than COUNT(*))
  # Touch account to invalidate caches when entries change
  belongs_to :account, counter_cache: true, touch: true
  belongs_to :transfer, optional: true
  belongs_to :import, optional: true

  delegated_type :entryable, types: Entryable::TYPES, dependent: :destroy
  accepts_nested_attributes_for :entryable

  validates :date, :name, :amount, :currency, presence: true
  validates :date, uniqueness: { scope: [ :account_id, :entryable_type ] }, if: -> { valuation? }
  validates :date, comparison: { greater_than: -> { min_supported_date } }
  validates :external_id, uniqueness: { scope: [ :account_id, :source ] }, if: -> { external_id.present? && source.present? }

  scope :visible, -> {
    joins(:account).where(accounts: { status: [ "draft", "active" ] })
  }

  scope :chronological, -> {
    order(
      date: :asc,
      Arel.sql("CASE WHEN entries.entryable_type = 'Valuation' THEN 1 ELSE 0 END") => :asc,
      created_at: :asc
    )
  }

  scope :reverse_chronological, -> {
    order(
      date: :desc,
      Arel.sql("CASE WHEN entries.entryable_type = 'Valuation' THEN 1 ELSE 0 END") => :desc,
      created_at: :desc
    )
  }

  def classification
    amount.negative? ? "income" : "expense"
  end

  def lock_saved_attributes!
    super
    entryable.lock_saved_attributes!
  end

  def sync_account_later
    sync_start_date = [ date_previously_was, date ].compact.min unless destroyed?
    # Use debounced sync to prevent flooding when creating multiple entries rapidly
    account.sync_later_debounced(window_start_date: sync_start_date)
  end

  def entryable_name_short
    entryable_type.demodulize.underscore
  end

  def balance_trend(entries, balances)
    Balance::TrendCalculator.new(self, entries, balances).trend
  end

  def linked?
    external_id.present?
  end

  class << self
    def search(params)
      EntrySearch.new(params).build_query(all)
    end

    # arbitrary cutoff date to avoid expensive sync operations
    def min_supported_date
      30.years.ago.to_date
    end

    def bulk_update!(bulk_update_params)
      bulk_attributes = {
        date: bulk_update_params[:date],
        notes: bulk_update_params[:notes],
        entryable_attributes: {
          category_id: bulk_update_params[:category_id],
          merchant_id: bulk_update_params[:merchant_id],
          tag_ids: bulk_update_params[:tag_ids]
        }.compact_blank
      }.compact_blank

      return 0 if bulk_attributes.blank?

      transaction do
        all.each do |entry|
          bulk_attributes[:entryable_attributes][:id] = entry.entryable_id if bulk_attributes[:entryable_attributes].present?
          entry.update! bulk_attributes

          entry.lock_saved_attributes!
          entry.entryable.lock_attr!(:tag_ids) if entry.transaction? && entry.transaction.tags.any?
        end
      end

      all.size
    end
  end

  private

    ALLOWED_RECEIPT_TYPES = %w[image/jpeg image/png image/webp application/pdf].freeze
    MAX_RECEIPT_SIZE = 10.megabytes

    def receipt_content_type_valid
      unless receipt.content_type.in?(ALLOWED_RECEIPT_TYPES)
        errors.add(:receipt, :invalid_content_type, message: "must be JPEG, PNG, WebP, or PDF")
        # Don't purge here - let Rails clean up unattached blobs automatically
        # Purging during validation can cause data loss and break user experience
      end
    end

    def receipt_size_valid
      if receipt.byte_size > MAX_RECEIPT_SIZE
        errors.add(:receipt, :invalid_file_size, max_megabytes: 10, message: "must be less than 10MB")
        # Don't purge here - let Rails clean up unattached blobs automatically
      end
    end
end
