class DebtOriginationService
  Result = Struct.new(:success?, :account, :error, :principal_delta, :delta_date, :balance_adjustment_entry_id, keyword_init: true)

  def self.call!(family:, params:)
    new(family:, params:).call!
  end

  def initialize(family:, params:)
    @family = family
    # Use indifferent access so both symbol and string keys work reliably
    @params = params.deep_dup.with_indifferent_access
  end

  attr_reader :balance_adjustment_entry_id

  def call!
    validate_params!

    ActiveRecord::Base.transaction do
      create_loan_account!

      if imported?
        seed_opening_anchor_via_manager!
      else
        create_disbursement_transfer!
      end

      apply_desired_balance!
      lock_and_sync!
    end

    Result.new(
      success?: true,
      account: @loan_account,
      principal_delta: principal_delta,
      delta_date: delta_reference_date,
      balance_adjustment_entry_id: balance_adjustment_entry_id
    )
  rescue => e
    Result.new(success?: false, error: e.message)
  end

  private
    attr_reader :family, :params

    def validate_params!
      required = %w[name currency]
      required.each do |k|
        next if params[k].present? || params.dig(:account, k).present?
        raise ArgumentError, "Missing required param: #{k}"
      end

      unless imported?
        # Only require disbursement_account_id for institutional loans or when explicitly needed
        debt_kind = params[:debt_kind] || params.dig(:accountable_attributes, :debt_kind) || "personal"
        if debt_kind == "institutional" || disbursement_account_id.present?
          raise ArgumentError, "Missing disbursement_account_id" if disbursement_account_id.blank?
        end
      end
      raise ArgumentError, "Missing initial principal" if initial_principal.blank? || initial_principal.to_d <= 0
    end

    def create_loan_account!
      loan_attrs = loan_accountable_attributes.dup
      balloon_value = loan_attrs.delete(:balloon_amount)

      acct_attrs = if params[:account].present?
        params[:account]
      else
        # Support both flattened and namespaced params
        params.slice(:name, :currency, :balance, :subtype).merge(
          accountable_type: "Loan",
          accountable_attributes: loan_attrs
        )
      end

      # Ensure classification and currency presence
      acct_attrs[:currency] ||= family.currency
      acct_attrs[:accountable_type] = "Loan"
      acct_attrs[:accountable_attributes] ||= loan_attrs

      # We create via Account directly to avoid auto-opening anchor if we are going to post a transfer
      @loan_account = family.accounts.new(acct_attrs)
      @loan_account.accountable.assign_attributes(
        {
          debt_kind: params[:debt_kind] || params.dig(:accountable_attributes, :debt_kind),
          counterparty_type: params[:counterparty_type] || params.dig(:accountable_attributes, :counterparty_type),
          counterparty_name: params[:counterparty_name] || params.dig(:accountable_attributes, :counterparty_name),
          relationship: params[:relationship] || params.dig(:accountable_attributes, :relationship),
          linked_contact_id: params[:linked_contact_id] || params.dig(:accountable_attributes, :linked_contact_id),
          lender_name: params[:lender_name] || params.dig(:accountable_attributes, :lender_name),
          disbursement_account_id: disbursement_account_id,
          origination_date: origination_date,
          compliance_type: params[:compliance_type] || params.dig(:accountable_attributes, :compliance_type)
        }.compact
      )
      @loan_account.save!

      # Persist loan metadata onto accountable
      @loan_account.accountable.update!(
        debt_kind: params[:debt_kind] || params.dig(:accountable_attributes, :debt_kind),
        counterparty_type: params[:counterparty_type] || params.dig(:accountable_attributes, :counterparty_type),
        counterparty_name: params[:counterparty_name] || params.dig(:accountable_attributes, :counterparty_name),
        relationship: params[:relationship] || params.dig(:accountable_attributes, :relationship),
        disbursement_account_id: disbursement_account_id,
        origination_date: origination_date,
        initial_balance: initial_principal.to_d,
        principal_amount: desired_balance || initial_principal.to_d
      )

      if params.key?(:balloon_amount) || params.dig(:accountable_attributes, :balloon_amount)
        updated_extra = (@loan_account.accountable.extra || {}).dup
        if balloon_value.nil?
          updated_extra.delete("balloon_amount")
        else
          updated_extra["balloon_amount"] = balloon_value
        end
        @loan_account.accountable.update!(extra: updated_extra)
      end
    end

    def seed_opening_anchor_via_manager!
      manager = Account::OpeningBalanceManager.new(@loan_account)
      res = manager.set_opening_balance(balance: initial_principal.to_d, date: (origination_date || default_opening_date))
      raise res.error if res.error
      @loan_account.sync_later
    end

    def create_disbursement_transfer!
      Transfer::Creator.new(
        family: family,
        source_account_id: @loan_account.id,
        destination_account_id: disbursement_account_id,
        date: origination_date || Date.current,
        amount: initial_principal.to_d
      ).create
    end

    def lock_and_sync!
      @loan_account.lock_saved_attributes!
      @loan_account.sync_later
    end

    def disbursement_account_id
      params[:disbursement_account_id] || params.dig(:accountable_attributes, :disbursement_account_id)
    end

    def origination_date
      val = params[:origination_date] || params.dig(:accountable_attributes, :origination_date)
      return val if val.is_a?(Date)
      return nil if val.blank?
      Date.parse(val.to_s)
    rescue ArgumentError
      nil
    end

    def initial_principal
      params[:initial_balance] || params.dig(:accountable_attributes, :initial_balance)
    end

    def desired_balance
      @desired_balance ||= begin
        raw = params[:balance] || params.dig(:account, :balance) || params.dig(:accountable_attributes, :balance)
        normalize_decimal(raw)
      end
    end

    def loan_accountable_attributes
      {
        rate_type: params[:rate_type] || params.dig(:accountable_attributes, :rate_type),
        interest_rate: params[:interest_rate] || params.dig(:accountable_attributes, :interest_rate),
        term_months: params[:term_months] || params.dig(:accountable_attributes, :term_months),
        initial_balance: initial_principal,
        principal_amount: params[:principal_amount] || params.dig(:accountable_attributes, :principal_amount) || initial_principal,
        start_date: params[:start_date] || params.dig(:accountable_attributes, :start_date),
        tenor_months: params[:tenor_months] || params.dig(:accountable_attributes, :tenor_months),
        payment_frequency: params[:payment_frequency] || params.dig(:accountable_attributes, :payment_frequency),
        schedule_method: params[:schedule_method] || params.dig(:accountable_attributes, :schedule_method),
        rate_or_profit: params[:rate_or_profit] || params.dig(:accountable_attributes, :rate_or_profit),
        balloon_amount: normalized_balloon_amount,
        interest_free: params[:interest_free] || params.dig(:accountable_attributes, :interest_free)
      }.compact
    end

    def normalized_balloon_amount
      raw = params[:balloon_amount]
      raw = params.dig(:accountable_attributes, :balloon_amount) if raw.blank?
      return nil if raw.blank?

      BigDecimal(raw.to_s)
    rescue ArgumentError
      nil
    end

    def normalize_decimal(value)
      return nil if value.blank?
      BigDecimal(value.to_s)
    rescue ArgumentError
      nil
    end

    def apply_desired_balance!
      return unless desired_balance

      @loan_account.reload
      result = @loan_account.set_current_balance(desired_balance)
      unless result.success?
        Rails.logger.warn({ at: "DebtOriginationService.balance_adjust", account_id: @loan_account.id, error: result.error }.to_json) rescue nil
      end
      @loan_account.accountable.update!(principal_amount: desired_balance)

      @balance_adjustment_entry_id = detect_balance_adjustment_entry(desired_balance)
    rescue => e
      Rails.logger.warn({ at: "DebtOriginationService.balance_adjust.error", account_id: @loan_account&.id, error: e.message }.to_json) rescue nil
    end

    def imported?
      ActiveModel::Type::Boolean.new.cast(params[:imported] || params.dig(:accountable_attributes, :imported))
    end

    def default_opening_date
      2.years.ago.to_date
    end

    def principal_delta
      return 0.to_d if desired_balance.nil? || initial_principal.nil?

      diff = initial_principal.to_d - desired_balance.to_d
      diff.positive? ? diff : 0.to_d
    rescue ArgumentError
      0.to_d
    end

    def delta_reference_date
      origination_date || Date.current
    end

    def detect_balance_adjustment_entry(target_amount)
      return nil unless target_amount

      @loan_account.entries
                   .joins("INNER JOIN valuations ON valuations.id = entries.entryable_id")
                   .where(entryable_type: "Valuation", valuations: { kind: "reconciliation" }, currency: @loan_account.currency)
                   .where(date: Date.current)
                   .order(created_at: :desc)
                   .find do |entry|
                     (entry.amount.to_d - target_amount.to_d).abs < 0.01
                   end
                   &.id
    rescue StandardError
      nil
    end
end
