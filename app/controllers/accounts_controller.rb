class AccountsController < ApplicationController
  before_action :set_account, only: %i[sync sparkline toggle_active show destroy value]
  include Periodable

  def index
    # PERFORMANCE: Eager load associations to prevent N+1 queries
    @manual_accounts = family.accounts.manual.alphabetically.includes(:accountable)
    @plaid_items = family.plaid_items.ordered.includes(:plaid_accounts)
    @simplefin_items = family.simplefin_items.ordered.includes(:simplefin_accounts)
    @lunchflow_items = family.lunchflow_items.ordered.includes(:lunchflow_accounts)

    render layout: "settings"
  end

  def sync_all
    family.sync_later
    redirect_to accounts_path, notice: "Syncing accounts..."
  end

  def show
    @chart_view = params[:chart_view] || "balance"
    @tab = params[:tab]
    @q = params.fetch(:q, {}).permit(:search)

    # PERFORMANCE: Eager load associations for entries
    # Note: Cannot use .includes(:entryable) on polymorphic - Rails will load automatically
    entries = @account.entries
                      .search(@q)
                      .reverse_chronological
                      .includes(:account)

    @pagy, @entries = pagy(:offset, entries, limit: per_page_param(10))

    @activity_feed_data = Account::ActivityFeedData.new(@account, @entries)

    load_loan_adjustment_prompt if @account.accountable_type == "Loan"
  end

  def sync
    unless @account.syncing?
      if @account.linked?
        # Sync all provider items for this account
        # Each provider item will trigger an account sync when complete
        @account.account_providers.each do |account_provider|
          item = account_provider.adapter&.item
          item&.sync_later if item && !item.syncing?
        end
      else
        # Manual accounts just need balance materialization
        @account.sync_later
      end
    end

    redirect_to account_path(@account)
  end

  def sparkline
    # Always render a body for Turbo Frame requests so the placeholder gets replaced.
    # We still leverage server-side caching in Account::Chartable#sparkline_series.
    @sparkline_series = @account.sparkline_series
    render layout: false
  end

  # GET /accounts/:id/value
  # Returns a small HTML fragment with the up-to-date display value for an account.
  # For loans, this is the remaining principal; otherwise, current balance.
  def value
    render partial: "accounts/value", locals: { account: @account }
  end

  def toggle_active
    if @account.active?
      @account.disable!
    elsif @account.disabled?
      @account.enable!
    end
    redirect_to accounts_path
  end

  def destroy
    if @account.linked?
      redirect_to account_path(@account), alert: "Cannot delete a linked account"
    else
      @account.destroy_later
      redirect_to accounts_path, notice: "Account scheduled for deletion"
    end
  end

  private
    def family
      Current.family
    end

    def set_account
      @account = family.accounts.find(params[:id])
    end

    def load_loan_adjustment_prompt
      prompt = flash.delete(:loan_adjustment)
      if prompt.present? && prompt[:account_id].to_s == @account.id
        build_loan_prompt_from_flash(prompt)
      else
        fallback_loan_prompt
      end
    rescue ArgumentError
      @loan_adjustment_prompt = nil
    end

    def build_loan_prompt_from_flash(prompt)
      amount_decimal = BigDecimal(prompt[:amount]) rescue nil
      suggested_date = begin
        Date.parse(prompt[:date]) if prompt[:date].present?
      rescue ArgumentError
        nil
      end

      assign_loan_prompt(amount_decimal, suggested_date, prompt[:reconciliation_entry_id])
    end

    def fallback_loan_prompt
      return if @account.accountable.extra&.[]("balance_adjustment_confirmed")

      initial = BigDecimal(@account.accountable.initial_balance.to_s) rescue nil
      current = BigDecimal((@account.accountable.principal_amount || @account.balance).to_s) rescue nil
      return unless initial && current

      delta = initial - current
      return unless delta.positive?

      return if loan_has_recorded_principal_payments?

      recon_entry = detect_recent_reconciliation(current)
      return unless recon_entry

      assign_loan_prompt(delta, @account.accountable.start_date, recon_entry.id)
    end

    def assign_loan_prompt(amount_decimal, suggested_date, entry_id)
      return unless amount_decimal && amount_decimal.positive?

      @loan_adjustment_prompt = {
        amount: amount_decimal,
        suggested_date: suggested_date || Date.current,
        reconciliation_entry_id: entry_id
      }

      @loan_prompt_sources = family.accounts.assets.alphabetically.where.not(id: @account.id)
    end

    def loan_has_recorded_principal_payments?
      @account.entries
              .joins("INNER JOIN transactions ON transactions.id = entries.entryable_id AND entries.entryable_type = 'Transaction'")
              .where(transactions: { kind: "funds_movement" })
              .where("entries.amount < 0")
              .exists?
    end

    def detect_recent_reconciliation(expected_balance)
      scope = @account.entries
                       .joins("INNER JOIN valuations ON valuations.id = entries.entryable_id")
                       .where(entryable_type: "Valuation", valuations: { kind: "reconciliation" }, currency: @account.currency)
                       .order(created_at: :desc)

      scope.find do |entry|
        (entry.amount.to_d - expected_balance.to_d).abs < 0.01
      end
    rescue
      nil
    end
end
