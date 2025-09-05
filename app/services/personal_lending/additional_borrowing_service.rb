class PersonalLending::AdditionalBorrowingService
  Result = Struct.new(:success?, :entry, :transfer, :error, keyword_init: true)

  def self.call!(family:, params:)
    new(family:, params:).call!
  end

  def initialize(family:, params:)
    @family = family
    @params = params
  end

  def call!
    validate_params!

    ActiveRecord::Base.transaction do
      create_borrowing_transaction!
      create_disbursement_transfer! if transfer_account_id.present?
      sync_account!
    end

    Result.new(success?: true, entry: @borrowing_entry, transfer: @transfer)
  rescue => e
    Result.new(success?: false, error: e.message)
  end

  private
    attr_reader :family, :params

    def validate_params!
      required = %w[personal_lending_account_id amount]
      required.each do |key|
        raise ArgumentError, "Missing required param: #{key}" if params[key].blank?
      end

      raise ArgumentError, "Amount must be positive" if amount.to_d <= 0

      unless personal_lending_account.accountable_type == "PersonalLending"
        raise ArgumentError, "Account must be a Personal Lending account"
      end

      unless personal_lending_account.accountable.lending_direction == "borrowing_from"
        raise ArgumentError, "Additional borrowing only available for borrowing accounts"
      end
    end

    def create_borrowing_transaction!
      personal_lending = personal_lending_account.accountable

      transaction_name = "Additional money borrowed from #{personal_lending.counterparty_name}"

      # For borrowing: negative amount (inflow to the account)
      @borrowing_entry = personal_lending_account.entries.create!(
        amount: -amount.to_d,
        currency: personal_lending_account.currency,
        date: date,
        name: transaction_name,
        notes: notes,
        entryable: Transaction.new(
          kind: "personal_borrowing",
          is_sharia_compliant: personal_lending.sharia_compliant?,
          islamic_transaction_type: personal_lending.lending_type
        )
      )
    end

    def create_disbursement_transfer!
      return unless transfer_account_id.present?

      @transfer = Transfer::Creator.new(
        family: family,
        source_account_id: personal_lending_account.id,
        destination_account_id: transfer_account_id,
        date: date,
        amount: amount.to_d
      ).create
    end

    def sync_account!
      personal_lending_account.sync_later
      transfer_account.sync_later if transfer_account.present?
    end

    # Parameter accessors
    def personal_lending_account_id
      params[:personal_lending_account_id]
    end

    def personal_lending_account
      @personal_lending_account ||= family.accounts.find(personal_lending_account_id)
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
