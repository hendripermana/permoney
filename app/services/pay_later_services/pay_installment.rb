module PayLaterServices
  class PayInstallment
    Result = Struct.new(:success?, :transfer, :installment, :error, keyword_init: true)

    def initialize(family:, params:)
      @family = family
      @params = params.deep_symbolize_keys
    end

    def call
      account = family.accounts.find(params.fetch(:account_id))
      raise ArgumentError, "Account is not PayLater" unless account.accountable_type == "PayLater"

      early_payoff = ActiveModel::Type::Boolean.new.cast(params[:early_payoff])
      payment_date = parse_date(params[:payment_date]) || Date.current
      source_account = family.accounts.assets.find(params.fetch(:source_account_id))
      installment_no = params[:installment_no]
      installment = PayLaterInstallment.for_account(account.id).find_by!(installment_no: installment_no) unless early_payoff

      transfer = nil

      ActiveRecord::Base.transaction do
        if early_payoff
          raise ArgumentError, "Early settlement not allowed" unless ActiveModel::Type::Boolean.new.cast(account.accountable.early_settlement_allowed)

          pending = PayLaterInstallment.for_account(account.id).where(status: 'pending').order(:installment_no)
          remaining_principal = pending.sum(:principal_amount).to_d
          fee = account.accountable.early_settlement_fee.to_d if account.accountable.early_settlement_fee.present?
          fee ||= 0.to_d
          amount_due = (remaining_principal + fee).round(2)

          transfer = ::Transfer::Creator.new(
            family: family,
            source_account_id: source_account.id,
            destination_account_id: account.id,
            date: payment_date,
            amount: amount_due
          ).create

          pending.update_all(status: 'cancelled')

          # Update available credit by remaining principal
          if account.accountable.credit_limit.present?
            new_available = (account.accountable.available_credit || 0) + remaining_principal
            account.accountable.update!(available_credit: [ new_available, account.accountable.credit_limit ].min)
          end

          transfer.sync_account_later
        else
          raise ArgumentError, "Installment already paid" unless installment.status_pending?

          # Late fee calculation (two-step) with grace days
          grace_days = account.accountable.grace_days.to_i
          raw_late_days = (payment_date - installment.due_date).to_i
          raw_late_days = [ raw_late_days, 0 ].max
          chargeable_late_days = [ raw_late_days - grace_days, 0 ].max
          fee = 0.to_d
          if chargeable_late_days > 0
            first = [ chargeable_late_days, 7 ].min
            rest = [ chargeable_late_days - 7, 0 ].max
            fee += (account.accountable.late_fee_first7 || 50_000) if first > 0
            fee += rest * (account.accountable.late_fee_per_day || 30_000)
          end

          amount_due = installment.total_due + fee

          transfer = ::Transfer::Creator.new(
            family: family,
            source_account_id: source_account.id,
            destination_account_id: account.id,
            date: payment_date,
            amount: amount_due
          ).create

          installment.update!(
            status: chargeable_late_days > 0 ? "late" : "paid",
            paid_on: payment_date,
            paid_amount: amount_due,
            fee_amount: fee,
            transfer_id: transfer.id
          )

          if account.accountable.credit_limit.present?
            new_available = (account.accountable.available_credit || 0) + installment.principal_amount
            account.accountable.update!(available_credit: [ new_available, account.accountable.credit_limit ].min)
          end

          transfer.sync_account_later
        end
      end

      Result.new(success?: true, transfer: transfer, installment: installment)
    rescue => e
      Result.new(success?: false, error: e.message)
    end

    private
      attr_reader :family, :params

      def parse_date(val)
        return val if val.is_a?(Date)
        Date.parse(val.to_s) rescue nil
      end
  end
end
