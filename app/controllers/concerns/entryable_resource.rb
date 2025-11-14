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

        # CORRECT OPTIMISTIC BALANCE CALCULATION FOR DELETE
        # Deleting a transaction should REVERSE its original effect on balance
        # Entry amount convention (from Balance::ForwardCalculator):
        #   - Negative amount = income (originally increased asset, decreased liability)
        #   - Positive amount = expense (originally decreased asset, increased liability)
        #
        # When CREATING: balance_change = -entry_amount * flows_factor
        # When DELETING: balance_change = entry_amount * flows_factor (reverses CREATE)
        #
        # Examples for ASSET (flows_factor=1):
        # - Delete expense (+100): balance_change = +100 → balance INCREASES ✓ (reverses decrease)
        # - Delete income (-200): balance_change = -200 → balance DECREASES ✓ (reverses increase)
        flows_factor = account.asset? ? 1 : -1
        balance_change = entry_amount * flows_factor  # Reverses the negated CREATE effect
        new_balance = account.balance + balance_change

        Rails.logger.info(
          "[Optimistic Update - Delete] Account #{account.id} (#{account.classification}): " \
          "balance #{account.balance} + reverse(#{entry_amount} * #{flows_factor}) = #{new_balance}"
        )

        # Update balance immediately
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
