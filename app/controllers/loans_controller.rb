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
    principal_param = params[:principal_amount].presence
    initial_param = params[:initial_balance].presence

    if params[:id].present?
      @account = Current.family.accounts.find(params[:id])
      authorize_account!(@account)
      principal = if principal_param
        principal_param.to_d
      else
        (
          @account.accountable.try(:remaining_principal) ||
          @account.accountable.try(:principal_amount) ||
          @account.accountable.try(:initial_balance) ||
          @account.balance
        ).to_d
      end
      initial_amount = if initial_param
        initial_param.to_d
      else
        (@account.accountable.initial_balance || principal).to_d
      end
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
      principal = (principal_param || params[:principal_amount] || 0).to_d
      initial_amount = if initial_param
        initial_param.to_d
      else
        principal
      end
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
        render partial: "loans/schedule_preview", locals: { rows: rows, account: @account, initial_amount: initial_amount, principal_amount: principal }
      end
      format.html do
        content = render_to_string(partial: "loans/schedule_preview", locals: { rows: rows, account: @account, initial_amount: initial_amount, principal_amount: principal })

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
      if result.principal_delta.to_d.positive?
        flash[:loan_adjustment] = {
          amount: result.principal_delta.to_s,
          account_id: result.account.id,
          date: result.delta_date&.iso8601,
          reconciliation_entry_id: result.balance_adjustment_entry_id
        }
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

  def record_backdated_payment
    @account = Current.family.accounts.find(params[:id])
    unless @account.accountable_type == "Loan"
      redirect_to account_path(@account), alert: "Invalid loan account"
      return
    end

    if params[:skip].present?
      mark_adjustment_confirmed(permitted[:reconciliation_entry_id])
      flash[:notice] = "Keeping current balance adjustment."
      redirect_to account_path(@account)
      return
    end

    permitted = loan_adjustment_params
    amount = BigDecimal(permitted[:amount]) rescue nil
    source_account = Current.family.accounts.find_by(id: permitted[:source_account_id])
    payment_date = begin
      Date.parse(permitted[:date])
    rescue ArgumentError, TypeError
      Date.current
    end

    if amount.nil? || amount <= 0 || source_account.nil?
      flash[:alert] = "Please select a valid source account and amount."
      redirect_to account_path(@account)
      return
    end

    service_params = {
      loan_account_id: @account.id,
      source_account_id: source_account.id,
      amount: amount,
      date: payment_date,
      notes: "Backdated adjustment"
    }

    result = Loan::PaymentService.call!(family: Current.family, params: service_params)

    if result.success?
      remove_balance_adjustment(permitted[:reconciliation_entry_id])
      flash[:notice] = "Recorded a backdated payment of #{view_context.number_to_currency(amount, unit: @account.currency)}."
      @account.sync_later
    else
      flash[:alert] = result.error
    end

    redirect_to account_path(@account)
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

    def loan_adjustment_params
      params.require(:loan_payment).permit(:source_account_id, :amount, :date, :reconciliation_entry_id)
    end

    def remove_balance_adjustment(entry_id)
      return if entry_id.blank?

      entry = @account.entries.find_by(id: entry_id)
      return unless entry&.entryable_type == "Valuation" && entry.entryable.respond_to?(:kind) && entry.entryable.reconciliation?

      entry.destroy
      clear_adjustment_confirmation
    rescue => e
      Rails.logger.warn({ at: "LoansController.remove_balance_adjustment", account_id: @account.id, entry_id: entry_id, error: e.message }.to_json) rescue nil
    end

    def mark_adjustment_confirmed(entry_id)
      return if entry_id.blank?

      extra = (@account.accountable.extra || {}).dup
      extra["balance_adjustment_confirmed"] = true
      @account.accountable.update(extra: extra)
    rescue => e
      Rails.logger.warn({ at: "LoansController.confirm_adjustment", account_id: @account.id, entry_id: entry_id, error: e.message }.to_json) rescue nil
    end

    def clear_adjustment_confirmation
      extra = (@account.accountable.extra || {}).dup
      if extra.delete("balance_adjustment_confirmed")
        @account.accountable.update(extra: extra)
      end
    end
end
