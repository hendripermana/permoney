class PreciousMetal::TransactionForm
  include ActiveModel::Model

  TRANSACTION_TYPES = %w[buy sell fee adjustment].freeze
  FEE_MODES = %w[cash metal].freeze

  attr_accessor :account, :transaction_type, :quantity, :cash_amount, :fee_mode, :date, :notes, :cash_currency

  validates :account, presence: true
  validates :transaction_type, inclusion: { in: TRANSACTION_TYPES }
  validates :date, presence: true
  validates :fee_mode, inclusion: { in: FEE_MODES }, if: -> { transaction_type == "fee" }

  validate :account_is_precious_metal
  validate :quantity_presence
  validate :quantity_non_negative
  validate :quantity_precision
  validate :cash_amount_non_negative
  validate :cash_amount_required_for_cash_fee
  validate :quantity_never_negative

  def create
    return entry if entry.present?
    return nil unless valid?

    ActiveRecord::Base.transaction do
      @entry = account.entries.create!(
        name: entry_name,
        date: date,
        amount: entry_amount,
        currency: account.currency,
        notes: notes,
        entryable: Transaction.new(
          kind: "funds_movement",
          extra: {
            "precious_metal" => {
              "action" => transaction_type,
              "account_id" => account.id,
              "quantity" => quantity_value&.to_s,
              "quantity_delta" => quantity_delta&.to_s,
              "unit" => account.accountable.unit,
              "fee_mode" => (fee_mode if transaction_type == "fee"),
              "cash_amount" => cash_amount_value&.to_s,
              "cash_currency" => account.currency,
              "price_per_unit" => account.accountable.manual_price&.to_s,
              "price_currency" => account.accountable.manual_price_currency
            }.compact
          }
        )
      )
    end

    entry
  rescue ActiveRecord::RecordInvalid
    nil
  end

  def entry
    @entry
  end

  private
    def quantity_value
      return nil if quantity.blank?

      quantity.to_d
    end

    def cash_amount_value
      return nil if cash_amount.blank?

      cash_amount.to_d
    end

    def entry_amount
      return 0 if cash_amount_value.blank?

      case transaction_type
      when "buy"
        cash_amount_value
      when "sell"
        cash_amount_value * -1
      when "fee"
        fee_mode == "cash" ? cash_amount_value : 0
      when "adjustment"
        0
      else
        0
      end
    end

    def quantity_delta
      case transaction_type
      when "buy"
        quantity_value
      when "sell"
        quantity_value ? -quantity_value : nil
      when "fee"
        fee_mode == "metal" ? (quantity_value ? -quantity_value : nil) : 0
      when "adjustment"
        return nil if quantity_value.nil?
        quantity_value - current_quantity
      end
    end

    def current_quantity
      account.accountable.quantity.to_d
    end

    def entry_name
      formatted_quantity = quantity_value.present? ? format("%.4f", quantity_value) : "0.0000"
      unit = account.accountable.unit

      case transaction_type
      when "buy"
        "Buy Gold (#{formatted_quantity} #{unit})"
      when "sell"
        "Sell Gold (#{formatted_quantity} #{unit})"
      when "fee"
        fee_mode == "metal" ? "Gold fee (#{formatted_quantity} #{unit})" : "Gold fee (cash)"
      when "adjustment"
        "Adjust Gold balance to #{formatted_quantity} #{unit}"
      else
        "Gold transaction"
      end
    end

    def quantity_presence
      requires_quantity = transaction_type.in?(%w[buy sell adjustment]) ||
        (transaction_type == "fee" && fee_mode == "metal")
      return unless requires_quantity
      return if quantity_value.present?

      errors.add(:quantity, "is required")
    end

    def account_is_precious_metal
      return if account&.precious_metal?

      errors.add(:account, "must be a precious metal account")
    end

    def quantity_non_negative
      return if quantity_value.nil?

      if transaction_type == "adjustment"
        errors.add(:quantity, "must be 0 or greater") if quantity_value.negative?
      else
        errors.add(:quantity, "must be greater than 0") if quantity_value <= 0
      end
    end

    def cash_amount_non_negative
      return if cash_amount_value.nil?

      errors.add(:cash_amount, "must be 0 or greater") if cash_amount_value.negative?
    end

    def cash_amount_required_for_cash_fee
      return unless transaction_type == "fee" && fee_mode == "cash"
      return if cash_amount_value.present?

      errors.add(:cash_amount, "is required for cash fees")
    end

    def quantity_precision
      return if quantity_value.nil?
      return if quantity_value == quantity_value.round(4)

      errors.add(:quantity, "must have at most 4 decimal places")
    end

    def quantity_never_negative
      return if account.blank? || quantity_delta.nil?

      new_quantity = current_quantity + quantity_delta
      errors.add(:quantity, "cannot make balance negative") if new_quantity.negative?
    end
end
