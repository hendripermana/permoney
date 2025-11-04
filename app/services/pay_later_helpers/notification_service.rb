module PayLaterHelpers
  class NotificationService
    # Notification configuration - easily extensible
    NOTIFICATION_CONFIG = {
      upcoming_payment: {
        0 => {
          title_template: "pay_later.notifications.upcoming_payment.due_today.title",
          message_template: "pay_later.notifications.upcoming_payment.due_today.message",
          priority: :urgent,
          icon: "calendar-exclamation"
        },
        1..3 => {
          title_template: "pay_later.notifications.upcoming_payment.due_soon.title",
          message_template: "pay_later.notifications.upcoming_payment.due_soon.message",
          priority: :high,
          icon: "calendar-clock"
        },
        4..7 => {
          title_template: "pay_later.notifications.upcoming_payment.reminder.title",
          message_template: "pay_later.notifications.upcoming_payment.reminder.message",
          priority: :medium,
          icon: "calendar"
        }
      },
      overdue_payment: {
        title_template: "pay_later.notifications.overdue_payment.title",
        message_template: "pay_later.notifications.overdue_payment.message",
        priority: :urgent,
        icon: "alert-triangle"
      },
      payment_confirmation: {
        title_template: "pay_later.notifications.payment_confirmation.title",
        message_template: "pay_later.notifications.payment_confirmation.message",
        priority: :info,
        icon: "check-circle"
      },
      purchase_recorded: {
        title_template: "pay_later.notifications.purchase_recorded.title",
        message_template: "pay_later.notifications.purchase_recorded.message",
        priority: :info,
        icon: "shopping-cart"
      },
      credit_limit_warning: {
        title_template: "pay_later.notifications.credit_limit_warning.title",
        message_template: "pay_later.notifications.credit_limit_warning.message",
        priority: :warning,
        icon: "alert-circle"
      },
      account_expiry_warning: {
        title_template: "pay_later.notifications.account_expiry_warning.title",
        message_template: "pay_later.notifications.account_expiry_warning.message",
        priority: :warning,
        icon: "calendar-x"
      },
      all_paid_congratulations: {
        title_template: "pay_later.notifications.all_paid_congratulations.title",
        message_template: "pay_later.notifications.all_paid_congratulations.message",
        priority: :success,
        icon: "party-popper"
      }
    }.freeze

    attr_reader :pay_later

    def initialize(pay_later)
      @pay_later = pay_later
    end

    def upcoming_payment_reminder
      next_installment = pay_later.next_due_installment
      return nil unless next_installment

      days_until_due = (next_installment.due_date - Date.current).to_i
      config = find_upcoming_payment_config(days_until_due)

      return nil unless config

      create_notification(
        title: interpolate_template(config[:title_template], installment: next_installment, days: days_until_due),
        message: interpolate_template(config[:message_template], installment: next_installment, days: days_until_due),
        priority: config[:priority],
        action_url: Rails.application.routes.url_helpers.account_path(pay_later.account),
        icon: config[:icon]
      )
    end

    def overdue_payment_reminder
      overdue_installments = pay_later.overdue_installments
      return nil if overdue_installments.empty?

      total_overdue = overdue_installments.sum(&:remaining_amount_decimal)
      days_overdue = (Date.current - overdue_installments.first.due_date).to_i
      config = NOTIFICATION_CONFIG[:overdue_payment]

      create_notification(
        title: interpolate_template(config[:title_template], installments: overdue_installments, total: total_overdue, days: days_overdue),
        message: interpolate_template(config[:message_template], installments: overdue_installments, total: total_overdue, days: days_overdue),
        priority: config[:priority],
        action_url: Rails.application.routes.url_helpers.account_path(pay_later.account),
        icon: config[:icon]
      )
    end

    def payment_confirmation(payment_amount, installments_affected)
      config = NOTIFICATION_CONFIG[:payment_confirmation]

      create_notification(
        title: interpolate_template(config[:title_template], amount: payment_amount, count: installments_affected.count),
        message: interpolate_template(config[:message_template], amount: payment_amount, count: installments_affected.count),
        priority: config[:priority],
        action_url: Rails.application.routes.url_helpers.account_path(pay_later.account),
        icon: config[:icon]
      )
    end

    def purchase_recorded(purchase_amount, tenor_months, merchant_name)
      config = NOTIFICATION_CONFIG[:purchase_recorded]

      create_notification(
        title: interpolate_template(config[:title_template], merchant: merchant_name, amount: purchase_amount),
        message: interpolate_template(config[:message_template], merchant: merchant_name, amount: purchase_amount, tenor: tenor_months),
        priority: config[:priority],
        action_url: Rails.application.routes.url_helpers.account_path(pay_later.account),
        icon: config[:icon]
      )
    end

    def credit_limit_warning
      return nil unless pay_later.utilization_percentage >= 80

      config = NOTIFICATION_CONFIG[:credit_limit_warning]

      create_notification(
        title: interpolate_template(config[:title_template], utilization: pay_later.utilization_percentage),
        message: interpolate_template(config[:message_template], utilization: pay_later.utilization_percentage, available: pay_later.available_credit_money.format),
        priority: config[:priority],
        action_url: Rails.application.routes.url_helpers.account_path(pay_later.account),
        icon: config[:icon]
      )
    end

    def account_expiry_warning
      return nil unless pay_later.expiry_date.present?

      days_until_expiry = (pay_later.expiry_date - Date.current).to_i
      return nil unless days_until_expiry > 0 && days_until_expiry <= 30

      config = NOTIFICATION_CONFIG[:account_expiry_warning]

      create_notification(
        title: interpolate_template(config[:title_template], days: days_until_expiry),
        message: interpolate_template(config[:message_template], days: days_until_expiry, date: pay_later.expiry_date.strftime("%B %d, %Y")),
        priority: config[:priority],
        action_url: Rails.application.routes.url_helpers.account_path(pay_later.account),
        icon: config[:icon]
      )
    end

    def all_paid_congratulations
      return nil unless pay_later.installments.unpaid.empty? && pay_later.installments.any?

      config = NOTIFICATION_CONFIG[:all_paid_congratulations]

      create_notification(
        title: interpolate_template(config[:title_template], provider: pay_later.provider_name || "PayLater"),
        message: interpolate_template(config[:message_template], provider: pay_later.provider_name || "PayLater"),
        priority: config[:priority],
        action_url: Rails.application.routes.url_helpers.account_path(pay_later.account),
        icon: config[:icon]
      )
    end

    def check_and_send_reminders
      notifications = []

      # Check for upcoming payments
      upcoming_notification = upcoming_payment_reminder
      notifications << upcoming_notification if upcoming_notification

      # Check for overdue payments
      overdue_notification = overdue_payment_reminder
      notifications << overdue_notification if overdue_notification

      # Check credit limit warning
      credit_warning = credit_limit_warning
      notifications << credit_warning if credit_warning

      # Check account expiry warning
      expiry_warning = account_expiry_warning
      notifications << expiry_warning if expiry_warning

      # Check if all paid
      all_paid = all_paid_congratulations
      notifications << all_paid if all_paid

      notifications.compact
    end

    private

      def find_upcoming_payment_config(days_until_due)
        NOTIFICATION_CONFIG[:upcoming_payment].find do |range_or_value, config|
          range_or_value === days_until_due
        end&.last
      end

      def interpolate_template(template_key, variables = {})
        # This would normally use I18n translation system
        # For now, return a basic template with variable substitution
        template = extract_default_template(template_key)

        variables.inject(template) do |result, (key, value)|
          formatted_value = format_value(value)
          result.gsub("%{#{key}}", formatted_value.to_s)
        end
      end

      def format_value(value)
        case value
        when Money
          value.format
        when BigDecimal, Float
          Money.new(value, pay_later.account.currency).format
        else
          value
        end
      end

      def extract_default_template(template_key)
        case template_key
        when "pay_later.notifications.upcoming_payment.due_today.title"
          "PayLater Payment Due Today"
        when "pay_later.notifications.upcoming_payment.due_today.message"
          "Your PayLater installment is due today. Please make the payment to avoid late fees."
        when "pay_later.notifications.upcoming_payment.due_soon.title"
          "PayLater Payment Due Soon"
        when "pay_later.notifications.upcoming_payment.due_soon.message"
          "Your PayLater installment is due in %{days} days."
        when "pay_later.notifications.upcoming_payment.reminder.title"
          "PayLater Payment Reminder"
        when "pay_later.notifications.upcoming_payment.reminder.message"
          "Your PayLater installment is due in %{days} days."
        when "pay_later.notifications.overdue_payment.title"
          "Overdue PayLater Payment"
        when "pay_later.notifications.overdue_payment.message"
          "You have %{count} overdue installment(s). Please pay to avoid additional late fees."
        when "pay_later.notifications.payment_confirmation.title"
          "Payment Received"
        when "pay_later.notifications.payment_confirmation.message"
          "Your PayLater payment of %{amount} has been recorded for %{count} installment(s)."
        when "pay_later.notifications.purchase_recorded.title"
          "Purchase Recorded"
        when "pay_later.notifications.purchase_recorded.message"
          "Your purchase at %{merchant} for %{amount} with %{tenor} months installment has been recorded."
        when "pay_later.notifications.credit_limit_warning.title"
          "Credit Limit Warning"
        when "pay_later.notifications.credit_limit_warning.message"
          "You have used %{utilization}% of your PayLater credit limit. Available: %{available}"
        when "pay_later.notifications.account_expiry_warning.title"
          "Account Expiring Soon"
        when "pay_later.notifications.account_expiry_warning.message"
          "Your PayLater account will expire in %{days} days on %{date}."
        when "pay_later.notifications.all_paid_congratulations.title"
          "All Paid! 🎉"
        when "pay_later.notifications.all_paid_congratulations.message"
          "Congratulations! You have successfully paid off all your %{provider} installments."
        else
          template_key.humanize
        end
      end

      def create_notification(title:, message:, priority:, action_url:, icon:)
        {
          title: title,
          message: message,
          priority: priority,
          action_url: action_url,
          icon: icon,
          created_at: Time.current,
          pay_later_id: pay_later.id,
          account_id: pay_later.account.id
        }
      end
  end
end
