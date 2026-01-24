class PreciousMetalsController < ApplicationController
  include AccountableResource

  permitted_accountable_attributes :id, :subtype, :unit, :quantity, :manual_price, :manual_price_currency

  def new
    super
    assign_defaults
  end

  def create
    normalized_params = normalized_account_params
    @account = Current.family.accounts.new(normalized_params)

    if @account.valid?
      @account = Current.family.accounts.create_and_sync(normalized_params.except(:return_to))
      @account.lock_saved_attributes!

      redirect_to(
        safe_return_path(normalized_params[:return_to]) || @account,
        allow_other_host: false,
        notice: "Precious metal account created"
      )
    else
      assign_defaults
      render :new, status: :unprocessable_entity
    end
  end

  def update
    normalized_params = normalized_account_params
    balance_value = normalized_params[:balance]

    if normalized_params[:currency].present? && @account.currency != normalized_params[:currency]
      @account.currency = normalized_params[:currency]
    end

    if balance_value.present?
      result = @account.set_current_balance(balance_value.to_d)
      unless result.success?
        @error_message = result.error_message
        render :edit, status: :unprocessable_entity
        return
      end
      @account.sync_later
    end

    update_params = normalized_params.except(:return_to, :balance)

    unless @account.update(update_params)
      @error_message = @account.errors.full_messages.join(", ")
      render :edit, status: :unprocessable_entity
      return
    end

    @account.lock_saved_attributes!
    redirect_back_or_to account_path(@account), notice: "Precious metal account updated"
  end

  private
    def assign_defaults
      return unless @account

      @account.accountable.subtype ||= "gold"
      @account.accountable.unit ||= "g"
      @account.accountable.manual_price_currency ||= @account.currency || Current.family.currency
    end

    def normalized_account_params
      params = account_params.dup

      if params.dig(:accountable_attributes, :subtype).blank?
        params[:accountable_attributes] ||= {}
        params[:accountable_attributes][:subtype] = "gold"
      end

      currency = params.dig(:accountable_attributes, :manual_price_currency).presence ||
        @account&.currency || Current.family.currency
      params[:currency] = currency

      raw_quantity = params.dig(:accountable_attributes, :quantity)
      quantity = raw_quantity.present? ? raw_quantity.to_d : 0
      manual_price = params.dig(:accountable_attributes, :manual_price).presence
      balance = manual_price.present? ? quantity * manual_price.to_d : 0
      params[:balance] = balance

      params
    end
end
