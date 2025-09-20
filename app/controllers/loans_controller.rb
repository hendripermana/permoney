class LoansController < ApplicationController
  include AccountableResource, StreamExtensions
  include LoanFormHelper

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
    :institution_name, :institution_type, :product_type, :notes, :balloon_amount, :interest_free,
    :relationship
  )

  # Additional borrowing from existing loan
  def new_borrowing
    @account = Current.family.accounts.find(params[:id])
    @available_accounts = available_payment_source_accounts(Current.family)
  end

  def create_borrowing
    @account = Current.family.accounts.find(params[:id])
    loan = @account.accountable

    begin
      transfer = loan.borrow_more(
        amount: borrowing_params[:amount],
        to_account: find_transfer_account,
        date: borrowing_params[:date] || Date.current,
        notes: borrowing_params[:notes]
      )

      if transfer.persisted?
        flash[:notice] = t("loans.borrowing.success")
        respond_to do |format|
          format.html { redirect_back_or_to account_path(@account) }
          format.turbo_stream { stream_redirect_back_or_to(account_path(@account)) }
        end
      else
        raise StandardError, "Failed to create transfer"
      end
    rescue => e
      @available_accounts = available_payment_source_accounts(Current.family)
      @error_message = e.message
      render :new_borrowing, status: :unprocessable_entity
    end
  end

  def new_payment
    @account = Current.family.accounts.find(params[:id])
    @source_accounts = available_payment_source_accounts(Current.family, loan_account: @account)
  end

  def create_payment
    @account = Current.family.accounts.find(payment_params[:loan_account_id])
    loan = @account.accountable
    source_account = Current.family.accounts.find(payment_params[:source_account_id])

    begin
      transfer = loan.make_payment(
        amount: payment_params[:amount],
        from_account: source_account,
        date: payment_params[:date] || Date.current,
        notes: payment_params[:notes]
      )

      if transfer
        flash[:notice] = t("loans.payment.success")
        respond_to do |format|
          format.html { redirect_back_or_to account_path(@account) }
          format.turbo_stream { stream_redirect_back_or_to(account_path(@account)) }
        end
      else
        raise StandardError, "Failed to process payment"
      end
    rescue => e
      @source_accounts = available_payment_source_accounts(Current.family, loan_account: @account)
      @error_message = e.message
      render :new_payment, status: :unprocessable_entity
    end
  end

  def new_extra_payment
    raise ActionController::RoutingError, "Not Found" unless loan_extra_payment_enabled?
    @account = Current.family.accounts.find(params[:id])
    @source_accounts = available_payment_source_accounts(Current.family, loan_account: @account)
  end

  def create_extra_payment
    raise ActionController::RoutingError, "Not Found" unless loan_extra_payment_enabled?
    @account = Current.family.accounts.find(params[:id])
    loan = @account.accountable

    begin
      extra_params = params.require(:extra)
      source_account = Current.family.accounts.find(extra_params[:source_account_id])

      transfer = loan.apply_extra_payment(
        amount: extra_params[:amount],
        from_account: source_account,
        date: extra_params[:date] || Date.current,
        allocation_mode: extra_params[:allocation_mode] || "principal_first"
      )

      if transfer
        flash[:notice] = t("loans.extra_payment.success")
        respond_to do |format|
          format.html { redirect_back_or_to account_path(@account) }
          format.turbo_stream { stream_redirect_back_or_to(account_path(@account)) }
        end
      else
        raise StandardError, "Failed to process extra payment"
      end
    rescue => e
      @source_accounts = available_payment_source_accounts(Current.family, loan_account: @account)
      @error_message = e.message
      render :new_extra_payment, status: :unprocessable_entity
    end
  end

  # GET /loans/schedule_preview and /loans/:id/schedule_preview
  def schedule_preview
    if params[:id].present?
      @account = Current.family.accounts.find(params[:id])
      authorize_account!(@account)
      principal = (params[:principal_amount] || @account.accountable.initial_balance || @account.balance).to_d
      boolean = ActiveModel::Type::Boolean.new
      interest_free_flag = if params.key?(:interest_free)
        boolean.cast(params[:interest_free])
      else
        nil
      end
      interest_free = interest_free_flag.nil? ? @account.accountable.interest_free? : interest_free_flag
      raw_rate = params[:rate_or_profit].presence || @account.accountable.interest_rate || @account.accountable.margin_rate || 0
      rate = interest_free ? 0.to_d : Loan.normalize_rate(raw_rate)
      tenor = (params[:tenor_months] || @account.accountable.term_months || 12).to_i
      freq = params[:payment_frequency].presence || @account.accountable.payment_frequency || "MONTHLY"
      method = params[:schedule_method].presence || @account.accountable.schedule_method || "ANNUITY"
      start = params[:start_date].presence || @account.accountable.origination_date || Date.current
      balloon = if params.key?(:balloon_amount)
        params[:balloon_amount].presence&.to_d || 0.to_d
      else
        @account.accountable.balloon_amount || 0.to_d
      end
    else
      principal = params[:principal_amount].to_d
      boolean = ActiveModel::Type::Boolean.new
      interest_free = boolean.cast(params[:interest_free])
      raw_rate = params[:rate_or_profit]
      rate = interest_free ? 0.to_d : Loan.normalize_rate(raw_rate)
      tenor = params[:tenor_months].to_i
      freq = (params[:payment_frequency] || "MONTHLY").to_s
      method = (params[:schedule_method] || "ANNUITY").to_s
      start = params[:start_date].presence || Date.current
      balloon = params[:balloon_amount].presence&.to_d || 0.to_d
    end

    generator = Loan::ScheduleGenerator.new(
      principal_amount: principal,
      rate_or_profit: rate,
      tenor_months: tenor,
      payment_frequency: freq,
      schedule_method: method,
      start_date: start,
      balloon_amount: balloon
    )
    rows = generator.generate
    respond_to do |format|
      format.turbo_stream do
        render partial: "loans/schedule_preview", locals: { rows: rows, account: @account }
      end
      format.html do
        content = render_to_string(partial: "loans/schedule_preview", locals: { rows: rows, account: @account })

        if turbo_frame_request?
          render html: view_context.tag.turbo_frame(id: "loan-schedule-preview") { content.html_safe }
        else
          render html: content.html_safe
        end
      end
    end
  end

  # POST /loans/:id/post_installment
  def post_installment
    @account = Current.family.accounts.find(params[:id])
    loan = @account.accountable
    source_account = Current.family.accounts.find(params.require(:source_account_id))

    begin
      installment = if params[:installment_no].present?
        loan.loan_installments.find_by!(installment_no: params[:installment_no])
      else
        nil # Will use next pending installment
      end

      transfer = loan.post_installment(
        installment: installment,
        from_account: source_account,
        date: params[:date] || Date.current
      )

      flash[:notice] = t("loans.installment.posted")
      respond_to do |format|
        format.html { redirect_back_or_to account_path(@account) }
        format.turbo_stream { stream_redirect_back_or_to(account_path(@account)) }
      end
    rescue => e
      @error_message = e.message
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

    def find_transfer_account
      cash_id = borrowing_params[:transfer_account_id].presence || borrowing_params[:cash_account_id].presence
      raise ArgumentError, "Transfer account must be selected" if cash_id.blank?

      Current.family.accounts.find(cash_id)
    end

    def authorize_account!(account)
      # Placeholder for future authorization; Current.family scoping already applies
      account
    end
end
