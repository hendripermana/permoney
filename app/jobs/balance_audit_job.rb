class BalanceAuditJob < ApplicationJob
  queue_as :low_priority

  DEFAULT_SAMPLE = 5
  DEFAULT_WINDOW_DAYS = 7

  def perform(sample_size: DEFAULT_SAMPLE, window_days: DEFAULT_WINDOW_DAYS)
    sample_size = sample_size.to_i
    window_days = window_days.to_i
    return if sample_size <= 0 || window_days <= 0

    window_start = Date.current - window_days
    window_end = Date.current

    accounts = Account.visible
      .order(Arel.sql("RANDOM()"))
      .limit(sample_size)

    accounts.each do |account|
      sync = account.sync_later(window_start_date: window_start, window_end_date: window_end)

      Sentry.capture_message(
        "Balance audit queued",
        level: :info,
        tags: { account_id: account.id, reason: "balance_audit" },
        extra: {
          window_start_date: window_start,
          window_end_date: window_end,
          sync_id: sync.id
        }
      )
    end
  end
end
