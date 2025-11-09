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
    entry_amount = @entry.amount
    entry_date = @entry.date
    entry_currency = @entry.currency

    # OPTIMISTIC UPDATE: Immediate balance update for smooth UI experience
    # This prevents "flickering" while async sync job recalculates accurate balance
    ActiveRecord::Base.transaction do
      @entry.destroy!

      # Only do optimistic update if:
      # 1. Entry is in account's native currency (avoid complex conversion)
      # 2. Entry is recent (within last 30 days) for safety
      # 3. Account has balances (avoid edge cases with new accounts)
      if entry_currency == account.currency &&
         entry_date >= 30.days.ago.to_date &&
         account.balances.any?

        # Calculate optimistic new balance (simple subtraction)
        # This is approximate - async sync will calculate exact balance
        new_balance = account.balance - entry_amount

        Rails.logger.info(
          "Optimistic balance update for account #{account.id}: " \
          "#{account.balance} - #{entry_amount} = #{new_balance}"
        )

        # Update balance immediately (skip validations for speed)
        account.update_columns(
          balance: new_balance,
          updated_at: Time.current
        )

        # Broadcast immediate update to UI via Turbo
        account.broadcast_replace_to(
          account.family,
          target: "account_#{account.id}",
          partial: "accounts/account",
          locals: { account: account.reload }
        )
      end
    end

    # Trigger async sync for accurate recalculation
    # This will correct any minor discrepancies from optimistic update
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
