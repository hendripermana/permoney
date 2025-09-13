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
      def with_child_span(op:, description:)
        self.span_called = true
        span = Struct.new(:set_data).new(proc { |_k, _v| })
        yield span
      end
      def add_breadcrumb(*)
      end
      def configure_scope
        yield Object.new
      end
      def get_current_scope
        Struct.new(:get_transaction).new(Struct.new(:set_measurement).new(proc { |_n, _v, _u| }))
      end
    end

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

