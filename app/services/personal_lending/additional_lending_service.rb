class PersonalLending::AdditionalLendingService
  Result = Struct.new(:success?, :transfer, :error, keyword_init: true)

  def self.call!(family:, params:)
    new(family:, params:).call!
  end

  def initialize(family:, params:)
    @family = family
    # Ensure indifferent access so callers can pass symbol or string keys safely
    @params = params.to_h.with_indifferent_access
  end

  def call!
    validate_params!

    ActiveRecord::Base.transaction do
      create_disbursement_transfer!
      sync_accounts!
    end

    Result.new(success?: true, transfer: @transfer)
  rescue => e
    Result.new(success?: false, error: e.message)
  end

  private
    attr_reader :family, :params

    def validate_params!
      required = %i[personal_lending_account_id source_account_id amount]
      required.each do |key|
        raise ArgumentError, "Missing required param: #{key}" if params[key].blank?
      end

      raise ArgumentError, "Amount must be positive" if amount.to_d <= 0

      unless personal_lending_account.accountable_type == "PersonalLending"
        raise ArgumentError, "Account must be a Personal Lending account"
      end

      unless personal_lending_account.accountable.lending_direction == "lending_out"
        raise ArgumentError, "Additional lending only available for lending-out accounts"
      end

      # Reliability checks: valid source account
      if source_account.id == personal_lending_account.id
        raise ArgumentError, "Source account cannot be the same as the Personal Lending account"
      end
      unless source_account.asset? && source_account.balance_type == :cash
        raise ArgumentError, "Source account must be a cash asset account"
      end
    end

    # Create a transfer from a cash account to the Personal Lending account
    # representing additional money lent to the counterparty.
    def create_disbursement_transfer!
      @transfer = Transfer::Creator.new(
        family: family,
        source_account_id: source_account_id,
        destination_account_id: personal_lending_account.id,
        date: date,
        amount: amount.to_d
      ).create

      if @transfer.persisted?
        # Ensure kinds and names are context-appropriate
        @transfer.outflow_transaction&.update!(kind: "personal_lending")
        @transfer.inflow_transaction&.update!(kind: "funds_movement")

        update_entry_names!(@transfer)

        note = lending_notes
        @transfer.update!(notes: note)
        @transfer.outflow_transaction&.entry&.update!(notes: note)
        @transfer.inflow_transaction&.entry&.update!(notes: note)
      end
    end

    def update_entry_names!(transfer)
      pl = personal_lending_account.accountable
      counterparty = pl.counterparty_name

      # Money goes from bank to Personal Lending (asset increase)
      transfer.outflow_transaction&.entry&.update!(name: "Lent money to #{counterparty}")
      transfer.inflow_transaction&.entry&.update!(name: "Money lent to #{counterparty}")
    end

    def lending_notes
      pl = personal_lending_account.accountable
      base = "Lending to #{pl.counterparty_name}"
      base = if pl.sharia_compliant?
        "#{base} (Syariah compliant - #{pl.lending_type.humanize})"
      else
        base
      end
      user_note = params[:notes].to_s.strip
      user_note.present? ? "#{base} — #{user_note}" : base
    end

    def sync_accounts!
      personal_lending_account.sync_later
      source_account.sync_later
    end

    # Param helpers
    def personal_lending_account_id
      params[:personal_lending_account_id]
    end

    def source_account_id
      params[:source_account_id]
    end

    def source_account
      @source_account ||= family.accounts.find(source_account_id)
    end

    def personal_lending_account
      @personal_lending_account ||= family.accounts.find(personal_lending_account_id)
    end

    def amount
      params[:amount]
    end

    def date
      params[:date] || Date.current
    end
end
