# frozen_string_literal: true

module Loan::Payable
  extend ActiveSupport::Concern

  included do
    has_many :loan_installments, foreign_key: :account_id, dependent: :destroy
  end

  # Make a payment towards this loan
  def make_payment(amount:, from_account:, date: Date.current, notes: nil)
    validate_payment!(amount, from_account)

    ActiveRecord::Base.transaction do
      # Use enhanced payment processor
      processor = Loan::PaymentProcessor.new(
        loan: self,
        amount: amount,
        from_account: from_account,
        date: date,
        notes: notes
      )

      processor.process
    end
  end

  # Post a specific installment
  def post_installment(installment: nil, from_account:, date: Date.current, notes: nil)
    installment ||= next_pending_installment
    raise ArgumentError, "No pending installments" unless installment
    raise ArgumentError, "Installment already posted" if installment.posted?

    ActiveRecord::Base.transaction do
      installment.with_lock do
        return if installment.posted? # Double-check after lock

        principal_amount = installment.principal_amount.to_d
        interest_amount = installment.interest_amount.to_d

        # Create principal transfer
        transfer = create_principal_transfer(
          amount: principal_amount,
          from_account: from_account,
          date: date
        ) if principal_amount.positive?

        # Create interest expense entry
        create_interest_expense(
          amount: interest_amount,
          from_account: from_account,
          date: date
        ) if interest_amount.positive?

        # Mark installment as posted
        installment.update!(
          status: "posted",
          posted_on: date,
          transfer_id: transfer&.id
        )

        # Sync accounts
        sync_accounts!(from_account)

        transfer
      end
    end
  end

  # Borrow additional amount (increase loan balance)
  def borrow_more(amount:, to_account:, date: Date.current, notes: nil)
    validate_borrowing!(amount, to_account)

    transfer = Transfer::Creator.new(
      family: Current.family,
      source_account_id: account.id,
      destination_account_id: to_account.id,
      date: date,
      amount: amount.to_d
    ).create

    if transfer.persisted?
      # Update transfer notes for context
      contextual_notes = build_borrowing_notes(notes)
      transfer.update!(notes: contextual_notes)

      sync_accounts!(to_account)
    end

    transfer
  end

  # Apply extra payment towards principal
  def apply_extra_payment(amount:, from_account:, date: Date.current, allocation_mode: "principal_first")
    validate_payment!(amount, from_account)

    case allocation_mode
    when "principal_first"
      apply_principal_payment(amount: amount, from_account: from_account, date: date)
    when "schedule_reduction"
      apply_with_schedule_adjustment(amount: amount, from_account: from_account, date: date)
    else
      raise ArgumentError, "Invalid allocation mode: #{allocation_mode}"
    end
  end

  # Calculate remaining principal from account balance
  def remaining_principal
    account.balance.abs
  end

  def remaining_principal_money
    Money.new(remaining_principal, account.currency)
  end

  # Get next pending installment
  def next_pending_installment
    loan_installments.pending.order(:installment_no).first
  end

  # Check if all installments are paid
  def fully_paid?
    loan_installments.pending.none? && remaining_principal.zero?
  end

  # Generate payment schedule
  def generate_schedule(
    principal_amount: nil,
    rate_or_profit: nil,
    tenor_months: nil,
    start_date: nil,
    **options
  )
    calculator = Loan::PaymentCalculator.new(
      loan: self,
      principal_amount: principal_amount,
      rate_or_profit: rate_or_profit,
      tenor_months: tenor_months,
      start_date: start_date,
      **options
    )

    calculator.calculate_installments
  end

  # Rebuild installment schedule
  def rebuild_schedule!(
    principal_amount: nil,
    rate_or_profit: nil,
    tenor_months: nil,
    start_date: nil,
    **options
  )
    # Clear existing planned installments
    loan_installments.planned.destroy_all

    # Generate new schedule
    rows = generate_schedule(
      principal_amount: principal_amount,
      rate_or_profit: rate_or_profit,
      tenor_months: tenor_months,
      start_date: start_date,
      **options
    )

    # Create new installment records
    rows.each_with_index do |row, index|
      loan_installments.create!(
        installment_no: index + 1,
        due_date: row.due_date,
        principal_amount: row.principal,
        interest_amount: row.interest,
        total_amount: row.total,
        status: "planned"
      )
    end

    loan_installments.reload
  end

  private

  def validate_payment!(amount, from_account)
    raise ArgumentError, "Amount must be positive" unless amount.to_d.positive?
    raise ArgumentError, "Source account required" unless from_account
    raise ArgumentError, "Cannot pay from same account" if from_account == account
  end

  def validate_borrowing!(amount, to_account)
    raise ArgumentError, "Amount must be positive" unless amount.to_d.positive?
    raise ArgumentError, "Destination account required" unless to_account
    raise ArgumentError, "Cannot borrow to same account" if to_account == account
  end

  def amounts_match?(planned_total, provided_amount)
    (planned_total.to_d - provided_amount.to_d).abs < 0.01
  end

  def create_payment_transfer(amount:, from_account:, date:, notes:)
    transfer = Transfer::Creator.new(
      family: Current.family,
      source_account_id: from_account.id,
      destination_account_id: account.id,
      date: date,
      amount: amount.to_d
    ).create

    if transfer.persisted?
      contextual_notes = build_payment_notes(notes)
      transfer.update!(notes: contextual_notes)
      sync_accounts!(from_account)
    end

    transfer
  end

  def create_principal_transfer(amount:, from_account:, date:)
    Transfer::Creator.new(
      family: Current.family,
      source_account_id: from_account.id,
      destination_account_id: account.id,
      date: date,
      amount: amount
    ).create
  end

  def create_interest_expense(amount:, from_account:, date:)
    interest_money = Money.new(amount, account.currency)
    converted_interest = interest_money.exchange_to(
      from_account.currency,
      date: date,
      fallback_rate: 1.0
    )

    entry = from_account.entries.create!(
      date: date,
      name: interest_expense_name,
      amount: converted_interest.amount,
      currency: from_account.currency,
      entryable: Transaction.new(kind: interest_transaction_kind)
    )

    # Set appropriate category
    category_key = sharia_compliant? ? "system:islamic_profit_expense" : "system:interest_expense"
    category = CategoryResolver.ensure_system_category(Current.family, category_key)
    entry.entryable.set_category!(category)

    entry
  end

  def apply_principal_payment(amount:, from_account:, date:)
    # Simple principal-only payment
    create_payment_transfer(
      amount: amount,
      from_account: from_account,
      date: date,
      notes: "Extra principal payment"
    )
  end

  def apply_with_schedule_adjustment(amount:, from_account:, date:)
    # Apply payment and regenerate future schedule
    create_payment_transfer(
      amount: amount,
      from_account: from_account,
      date: date,
      notes: "Extra payment with schedule adjustment"
    )

    # Regenerate remaining schedule based on new balance
    rebuild_schedule!
  end

  def build_payment_notes(user_notes)
    base_note = if personal_loan? && counterparty_name.present?
      context = sharia_compliant? ? "(Syariah compliant)" : ""
      "Repayment to #{counterparty_name} #{context}".strip
    else
      "Loan payment"
    end

    user_notes.present? ? "#{base_note} — #{user_notes}" : base_note
  end

  def build_borrowing_notes(user_notes)
    base_note = if personal_loan? && counterparty_name.present?
      context = sharia_compliant? ? "(Syariah compliant)" : ""
      "Additional borrowing from #{counterparty_name} #{context}".strip
    else
      "Additional loan disbursement"
    end

    user_notes.present? ? "#{base_note} — #{user_notes}" : base_note
  end

  def interest_expense_name
    base = sharia_compliant? ? "Profit portion of installment" : "Interest portion of installment"
    "#{base} — #{account.name}"
  end

  def interest_transaction_kind
    sharia_compliant? ? "margin_payment" : "loan_payment"
  end


  def sync_accounts!(*accounts)
    ([account] + accounts).uniq.each(&:sync_later)
  end
end
