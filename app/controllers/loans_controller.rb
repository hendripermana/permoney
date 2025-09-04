class LoansController < ApplicationController
  include AccountableResource, StreamExtensions

  permitted_accountable_attributes(
    :id, :rate_type, :interest_rate, :term_months, :initial_balance,
    :debt_kind, :counterparty_type, :counterparty_name, :disbursement_account_id, :origination_date, :imported,
    # Sharia compliance fields
    :compliance_type, :islamic_product_type, :profit_sharing_ratio, :margin_rate,
    :late_penalty_type, :fintech_type, :agreement_notes, :witness_name
  )

  # Additional actions for personal loan functionality
  def new_borrowing
    @account = Current.family.accounts.find(params[:id])
    @available_accounts = Current.family.accounts.manual.active.where.not(id: @account.id).alphabetically
  end

  def create_borrowing
    result = Loan::AdditionalBorrowingService.call!(
      family: Current.family,
      params: borrowing_params
    )

    if result.success?
      flash[:notice] = "Additional borrowing recorded successfully"
      respond_to do |format|
        format.html { redirect_back_or_to account_path(result.entry.account) }
        format.turbo_stream { stream_redirect_back_or_to(account_path(result.entry.account)) }
      end
    else
      @account = Current.family.accounts.find(borrowing_params[:loan_account_id])
      @available_accounts = Current.family.accounts.manual.active.where.not(id: @account.id).alphabetically
      @error_message = result.error
      render :new_borrowing, status: :unprocessable_entity
    end
  end

  def new_payment
    @account = Current.family.accounts.find(params[:id])
    @source_accounts = Current.family.accounts.manual.active.where.not(id: @account.id)
                                  .where(classification: "asset").alphabetically
  end

  def create_payment
    result = Loan::PaymentService.call!(
      family: Current.family,
      params: payment_params
    )

    if result.success?
      flash[:notice] = "Payment recorded successfully"
      respond_to do |format|
        format.html { redirect_back_or_to account_path(Current.family.accounts.find(payment_params[:loan_account_id])) }
        format.turbo_stream { stream_redirect_back_or_to(account_path(Current.family.accounts.find(payment_params[:loan_account_id]))) }
      end
    else
      @account = Current.family.accounts.find(payment_params[:loan_account_id])
      @source_accounts = Current.family.accounts.manual.active.where.not(id: @account.id)
                                    .where(classification: "asset").alphabetically
      @error_message = result.error
      render :new_payment, status: :unprocessable_entity
    end
  end

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

  private

  def borrowing_params
    params.require(:borrowing).permit(:loan_account_id, :amount, :transfer_account_id, :date, :notes)
  end

  def payment_params
    params.require(:payment).permit(:loan_account_id, :source_account_id, :amount, :date, :notes)
  end
end
