require "test_helper"

class LoanPostInstallmentObservabilityTest < ActiveSupport::TestCase
  setup do
    @family = families(:dylan_family)
    @loan = accounts(:loan)
    @cash = accounts(:depository)
    LoanInstallment.create!(
      account_id: @loan.id,
      installment_no: 3,
      due_date: Date.current + 1,
      status: "planned",
      principal_amount: 1000,
      interest_amount: 0,
      total_amount: 1000
    )
  end
  test "fires notifications and Sentry spans when available" do
    events = []
    sub = ActiveSupport::Notifications.subscribe("permoney.loan.installment.posted") { |*args| events << ActiveSupport::Notifications::Event.new(*args) }

    # Provide a minimal Sentry shim if not present
    unless defined?(::Sentry)
      Object.const_set(:Sentry, Module.new)
    end
    ::Sentry.singleton_class.class_eval do
      attr_accessor :span_called
      def with_child_span(op:, description: nil, **_kwargs)
        self.span_called = true
        span = Object.new
        span.define_singleton_method(:set_data) { |_k, _v| }
        span.define_singleton_method(:set_description) { |_desc| }
        yield span
      end
      def add_breadcrumb(*)
      end
      def configure_scope
        scope = Object.new
        scope.define_singleton_method(:set_transaction_name) { |_name| }
        yield scope
      end
      def get_current_scope
        scope = Object.new
        scope.define_singleton_method(:set_transaction_name) { |_name| }
        tx = Object.new
        tx.define_singleton_method(:set_measurement) { |_name, _value, _unit| }
        scope.define_singleton_method(:get_transaction) { tx }
        scope
      end
    end

    ::Sentry.span_called = false
    result = Loan::PostInstallment.new(
      family: @family,
      account_id: @loan.id,
      source_account_id: @cash.id,
      date: Date.current
    ).call!

    assert result.success?
    assert events.any?, "expected instrumentation event"
    assert ::Sentry.respond_to?(:span_called) && ::Sentry.span_called, "expected Sentry span to be called"
  ensure
    ActiveSupport::Notifications.unsubscribe(sub) if sub
  end
end
