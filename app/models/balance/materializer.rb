class Balance::Materializer
  attr_reader :account, :strategy

  def initialize(account, strategy:)
    @account = account
    @strategy = strategy
  end

  def materialize_balances
    Balance.transaction do
      materialize_holdings
      calculate_balances

      Rails.logger.info("Persisting #{@balances.size} balances")
      persist_balances

      purge_stale_balances

      # CRITICAL FIX: Update account balance for BOTH forward and reverse strategies
      # Previously only forward strategy updated the account, causing balances to not
      # update for linked/synced accounts (which use reverse strategy)
      update_account_info
    end
  end

  private
    def materialize_holdings
      @holdings = Holding::Materializer.new(account, strategy: strategy).materialize_holdings
    end

    def update_account_info
      # Query fresh balance from DB to get generated column values
      current_balance = account.balances
        .where(currency: account.currency)
        .order(date: :desc)
        .first

      if current_balance
        calculated_balance = current_balance.end_balance
        calculated_cash_balance = current_balance.end_cash_balance
      else
        # Fallback if no balance exists
        calculated_balance = 0
        calculated_cash_balance = 0
      end

      Rails.logger.info("Balance update: cash=#{calculated_cash_balance}, total=#{calculated_balance}")

      account.update!(
        balance: calculated_balance,
        cash_balance: calculated_cash_balance
      )
    end

    def calculate_balances
      @balances = calculator.calculate
    end

    # PRODUCTION-READY: Rails 8.1 compatible batch upsert dengan proper timestamp handling
    # Best Practices:
    # 1. Use upsert_all untuk bulk operations (10-50x lebih cepat dari individual saves)
    # 2. Batch processing dalam chunks untuk memory efficiency
    # 3. Rails 8.1 automatic timestamp handling via record_timestamps option
    # 4. Single transaction untuk atomicity
    #
    # CRITICAL FIX: Rails 8.1 PostgreSQL upsert behavior change
    # - When record_timestamps: true, Rails automatically adds updated_at to ON CONFLICT DO UPDATE
    # - We MUST NOT include updated_at in data payload to avoid "multiple assignments to updated_at"
    # - created_at is safe since it's only set on INSERT, not UPDATE
    def persist_balances
      return if @balances.empty?

      current_time = Time.current

      # PERFORMANCE: Batch size 1000 balances optimal untuk memory vs network roundtrips
      # Larger batches risk hitting max_allowed_packet, smaller batches waste network roundtrips
      batch_size = 1000

      @balances.each_slice(batch_size) do |balance_batch|
        # RAILS 8.1 FIX: Do NOT include updated_at in data - Rails will handle it automatically
        # Only include created_at for INSERT operations (ignored during UPDATE)
        upsert_data = balance_batch.map { |b|
          attrs = b.attributes
            .except("id", "created_at", "updated_at", "account_id")
            .slice("date", "balance", "cash_balance", "currency",
                   "start_cash_balance", "start_non_cash_balance",
                   "cash_inflows", "cash_outflows",
                   "non_cash_inflows", "non_cash_outflows",
                   "net_market_flows",
                   "cash_adjustments", "non_cash_adjustments",
                   "flows_factor")
          attrs["account_id"] = account.id
          attrs["created_at"] = current_time
          # CRITICAL: Do NOT set updated_at here - Rails 8.1 will add it automatically
          attrs
        }

        # RAILS 8.1 BEST PRACTICE: Use record_timestamps: true (default)
        # This tells Rails to automatically handle updated_at in ON CONFLICT DO UPDATE clause
        # No need to manually add it to upsert_data or update_only
        account.balances.upsert_all(
          upsert_data,
          unique_by: %i[account_id date currency]
          # record_timestamps: true is the default, handles updated_at automatically
        )
      end

      Rails.logger.info("Successfully persisted #{@balances.size} balances in #{(@balances.size.to_f / batch_size).ceil} batches")
    end

    def purge_stale_balances
      sorted_balances = @balances.sort_by(&:date)
      oldest_calculated_balance_date = sorted_balances.first&.date
      newest_calculated_balance_date = sorted_balances.last&.date
      deleted_count = account.balances.delete_by("date < ? OR date > ?", oldest_calculated_balance_date, newest_calculated_balance_date)
      Rails.logger.info("Purged #{deleted_count} stale balances") if deleted_count > 0
    end

    def calculator
      if strategy == :reverse
        Balance::ReverseCalculator.new(account)
      else
        Balance::ForwardCalculator.new(account)
      end
    end
end
