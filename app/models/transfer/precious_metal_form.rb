class Transfer::PreciousMetalForm
  include ActiveModel::Model

  attr_accessor :family, :from_account_id, :to_account_id, :amount, :quantity,
    :price_per_unit, :price_currency, :fee_amount, :date, :save_price

  validates :family, presence: true
  validates :from_account_id, :to_account_id, presence: true
  validates :price_per_unit, presence: true, numericality: { greater_than: 0 }, unless: :default_price_available?
  validates :fee_amount, numericality: { greater_than_or_equal_to: 0 }, allow_blank: true

  validate :accounts_present
  validate :accounts_are_different
  validate :destination_is_precious_metal
  validate :date_is_valid
  validate :price_per_unit_positive
  validate :price_currency_valid
  validate :amount_or_quantity_present
  validate :amount_and_quantity_positive
  validate :quantity_precision
  validate :amount_quantity_consistency

  def create
    return false unless valid?

    @transfer = Transfer::Creator.new(
      family: family,
      source_account_id: from_account_id,
      destination_account_id: to_account_id,
      date: date_value,
      amount: total_amount_source,
      precious_metal: precious_metal_payload,
      save_price: save_price?
    ).create

    return true if @transfer.persisted?

    @transfer.errors.each { |error| errors.add(error.attribute, error.message) }
    false
  end

  def transfer
    @transfer
  end

  private
    def source_account
      @source_account ||= family&.accounts&.find_by(id: from_account_id)
    end

    def destination_account
      @destination_account ||= family&.accounts&.find_by(id: to_account_id)
    end

    def destination_metal
      return nil unless destination_account&.accountable_type == "PreciousMetal"

      destination_account.accountable
    end

    def date_value
      @date_value ||= ActiveModel::Type::Date.new.cast(date)
    end

    def price_per_unit_value
      return @price_per_unit_value if defined?(@price_per_unit_value)

      @price_per_unit_value = if price_per_unit.present?
        price_per_unit.to_d
      else
        destination_metal&.manual_price&.to_d
      end
    end

    def price_currency_value
      @price_currency_value ||= price_currency.presence ||
        destination_metal&.manual_price_currency ||
        destination_account&.currency
    end

    def amount_value
      return nil if amount.blank?

      amount.to_d
    end

    def quantity_value
      return nil if quantity.blank?

      quantity.to_d
    end

    def fee_value
      return 0.to_d if fee_amount.blank?

      fee_amount.to_d
    end

    def amount_in_price_currency
      return nil if amount_value.blank? || source_account.blank? || price_currency_value.blank? || date_value.blank?

      Money.new(amount_value, source_account.currency)
           .exchange_to(price_currency_value, date: date_value, fallback_rate: 1.0)
           .amount
    end

    def computed_quantity
      return nil if amount_value.blank? || price_per_unit_value.blank?

      (amount_in_price_currency / price_per_unit_value).round(3)
    end

    def computed_amount_source
      return nil if quantity_value.blank? || price_per_unit_value.blank?
      return nil if source_account.blank? || price_currency_value.blank? || date_value.blank?

      total_in_price_currency = quantity_value * price_per_unit_value
      Money.new(total_in_price_currency, price_currency_value)
           .exchange_to(source_account.currency, date: date_value, fallback_rate: 1.0)
           .amount
           .round(4)
    end

    def purchase_amount_source
      amount_value.presence || computed_amount_source
    end

    def purchase_amount_price_currency
      if amount_value.present?
        amount_in_price_currency.round(4)
      else
        (quantity_value * price_per_unit_value).round(4)
      end
    end

    def total_amount_source
      (purchase_amount_source + fee_value).round(4)
    end

    def save_price?
      ActiveModel::Type::Boolean.new.cast(save_price)
    end

    def default_price_available?
      price_per_unit_value.present?
    end

    def precious_metal_payload
      {
        "action" => "buy",
        "account_id" => destination_account.id,
        "quantity" => computed_or_provided_quantity.to_s,
        "quantity_delta" => computed_or_provided_quantity.to_s,
        "unit" => destination_metal.unit,
        "cash_amount" => purchase_amount_price_currency.to_s,
        "cash_currency" => price_currency_value,
        "price_per_unit" => price_per_unit_value.to_s,
        "price_currency" => price_currency_value,
        "fee_amount" => fee_value.positive? ? fee_value.to_s : nil,
        "fee_currency" => fee_value.positive? ? source_account.currency : nil
      }.compact
    end

    def computed_or_provided_quantity
      quantity_value.presence || computed_quantity
    end

    def accounts_present
      errors.add(:from_account_id, "is invalid") if source_account.nil?
      errors.add(:to_account_id, "is invalid") if destination_account.nil?
    end

    def accounts_are_different
      return if source_account.nil? || destination_account.nil?
      return if source_account.id != destination_account.id

      errors.add(:base, "Transfer must be between different accounts")
    end

    def destination_is_precious_metal
      return if destination_account.nil?
      return if destination_account.accountable_type == "PreciousMetal"

      errors.add(:to_account_id, "must be a precious metal account")
    end

    def date_is_valid
      errors.add(:date, "is required") if date_value.blank?
    end

    def price_currency_valid
      Money::Currency.new(price_currency_value) if price_currency_value.present?
    rescue Money::Currency::UnknownCurrencyError
      errors.add(:price_currency, "is not a valid currency")
    end

    def price_per_unit_positive
      return if price_per_unit_value.blank?
      return if price_per_unit_value.positive?

      errors.add(:price_per_unit, "must be greater than 0")
    end

    def amount_or_quantity_present
      return if amount_value.present? || quantity_value.present?

      errors.add(:base, "Enter either an amount or grams to transfer")
    end

    def amount_and_quantity_positive
      errors.add(:amount, "must be greater than 0") if amount_value.present? && amount_value <= 0
      errors.add(:quantity, "must be greater than 0") if quantity_value.present? && quantity_value <= 0
      errors.add(:fee_amount, "must be 0 or greater") if fee_value.negative?
    end

    def quantity_precision
      return if quantity_value.blank?

      errors.add(:quantity, "must have at most 3 decimal places") if quantity_value != quantity_value.round(3)
    end

    def amount_quantity_consistency
      return if amount_value.blank? || quantity_value.blank? || price_per_unit_value.blank?

      derived_quantity = computed_quantity
      return if derived_quantity.nil?
      return if (derived_quantity - quantity_value).abs <= 0.001

      errors.add(:base, "Amount and grams do not match the price per gram")
    end
end
