class PayLatersController < ApplicationController
  include AccountableResource

  # Additional permitted attributes for PayLater creation/editing
  permitted_accountable_attributes(
    :id, :provider_name, :credit_limit, :available_credit, :free_interest_months,
    :late_fee_first7, :late_fee_per_day, :interest_rate_table,
    :currency_code, :exchange_rate_to_idr, :approved_date, :expiry_date, :max_tenor,
    :status, :notes, :auto_update_rate, :contract_url, :grace_days, :is_compound,
    :early_settlement_allowed, :early_settlement_fee, :updated_by
  )

  # Create via service for validation + JSON parsing while preserving existing flows
  def create
    result = ::PayLaterServices::CreateAccount.new(
      family: Current.family,
      params: account_params.to_h
    ).call

    if result.success?
      redirect_to(account_params[:return_to].presence || result.account, allow_other_host: false, notice: t("accounts.create.success", type: "PayLater"))
    else
      @account = Current.family.accounts.build(currency: Current.family.currency, accountable: PayLater.new)
      @error_message = result.error
      render :new, status: :unprocessable_entity
    end
  end
end
