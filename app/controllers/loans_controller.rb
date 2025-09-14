class LoansController < ApplicationController
  include AccountableResource, StreamExtensions

  permitted_accountable_attributes(
    :id, :rate_type, :interest_rate, :term_months, :initial_balance,
    :debt_kind, :counterparty_type, :counterparty_name, :disbursement_account_id, :origination_date, :imported,
    # Sharia compliance fields
    :compliance_type, :islamic_product_type, :profit_sharing_ratio, :margin_rate,
    :late_penalty_type, :fintech_type, :agreement_notes, :witness_name,
    # Borrowed loans metadata (nullable, additive)
    :principal_amount, :start_date, :tenor_months, :payment_frequency, :schedule_method,
    :rate_or_profit, :installment_amount, :early_repayment_policy, :collateral_desc,
    :initial_balance_override, :initial_balance_date, :linked_contact_id, :lender_name,
    :institution_name, :institution_type, :product_type, :notes
  )

  # Additional actions for personal loan functionality
  def new_borrowing
    @account = Current.family.accounts.find(params[:id])
    @available_accounts = Current.family.accounts.manual.active.where.not(id: @account.id).alphabetically
  end

  def create_borrowing
    if borrowing_params[:loan_account_id].blank?
      @account = Current.family.accounts.find(params[:id])
      @available_accounts = Current.family.accounts.manual.active.where.not(id: @account.id).alphabetically
      @error_message = "Loan account must be selected"
      return render :new_borrowing, status: :unprocessable_entity
    end

    account = Current.family.accounts.find(borrowing_params[:loan_account_id])
    cash_id = borrowing_params[:transfer_account_id].presence || borrowing_params[:cash_account_id].presence
    cash = Current.family.accounts.find(cash_id) if cash_id.present?
    result = Loan::DisburseMore.call(account: account, amount: borrowing_params[:amount], date: borrowing_params[:date], cash_account: cash)

    if result.success?
      flash[:notice] = "Borrowed amount posted."
      # Synchronously materialize balances so UI reflects changes immediately after redirect
      Account::QuickSync.call(account) rescue nil
      Account::QuickSync.call(cash) rescue nil
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
      flash[:notice] = "Payment posted."
      loan = Current.family.accounts.find(payment_params[:loan_account_id])
      src  = Current.family.accounts.find(payment_params[:source_account_id])
      Account::QuickSync.call(loan) rescue nil
      Account::QuickSync.call(src) rescue nil
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

  def new_extra_payment
    raise ActionController::RoutingError, "Not Found" unless Rails.application.config.features.loans.extra_payment
    @account = Current.family.accounts.find(params[:id])
  end

  def create_extra_payment
    raise ActionController::RoutingError, "Not Found" unless Rails.application.config.features.loans.extra_payment
    @account = Current.family.accounts.find(params[:id])

    service = Loan::ApplyExtraPayment.new(
      account: @account,
      amount: params.require(:extra)[:amount],
      date: params.require(:extra)[:date],
      allocation_mode: params.require(:extra)[:allocation_mode]
    )
    result = service.call!

    if result.success?
      flash[:notice] = "Extra payment applied and future schedule updated"
      respond_to do |format|
        format.html { redirect_back_or_to account_path(@account) }
        format.turbo_stream { stream_redirect_back_or_to(account_path(@account)) }
      end
    else
      @error_message = result.error
      render :new_extra_payment, status: :unprocessable_entity
    end
  end

  # GET /loans/schedule_preview and /loans/:id/schedule_preview
  def schedule_preview
    if params[:id].present?
      @account = Current.family.accounts.find(params[:id])
      authorize_account!(@account)
      principal = (params[:principal_amount] || @account.accountable.initial_balance || @account.balance).to_d
      rate = params[:rate_or_profit].presence || @account.accountable.interest_rate || @account.accountable.margin_rate || 0
      tenor = (params[:tenor_months] || @account.accountable.term_months || 12).to_i
      freq = params[:payment_frequency].presence || @account.accountable.payment_frequency || "MONTHLY"
      method = params[:schedule_method].presence || @account.accountable.schedule_method || "ANNUITY"
      start = params[:start_date].presence || @account.accountable.origination_date || Date.current
    else
      principal = params[:principal_amount].to_d
      rate = params[:rate_or_profit].to_d
      tenor = params[:tenor_months].to_i
      freq = (params[:payment_frequency] || "MONTHLY").to_s
      method = (params[:schedule_method] || "ANNUITY").to_s
      start = params[:start_date].presence || Date.current
    end

    generator = Loan::ScheduleGenerator.new(
      principal_amount: principal,
      rate_or_profit: rate,
      tenor_months: tenor,
      payment_frequency: freq,
      schedule_method: method,
      start_date: start
    )
    rows = generator.generate
    respond_to do |format|
      format.turbo_stream { render partial: "loans/schedule_preview", locals: { rows: rows, account: @account } }
      format.html        { render partial: "loans/schedule_preview", locals: { rows: rows, account: @account } }
    end
  end

  # POST /loans/:id/post_installment
  def post_installment
    account = Current.family.accounts.find(params[:id])
    result = Loan::PostInstallment.new(
      family: Current.family,
      account_id: account.id,
      source_account_id: params.require(:source_account_id),
      installment_no: params[:installment_no],
      date: params[:date]
    ).call!

    if result.success?
      flash[:notice] = "Installment posted"
      respond_to do |format|
        format.html { redirect_back_or_to account_path(account) }
        format.turbo_stream { stream_redirect_back_or_to(account_path(account)) }
      end
    else
      @error_message = result.error
      render status: :unprocessable_entity
    end
  end

  # Override create to leverage DebtOriginationService for double-entry origination
  def create
    result = DebtOriginationService.call!(
      family: Current.family,
      params: account_params.to_h.deep_symbolize_keys
    )

    if result.success?
      flash[:notice] = t("accounts.create.success", type: "Loan")
      if account_params.dig(:accountable_attributes, :initial_balance).present?
        flash[:notice] = [ flash[:notice], "Opening balance anchored successfully." ].join(" — ")
      end
      redirect_to(safe_return_path(account_params[:return_to]) || result.account, allow_other_host: false)
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
      params.require(:borrowing).permit(:loan_account_id, :amount, :transfer_account_id, :cash_account_id, :date, :notes)
    end

    def payment_params
      params.require(:payment).permit(:loan_account_id, :source_account_id, :amount, :date, :notes)
    end

    def authorize_account!(account)
      # Placeholder for future authorization; Current.family scoping already applies
      account
    end
end
