class Loan::AdditionalBorrowingService
  Result = Struct.new(:success?, :entry, :transfer, :error, keyword_init: true)

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
      create_borrowing_transaction!
      create_disbursement_transfer! if transfer_account_id.present?
      update_loan_principal!
      sync_account!
    end

    Result.new(success?: true, entry: @borrowing_entry, transfer: @transfer)
  rescue => e
    Result.new(success?: false, error: e.message)
  end

  private
    attr_reader :family, :params

    def validate_params!
      required = %w[loan_account_id amount]
      required.each do |key|
        raise ArgumentError, "Missing required param: #{key}" if params[key].blank?
      end

      raise ArgumentError, "Amount must be positive" if amount.to_d <= 0

      unless loan_account.accountable_type == "Loan"
        raise ArgumentError, "Account must be a Loan account"
      end

      unless loan_account.accountable.personal_loan?
        raise ArgumentError, "Additional borrowing only available for personal loans"
      end
    end

    def create_borrowing_transaction!
      loan = loan_account.accountable

      counterparty = loan.counterparty_name.present? ? loan.counterparty_name : "lender"
      transaction_name = "Additional money borrowed from #{counterparty}"

      # For borrowing: positive amount increases debt balance for liability accounts
      # The balance calculation for liability accounts adds entry amounts directly
      @borrowing_entry = loan_account.entries.create!(
        amount: amount.to_d,
        currency: loan_account.currency,
        date: date,
        name: transaction_name,
        notes: notes,
        entryable: Transaction.new(
          kind: "loan_disbursement",
          is_sharia_compliant: loan.sharia_compliant?,
          islamic_transaction_type: loan.islamic_product_type
        )
      )
    end

    def create_disbursement_transfer!
      return unless transfer_account_id.present?

      @transfer = Transfer::Creator.new(
        family: family,
        source_account_id: loan_account.id,
        destination_account_id: transfer_account_id,
        date: date,
        amount: amount.to_d
      ).create
    end

    def update_loan_principal!
      loan = loan_account.accountable
      base = loan.principal_amount || loan.initial_balance || 0
      new_principal = base.to_d + amount.to_d

      loan.update!(
        principal_amount: new_principal
      )
    end

    def sync_account!
      # Schedule async sync for balance recalculation
      # The balance will be recalculated from entries by the sync process
      loan_account.sync_later
      transfer_account.sync_later if transfer_account.present?
    end

    # Parameter accessors
    def loan_account_id
      params[:loan_account_id]
    end

    def loan_account
      @loan_account ||= family.accounts.find(loan_account_id)
    end

    def transfer_account_id
      params[:transfer_account_id]
    end

    def transfer_account
      @transfer_account ||= family.accounts.find(transfer_account_id) if transfer_account_id.present?
    end

    def amount
      params[:amount]
    end

    def date
      params[:date] || Date.current
    end

    def notes
      params[:notes]
    end
end
