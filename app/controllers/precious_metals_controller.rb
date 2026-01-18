class PreciousMetalsController < ApplicationController
  include AccountableResource

  before_action :prepare_form_state, only: :edit

  permitted_accountable_attributes :id, :subtype, :unit, :quantity, :manual_price, :manual_price_currency,
                                   :account_number, :account_status, :scheme_type, :akad, :preferred_funding_account_id

  def new
    super
    assign_defaults
    prepare_form_state
  end

  def create
    normalized_params = normalized_account_params
    @account = Current.family.accounts.new(normalized_params)

    if @account.valid?
      if initial_purchase_present?
        create_with_initial_purchase(normalized_params)
      else
        @account = Current.family.accounts.create_and_sync(normalized_params.except(:return_to))
        @account.lock_saved_attributes!

        redirect_to(
          safe_return_path(normalized_params[:return_to]) || @account,
          allow_other_host: false,
          notice: "Precious metal account created"
        )
      end
    else
      assign_defaults
      prepare_form_state
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
      prepare_form_state
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
      @account.accountable.account_status ||= "active"
      @account.accountable.manual_price_currency ||= @account.currency || Current.family.currency
    end

    def normalized_account_params
      params = account_params.to_h.deep_symbolize_keys
      params[:accountable_attributes] ||= {}
      params[:accountable_attributes][:subtype] ||= "gold"

      currency = params.dig(:accountable_attributes, :manual_price_currency).presence ||
        @account&.currency || Current.family.currency
      params[:currency] = currency

      raw_quantity = params.dig(:accountable_attributes, :quantity)
      quantity = raw_quantity.present? ? raw_quantity.to_d : 0
      params[:accountable_attributes][:quantity] = quantity

      manual_price = params.dig(:accountable_attributes, :manual_price).presence
      balance = manual_price.present? ? quantity * manual_price.to_d : 0
      balance = 0 if initial_purchase_present?
      params[:balance] = balance

      params
    end

    def prepare_form_state
      @funding_accounts = funding_accounts
      return unless @account&.new_record?

      @initial_purchase_form ||= build_initial_purchase_form
      @initial_purchase_form.price_per_unit ||= @account.accountable.manual_price
      @initial_purchase_form.price_currency ||= @account.accountable.manual_price_currency ||
        @account.currency ||
        Current.family.currency
      @initial_purchase_form.date ||= Date.current
      @initial_purchase_form.from_account_id ||= @account.accountable.preferred_funding_account_id
    end

    def funding_accounts
      Current.family.accounts.manual.active
        .where(classification: "asset")
        .includes(:accountable)
        .alphabetically
        .to_a
        .select { |account| account.balance_type == :cash }
    end

    def initial_purchase_params
      params.fetch(:initial_purchase, {}).permit(
        :from_account_id, :amount, :quantity, :price_per_unit,
        :price_currency, :fee_amount, :date, :save_price
      )
    end

    def initial_purchase_present?
      attrs = initial_purchase_params
      attrs[:from_account_id].present? || attrs[:amount].present? || attrs[:quantity].present?
    end

    def build_initial_purchase_form(account = nil)
      attrs = initial_purchase_params
      Transfer::PreciousMetalForm.new(
        family: Current.family,
        from_account_id: attrs[:from_account_id],
        to_account_id: account&.id,
        amount: attrs[:amount],
        quantity: attrs[:quantity],
        price_per_unit: attrs[:price_per_unit],
        price_currency: attrs[:price_currency],
        fee_amount: attrs[:fee_amount],
        date: attrs[:date],
        save_price: attrs[:save_price]
      )
    end

    def create_with_initial_purchase(normalized_params)
      transfer_form = nil
      created = false

      ApplicationRecord.transaction do
        normalized_params[:balance] = 0
        normalized_params[:accountable_attributes] ||= {}
        normalized_params[:accountable_attributes][:quantity] = 0

        @account = Current.family.accounts.create_and_sync(
          normalized_params.except(:return_to),
          skip_initial_sync: true
        )
        @account.lock_saved_attributes!

        transfer_form = build_initial_purchase_form(@account)
        if transfer_form.create
          created = true
        else
          @error_message = transfer_form.errors.full_messages.to_sentence
          raise ActiveRecord::Rollback
        end
      end

      if created
        redirect_to(
          safe_return_path(normalized_params[:return_to]) || @account,
          allow_other_host: false,
          notice: "Precious metal account created"
        )
      else
        @account = Current.family.accounts.new(normalized_params)
        @initial_purchase_form = transfer_form || build_initial_purchase_form
        assign_defaults
        prepare_form_state
        render :new, status: :unprocessable_entity
      end
    rescue ActiveRecord::RecordInvalid => e
      @error_message = e.record.errors.full_messages.join(", ")
      @account = Current.family.accounts.new(normalized_params)
      @initial_purchase_form = transfer_form || build_initial_purchase_form
      assign_defaults
      prepare_form_state
      render :new, status: :unprocessable_entity
    end
end
