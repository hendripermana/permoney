class LoanInstallment < ApplicationRecord
  include AuditableChanges

  belongs_to :account
  belongs_to :transfer, optional: true

  enum :status, { planned: "planned", posted: "posted" }

  scope :for_account, ->(account_id) { where(account_id: account_id) }
  scope :pending, -> { where(status: "planned").order(:installment_no) }

  def principal_money
    Money.new(principal_amount, account.currency)
  end
  def interest_money
    Money.new(interest_amount, account.currency)
  end

  def total_money
    Money.new(total_amount, account.currency)
  end

  track_changes_for :due_date, :principal_amount, :interest_amount, :total_amount, :status, :posted_on, :transfer_id
end
