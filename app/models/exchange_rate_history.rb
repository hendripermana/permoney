class ExchangeRateHistory < ApplicationRecord
  validates :currency_code, presence: true, length: { is: 3 }
  validates :rate_to_idr, presence: true, numericality: { greater_than: 0 }
  validates :effective_date, presence: true

  scope :for_currency, ->(code) { where(currency_code: code) }
  scope :effective_on_or_before, ->(date) { where("effective_date <= ?", date) }
end
