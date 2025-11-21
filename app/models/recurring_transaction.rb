class RecurringTransaction < ApplicationRecord
  include Monetizable

  belongs_to :family
  belongs_to :merchant, optional: true

  monetize :amount
  monetize :expected_amount_min, allow_nil: true
  monetize :expected_amount_max, allow_nil: true
  monetize :expected_amount_avg, allow_nil: true

  enum :status, { active: "active", inactive: "inactive" }

  validates :amount, presence: true
  validates :currency, presence: true
  validates :expected_day_of_month, presence: true, numericality: { greater_than: 0, less_than_or_equal_to: 31 }
  validate :merchant_or_name_present
  validate :amount_variance_consistency

  def merchant_or_name_present
    if merchant_id.blank? && name.blank?
      errors.add(:base, "Either merchant or name must be present")
    end
  end

  def amount_variance_consistency
    return unless manual?

    if expected_amount_min.present? && expected_amount_max.present?
      if expected_amount_min > expected_amount_max
        errors.add(:expected_amount_min, "cannot be greater than expected_amount_max")
      end
    end
  end

  scope :for_family, ->(family) { where(family: family) }
  scope :expected_soon, -> { active.where("next_expected_date <= ?", 1.month.from_now) }

  # Class methods for identification and cleanup
  def self.identify_patterns_for(family)
    Identifier.new(family).identify_recurring_patterns
  end

  def self.cleanup_stale_for(family)
    Cleaner.new(family).cleanup_stale_transactions
  end

  # Create a manual recurring transaction from an existing transaction
  # Automatically calculates amount variance from past 6 months of matching transactions
  def self.create_from_transaction(transaction, day_of_month: nil)
    family = transaction.entry.account.family
    entry = transaction.entry
    merchant = transaction.merchant

    # Determine day of month if not provided
    day_of_month ||= entry.date.day

    # Find past matching transactions to calculate variance
    # Look back 6 months
    start_date = 6.months.ago.to_date

    query = family.entries
      .where(entryable_type: "Transaction")
      .where(currency: entry.currency)
      .where("entries.date >= ?", start_date)
      .where("entries.date <= ?", entry.date)
      .where("EXTRACT(DAY FROM entries.date) BETWEEN ? AND ?",
             [ day_of_month - 5, 1 ].max,
             [ day_of_month + 5, 31 ].min)

    if merchant.present?
      # Match by merchant
      matching_entries = query.select do |e|
        e.entryable.is_a?(Transaction) && e.entryable.merchant_id == merchant.id
      end
    else
      # Match by name
      matching_entries = query.where(name: entry.name)
    end

    # Include the current transaction if not already in list
    unless matching_entries.find { |e| e.id == entry.id }
      matching_entries << entry
    end

    # Calculate amounts
    amounts = matching_entries.map(&:amount)
    min_amount = amounts.min
    max_amount = amounts.max
    avg_amount = amounts.sum / amounts.size

    # Create the recurring transaction
    create!(
      family: family,
      merchant: merchant,
      name: merchant.present? ? nil : entry.name,
      amount: entry.amount, # Use current amount as base
      currency: entry.currency,
      expected_day_of_month: day_of_month,
      last_occurrence_date: entry.date,
      next_expected_date: entry.date.next_month, # Simple projection, will be refined
      occurrence_count: amounts.size,
      status: "active",
      manual: true,
      expected_amount_min: min_amount,
      expected_amount_max: max_amount,
      expected_amount_avg: avg_amount
    )
  end

  # Find matching transactions for this recurring pattern
  def matching_transactions
    entries = family.entries
      .where(entryable_type: "Transaction")
      .where(currency: currency)

    # For manual recurring transactions, we allow amount variance
    if manual? && expected_amount_min.present? && expected_amount_max.present?
      # Allow 10% buffer outside the observed range or at least 5 units
      buffer = [ expected_amount_avg * 0.1, 5 ].max
      entries = entries.where("entries.amount BETWEEN ? AND ?",
                             expected_amount_min - buffer,
                             expected_amount_max + buffer)
    else
      entries = entries.where("entries.amount = ?", amount)
    end

    entries = entries.where("EXTRACT(DAY FROM entries.date) BETWEEN ? AND ?",
             [ expected_day_of_month - 2, 1 ].max,
             [ expected_day_of_month + 2, 31 ].min)
      .order(date: :desc)

    # Filter by merchant or name
    if merchant_id.present?
      # Match by merchant through the entryable (Transaction)
      entries.select do |entry|
        entry.entryable.is_a?(Transaction) && entry.entryable.merchant_id == merchant_id
      end
    else
      # Match by entry name
      entries.where(name: name)
    end
  end

  # Check if this recurring transaction should be marked inactive
  def should_be_inactive?
    return false if last_occurrence_date.nil?
    last_occurrence_date < 2.months.ago
  end

  # Mark as inactive
  def mark_inactive!
    update!(status: "inactive")
  end

  # Mark as active
  def mark_active!
    update!(status: "active")
  end

  # Update based on a new transaction occurrence
  # Update based on a new transaction occurrence
  def record_occurrence!(transaction_date, transaction_amount = nil)
    self.last_occurrence_date = transaction_date
    self.next_expected_date = calculate_next_expected_date(transaction_date)
    self.occurrence_count += 1
    self.status = "active"

    # Update variance stats if amount provided and manual
    if manual? && transaction_amount.present?
      self.expected_amount_min = [ expected_amount_min || amount, transaction_amount ].min
      self.expected_amount_max = [ expected_amount_max || amount, transaction_amount ].max

      # Weighted average update
      current_avg = expected_amount_avg || amount
      # New average = ((old_avg * (count-1)) + new_amount) / count
      # We use occurrence_count which was just incremented
      self.expected_amount_avg = ((current_avg * (occurrence_count - 1)) + transaction_amount) / occurrence_count
    end

    save!
  end

  # Calculate the next expected date based on the last occurrence
  def calculate_next_expected_date(from_date = last_occurrence_date)
    # Start with next month
    next_month = from_date.next_month

    # Try to use the expected day of month
    begin
      Date.new(next_month.year, next_month.month, expected_day_of_month)
    rescue ArgumentError
      # If day doesn't exist in month (e.g., 31st in February), use last day of month
      next_month.end_of_month
    end
  end

  # Get the projected transaction for display
  def projected_entry
    return nil unless active?
    return nil unless next_expected_date.future?

    # Use average amount for manual recurring transactions if available
    projected_amount = (manual? && expected_amount_avg.present?) ? expected_amount_avg : amount

    OpenStruct.new(
      date: next_expected_date,
      amount: projected_amount,
      currency: currency,
      merchant: merchant,
      name: merchant.present? ? merchant.name : name,
      recurring: true,
      projected: true
    )
  end

  def has_amount_variance?
    return false unless manual?
    return false unless expected_amount_min.present? && expected_amount_max.present?
    expected_amount_min != expected_amount_max
  end

  private
    def monetizable_currency
      currency
    end
end
