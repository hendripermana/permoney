class Balance::Materializer
  require "zlib"
  ADVISORY_LOCK_NAMESPACE = 42_001
  attr_reader :account, :strategy, :window_start_date, :window_end_date, :downgraded_full_rebuild, :requested_window_start_date, :downgraded_reason
  MAX_RECALCULATION_PASSES = 2

  def initialize(account, strategy:, window_start_date: nil, window_end_date: nil)
    @account = account
    @strategy = strategy

    @requested_window_start_date = window_start_date

    # SAFETY: Only honor windowed recalcs if we have an anchor balance. Otherwise, do full rebuild.
    @downgraded_full_rebuild = window_start_date.present? && !anchor_present?
    @downgraded_reason = @downgraded_full_rebuild ? "missing_anchor" : nil
    @window_start_date = @downgraded_full_rebuild ? nil : window_start_date
    @window_end_date = window_end_date
  end

  def materialize_balances
    # PERFORMANCE MONITORING: Track sync duration and performance
    start_time = Time.current
    Rails.logger.info(
      "[Balance Sync Start] Account #{account.id}, Strategy: #{strategy}, " \
      "Window: #{window_start_date || 'full'} to #{window_end_date || 'latest'}" \
      "#{downgraded_full_rebuild ? ' (downgraded: missing anchor)' : ''}"
    )

    if downgraded_full_rebuild
      Sentry.capture_message(
        "Balance window downgraded to full rebuild (missing anchor)",
        level: :info,
        tags: { account_id: account.id, strategy: strategy },
        extra: {
          requested_window_start_date: requested_window_start_date,
          effective_window_start_date: window_start_date,
          window_end_date: window_end_date
        }
      )
    end

    with_account_lock do
      Balance.transaction do
        recalc_passes = 0

        begin
          recalc_passes += 1

          # Step 1: Materialize holdings
          holdings_start = Time.current
          materialize_holdings
          holdings_duration = Time.current - holdings_start

          # Step 2: Calculate balances (most expensive operation)
          calc_start = Time.current
          calculate_balances
          calc_duration = Time.current - calc_start

          Rails.logger.info(
            "[Balance Calc] #{@balances.size} balances calculated in #{calc_duration.round(2)}s " \
            "(#{calc_duration.positive? ? (@balances.size / calc_duration).round(1) : 0} balances/sec)"
          )

          if @balances.blank? && recalc_passes < MAX_RECALCULATION_PASSES
            Sentry.capture_message(
              "Balance calc produced no rows, retrying with full rebuild",
              level: :warning,
              tags: { account_id: account.id, strategy: strategy, reason: "empty_calc" },
              extra: delta_spike_metadata.merge(reason: "empty_calc")
            )

            @window_start_date = nil
            @downgraded_full_rebuild = true
            @downgraded_reason = "empty_calc"
            next
          end

          # Safety net: detect delta spikes and retry with full rebuild once
          if delta_spike_detected? && window_start_date && recalc_passes < MAX_RECALCULATION_PASSES
            Sentry.capture_message(
              "Balance delta spike detected, retrying with full rebuild",
              level: :warning,
              tags: { account_id: account.id, strategy: strategy, reason: "delta_spike" },
              extra: delta_spike_metadata
            )

            @window_start_date = nil
            @downgraded_full_rebuild = true
            @downgraded_reason = "delta_spike"
            @balances = []
            next
          end

          # Step 3: Persist to database
          persist_start = Time.current
          persist_balances
          persist_duration = Time.current - persist_start

          # Step 4: Cleanup
          purge_start = Time.current
          purge_stale_balances
          purge_duration = Time.current - purge_start

          # Step 5: Update account
          update_start = Time.current
          update_account_info
          update_duration = Time.current - update_start

          # Final performance summary
          total_duration = Time.current - start_time
          Rails.logger.info(
            "[Balance Sync Complete] Account #{account.id}: #{total_duration.round(2)}s total " \
            "(holdings: #{holdings_duration.round(2)}s, calc: #{calc_duration.round(2)}s, " \
            "persist: #{persist_duration.round(2)}s, purge: #{purge_duration.round(2)}s, " \
            "update: #{update_duration.round(2)}s)"
          )

          # MONITORING: Report slow syncs to Sentry for investigation
          if total_duration > 10.seconds
            Sentry.capture_message(
              "Slow balance sync detected",
              level: :warning,
              extra: {
                account_id: account.id,
                strategy: strategy,
                total_duration: total_duration.round(2),
                balance_count: @balances.size,
                calc_duration: calc_duration.round(2),
                window_start: window_start_date,
                window_end: window_end_date
              }
            )
          end
          broadcast_downgrade_notice if downgraded_full_rebuild && requested_window_start_date.present?
          break
        end while recalc_passes < MAX_RECALCULATION_PASSES
      end
    end
  end

  private
    def with_account_lock
      locked = false
      key = account.id.to_i
      sql = ActiveRecord::Base.send(:sanitize_sql_array, [ "SELECT pg_try_advisory_lock(?, ?)", ADVISORY_LOCK_NAMESPACE, key ])
      locked = ActiveRecord::Base.connection.select_value(sql)

      unless locked
        Rails.logger.warn("Balance materializer lock contention for account #{account.id}")
        Sentry.capture_message(
          "Balance materializer lock contention",
          level: :warning,
          tags: { account_id: account.id },
          extra: { strategy: strategy, window_start_date: window_start_date, window_end_date: window_end_date }
        )
        return
      end

      yield
    ensure
      if locked
        unlock_sql = ActiveRecord::Base.send(:sanitize_sql_array, [ "SELECT pg_advisory_unlock(?, ?)", ADVISORY_LOCK_NAMESPACE, key ])
        ActiveRecord::Base.connection.select_value(unlock_sql)
      end
    end

    def materialize_holdings
      @holdings = Holding::Materializer.new(account, strategy: strategy).materialize_holdings
    end

    def anchor_present?
      account.balances.where(currency: account.currency).exists?
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

    def delta_spike_detected?
      return false if @balances.blank?

      latest_existing = account.balances
        .where(currency: account.currency)
        .order(date: :desc)
        .first

      return false unless latest_existing

      new_latest = @balances.max_by(&:date)
      return false unless new_latest&.end_balance && latest_existing&.end_balance

      delta = new_latest.end_balance - latest_existing.end_balance

      flow_magnitude = @balances.sum { |b|
        b.cash_inflows.to_i.abs + b.cash_outflows.to_i.abs +
          b.non_cash_inflows.to_i.abs + b.non_cash_outflows.to_i.abs
      }

      threshold = flow_magnitude * 3
      threshold.positive? && delta.abs > threshold
    end

    def delta_spike_metadata
      latest_existing = account.balances
        .where(currency: account.currency)
        .order(date: :desc)
        .first
      new_latest = @balances.max_by(&:date)

      {
        account_id: account.id,
        strategy: strategy,
        requested_window_start_date: requested_window_start_date,
        effective_window_start_date: window_start_date,
        window_end_date: window_end_date,
        latest_existing_date: latest_existing&.date,
        latest_existing_balance: latest_existing&.end_balance,
        new_latest_date: new_latest&.date,
        new_latest_balance: new_latest&.end_balance,
        flow_magnitude: @balances.sum { |b|
          b.cash_inflows.to_i.abs + b.cash_outflows.to_i.abs +
            b.non_cash_inflows.to_i.abs + b.non_cash_outflows.to_i.abs
        },
        downgraded_reason: @downgraded_reason
      }
    end

    def broadcast_downgrade_notice
      message =
        case @downgraded_reason
        when "delta_spike"
          "#{account.name} sync fell back to full rebuild (safety: large delta)."
        when "missing_anchor"
          "#{account.name} sync fell back to full rebuild (missing anchor)."
        else
          "#{account.name} sync fell back to full rebuild."
        end

      ActionView::Base.with_empty_template_cache do
        turbo_stream = ApplicationController.render(
          partial: "shared/notifications/notice",
          locals: { message: message }
        )

        Turbo::StreamsChannel.broadcast_append_to(
          account.family,
          target: "notification-tray",
          html: turbo_stream
        )
      end
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

      total = @balances.size
      # PERFORMANCE: adaptif - batch lebih kecil untuk dataset besar supaya lock DB tidak lama
      batch_size = total > 10_000 ? 500 : 1000

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

      Rails.logger.info(
        "Successfully persisted #{@balances.size} balances in #{(@balances.size.to_f / batch_size).ceil} batches (batch_size=#{batch_size})"
      )
    end

    def purge_stale_balances
      return if @balances.blank?

      calculated_dates = @balances.map(&:date)
      calculated_start = calculated_dates.min
      calculated_end = calculated_dates.max

      deleted_count =
        if window_start_date.nil? && window_end_date.nil?
          # Full rebuild: trim balances outside the newly calculated range
          account.balances.delete_by("date < ? OR date > ?", calculated_start, calculated_end)
        else
          # Windowed recalculation: only purge stale rows inside the recalculated window
          account.balances
            .where("date >= ?", calculated_start)
            .where("date <= ?", calculated_end)
            .where.not(date: calculated_dates)
            .delete_all
        end

      Rails.logger.info("Purged #{deleted_count} stale balances") if deleted_count.positive?
    end

    def calculator
      # PERFORMANCE: Pass window dates to calculator for incremental calculation
      if strategy == :reverse
        Balance::ReverseCalculator.new(account,
          window_start_date: window_start_date,
          window_end_date: window_end_date)
      else
        Balance::ForwardCalculator.new(account,
          window_start_date: window_start_date,
          window_end_date: window_end_date)
      end
    end
end
