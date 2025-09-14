class Loan::RemainingPrincipalCalculator
  def initialize(account)
    @account = account
    raise ArgumentError, "Account must be a Loan account" unless @account&.accountable_type == "Loan"
  end

  # Returns a decimal number in account currency units
  def remaining_principal
    base = (@account.accountable.initial_balance || 0).to_d

    tx_join = "INNER JOIN transactions ON transactions.id = entries.entryable_id AND entries.entryable_type = 'Transaction'"

    # Explicit disbursements: Additional money borrowed
    disbursements = @account
      .entries
      .joins(tx_join)
      .where(transactions: { kind: "loan_disbursement" })
      .sum(:amount)
      .to_d

    # Principal paid: transfers into loan account (destination side), represented
    # as Transaction kind=funds_movement with negative entry amounts on the loan
    principal_paid = @account
      .entries
      .joins(tx_join)
      .where(transactions: { kind: "funds_movement" })
      .where("entries.amount < 0")
      .sum("-entries.amount")
      .to_d

    remaining = (base + disbursements - principal_paid)

    begin
      Rails.logger.info({ at: "Loan.Remaining", account_id: @account.id, disburse_count: disbursement_count, principal_payments_count: principal_payment_count, remaining: remaining.to_s }.to_json)
    rescue
      # no-op
    end

    remaining
  end

  # Convenience: return Money instance in account currency
  def remaining_principal_money
    Money.new(remaining_principal, @account.currency)
  end

  private
    def tx_join_sql
      "INNER JOIN transactions ON transactions.id = entries.entryable_id AND entries.entryable_type = 'Transaction'"
    end

    def disbursement_count
      @account.entries.joins(tx_join_sql).where(transactions: { kind: "loan_disbursement" }).count
    end

    def principal_payment_count
      @account.entries.joins(tx_join_sql).where(transactions: { kind: "funds_movement" }).where("entries.amount < 0").count
    end
end
