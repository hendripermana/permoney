# frozen_string_literal: true

# Controller untuk mengelola receipt/document attachments pada transaksi (Entry)
# Stored in Cloudflare R2 for zero-egress, cost-effective cloud storage
class EntryReceiptsController < ApplicationController
  before_action :set_entry

  # DELETE /entries/:entry_id/receipt
  def destroy
    if @entry.receipt.attached?
      @entry.receipt.purge_later # Async purge for better UX

      respond_to do |format|
        format.html { redirect_back fallback_location: transaction_path(@entry), notice: t(".receipt_removed", default: "Receipt removed successfully") }
        format.turbo_stream do
          flash.now[:notice] = t(".receipt_removed", default: "Receipt removed successfully")
          render turbo_stream: [
            turbo_stream.replace("entry_receipt_section", partial: "transactions/receipt_section", locals: { entry: @entry }),
            *flash_notification_stream_items
          ]
        end
      end
    else
      redirect_back fallback_location: transaction_path(@entry), alert: t(".no_receipt", default: "No receipt attached")
    end
  end

  private

    def set_entry
      @entry = Current.family.entries.find(params[:entry_id])
    end
end
