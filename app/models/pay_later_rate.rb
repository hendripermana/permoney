class PayLaterRate < ApplicationRecord
  PROVIDERS = %w[GoPayLater Kredivo ShopeePayLater Akulaku Other].freeze

  validates :provider_name, presence: true
  validates :tenor_months, presence: true, numericality: { greater_than: 0 }
  validates :monthly_rate, presence: true, numericality: { greater_than_or_equal_to: 0 }
  validates :effective_date, presence: true

  scope :provider, ->(name) { where(provider_name: name) }
  scope :effective_on_or_before, ->(date) { where("effective_date <= ?", date) }

  def self.current_rate_for(provider_name:, tenor_months:, on: Date.current)
    provider(provider_name)
      .where(tenor_months: tenor_months)
      .effective_on_or_before(on)
      .order(effective_date: :desc)
      .first
  end
end
