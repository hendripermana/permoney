class PayLater::InstallmentScheduleComponent < ApplicationComponent
  attr_reader :installments, :account, :pay_later, :show_actions

  def initialize(installments:, account:, show_actions: true)
    @installments = installments
    @account = account
    @pay_later = account.accountable
    @show_actions = show_actions
  end

  def grouped_installments
    installments.group_by(&:status)
  end

  def status_badge_color(status)
    case status
    when "paid"
      "bg-green-100 text-green-800"
    when "pending"
      "bg-blue-100 text-blue-800"
    when "partially_paid"
      "bg-yellow-100 text-yellow-800"
    when "overdue"
      "bg-red-100 text-red-800"
    when "cancelled"
      "bg-gray-100 text-gray-800"
    else
      "bg-gray-100 text-gray-800"
    end
  end

  def status_icon(status)
    case status
    when "paid"
      "check-circle"
    when "pending"
      "clock"
    when "partially_paid"
      "clock"
    when "overdue"
      "alert-triangle"
    when "cancelled"
      "x-circle"
    else
      "circle"
    end
  end

  def row_bg_color(installment)
    if installment.status_overdue?
      "bg-red-50"
    elsif installment.status_partially_paid?
      "bg-yellow-50"
    elsif installment.status_paid?
      "bg-green-50"
    else
      ""
    end
  end

  def summary
    {
      total: installments.count,
      paid: installments.select(&:status_paid?).count,
      pending: installments.reject(&:status_paid?).reject(&:status_cancelled?).count,
      overdue: installments.select(&:overdue?).count,
      total_amount: installments.sum(&:total_due),
      total_paid: installments.select(&:status_paid?).sum(&:paid_amount),
      total_remaining: installments.reject(&:status_paid?).reject(&:status_cancelled?).sum(&:remaining_amount_decimal)
    }
  end

  def progress_percentage
    return 0 if summary[:total].zero?
    ((summary[:paid].to_f / summary[:total]) * 100).round(1)
  end
end
