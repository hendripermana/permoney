class PersonalLending::PaymentService
  Result = Struct.new(:success?, :transfer, :error, keyword_init: true)

  def self.call!(family:, params:)
    new(family:, params:).call!
  end

  def initialize(family:, params:)
    @family = family
    # Accept symbol or string keys safely
    @params = params.to_h.with_indifferent_access
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
      required = %i[personal_lending_account_id source_account_id amount]
      required.each do |key|
        raise ArgumentError, "Missing required param: #{key}" if params[key].blank?
      end

      raise ArgumentError, "Amount must be positive" if amount.to_d <= 0

      unless personal_lending_account.accountable_type == "PersonalLending"
        raise ArgumentError, "Account must be a Personal Lending account"
      end

      # Overpayment validation (Personal Lending is lending_out only)
      excess = overpayment_amount
      if excess.positive? && !treat_excess_as_income?
        raise ArgumentError, "Payment exceeds outstanding by #{Money.new(excess, personal_lending_account.currency)}. Enable 'Record excess as income' to proceed."
      end
    end

    def create_payment_transfer!
      personal_lending = personal_lending_account.accountable

      outstanding_before = outstanding_amount
      payment_amount = amount.to_d

      # If overpaying on lending_out and treating excess as income, cap transfer to outstanding
      excess = 0.to_d
      if lending_out? && payment_amount > outstanding_before
        excess = payment_amount - outstanding_before
        payment_amount = outstanding_before
      end

      # Personal Lending is lending_out only:
      # Money comes into bank (cash), PL balance decreases
      # => source: personal_lending_account, destination: source_account
      @transfer = Transfer::Creator.new(
        family: family,
        source_account_id: personal_lending_account.id,
        destination_account_id: source_account_id,
        date: date,
        amount: payment_amount
      ).create

      # Update transaction kinds and notes contextually
      if @transfer.persisted?
        @transfer.outflow_transaction&.update!(kind: outflow_transaction_kind)
        @transfer.inflow_transaction&.update!(kind: inflow_transaction_kind)

        note = payment_notes
        @transfer.update!(notes: note)
        @transfer.outflow_transaction&.entry&.update!(notes: note)
        @transfer.inflow_transaction&.entry&.update!(notes: note)
      end

      # If there is excess on lending_out and user opted in, record it as income to the destination account
      if lending_out? && excess.positive? && treat_excess_as_income?
        record_excess_income!(excess)
      end

      # Mark as returned if fully paid off after this operation
      outstanding_after = [ outstanding_before - payment_amount, 0.to_d ].max
      if lending_out? && outstanding_after <= 0 && personal_lending.actual_return_date.nil?
        personal_lending.update!(actual_return_date: date)
      end
    end

    def sync_accounts!
      personal_lending_account.sync_later
      source_account.sync_later
    end

    def outflow_transaction_kind
      # For Personal Lending (lending_out), the outflow side is the PL account
      "personal_lending"
    end

    def inflow_transaction_kind
      "funds_movement" # The receiving side is always funds movement
    end

    def record_excess_income!(excess_amount)
      counterparty = personal_lending_account.accountable.counterparty_name
      income_entry = source_account.entries.create!(
        amount: -excess_amount.to_d.abs,
        currency: source_account.currency,
        date: date,
        name: "Excess repayment from #{counterparty}",
        entryable: Transaction.new(kind: "standard")
      )

      # Auto-categorize as Gift income
      income_entry.entryable.update!(category: gift_income_category)
    end

    def outstanding_amount
      personal_lending_account.balance.to_d
    end

    def overpayment_amount
      [ amount.to_d - outstanding_amount, 0.to_d ].max
    end

    def lending_out?
      true
    end

    def treat_excess_as_income?
      ActiveModel::Type::Boolean.new.cast(params[:treat_excess_as_income])
    end

    def gift_income_category
      parent_income = family.categories.find_by(name: "Income")

      # Choose a color: inherit from parent if present, otherwise a default
      color = parent_income&.color || Category::COLORS.first

      family.categories.find_or_create_by!(name: "Gift") do |category|
        category.classification = "income"
        category.parent = parent_income if parent_income
        category.color = color
        category.lucide_icon = "ribbon"
      end
    end

    def payment_notes
      personal_lending = personal_lending_account.accountable
      base_note = "Payment from #{personal_lending.counterparty_name}"
      base_note = if personal_lending.sharia_compliant?
        "#{base_note} (Syariah compliant - #{personal_lending.lending_type.humanize})"
      else
        base_note
      end

      user_note = params[:notes].to_s.strip
      user_note.present? ? "#{base_note} — #{user_note}" : base_note
    end

    # Name generation moved to Transfer::Creator for consistency

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
