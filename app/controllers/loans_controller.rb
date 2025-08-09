class LoansController < ApplicationController
  include AccountableResource

  permitted_accountable_attributes(
    :id, :rate_type, :interest_rate, :term_months, :initial_balance,
    :debt_kind, :counterparty_type, :counterparty_name, :disbursement_account_id, :origination_date, :imported
  )

  # Override create to leverage DebtOriginationService for double-entry origination
  def create
    result = DebtOriginationService.call!(
      family: Current.family,
      params: account_params.to_h.deep_symbolize_keys
    )

    if result.success?
      redirect_to account_params[:return_to].presence || result.account, notice: t("accounts.create.success", type: "Loan")
    else
      @account = Current.family.accounts.build(
        currency: Current.family.currency,
        accountable: Loan.new
      )
      @error_message = result.error
      render :new, status: :unprocessable_entity
    end
  end
end
