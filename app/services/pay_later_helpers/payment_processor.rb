module PayLaterHelpers
  class PaymentProcessor
    Result = Struct.new(:success?, :transfer, :installments_affected, :error, keyword_init: true)

    attr_reader :pay_later_account, :amount, :source_account, :date, :notes

    def initialize(pay_later_account:, amount:, source_account:, date: Date.current, notes: nil)
      @pay_later_account = pay_later_account
      @pay_later = pay_later_account.accountable
      @amount = amount.to_d
      @source_account = source_account
      @date = date
      @notes = notes
    end

    def process
      validate!

      strategy = determine_payment_strategy
      result = strategy.process

      Result.new(
        success?: result[:success],
        transfer: result[:transfer],
        installments_affected: result[:installments_affected],
        error: result[:error]
      )
    rescue => e
      Rails.logger.error("PayLater::PaymentProcessor failed: #{e.message}\n#{e.backtrace.join("\n")}")
      Result.new(
        success?: false,
        transfer: nil,
        installments_affected: [],
        error: e.message
      )
    end

    private

      attr_reader :pay_later

      def validate!
        raise ArgumentError, "Amount must be positive" unless amount > 0
        raise ArgumentError, "Source account required" unless source_account.present?
        raise ArgumentError, "PayLater account required" unless pay_later_account.present?
        raise ArgumentError, "No unpaid installments found" unless pay_later.installments.unpaid.any?
      end

      def determine_payment_strategy
        pending_installment = pay_later.next_due_installment

        if pending_installment && exact_installment_match?(pending_installment)
          Strategies::ExactInstallmentMatch.new(
            pay_later: pay_later,
            pay_later_account: pay_later_account,
            installment: pending_installment,
            amount: amount,
            source_account: source_account,
            date: date,
            notes: notes
          )
        elsif pending_installment && partial_installment_match?(pending_installment)
          Strategies::PartialInstallmentMatch.new(
            pay_later: pay_later,
            pay_later_account: pay_later_account,
            installment: pending_installment,
            amount: amount,
            source_account: source_account,
            date: date,
            notes: notes
          )
        elsif overpayment?
          Strategies::Overpayment.new(
            pay_later: pay_later,
            pay_later_account: pay_later_account,
            amount: amount,
            source_account: source_account,
            date: date,
            notes: notes
          )
        else
          Strategies::GeneralPayment.new(
            pay_later: pay_later,
            pay_later_account: pay_later_account,
            amount: amount,
            source_account: source_account,
            date: date,
            notes: notes
          )
        end
      end

      def exact_installment_match?(installment)
        (installment.total_due.to_d - amount).abs < 0.01
      end

      def partial_installment_match?(installment)
        amount > 0 && amount < installment.total_due.to_d
      end

      def overpayment?
        pending_installment = pay_later.next_due_installment
        return false unless pending_installment

        amount > pending_installment.total_due.to_d
      end

      # Payment Strategy Classes
      module Strategies
        class BaseStrategy
          attr_reader :pay_later, :pay_later_account, :amount, :source_account, :date, :notes

          def initialize(pay_later:, pay_later_account:, amount:, source_account:, date:, notes:)
            @pay_later = pay_later
            @pay_later_account = pay_later_account
            @amount = amount
            @source_account = source_account
            @date = date
            @notes = notes
          end

          def process
            raise NotImplementedError, "Subclasses must implement process method"
          end

          protected

            def create_payment_transfer(amount, notes = nil)
              transfer = Transfer.create!(
                family: Current.family,
                from_account: source_account,
                to_account: pay_later_account,
                amount: amount,
                date: date,
                notes: build_payment_notes(notes)
              )

              # Sync accounts after transfer
              pay_later_account.sync_later if pay_later_account.respond_to?(:sync_later)
              source_account.sync_later if source_account.respond_to?(:sync_later)

              transfer
            end

            def build_payment_notes(user_notes)
              base_note = "PayLater payment to #{pay_later.provider_name || 'provider'}"
              user_notes.present? ? "#{base_note} — #{user_notes}" : base_note
            end

            def create_interest_expense(amount)
              return if amount.zero?

              interest_money = Money.new(amount, pay_later_account.currency)
              converted_interest = interest_money.exchange_to(
                source_account.currency,
                date: date,
                fallback_rate: 1.0
              )

              entry = source_account.entries.create!(
                date: date,
                name: interest_expense_name,
                amount: converted_interest.amount,
                currency: source_account.currency,
                entryable: Transaction.new(
                  kind: pay_later.sharia_compliant? ? "margin_payment" : "interest_payment"
                )
              )

              # Set appropriate category
              category_key = pay_later.sharia_compliant? ? "system:islamic_profit_expense" : "system:interest_expense"
              category = find_or_create_interest_category(category_key)
              entry.entryable.set_category!(category) if category

              entry
            end

            def interest_expense_name
              base = pay_later.sharia_compliant? ? "Profit portion" : "Interest portion"
              "#{base} — #{pay_later_account.name}"
            end

            def find_or_create_interest_category(category_key)
              family = Current.family
              category = family.categories.find_by(key: category_key)

              unless category
                name = pay_later.sharia_compliant? ? "Profit/Margin Expense" : "Interest Expense"
                category = family.categories.create(
                  key: category_key,
                  name: name,
                  classification: "expense",
                  color: "#DC2626",
                  lucide_icon: "percent"
                )
              end

              category
            rescue => e
              Rails.logger.warn("Failed to find/create interest category: #{e.message}")
              nil
            end
        end

        class ExactInstallmentMatch < BaseStrategy
          attr_reader :installment

          def initialize(pay_later:, pay_later_account:, installment:, amount:, source_account:, date:, notes:)
            super(pay_later: pay_later, pay_later_account: pay_later_account, amount: amount, source_account: source_account, date: date, notes: notes)
            @installment = installment
          end

          def process
            ActiveRecord::Base.transaction do
              # Create transfer for principal portion
              transfer = create_payment_transfer(
                installment.principal_amount,
                "Installment ##{installment.installment_no} payment"
              )

              # Create interest expense entry if applicable
              if installment.interest_amount.to_d > 0
                create_interest_expense(installment.interest_amount)
              end

              # Mark installment as paid
              installment.mark_as_paid!(transfer_id: transfer.id, paid_on: date)

              # Update available credit
              pay_later.update_available_credit!

              { success: true, transfer: transfer, installments_affected: [ installment ], error: nil }
            end
          rescue => e
            { success: false, transfer: nil, installments_affected: [], error: e.message }
          end
        end

        class PartialInstallmentMatch < BaseStrategy
          attr_reader :installment

          def initialize(pay_later:, pay_later_account:, installment:, amount:, source_account:, date:, notes:)
            super(pay_later: pay_later, pay_later_account: pay_later_account, amount: amount, source_account: source_account, date: date, notes: notes)
            @installment = installment
          end

          def process
            ActiveRecord::Base.transaction do
              # Calculate portions (maintain original ratio)
              ratio = amount / installment.total_due.to_d
              principal_portion = (installment.principal_amount.to_d * ratio).round(2)
              interest_portion = (installment.interest_amount.to_d * ratio).round(2)

              # Create transfer for principal portion
              transfer = create_payment_transfer(
                principal_portion,
                "Partial payment for Installment ##{installment.installment_no}"
              )

              # Create interest expense entry if applicable
              if interest_portion > 0
                create_interest_expense(interest_portion)
              end

              # Record partial payment
              installment.record_partial_payment!(amount, transfer_id: transfer.id, paid_on: date)

              # Update available credit (partial payment affects credit)
              pay_later.update_available_credit!

              { success: true, transfer: transfer, installments_affected: [ installment ], error: nil }
            end
          rescue => e
            { success: false, transfer: nil, installments_affected: [], error: e.message }
          end
        end

        class Overpayment < BaseStrategy
          def process
            ActiveRecord::Base.transaction do
              remaining_amount = amount
              installments_affected = []
              transfer = nil

              # Pay installments in order until amount is exhausted
              pay_later.installments.unpaid.by_installment_no.each do |installment|
                break if remaining_amount <= 0

                if remaining_amount >= installment.total_due.to_d
                  # Full payment for this installment
                  installment_transfer = create_payment_transfer(
                    installment.principal_amount,
                    "Installment ##{installment.installment_no} payment (overpayment)"
                  )

                  if installment.interest_amount.to_d > 0
                    create_interest_expense(installment.interest_amount)
                  end

                  installment.mark_as_paid!(transfer_id: installment_transfer.id, paid_on: date)
                  installments_affected << installment
                  remaining_amount -= installment.total_due.to_d

                  transfer ||= installment_transfer
                else
                  # Partial payment for this installment
                  ratio = remaining_amount / installment.total_due.to_d
                  principal_portion = (installment.principal_amount.to_d * ratio).round(2)
                  interest_portion = (installment.interest_amount.to_d * ratio).round(2)

                  installment_transfer = create_payment_transfer(
                    principal_portion,
                    "Partial payment for Installment ##{installment.installment_no} (overpayment)"
                  )

                  if interest_portion > 0
                    create_interest_expense(interest_portion)
                  end

                  installment.record_partial_payment!(remaining_amount, transfer_id: installment_transfer.id, paid_on: date)
                  installments_affected << installment
                  remaining_amount = 0

                  transfer ||= installment_transfer
                end
              end

              # Update available credit
              pay_later.update_available_credit!

              { success: true, transfer: transfer, installments_affected: installments_affected, error: nil }
            end
          rescue => e
            { success: false, transfer: nil, installments_affected: [], error: e.message }
          end
        end

        class GeneralPayment < BaseStrategy
          def process
            # Determine how to apply the payment
            next_installment = pay_later.next_due_installment

            if next_installment
              if amount >= next_installment.total_due.to_d
                # Process as exact match or overpayment
                if amount == next_installment.total_due.to_d
                  ExactInstallmentMatch.new(
                    pay_later: pay_later,
                    pay_later_account: pay_later_account,
                    installment: next_installment,
                    amount: amount,
                    source_account: source_account,
                    date: date,
                    notes: notes
                  ).process
                else
                  Overpayment.new(
                    pay_later: pay_later,
                    pay_later_account: pay_later_account,
                    amount: amount,
                    source_account: source_account,
                    date: date,
                    notes: notes
                  ).process
                end
              else
                # Process as partial payment
                PartialInstallmentMatch.new(
                  pay_later: pay_later,
                  pay_later_account: pay_later_account,
                  installment: next_installment,
                  amount: amount,
                  source_account: source_account,
                  date: date,
                  notes: notes
                ).process
              end
            else
              { success: false, transfer: nil, installments_affected: [], error: "No unpaid installments found" }
            end
          rescue => e
            { success: false, transfer: nil, installments_affected: [], error: e.message }
          end
        end
      end
  end
end
