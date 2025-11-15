module EntryableResource
  extend ActiveSupport::Concern

  included do
    include StreamExtensions, ActionView::RecordIdentifier

    before_action :set_entry, only: %i[show update destroy]
  end

  def show
  end

  def new
    account = ::Current.family.accounts.find_by(id: params[:account_id])

    @entry = ::Current.family.entries.new(
      account: account,
      currency: account ? account.currency : ::Current.family.currency,
      entryable: entryable
    )
  end

  def create
    raise NotImplementedError, "Entryable resources must implement #create"
  end

  def update
    raise NotImplementedError, "Entryable resources must implement #update"
  end

  def destroy
    account = @entry.account
    
    # OPTIMISTIC UPDATE: Immediate balance reversal for smooth UI
    # Calculate the balance change that will be reversed when entry is deleted
    entry_amount = @entry.amount
    entry_date = @entry.date
    entry_currency = @entry.currency

    # Only do optimistic update if entry is recent and in account currency
    if entry_currency == account.currency &&
       entry_date >= 30.days.ago.to_date &&
       account.balances.any?

      # REVERSE the balance change (opposite of create)
      # Entry being deleted means we UNDO its effect on balance
      flows_factor = account.asset? ? 1 : -1
      balance_change = entry_amount * flows_factor  # Note: NO negation (undoing the original change)
      new_balance = account.balance + balance_change

      Rails.logger.info(
        "[Optimistic Delete] Account #{account.id}: " \
        "entry_amount=#{entry_amount}, " \
        "balance_change=#{balance_change}, " \
        "old=#{account.balance}, new=#{new_balance}"
      )

      account.update_column(:balance, new_balance)
    end

    @entry.destroy!
    @entry.sync_account_later

    redirect_back_or_to account_path(account), notice: t("account.entries.destroy.success")
  end

  private
    def entryable
      controller_name.classify.constantize.new
    end

    def set_entry
      @entry = ::Current.family.entries.find(params[:id])
    end
end
