class TransfersController < ApplicationController
  include StreamExtensions

  before_action :set_transfer, only: %i[show destroy update]

  def new
    @transfer = Transfer.new
  end

  def show
    @categories = Current.family.categories.expenses
  end

  def create
    if precious_metal_transfer?
      form = Transfer::PreciousMetalForm.new(
        family: Current.family,
        from_account_id: transfer_params[:from_account_id],
        to_account_id: transfer_params[:to_account_id],
        amount: transfer_params[:amount],
        quantity: transfer_params[:metal_quantity],
        price_per_unit: transfer_params[:price_per_unit],
        price_currency: transfer_params[:price_currency],
        fee_amount: transfer_params[:fee_amount],
        date: transfer_params[:date],
        save_price: transfer_params[:save_price]
      )

      if form.create
        @transfer = form.transfer
      else
        @transfer = Transfer.new
        form.errors.each { |error| @transfer.errors.add(error.attribute, error.message) }
      end
    else
      @transfer = Transfer::Creator.new(
        family: Current.family,
        source_account_id: transfer_params[:from_account_id],
        destination_account_id: transfer_params[:to_account_id],
        date: transfer_params[:date],
        amount: transfer_params[:amount].to_d
      ).create
    end

    if @transfer.persisted?
      success_message = "Transfer created"
      respond_to do |format|
        format.html { redirect_back_or_to transactions_path, notice: success_message }
        format.turbo_stream { stream_redirect_back_or_to transactions_path, notice: success_message }
      end
    else
      render :new, status: :unprocessable_entity
    end
  end

  def update
    Transfer.transaction do
      update_transfer_status
      update_transfer_details unless transfer_update_params[:status] == "rejected"
    end

    respond_to do |format|
      format.html { redirect_back_or_to transactions_url, notice: t(".success") }
      format.turbo_stream
    end
  end

  def destroy
    @transfer.destroy!
    redirect_back_or_to transactions_url, notice: t(".success")
  end

  private
    def set_transfer
      # Finds the transfer and ensures the family owns it
      @transfer = Transfer
                    .where(id: params[:id])
                    .where(inflow_transaction_id: Current.family.transactions.select(:id))
                    .first
    end

    def transfer_params
      params.require(:transfer).permit(
        :from_account_id, :to_account_id, :amount, :date, :name, :excluded,
        :metal_quantity, :price_per_unit, :price_currency, :fee_amount, :save_price
      )
    end

    def transfer_update_params
      params.require(:transfer).permit(:notes, :status, :category_id)
    end

    def precious_metal_transfer?
      destination_account_id = transfer_params[:to_account_id]
      return false if destination_account_id.blank?

      Current.family.accounts.find_by(id: destination_account_id)&.accountable_type == "PreciousMetal"
    end

    def update_transfer_status
      if transfer_update_params[:status] == "rejected"
        @transfer.reject!
      elsif transfer_update_params[:status] == "confirmed"
        @transfer.confirm!
      end
    end

    def update_transfer_details
      @transfer.outflow_transaction.update!(category_id: transfer_update_params[:category_id])
      @transfer.update!(notes: transfer_update_params[:notes])
    end
end
