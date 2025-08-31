module PayLater
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
      amount = params.fetch(:amount).to_d.abs
      currency = params[:currency].presence || account.currency
      date = parse_date(params[:date]) || Date.current
      tenor = params[:tenor_months].to_i
      manual_rate = params[:manual_monthly_rate]&.to_d

      installments = []
      entry = nil

      ActiveRecord::Base.transaction do
        validate_credit!(account, amount)

        # 1) Create Expense Transaction on PayLater account (liability increase)
        entry = account.entries.create!(
          amount: amount, # positive on liability = increases debt
          currency: currency,
          date: date,
          name: name,
          entryable: Transaction.new(
            category_id: params[:category_id],
            merchant_id: params[:merchant_id]
          )
        )

        # 2) Compute rate and schedule
        rate = current_rate_for(account, tenor) || manual_rate || 0.to_d
        installments = build_installments!(account, amount, tenor, rate, start_date: date)

        # 3) Update available credit if tracked
        if account.accountable.available_credit.present?
          new_available = (account.accountable.available_credit || 0) - amount
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

      # Generates installments and persists to pay_later_installments
      # Simple flat monthly_rate model (e.g., 2.63% per month of principal)
      def build_installments!(account, principal, tenor, monthly_rate, start_date:)
        tenor = tenor.to_i
        return [] if tenor <= 0

        equal_principal = (principal / tenor).round(2)
        installments = []

        tenor.times do |i|
          n = i + 1
          due_date = (start_date.to_date >> n)
          # optional: free-interest period for first N months
          rate = (n <= (account.accountable.free_interest_months || 0)) ? 0.to_d : monthly_rate
          interest = (principal * rate).round(2)
          total_due = (equal_principal + interest).round(2)

          installments << PayLaterInstallment.create!(
            account_id: account.id,
            installment_no: n,
            due_date: due_date,
            status: "pending",
            principal_amount: equal_principal,
            interest_amount: interest,
            fee_amount: 0,
            total_due: total_due
          )
        end

        installments
      end
  end
end

