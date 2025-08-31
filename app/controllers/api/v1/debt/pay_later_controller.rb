class Api::V1::Debt::PayLaterController < Api::V1::BaseController
  before_action :ensure_write_scope

  # POST /api/v1/debt/paylater
  # Params: { name, currency, provider_name, credit_limit, available_credit, ... }
  def create
    service = ::PayLaterServices::CreateAccount.new(
      family: current_resource_owner.family,
      params: account_params.to_h
    )

    result = service.call

    if result.success?
      render json: { account_id: result.account.id }, status: :created
    else
      render json: { error: "validation_failed", message: result.error }, status: :unprocessable_entity
    end
  end

  # POST /api/v1/debt/paylater/expense
  # Params: { account_id, name, amount, currency, date, category_id, merchant_id, tenor_months }
  def expense
    service = ::PayLaterServices::RecordExpense.new(
      family: current_resource_owner.family,
      params: expense_params.to_h
    )

    result = service.call

    if result.success?
      render json: { entry_id: result.entry.id, schedule_count: result.installments.size }, status: :created
    else
      render json: { error: "validation_failed", message: result.error }, status: :unprocessable_entity
    end
  end

  # POST /api/v1/debt/paylater/installment/pay
  # Params: { account_id, installment_no, payment_date, source_account_id }
  def pay_installment
    service = ::PayLaterServices::PayInstallment.new(
      family: current_resource_owner.family,
      params: pay_params.to_h
    )

    result = service.call

    if result.success?
      render json: { transfer_id: result.transfer.id, installment: result.installment.reload }, status: :ok
    else
      render json: { error: "validation_failed", message: result.error }, status: :unprocessable_entity
    end
  end

  private
    def ensure_write_scope
      authorize_scope!(:write)
    end

    def account_params
      params.permit(:name, :currency, :provider_name, :credit_limit, :available_credit,
                    :free_interest_months, :late_fee_first7, :late_fee_per_day, :interest_rate_table,
                    :currency_code, :exchange_rate_to_idr, :approved_date, :expiry_date, :max_tenor,
                    :status, :notes, :auto_update_rate, :contract_url, :grace_days, :is_compound,
                    :early_settlement_allowed, :early_settlement_fee, :updated_by)
    end

    def expense_params
      params.permit(:account_id, :name, :amount, :currency, :date, :category_id, :merchant_id,
                    :tenor_months, :manual_monthly_rate, :expense_exchange_rate_to_idr)
    end

    def pay_params
      params.permit(:account_id, :installment_no, :payment_date, :source_account_id, :early_payoff)
    end
end
