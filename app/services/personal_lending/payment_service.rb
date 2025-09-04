class PersonalLending::PaymentService
  Result = Struct.new(:success?, :transfer, :error, keyword_init: true)

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
      create_payment_transfer!
      sync_accounts!
    end

    Result.new(success?: true, transfer: @transfer)
  rescue => e
    Result.new(success?: false, error: e.message)
  end

  private
    attr_reader :family, :params

    def validate_params!
      required = %w[personal_lending_account_id source_account_id amount]
      required.each do |key|
        raise ArgumentError, "Missing required param: #{key}" if params[key].blank?
      end

      raise ArgumentError, "Amount must be positive" if amount.to_d <= 0
      
      unless personal_lending_account.accountable_type == "PersonalLending"
        raise ArgumentError, "Account must be a Personal Lending account"
      end
    end

    def create_payment_transfer!
      personal_lending = personal_lending_account.accountable

      # Direction-aware money flow:
      # - lending_out (asset): money comes into bank, PL balance should decrease
      #   => source: personal_lending_account, destination: source_account
      # - borrowing_from (liability): money goes out from bank to reduce what you owe
      #   => source: source_account, destination: personal_lending_account
      if personal_lending.lending_direction == "lending_out"
        @transfer = Transfer::Creator.new(
          family: family,
          source_account_id: personal_lending_account.id,
          destination_account_id: source_account_id,
          date: date,
          amount: amount.to_d
        ).create
      else # borrowing_from
        @transfer = Transfer::Creator.new(
          family: family,
          source_account_id: source_account_id,
          destination_account_id: personal_lending_account.id,
          date: date,
          amount: amount.to_d
        ).create
      end

      # Update transaction kinds and notes contextually
      if @transfer.persisted?
        @transfer.outflow_transaction.update!(kind: outflow_transaction_kind)
        @transfer.inflow_transaction.update!(kind: inflow_transaction_kind)

        note = payment_notes
        @transfer.update!(notes: note)
        @transfer.outflow_transaction.entry.update!(notes: note)
        @transfer.inflow_transaction.entry.update!(notes: note)
      end
    end

    def sync_accounts!
      personal_lending_account.sync_later
      source_account.sync_later
    end

    def outflow_transaction_kind
      # Based on lending direction, determine the payment type
      case personal_lending_account.accountable.lending_direction
      when "borrowing_from"
        "personal_borrowing" # You're paying back someone you borrowed from
      when "lending_out"
        "personal_lending" # Someone is paying you back
      else
        "funds_movement"
      end
    end

    def inflow_transaction_kind
      "funds_movement" # The receiving side is always funds movement
    end

    def payment_notes
      personal_lending = personal_lending_account.accountable
      direction = personal_lending.lending_direction == "borrowing_from" ? "repayment to" : "payment from"
      
      base_note = "#{direction.capitalize} #{personal_lending.counterparty_name}"
      
      base_note = if personal_lending.sharia_compliant?
        "#{base_note} (Syariah compliant - #{personal_lending.lending_type.humanize})"
      else
        base_note
      end

      user_note = params[:notes].to_s.strip
      user_note.present? ? "#{base_note} — #{user_note}" : base_note
    end

    # Parameter accessors
    def personal_lending_account_id
      params[:personal_lending_account_id]
    end

    def personal_lending_account
      @personal_lending_account ||= family.accounts.find(personal_lending_account_id)
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
