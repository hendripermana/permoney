class PreciousMetalTransactionsController < ApplicationController
  include StreamExtensions

  before_action :set_account

  def new
    @form = PreciousMetal::TransactionForm.new(
      account: @account,
      date: Date.current,
      fee_mode: "cash",
      transaction_type: "buy",
      cash_currency: @account.currency
    )
  end

  def create
    @form = PreciousMetal::TransactionForm.new(form_params.merge(account: @account, cash_currency: @account.currency))

    entry = @form.create

    if entry
      entry.lock_saved_attributes!
      entry.sync_account_later

      respond_to do |format|
        format.html { redirect_back_or_to account_path(@account), notice: "Transaction created" }
        format.turbo_stream do
          render turbo_stream: [
            turbo_stream.update("modal", ""),
            build_stream_redirect_back_or_to(account_path(@account)),
            *flash_notification_stream_items
          ]
        end
      end
    else
      render :new, status: :unprocessable_entity
    end
  end

  private
    def set_account
      @account = Current.family.accounts.find(params[:account_id])
    end

    def form_params
      params.require(:precious_metal_transaction_form)
            .permit(:transaction_type, :quantity, :cash_amount, :fee_mode, :date, :notes)
    end
end
