class LoanInstallment < ApplicationRecord
  include AuditableChanges

  belongs_to :account
  belongs_to :transfer, optional: true

  enum :status, { planned: "planned", posted: "posted", partially_paid: "partially_paid" }

  scope :for_account, ->(account_id) { where(account_id: account_id) }
  scope :pending, -> { where(status: "planned").order(:installment_no) }
  scope :partially_paid, -> { where(status: "partially_paid") }

  def principal_money
    Money.new(principal_amount, account.currency)
  end
  def interest_money
    Money.new(interest_amount, account.currency)
  end

  def total_money
    Money.new(total_amount, account.currency)
  end

  def paid_principal
    attributes['paid_principal'] || 0
  end

  def paid_interest
    attributes['paid_interest'] || 0
  end

  def remaining_principal
    principal_amount - paid_principal
  end

  def remaining_interest
    interest_amount - paid_interest
  end

  def fully_paid?
    remaining_principal <= 0 && remaining_interest <= 0
  end

  def payment_progress
    return 1.0 if total_amount.zero?
    (paid_principal + paid_interest) / total_amount
  end

  track_changes_for :due_date, :principal_amount, :interest_amount, :total_amount, :status, :posted_on, :transfer_id, :paid_principal, :paid_interest, :last_payment_date
end
