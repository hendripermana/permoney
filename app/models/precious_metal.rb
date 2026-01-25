class PreciousMetal < ApplicationRecord
  include Accountable

  SUBTYPES = {
    "gold" => { short: "Gold", long: "Gold" }
  }.freeze

  ACCOUNT_STATUSES = %w[active closed].freeze
  SCHEME_TYPES = %w[conventional sharia].freeze

  UNITS = {
    "g" => { short: "g", long: "Grams" }
  }.freeze

  attribute :unit, :string, default: "g"

  belongs_to :preferred_funding_account, class_name: "Account", optional: true

  attr_accessor :balance_sync_date

  before_validation :normalize_currency

  normalizes :account_number, with: ->(value) { value.to_s.strip.presence }
  normalizes :akad, with: ->(value) { value.to_s.strip.presence }

  validates :subtype, presence: true, inclusion: { in: SUBTYPES.keys }
  validates :unit, presence: true, inclusion: { in: UNITS.keys }
  validates :quantity, numericality: { greater_than_or_equal_to: 0 }
  validate :quantity_precision
  validates :account_status, inclusion: { in: ACCOUNT_STATUSES }, allow_blank: true
  validates :scheme_type, inclusion: { in: SCHEME_TYPES }, allow_blank: true
  validates :account_number, length: { maximum: 50 }, allow_blank: true
  validates :akad, length: { maximum: 100 }, allow_blank: true
  validates :preferred_funding_account_id, presence: true, if: -> { preferred_funding_account_id.present? }
  validates :manual_price, numericality: { greater_than_or_equal_to: 0 }, allow_nil: true
  validates :manual_price_currency, presence: true, if: -> { manual_price.present? }
  validate :manual_price_currency_valid, if: -> { manual_price_currency.present? }

  after_commit :sync_account_balance, on: :update, if: :should_sync_account_balance?

  class << self
    def display_name
      "Precious Metals"
    end

    def color
      "#D97706"
    end

    def classification
      "asset"
    end

    def icon
      "coins"
    end
  end

  def unit_label
    UNITS[unit]&.fetch(:long, unit)
  end

  def manual_price_money
    return nil if manual_price.blank? || manual_price_currency.blank?

    Money.new(manual_price, manual_price_currency)
  end

  def estimated_value_amount
    return nil if manual_price.blank?

    # Money in this app uses major units (see lib/money.rb), so keep value in major units.
    quantity.to_d * manual_price.to_d
  end

  # Use the FX engine for display values while preserving manual price currency as the source.
  def value_in(target_currency = nil)
    amount = estimated_value_amount
    return nil if amount.nil? || manual_price_currency.blank?

    target_code = (target_currency || account&.family&.currency || account&.currency).to_s.upcase
    return nil if target_code.blank?

    value_money = Money.new(amount, manual_price_currency)
    target_currency_obj = Money::Currency.new(target_code)
    return value_money if value_money.currency.iso_code == target_currency_obj.iso_code

    value_money.exchange_to(target_currency_obj.iso_code)
  rescue Money::ConversionError, Money::Currency::UnknownCurrencyError
    # Nil signals missing FX/invalid currency so UI can render "—" safely.
    nil
  end

  def estimated_value_money
    value_in
  end

  def apply_quantity_delta!(delta, effective_date: nil)
    self.balance_sync_date = effective_date if effective_date.present?
    update!(quantity: quantity.to_d + delta.to_d)
  end

  private
    def normalize_currency
      self.manual_price_currency = manual_price_currency.to_s.upcase if manual_price_currency.present?
    end

    def manual_price_currency_valid
      Money::Currency.new(manual_price_currency)
    rescue Money::Currency::UnknownCurrencyError
      errors.add(:manual_price_currency, "is not a valid currency")
    end

    def quantity_precision
      return if quantity.blank?

      errors.add(:quantity, "must have at most 4 decimal places") if quantity.to_d != quantity.to_d.round(4)
    end

    def should_sync_account_balance?
      saved_change_to_quantity? || saved_change_to_manual_price? || saved_change_to_manual_price_currency?
    end

    def sync_account_balance
      return unless account&.persisted?

      value = estimated_value_amount
      if value.nil?
        account.update!(balance: 0)
        account.sync_later
        return
      end

      reconciliation_date = balance_sync_date || Date.current
      reconciliation_manager = Account::ReconciliationManager.new(account)
      existing_valuation = account.entries.valuations.find_by(date: reconciliation_date)
      reconciliation_manager.reconcile_balance(balance: value, date: reconciliation_date, existing_valuation_entry: existing_valuation)
      account.update!(balance: value)
      account.sync_later
    ensure
      self.balance_sync_date = nil
    end
end
