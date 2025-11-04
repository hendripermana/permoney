class PayLatersController < ApplicationController
  include AccountableResource

  before_action :set_pay_later_account, only: [ :show, :new_purchase, :create_purchase, :new_payment, :process_payment, :schedule, :early_settlement, :process_early_settlement ]

  # Additional permitted attributes for PayLater creation/editing
  permitted_accountable_attributes(
    :id, :provider_name, :credit_limit, :available_credit, :free_interest_months,
    :late_fee_first7, :late_fee_per_day, :interest_rate_table,
    :currency_code, :exchange_rate_to_idr, :approved_date, :expiry_date, :max_tenor,
    :status, :notes, :auto_update_rate, :contract_url, :grace_days, :is_compound,
    :early_settlement_allowed, :early_settlement_fee, :updated_by, :compliance_type
  )

  # Show PayLater account with tabs (overview, purchases, schedule, payments)
  def show
    @pay_later = @account.accountable
    @tab = params[:tab] || "overview"

    respond_to do |format|
      format.html
      format.turbo_stream
    end
  end

  # Create via service for validation + JSON parsing while preserving existing flows
  def create
    result = ::PayLaterServices::CreateAccount.new(
      family: Current.family,
      params: account_params.to_h
    ).call

    if result.success?
      respond_to do |format|
        format.html { redirect_to(safe_return_path(account_params[:return_to]) || result.account, allow_other_host: false, notice: "PayLater account created successfully") }
        format.turbo_stream {
          flash.now[:notice] = "PayLater account created successfully"
          redirect_to result.account
        }
      end
    else
      @account = Current.family.accounts.build(currency: Current.family.currency, accountable: PayLater.new)
      @error_message = result.error

      respond_to do |format|
        format.html { render :new, status: :unprocessable_entity }
        format.turbo_stream { render turbo_stream: turbo_stream.replace("form_errors", partial: "shared/form_errors", locals: { errors: [ @error_message ] }) }
      end
    end
  end

  # New purchase form
  def new_purchase
    @pay_later = @account.accountable
    @categories = Current.family.categories.expenses.alphabetically
    @purchase = OpenStruct.new(
      merchant_name: nil,
      amount: nil,
      tenor_months: 3,
      category_id: @categories.first&.id,
      purchase_date: Date.current
    )

    respond_to do |format|
      format.html
      format.turbo_stream
    end
  end

  # Preview installment schedule before creating purchase (AJAX/Turbo Stream)
  def preview_installments
    @account = Current.family.accounts.find(params[:id])
    @pay_later = @account.accountable
    @categories = Current.family.categories.expenses.alphabetically

    amount = params[:amount].to_d
    tenor_months = params[:tenor_months].to_i
    category = params[:category] || "default"

    if amount > 0 && tenor_months > 0
      generator = PayLaterHelpers::ScheduleGenerator.new(
        pay_later: @pay_later,
        purchase_amount: amount,
        tenor_months: tenor_months,
        purchase_date: Date.current,
        category: category
      )

      @installments = generator.generate
      @total_cost = @installments.sum { |i| i[:total_due] }
      @total_interest = @installments.sum { |i| i[:interest_amount] }
    else
      @error = "Invalid amount or tenor"
    end

    respond_to do |format|
      format.turbo_stream
    end
  end

  # Create purchase and installments
  def create_purchase
    @pay_later = @account.accountable

    result = PayLaterHelpers::RecordPurchase.new(
      family: Current.family,
      pay_later_account: @account,
      params: purchase_params
    ).call

    if result.success?
      redirect_to account_path(@account, tab: "overview"),
        notice: "Purchase recorded successfully. #{result.installments.count} installments created."
    else
      @pay_later = @account.accountable
      @error_message = result.error
      @purchase = OpenStruct.new(purchase_params)
      @categories = Current.family.categories.expenses.alphabetically
      
      render :new_purchase, status: :unprocessable_entity
    end
  end

  # New payment form
  def new_payment
    @pay_later = @account.accountable
    @source_accounts = Current.family.accounts.assets.where.not(id: @account.id)
    @pending_installments = @pay_later.installments.unpaid.by_installment_no
    @suggested_amount = @pay_later.next_due_installment&.total_due

    respond_to do |format|
      format.html
      format.turbo_stream
    end
  end

  # Process payment
  def process_payment
    @pay_later = @account.accountable
    source_account = Current.family.accounts.find(params[:source_account_id])

    result = PayLaterHelpers::PaymentProcessor.new(
      pay_later_account: @account,
      amount: params[:amount],
      source_account: source_account,
      date: params[:payment_date] || Date.current,
      notes: params[:notes]
    ).process

    if result.success?
      # Broadcast to update UI in real-time if needed
      @account.broadcast_replace_later_to(
        Current.family,
        partial: "accounts/account_card",
        locals: { account: @account }
      ) if @account.respond_to?(:broadcast_replace_later_to)

      respond_to do |format|
        format.html {
          redirect_to account_path(@account, tab: "schedule"),
          notice: "Payment processed successfully. #{result.installments_affected.count} installment(s) affected."
        }
        format.turbo_stream {
          flash.now[:notice] = "Payment processed successfully"
          redirect_to account_path(@account, tab: "schedule")
        }
      end
    else
      @error_message = result.error
      @source_accounts = Current.family.accounts.assets.where.not(id: @account.id)
      @pending_installments = @pay_later.installments.unpaid.by_installment_no

      respond_to do |format|
        format.html { render :new_payment, status: :unprocessable_entity }
        format.turbo_stream {
          render turbo_stream: turbo_stream.replace(
            "payment_form",
            partial: "pay_laters/payment_form",
            locals: {
              account: @account,
              source_accounts: @source_accounts,
              error: @error_message
            }
          )
        }
      end
    end
  end

  # Show installment schedule
  def schedule
    @pay_later = @account.accountable
    @installments = @pay_later.installments.by_installment_no
    @summary = {
      total: @installments.count,
      paid: @installments.paid.count,
      pending: @installments.unpaid.count,
      overdue: @pay_later.overdue_installments.count
    }

    respond_to do |format|
      format.html
      format.turbo_stream
    end
  end

  # Early settlement form
  def early_settlement
    @pay_later = @account.accountable
    @source_accounts = Current.family.accounts.assets.where.not(id: @account.id)
    @settlement_amount = @pay_later.calculate_early_settlement_amount
    @unpaid_installments = @pay_later.installments.unpaid.by_installment_no

    respond_to do |format|
      format.html
      format.turbo_stream
    end
  end

  # Process early settlement
  def process_early_settlement
    @pay_later = @account.accountable
    source_account = Current.family.accounts.find(params[:source_account_id])
    settlement_amount = @pay_later.calculate_early_settlement_amount

    # Process as overpayment to pay all remaining installments
    result = PayLaterHelpers::PaymentProcessor.new(
      pay_later_account: @account,
      amount: settlement_amount.amount,
      source_account: source_account,
      date: params[:settlement_date] || Date.current,
      notes: "Early settlement payment"
    ).process

    if result.success?
      respond_to do |format|
        format.html {
          redirect_to account_path(@account),
          notice: "Early settlement processed successfully. All installments paid off!"
        }
        format.turbo_stream {
          flash.now[:notice] = "Early settlement completed!"
          redirect_to account_path(@account)
        }
      end
    else
      @error_message = result.error
      @source_accounts = Current.family.accounts.assets.where.not(id: @account.id)
      @settlement_amount = settlement_amount

      respond_to do |format|
        format.html { render :early_settlement, status: :unprocessable_entity }
        format.turbo_stream {
          render turbo_stream: turbo_stream.replace(
            "settlement_form",
            partial: "pay_laters/settlement_form",
            locals: {
              account: @account,
              settlement_amount: @settlement_amount,
              error: @error_message
            }
          )
        }
      end
    end
  end

  private

    def set_pay_later_account
      @account = Current.family.accounts.find(params[:id])
      unless @account.accountable_type == "PayLater"
        redirect_to accounts_path, alert: "Account is not a PayLater account"
      end
    end

    def purchase_params
      params.permit(
        :merchant_name,
        :amount,
        :tenor_months,
        :category_id,
        :purchase_date,
        :notes,
        :rate_category
      )
    end
end
