module PayLaterHelpers
  class RecordPurchase
    Result = Struct.new(:success?, :transaction, :installments, :error, keyword_init: true)

    attr_reader :family, :pay_later_account, :params

    def initialize(family:, pay_later_account:, params:)
      @family = family
      @pay_later_account = pay_later_account
      @params = params.is_a?(ActionController::Parameters) ? params.to_h.symbolize_keys : params.symbolize_keys
      @pay_later = pay_later_account.accountable
    end

    def call
      validate!

      transaction = nil
      installments = []

      ActiveRecord::Base.transaction do
        # 1. Check available credit
        purchase_amount = params[:amount].to_d
        unless @pay_later.can_purchase?(purchase_amount)
          raise ArgumentError, "Insufficient credit. Available: #{@pay_later.available_credit_money.format}, Required: #{Money.new(purchase_amount, pay_later_account.currency).format}"
        end

        # 2. Create purchase transaction (expense entry)
        transaction = create_purchase_transaction

        # 3. Generate installment schedule
        schedule = generate_installment_schedule(purchase_amount)

        # 4. Create PayLaterInstallment records
        installments = create_installment_records(schedule, transaction)

        # 5. Update available credit
        @pay_later.update_available_credit!

        # 6. Sync account balance
        pay_later_account.sync_later if pay_later_account.respond_to?(:sync_later)
      end

      Result.new(
        success?: true,
        transaction: transaction,
        installments: installments,
        error: nil
      )
    rescue => e
      Rails.logger.error("PayLater::RecordPurchase failed: #{e.message}\n#{e.backtrace.join("\n")}")
      Result.new(
        success?: false,
        transaction: nil,
        installments: [],
        error: e.message
      )
    end

    private

      attr_reader :pay_later

      def validate!
        raise ArgumentError, "Missing amount" unless params[:amount].present?
        raise ArgumentError, "Missing merchant name" unless params[:merchant_name].present?
        raise ArgumentError, "Missing tenor" unless params[:tenor_months].present?
        raise ArgumentError, "Amount must be positive" unless params[:amount].to_d > 0
        raise ArgumentError, "Tenor must be positive" unless params[:tenor_months].to_i > 0
        raise ArgumentError, "Tenor exceeds maximum allowed (#{pay_later.max_tenor})" if params[:tenor_months].to_i > pay_later.max_tenor
        raise ArgumentError, "PayLater account is not active" unless pay_later.active?
      end

      def create_purchase_transaction
        purchase_date = params[:purchase_date] || Date.current
        merchant_name = params[:merchant_name]
        amount = params[:amount].to_d
        category_id = params[:category_id]
        notes = params[:notes]

        # Use existing category from family
        category = category_id ? family.categories.find_by(id: category_id) : nil

        # Create the transaction entry
        entry = pay_later_account.entries.create!(
          date: purchase_date,
          name: "#{merchant_name} - PayLater Purchase",
          amount: amount,
          currency: pay_later_account.currency,
          notes: build_transaction_notes(notes),
          entryable: Transaction.new(
            kind: "standard", # Use standard instead of expense to include in budget
            category: category
          )
        )

        entry
      end

      def generate_installment_schedule(purchase_amount)
        tenor_months = params[:tenor_months].to_i
        purchase_date = params[:purchase_date] || Date.current
        category = params[:rate_category] || "default"

        generator = ScheduleGenerator.new(
          pay_later: pay_later,
          purchase_amount: purchase_amount,
          tenor_months: tenor_months,
          purchase_date: purchase_date,
          category: category
        )

        generator.generate
      end

      def create_installment_records(schedule, transaction)
        schedule.map do |installment_data|
          PayLaterInstallment.create!(
            account_id: pay_later_account.id,
            installment_no: installment_data[:installment_no],
            due_date: installment_data[:due_date],
            principal_amount: installment_data[:principal_amount],
            interest_amount: installment_data[:interest_amount],
            fee_amount: installment_data[:fee_amount],
            total_due: installment_data[:total_due],
            total_cost: installment_data[:total_cost],
            status: installment_data[:status],
            applied_rate: installment_data[:applied_rate]
          )
        end
      end

      def build_transaction_notes(user_notes)
        base_note = "Purchase using #{pay_later.provider_name || 'PayLater'}"
        tenor_info = "#{params[:tenor_months]} months installment"

        parts = [ base_note, tenor_info ]
        parts << user_notes if user_notes.present?

        parts.join(" — ")
      end
  end
end
