class PayLaterInstallment < ApplicationRecord
  include Monetizable

  # Associations
  belongs_to :account
  belongs_to :transfer, optional: true

  # Enums
  enum :status, {
    pending: "pending",
    paid: "paid",
    partially_paid: "partially_paid",
    overdue: "overdue",
    cancelled: "cancelled"
  }, prefix: true

  # Validations
  validates :installment_no, presence: true, numericality: { greater_than: 0, only_integer: true }
  validates :due_date, presence: true
  validates :principal_amount, :interest_amount, :total_due, presence: true, numericality: { greater_than_or_equal_to: 0 }
  validates :fee_amount, numericality: { greater_than_or_equal_to: 0 }, allow_nil: true
  validates :paid_amount, numericality: { greater_than_or_equal_to: 0 }, allow_nil: true
  validates :status, presence: true, inclusion: { in: statuses.keys }

  # Monetize fields
  monetize :principal_amount, :interest_amount, :fee_amount, :total_due, :paid_amount, :total_cost

  # Scopes
  scope :for_account, ->(account_id) { where(account_id: account_id) }
  scope :by_installment_no, -> { order(:installment_no) }
  scope :upcoming, -> { where(status: "pending").where("due_date >= ?", Date.current).order(:due_date) }
  scope :overdue, -> { where("due_date < ? AND status IN (?)", Date.current, [ "pending", "partially_paid" ]) }
  scope :due_soon, ->(days = 7) { where(status: "pending").where("due_date BETWEEN ? AND ?", Date.current, days.days.from_now).order(:due_date) }
  scope :paid, -> { where(status: "paid") }
  scope :unpaid, -> { where(status: [ "pending", "partially_paid", "overdue" ]) }

  # Callbacks
  before_save :update_status_based_on_payment
  after_save :update_account_balance, if: :saved_change_to_status?

  # Instance methods

  # Calculate remaining amount to pay
  def remaining_amount
    total_due_money - paid_amount_money
  end

  # Calculate remaining amount as decimal
  def remaining_amount_decimal
    total_due.to_d - (paid_amount || 0).to_d
  end

  # Check if installment is overdue
  def overdue?
    due_date < Date.current && !status_paid? && !status_cancelled?
  end

  # Calculate days overdue (returns 0 if not overdue)
  def days_overdue
    return 0 unless overdue?
    (Date.current - due_date).to_i
  end

  # Calculate late fee based on days overdue
  def calculate_late_fee
    return Money.new(0, account.currency) unless overdue?

    pay_later = account.accountable
    days = days_overdue

    if days <= 7
      pay_later.late_fee_first7_money * days
    else
      (pay_later.late_fee_first7_money * 7) +
      (pay_later.late_fee_per_day_money * (days - 7))
    end
  end

  # Check if this is the first installment
  def first_installment?
    installment_no == 1
  end

  # Check if this is the last installment
  def last_installment?
    account.accountable.installments.maximum(:installment_no) == installment_no
  end

  # Get the next installment
  def next_installment
    account.accountable.installments
      .where("installment_no > ?", installment_no)
      .order(:installment_no)
      .first
  end

  # Get the previous installment
  def previous_installment
    account.accountable.installments
      .where("installment_no < ?", installment_no)
      .order(:installment_no)
      .last
  end

  # Check if can be paid
  def can_be_paid?
    status_pending? || status_partially_paid? || status_overdue?
  end

  # Mark as paid
  def mark_as_paid!(transfer_id: nil, paid_on: Date.current)
    update!(
      status: "paid",
      paid_amount: total_due,
      paid_on: paid_on,
      transfer_id: transfer_id
    )
  end

  # Record partial payment
  def record_partial_payment!(amount, transfer_id: nil, paid_on: Date.current)
    current_paid = paid_amount.to_d
    new_paid = current_paid + amount.to_d

    update!(
      paid_amount: new_paid,
      transfer_id: transfer_id,
      paid_on: paid_on
    )
  end

  # Get payment progress percentage
  def payment_progress_percentage
    return 0 if total_due.to_d.zero?
    ((paid_amount.to_d / total_due.to_d) * 100).round(2)
  end

  # Get human-readable status with context
  def status_with_context
    case status
    when "pending"
      overdue? ? "Overdue (#{days_overdue} days)" : "Pending"
    when "partially_paid"
      "Partially Paid (#{payment_progress_percentage}%)"
    when "paid"
      "Paid on #{paid_on&.strftime('%b %d, %Y') || 'N/A'}"
    when "overdue"
      "Overdue (#{days_overdue} days)"
    else
      status.humanize
    end
  end

  private

    def monetizable_currency
      account&.currency
    end

    # Update status based on payment amount
    def update_status_based_on_payment
      # Do not interfere with explicit cancellation
      return if status == "cancelled"
      return unless paid_amount.present?

      if paid_amount.to_d >= total_due.to_d
        self.status = "paid"
      elsif paid_amount.to_d > 0
        self.status = "partially_paid"
      elsif overdue?
        self.status = "overdue"
      end
    end

    # Update account balance after status change
    def update_account_balance
      return unless account.present?

      # Trigger account balance sync
      account.sync_later if account.respond_to?(:sync_later)

      # Update available credit for PayLater
      if account.accountable.respond_to?(:update_available_credit!)
        account.accountable.update_available_credit!
      end
    end
end
