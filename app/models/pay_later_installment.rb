class PayLaterInstallment < ApplicationRecord
  include Monetizable
  belongs_to :account

  enum :status, { pending: "pending", paid: "paid", late: "late", cancelled: "cancelled" }, prefix: true

  validates :installment_no, presence: true
  validates :due_date, presence: true

  monetize :principal_amount, :interest_amount, :fee_amount, :total_due, :paid_amount

  scope :for_account, ->(account_id) { where(account_id: account_id) }
  scope :upcoming, -> { where(status: "pending").order(:due_date) }

  private
    def monetizable_currency
      account&.currency
    end
end
