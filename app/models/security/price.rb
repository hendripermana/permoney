class Security::Price < ApplicationRecord
  belongs_to :security

  validates :date, :price, :currency, presence: true
  validates :date, uniqueness: { scope: %i[security_id currency] }

  scope :provisional, -> { where(provisional: true) }
end
