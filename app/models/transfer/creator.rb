class Transfer::Creator
  def initialize(family:, source_account_id:, destination_account_id:, date:, amount:, precious_metal: nil, save_price: false)
    @family = family
    @source_account = family.accounts.find(source_account_id) # early throw if not found
    @destination_account = family.accounts.find(destination_account_id) # early throw if not found
    @date = date
    @amount = amount.to_d
    @precious_metal = precious_metal
    @save_price = ActiveModel::Type::Boolean.new.cast(save_price)
  end

  def create
    transfer = Transfer.new(
      inflow_transaction: inflow_transaction,
      outflow_transaction: outflow_transaction,
      status: "confirmed"
    )

    Transfer.transaction do
      if transfer.save
        update_precious_metal_defaults if save_price?
        source_account.sync_later
        destination_account.sync_later
      end
    end

    transfer
  end

  private
    attr_reader :family, :source_account, :destination_account, :date, :amount, :precious_metal, :save_price

    def outflow_transaction
      name = outflow_name

      Transaction.new(
        kind: outflow_transaction_kind,
        entry: source_account.entries.build(
          amount: amount.abs,
          currency: source_account.currency,
          date: date,
          name: name,
        )
      )
    end

    def inflow_transaction
      name = inflow_name

      Transaction.new(
        kind: "funds_movement",
        entry: destination_account.entries.build(
          amount: inflow_converted_money.amount.abs * -1,
          currency: destination_account.currency,
          date: date,
          name: name,
        )
      ).tap do |transaction|
        payload = precious_metal_payload
        transaction.extra = payload if payload.present?
      end
    end

    # If destination account has different currency, its transaction should show up as converted
    # Future improvement: instead of a 1:1 conversion fallback, add a UI/UX flow for missing rates
    def inflow_converted_money
      Money.new(amount.abs, source_account.currency)
           .exchange_to(
             destination_account.currency,
             date: date,
             fallback_rate: 1.0
           )
    end

    def precious_metal_payload
      return nil unless destination_account.accountable_type == "PreciousMetal"
      return nil unless precious_metal.is_a?(Hash)

      payload = precious_metal.stringify_keys.slice(*precious_metal_allowed_keys)
      payload["account_id"] ||= destination_account.id
      payload["unit"] ||= destination_account.accountable.unit
      payload["action"] = "buy" unless payload["action"] == "buy"

      precious_metal_decimal_keys.each do |key|
        value = payload[key]
        next if value.blank?

        payload[key] = BigDecimal(value.to_s).to_s("F")
      rescue ArgumentError
        payload.delete(key)
      end

      { "precious_metal" => payload }
    end

    # The "expense" side of a transfer is treated different in analytics based on where it goes.
    def outflow_transaction_kind
      if destination_account.loan?
        "loan_payment"
      elsif destination_account.accountable_type == "PersonalLending"
        # Use the Transfer class method to determine the correct kind
        Transfer.kind_for_account(destination_account)
      elsif destination_account.liability?
        "cc_payment"
      else
        "funds_movement"
      end
    end

    def save_price?
      save_price
    end

    def update_precious_metal_defaults
      return unless destination_account.accountable_type == "PreciousMetal"

      price_value = precious_metal&.dig(:price_per_unit) || precious_metal&.dig("price_per_unit")
      currency_value = precious_metal&.dig(:price_currency) || precious_metal&.dig("price_currency")
      return if price_value.blank? || currency_value.blank?

      destination_account.accountable.update!(
        manual_price: price_value,
        manual_price_currency: currency_value
      )

      return if destination_account.currency == currency_value

      destination_account.update!(currency: currency_value)
    end

    def precious_metal_allowed_keys
      @precious_metal_allowed_keys ||= %w[
        action account_id quantity quantity_delta unit cash_amount cash_currency
        price_per_unit price_currency fee_amount fee_currency
      ].freeze
    end

    def precious_metal_decimal_keys
      @precious_metal_decimal_keys ||= %w[
        quantity quantity_delta cash_amount price_per_unit fee_amount
      ].freeze
    end

    # Build context-aware, user-friendly names for both sides of the transfer.
    # The wording favors clarity for non-expert users.
    def outflow_name
      # Personal Lending cases
      if personal_lending_context?
        ctx = personal_lending_context
        pl = ctx[:pl]
        counterparty = pl.counterparty_name

        # Personal Lending is lending_out only
        # Two flows:
        # 1) Additional lending: source is bank, destination is PL
        return "Lending to #{counterparty}" if ctx[:role] == :destination

        # 2) Payment received: source is PL, destination is bank
        return repayment_label(prefix: "Repayment from", amount:, outstanding: source_account.balance, final_word: "Final")
      end

      # Loan target
      if destination_account.loan?
        return destination_account.accountable.personal_loan? ? "Loan repayment to #{destination_account.name}" : "Loan payment to #{destination_account.name}"
      end

      # Other liabilities (e.g., credit cards)
      return "Payment to #{destination_account.name}" if destination_account.liability?

      # Default transfer wording
      "Transfer to #{destination_account.name}"
    end

    def inflow_name
      if personal_lending_context?
        ctx = personal_lending_context
        pl = ctx[:pl]
        counterparty = pl.counterparty_name

        # Additional lending: destination is PL
        return "Money lent to #{counterparty}" if ctx[:role] == :destination

        # Payment received: destination is bank
        return repayment_label(prefix: "Payment received from", amount:, outstanding: source_account.balance, final_word: "Final")
      end

      # Loan target
      if destination_account.loan?
        return destination_account.accountable.personal_loan? ? "Loan repayment from #{source_account.name}" : "Loan payment from #{source_account.name}"
      end

      # Other liabilities
      return "Payment from #{source_account.name}" if destination_account.liability?

      # Default transfer wording
      "Transfer from #{source_account.name}"
    end

    def personal_lending_context?
      source_account.accountable_type == "PersonalLending" || destination_account.accountable_type == "PersonalLending"
    end

    def personal_lending_context
      if destination_account.accountable_type == "PersonalLending"
        { pl: destination_account.accountable, role: :destination }
      elsif source_account.accountable_type == "PersonalLending"
        { pl: source_account.accountable, role: :source }
      end
    end

    # For repayments, include Partial/Final label for clarity
    def repayment_label(prefix:, amount:, outstanding:, final_word: "Final")
      begin
        amt = amount.to_d
        out = outstanding.to_d
        if out > 0 && amt < out
          "Partial #{prefix.downcase} #{source_personal_lending_counterparty}"
        else
          "#{final_word} #{prefix.downcase} #{source_personal_lending_counterparty}"
        end
      rescue
        "#{prefix} #{source_personal_lending_counterparty}"
      end
    end

    def source_personal_lending_counterparty
      if source_account.accountable_type == "PersonalLending"
        source_account.accountable.counterparty_name
      elsif destination_account.accountable_type == "PersonalLending"
        destination_account.accountable.counterparty_name
      else
        source_account.name
      end
    end
end
