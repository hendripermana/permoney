class Balance::ForwardCalculator < Balance::BaseCalculator
  def calculate
    Rails.logger.tagged("Balance::ForwardCalculator") do
      # PERFORMANCE: Incremental calculation optimization
      # Instead of recalculating from opening_anchor_date every time,
      # start from window_start_date (if provided) or latest calculated balance
      start_date = determine_start_date
      end_date = determine_end_date

      # Get starting balance from previous calculation (if exists)
      starting_balance_record = account.balances
        .where(currency: account.currency)
        .where("date < ?", start_date)
        .order(date: :desc)
        .first

      if starting_balance_record
        # INCREMENTAL: Continue from last calculated balance
        start_cash_balance = starting_balance_record.end_cash_balance
        start_non_cash_balance = starting_balance_record.end_non_cash_balance

        Rails.logger.info(
          "[Incremental Calc] Starting from #{starting_balance_record.date}: " \
          "cash=#{start_cash_balance}, non_cash=#{start_non_cash_balance}"
        )
      else
        # FULL: No previous balance, start from opening anchor
        start_cash_balance = derive_cash_balance_on_date_from_total(
          total_balance: account.opening_anchor_balance,
          date: account.opening_anchor_date
        )
        start_non_cash_balance = account.opening_anchor_balance - start_cash_balance

        Rails.logger.info(
          "[Full Calc] Starting from opening anchor #{account.opening_anchor_date}: " \
          "cash=#{start_cash_balance}, non_cash=#{start_non_cash_balance}"
        )
      end

      start_date.upto(end_date).map do |date|
        valuation = sync_cache.get_valuation(date)

        if valuation
          end_cash_balance = derive_cash_balance_on_date_from_total(
            total_balance: valuation.amount,
            date: date
          )
          end_non_cash_balance = valuation.amount - end_cash_balance
        else
          end_cash_balance = derive_end_cash_balance(start_cash_balance: start_cash_balance, date: date)
          end_non_cash_balance = derive_end_non_cash_balance(start_non_cash_balance: start_non_cash_balance, date: date)
        end

        flows = flows_for_date(date)
        market_value_change = market_value_change_on_date(date, flows)

        cash_adjustments = cash_adjustments_for_date(start_cash_balance, end_cash_balance, (flows[:cash_inflows] - flows[:cash_outflows]) * flows_factor)
        non_cash_adjustments = non_cash_adjustments_for_date(start_non_cash_balance, end_non_cash_balance, (flows[:non_cash_inflows] - flows[:non_cash_outflows]) * flows_factor)

        output_balance = build_balance(
          date: date,
          balance: end_cash_balance + end_non_cash_balance,
          cash_balance: end_cash_balance,
          start_cash_balance: start_cash_balance,
          start_non_cash_balance: start_non_cash_balance,
          cash_inflows: flows[:cash_inflows],
          cash_outflows: flows[:cash_outflows],
          non_cash_inflows: flows[:non_cash_inflows],
          non_cash_outflows: flows[:non_cash_outflows],
          cash_adjustments: cash_adjustments,
          non_cash_adjustments: non_cash_adjustments,
          net_market_flows: market_value_change
        )

        # Set values for the next iteration
        start_cash_balance = end_cash_balance
        start_non_cash_balance = end_non_cash_balance

        output_balance
      end
    end
  end

  private
    # PERFORMANCE: Determine optimal start date for calculation
    # Priority order:
    # 1. Sync window_start_date (if provided by sync operation AND we have an anchor balance)
    # 2. Latest balance date + 1 (incremental calculation)
    # 3. Opening anchor date (full recalculation fallback)
    def determine_start_date
      if window_start_date && balance_anchor_present?
        # Explicit window provided by sync and we have an anchor balance to build from
        window_start_date
      else
        # Try incremental calculation from latest balance
        latest_balance_date = account.balances
          .where(currency: account.currency)
          .maximum(:date)

        if latest_balance_date
          # Start from day after latest balance
          latest_balance_date + 1.day
        else
          # No balances exist, start from opening anchor
          account.opening_anchor_date
        end
      end
    end

    # Determine end date for calculation
    # Use window_end_date if provided, otherwise calculate to latest entry/holding
    def determine_end_date
      if window_end_date
        window_end_date
      else
        [ account.entries.order(:date).last&.date,
          account.holdings.order(:date).last&.date ].compact.max || Date.current
      end
    end

    def balance_anchor_present?
      account.balances.where(currency: account.currency).exists?
    end

    # Legacy methods for backward compatibility (if needed by tests)
    def calc_start_date
      determine_start_date
    end

    def calc_end_date
      determine_end_date
    end

    # Negative entries amount on an "asset" account means, "account value has increased"
    # Negative entries amount on a "liability" account means, "account debt has decreased"
    # Positive entries amount on an "asset" account means, "account value has decreased"
    # Positive entries amount on a "liability" account means, "account debt has increased"
    def signed_entry_flows(entries)
      entry_flows = entries.sum(&:amount)
      account.asset? ? -entry_flows : entry_flows
    end

    # Derives cash balance, starting from the start-of-day, applying entries in forward to get the end-of-day balance
    def derive_end_cash_balance(start_cash_balance:, date:)
      derive_cash_balance(start_cash_balance, date)
    end

    # Derives non-cash balance, starting from the start-of-day, applying entries in forward to get the end-of-day balance
    def derive_end_non_cash_balance(start_non_cash_balance:, date:)
      derive_non_cash_balance(start_non_cash_balance, date, direction: :forward)
    end

    def flows_factor
      account.asset? ? 1 : -1
    end
end
