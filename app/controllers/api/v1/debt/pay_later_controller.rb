class Api::V1::Debt::PayLaterController < Api::V1::BaseController
  before_action :ensure_write_scope
  before_action :validate_account_ownership, only: [:expense, :pay_installment]

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
      params: expense_params.to_h,
      account: @validated_account
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
      params: pay_params.to_h,
      account: @validated_account
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

    # Validate account ownership before processing expense or payment
    # This prevents account_id hijacking attacks
    def validate_account_ownership
      account_id = params[:account_id]

      unless account_id.present?
        render json: { error: "validation_failed", message: "account_id is required" }, status: :unprocessable_entity
        return
      end

      family = current_resource_owner.family
      account = family.accounts.find_by(id: account_id)

      unless account
        render json: { error: "forbidden", message: "Account not found or access denied" }, status: :forbidden
        return
      end

      # Additional validation: ensure it's a PayLater account
      unless account.accountable_type == "PayLater"
        render json: { error: "validation_failed", message: "Account is not a PayLater account" }, status: :unprocessable_entity
        return
      end

      # Store validated account for potential use in actions
      @validated_account = account
    end

    def account_params
      params.permit(:name, :currency, :provider_name, :credit_limit, :available_credit,
                    :free_interest_months, :late_fee_first7, :late_fee_per_day, :interest_rate_table,
                    :currency_code, :exchange_rate_to_idr, :approved_date, :expiry_date, :max_tenor,
                    :status, :notes, :auto_update_rate, :contract_url, :grace_days, :is_compound,
                    :early_settlement_allowed, :early_settlement_fee, :updated_by)
    end

    # expense_exchange_rate_to_idr is safe because:
    # 1. account_id is validated via validate_account_ownership before_action
    # 2. Service layer validates account belongs to family (family.accounts.find)
    # 3. This parameter is only used for currency conversion calculations, not direct assignment
    def expense_params
      params.permit(:account_id, :name, :amount, :currency, :date, :category_id, :merchant_id,
                    :tenor_months, :manual_monthly_rate, :expense_exchange_rate_to_idr)
    end

    # early_payoff is safe because:
    # 1. account_id is validated via validate_account_ownership before_action
    # 2. Service layer validates account belongs to family (family.accounts.find)
    # 3. This is a boolean flag used for business logic, not direct model assignment
    def pay_params
      params.permit(:account_id, :installment_no, :payment_date, :source_account_id, :early_payoff)
    end
end
