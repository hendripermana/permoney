class Loan::PaymentService
  Result = Struct.new(:success?, :transfer, :error, keyword_init: true)

  def self.call!(family:, params:)
    new(family:, params:).call!
  end

  def initialize(family:, params:)
    @family = family
    # Accept both string and symbol keys reliably
    @params = params.deep_dup.with_indifferent_access
  end

  def call!
    validate_params!

    ActiveRecord::Base.transaction do
      # If a planned installment exists and the requested amount is blank or
      # matches the planned total, post via Loan::PostInstallment to split
      # principal and interest correctly.
      pending = loan_account.loan_installments.pending.order(:installment_no).first
      if pending.present? && (amount.blank? || amounts_match?(pending.total_amount, amount))
        result = Loan::PostInstallment.new(
          family: family,
          account_id: loan_account.id,
          source_account_id: source_account_id,
          date: date
        ).call!
        raise result.error unless result.success?
        @transfer = result.transfer
      else
        create_payment_transfer!
      end
      sync_accounts!
    end

    Result.new(success?: true, transfer: @transfer)
  rescue => e
    Result.new(success?: false, error: e.message)
  end

  private
    attr_reader :family, :params

    def validate_params!
      required = %w[loan_account_id source_account_id amount]
      required.each do |key|
        raise ArgumentError, "Missing required param: #{key}" if params[key].blank?
      end

      raise ArgumentError, "Amount must be positive" if amount.to_d <= 0

      unless loan_account.accountable_type == "Loan"
        raise ArgumentError, "Account must be a Loan account"
      end
    end

    def create_payment_transfer!
      loan = loan_account.accountable

      # Create a contextualized transfer for loan payment
      @transfer = Transfer::Creator.new(
        family: family,
        source_account_id: source_account_id,
        destination_account_id: loan_account.id,
        date: date,
        amount: amount.to_d
      ).create

      # Update transaction kinds and notes to be more contextual for personal loans
      if @transfer.persisted? && loan.personal_loan?
        # Notes are stored on entries, not on transactions
        note = payment_notes(loan)
        @transfer.update!(notes: note)
        @transfer.outflow_transaction.entry.update!(notes: note)
        @transfer.inflow_transaction.entry.update!(notes: note)
      end
    end

    def amounts_match?(planned_total, provided)
      (planned_total.to_d - provided.to_d).abs < 0.01
    end

    def sync_accounts!
      loan_account.sync_later
      source_account.sync_later
    end

    def payment_notes(loan)
      if loan.counterparty_name.present?
        base_note = "Repayment to #{loan.counterparty_name}"

        base_note = if loan.sharia_compliant?
          "#{base_note} (Syariah compliant - #{loan.islamic_product_type&.humanize || 'Interest-free'})"
        else
          base_note
        end
      else
        base_note = "Loan payment"
      end

      user_note = params[:notes].to_s.strip
      user_note.present? ? "#{base_note} — #{user_note}" : base_note
    end

    # Parameter accessors
    def loan_account_id
      params[:loan_account_id]
    end

    def loan_account
      @loan_account ||= family.accounts.find(loan_account_id)
    end

    def source_account_id
      params[:source_account_id]
    end

    def source_account
      @source_account ||= family.accounts.find(source_account_id)
    end

    def amount
      params[:amount]
    end

    def date
      params[:date] || Date.current
    end
end
