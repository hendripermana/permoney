module PayLaterServices
  class RecordExpense
    Result = Struct.new(:success?, :entry, :installments, :error, keyword_init: true)

    def initialize(family:, params:)
      @family = family
      @params = params.deep_symbolize_keys
    end

    def call
      account = family.accounts.find(params.fetch(:account_id))
      raise ArgumentError, "Account is not PayLater" unless account.accountable_type == "PayLater"

      name = params[:name].presence || "PayLater Purchase"
      original_amount = params.fetch(:amount).to_d.abs
      original_currency = (params[:currency].presence || account.accountable.currency_code || account.currency).to_s.upcase
      date = parse_date(params[:date]) || Date.current
      tenor = params[:tenor_months].to_i
      manual_rate = params[:manual_monthly_rate]&.to_d

      installments = []
      entry = nil

      ActiveRecord::Base.transaction do
        # Currency conversion via IDR bridge if expense currency differs from account's PayLater currency
        account_ccy = (account.accountable.currency_code || account.currency).to_s.upcase
        expense_rate_idr = params[:expense_exchange_rate_to_idr]&.to_d || ExchangeRateService.get_latest_rate(original_currency)
        account_rate_idr = account.accountable.exchange_rate_to_idr || ExchangeRateService.get_latest_rate(account_ccy)
        converted_amount = convert_via_idr(original_amount, expense_rate_idr, account_rate_idr)

        validate_credit!(account, converted_amount)

        # 1) Create Expense Transaction on PayLater account (liability increase)
        entry = account.entries.create!(
          amount: converted_amount, # positive on liability = increases debt
          currency: account.currency,
          date: date,
          name: name,
          entryable: Transaction.new(
            category_id: params[:category_id],
            merchant_id: params[:merchant_id]
          )
        )

        # 2) Determine applied rate (provider, or account table fallback with category overrides)
        category_name = entry.transaction.category&.name
        applied_rate = determine_applied_rate(account, tenor, category_name: category_name, manual_rate: manual_rate)

        # 3) Compute schedule
        installments = build_installments!(account, converted_amount, tenor, applied_rate, start_date: date)

        # 4) Audit enrichment (store original/converted amounts and effective rates)
        attach_audit!(entry,
          original_amount: original_amount,
          original_currency: original_currency,
          converted_amount: converted_amount,
          account_currency: account_ccy,
          expense_rate_to_idr: expense_rate_idr,
          account_rate_to_idr: account_rate_idr,
          applied_rate: applied_rate,
          tenor: tenor
        )

        # 3) Update available credit if tracked
        if account.accountable.available_credit.present?
          new_available = (account.accountable.available_credit || 0) - converted_amount
          account.accountable.update!(available_credit: [ new_available, 0 ].max)
        end

        entry.sync_account_later
      end

      Result.new(success?: true, entry: entry, installments: installments)
    rescue => e
      Result.new(success?: false, error: e.message)
    end

    private
      attr_reader :family, :params

      def validate_credit!(account, amount)
        limit = account.accountable.credit_limit
        return true unless limit.present?
        avail = account.accountable.available_credit || 0
        raise ArgumentError, "Insufficient available credit" if amount > avail
      end

      def parse_date(val)
        return val if val.is_a?(Date)
        Date.parse(val.to_s) rescue nil
      end

      def current_rate_for(account, tenor)
        provider = account.accountable.provider_name
        return nil if provider.blank? || tenor <= 0
        PayLaterRate.current_rate_for(provider_name: provider, tenor_months: tenor)&.monthly_rate
      end

      def determine_applied_rate(account, tenor, category_name:, manual_rate: nil)
        return manual_rate if manual_rate.present?

        if ActiveModel::Type::Boolean.new.cast(account.accountable.auto_update_rate)
          current_rate_for(account, tenor)
        else
          table = account.accountable.interest_rate_table || {}
          selected = nil
          if category_name && table.is_a?(Hash) && table["overrides"].is_a?(Hash)
            key = category_name.to_s.downcase
            selected = table.dig("overrides", key, tenor.to_s)
          end
          selected ||= (table.is_a?(Hash) ? table.dig("default", tenor.to_s) || table[tenor.to_s] : nil)
          selected&.to_d
        end
      end

      def convert_via_idr(amount, expense_rate_idr, account_rate_idr)
        return amount if expense_rate_idr.to_d <= 0 || account_rate_idr.to_d <= 0
        (amount * (expense_rate_idr.to_d / account_rate_idr.to_d)).round(2)
      end

      # Generates installments and persists to pay_later_installments
      # Simple flat monthly_rate model (e.g., 2.63% per month of principal)
      def build_installments!(account, principal, tenor, monthly_rate, start_date:)
        tenor = tenor.to_i
        return [] if tenor <= 0

        equal_principal = (principal / tenor).round(2)
        installments = []
        remaining_principal = principal

        tenor.times do |i|
          n = i + 1
          due_date = (start_date.to_date >> n)
          # optional: free-interest period for first N months
          rate = (n <= (account.accountable.free_interest_months || 0)) ? 0.to_d : (monthly_rate || 0.to_d)

          if ActiveModel::Type::Boolean.new.cast(account.accountable.is_compound)
            interest = (remaining_principal * rate).round(2)
          else
            interest = (principal * rate).round(2)
          end
          total_due = (equal_principal + interest).round(2)

          installments << PayLaterInstallment.create!(
            account_id: account.id,
            installment_no: n,
            due_date: due_date,
            status: "pending",
            principal_amount: equal_principal,
            interest_amount: interest,
            fee_amount: 0,
            total_due: total_due,
            applied_rate: monthly_rate
          )

          remaining_principal = (remaining_principal - equal_principal).round(2)
        end

        # Save full-schedule TCO on first installment for reference (principal + interest)
        tco = installments.sum { |x| x.principal_amount.to_d + x.interest_amount.to_d + x.fee_amount.to_d }
        first = installments.first
        first.update!(total_cost: tco) if first

        installments
      end

      def attach_audit!(entry, **data)
        DataEnrichment.create!(
          enrichable: entry,
          source: 'paylater',
          attribute_name: 'expense_audit',
          value: data
        )
      end
  end
end
