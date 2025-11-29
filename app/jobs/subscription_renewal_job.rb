class SubscriptionRenewalJob < ApplicationJob
  queue_as :high_priority

  # Retry strategy for failed jobs
  retry_on ActiveRecord::Deadlocked, wait: :exponentially_longer, attempts: 5
  retry_on ActiveRecord::LockWaitTimeout, wait: :exponentially_longer, attempts: 3
  retry_on ActiveRecord::ConnectionNotEstablished, wait: 2.seconds, attempts: 3
  retry_on Redis::ConnectionError, wait: 2.seconds, attempts: 3

  # Handle record not found gracefully
  discard_on ActiveRecord::RecordNotFound

  def perform(date = Date.current)
    Rails.logger.info("Starting subscription renewals for #{date}")

    # Process renewals for the specified date
    process_renewals_for_date(date)

    # Send renewal reminders
    send_renewal_reminders(date)

    # Process trial expirations
    process_trial_expirations(date)

    # Process subscription expirations
    process_subscription_expirations(date)

    Rails.logger.info("Completed subscription renewals for #{date}")
  end

  private

    def process_renewals_for_date(date)
      Rails.logger.info("Processing renewals for #{date}")

      # Find subscriptions renewing today
      subscriptions_renewing = SubscriptionPlan.active.where(next_billing_at: date)

      subscriptions_renewing.find_each do |subscription|
        process_subscription_renewal(subscription, date)
      end

      Rails.logger.info("Processed #{subscriptions_renewing.count} renewals for #{date}")
    end

    def process_subscription_renewal(subscription, date)
      Rails.logger.info("Processing renewal for subscription #{subscription.id} (#{subscription.name})")

      begin
        if subscription.auto_renewal_enabled?
          if subscription.payment_method_auto?
            # Process Stripe payment
            process_stripe_renewal(subscription)
          else
            # Manual renewal - just mark as renewed
            subscription.mark_as_renewed!
            create_manual_transaction(subscription)
          end
        else
          # Auto-renew disabled - mark as expired if past due
          if subscription.cancelled?
            subscription.expire!
          else
            # Send renewal reminder
            SubscriptionMailer.renewal_reminder(subscription).deliver_later
          end
        end

        Rails.logger.info("Successfully processed renewal for subscription #{subscription.id}")

      rescue => e
        Rails.logger.error("Failed to process renewal for subscription #{subscription.id}: #{e.message}")
        handle_renewal_failure(subscription, e)
      end
    end

    def process_stripe_renewal(subscription)
      return unless subscription.stripe_subscription_id.present?

      begin
        # Check subscription status with Stripe
        stripe_subscription = Stripe::Subscription.retrieve(subscription.stripe_subscription_id)

        if stripe_subscription.status == "active"
          # Subscription is still active, just update next billing date
          subscription.mark_as_renewed!

          # Create transaction for accounting
          create_stripe_transaction(subscription, stripe_subscription)

          # Send confirmation email
          SubscriptionMailer.renewal_confirmation(subscription).deliver_later

          Rails.logger.info("Stripe subscription #{subscription.id} renewed successfully")
        else
          # Subscription is not active, mark as failed
          subscription.mark_payment_failed!
          SubscriptionMailer.payment_failed(subscription, "Subscription status: #{stripe_subscription.status}").deliver_later

          Rails.logger.warn("Stripe subscription #{subscription.id} has status: #{stripe_subscription.status}")
        end

      rescue Stripe::CardError => e
        # Payment failed
        subscription.mark_payment_failed!
        SubscriptionMailer.payment_failed(subscription, e.message).deliver_later

        Rails.logger.error("Stripe payment failed for subscription #{subscription.id}: #{e.message}")

      rescue Stripe::StripeError => e
        # Other Stripe error
        Rails.logger.error("Stripe error for subscription #{subscription.id}: #{e.message}")
        raise e # Re-raise to trigger retry

      rescue => e
        # Unknown error
        Rails.logger.error("Unknown error processing Stripe renewal for subscription #{subscription.id}: #{e.message}")
        raise e # Re-raise to trigger retry
      end
    end

    def create_stripe_transaction(subscription, stripe_subscription)
      # Create transaction record for the renewal
      transaction = subscription.account.transactions.create!(
        amount: -subscription.amount, # Negative for expense
        currency: subscription.currency,
        date: Date.current,
        description: "Subscription renewal: #{subscription.name}",
        category: Category.find_or_create_by(
          name: "Subscription Fees",
          family: subscription.family,
          classification: "expense"
        ),
        metadata: {
          subscription_id: subscription.id,
          stripe_subscription_id: subscription.stripe_subscription_id,
          stripe_invoice_id: stripe_subscription.latest_invoice&.id
        }
      )

      # Update subscription with transaction reference
      subscription.update!(last_transaction_id: transaction.id)
    end

    def create_manual_transaction(subscription)
      # Create manual transaction for non-Stripe payments
      transaction = subscription.account.transactions.create!(
        amount: -subscription.amount, # Negative for expense
        currency: subscription.currency,
        date: Date.current,
        description: "Manual subscription payment: #{subscription.name}",
        category: Category.find_or_create_by(
          name: "Subscription Fees",
          family: subscription.family,
          classification: "expense"
        ),
        metadata: {
          subscription_id: subscription.id,
          payment_method: subscription.payment_method
        }
      )

      # Update subscription with transaction reference
      subscription.update!(last_transaction_id: transaction.id)
    end

    def handle_renewal_failure(subscription, error)
      # Track failed renewal
      subscription.update!(
        failed_payment_alert_sent: true,
        status: "payment_failed"
      )

      # Send failure notification
      SubscriptionMailer.payment_failed(subscription, error.message).deliver_later

      # Track in analytics
      Sentry.capture_message(
        "Subscription renewal failed",
        level: :error,
        tags: {
          subscription_id: subscription.id,
          family_id: subscription.family.id
        },
        extra: {
          error_message: error.message,
          subscription_details: {
            name: subscription.name,
            amount: subscription.amount,
            billing_cycle: subscription.billing_cycle
          }
        }
      )
    end

    def send_renewal_reminders(date)
      Rails.logger.info("Sending renewal reminders for #{date}")

      # Send reminders for upcoming renewals (3 days, 1 day)
      [ 3, 1 ].each do |days_ahead|
        reminder_date = date + days_ahead.days
        subscriptions_reminded = 0

        SubscriptionPlan.active.where(next_billing_at: reminder_date).find_each do |subscription|
          # Only send reminder if not already sent for this cycle
          unless subscription.metadata&.dig("reminder_sent_for_cycle", reminder_date.to_s)
            SubscriptionMailer.renewal_reminder(subscription, days_ahead).deliver_later

            # Track that reminder was sent
            subscription.update_column(
              :metadata,
              (subscription.metadata || {}).deep_merge(
                "reminder_sent_for_cycle" => { reminder_date.to_s => true }
              )
            )

            subscriptions_reminded += 1
          end
        end

        Rails.logger.info("Sent #{subscriptions_reminded} renewal reminders for #{days_ahead} days ahead")
      end
    end

    def process_trial_expirations(date)
      Rails.logger.info("Processing trial expirations for #{date}")

      # Find trials ending today
      trials_ending = SubscriptionPlan.trial.where(trial_ends_at: date)

      trials_ending.find_each do |subscription|
        if subscription.auto_renewal_enabled?
          # Convert trial to active subscription
          subscription.resume!
          Rails.logger.info("Converted trial to active: #{subscription.id}")
        else
          # Trial ended, subscription should be cancelled
          subscription.cancel!
          Rails.logger.info("Cancelled expired trial: #{subscription.id}")
        end
      end
    end

    def process_subscription_expirations(date)
      Rails.logger.info("Processing subscription expirations for #{date}")

      # Find subscriptions that should expire today
      subscriptions_to_expire = SubscriptionPlan.where(
        status: "cancelled",
        expires_at: date
      )

      subscriptions_to_expire.find_each do |subscription|
        subscription.expire!
        Rails.logger.info("Expired subscription: #{subscription.id}")
      end
    end
end
