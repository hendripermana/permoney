# frozen_string_literal: true

class Loan::CalculatorService
  attr_reader :principal, :rate, :term_months, :payment_frequency, :schedule_method, :currency

  def initialize(loan_or_params)
    if loan_or_params.is_a?(::Loan)
        initialize_from_loan(loan_or_params)
      else
        initialize_from_params(loan_or_params)
      end
    end

    # Calculate monthly payment amount
    def monthly_payment
      return Money.new(0, currency) if principal.zero? || term_months.zero?

      case schedule_method
      when "ANNUITY"
        calculate_annuity_payment
      when "LINEAR"
        calculate_linear_payment
      when "BALLOON"
        calculate_balloon_payment
      else
        calculate_annuity_payment
      end
    end

    # Generate complete amortization schedule
    def amortization_schedule
      return [] if principal.zero? || term_months.zero?

      schedule = []
      remaining_balance = principal
      payment_amount = monthly_payment

      (1..term_months).each do |month|
        interest_amount = calculate_interest(remaining_balance)
        principal_payment = payment_amount - interest_amount

        # Adjust last payment for rounding
        if month == term_months
          principal_payment = remaining_balance
          payment_amount = principal_payment + interest_amount
        end

        remaining_balance -= principal_payment

        schedule << {
          payment_number: month,
          payment_date: Date.current + month.months,
          payment_amount: payment_amount,
          principal_payment: principal_payment,
          interest_payment: interest_amount,
          remaining_balance: [ remaining_balance, Money.new(0, currency) ].max
        }
      end

      schedule
    end

    # Calculate total interest over loan term
    def total_interest
      amortization_schedule.sum { |payment| payment[:interest_payment] }
    end

    # Calculate total amount to be paid
    def total_payment
      amortization_schedule.sum { |payment| payment[:payment_amount] }
    end

    # Calculate effective APR
    def effective_apr
      return 0.0 if rate.zero?

      case payment_frequency
      when "MONTHLY"
        ((1 + rate / 100.0 / 12) ** 12 - 1) * 100
      when "QUARTERLY"
        ((1 + rate / 100.0 / 4) ** 4 - 1) * 100
      when "SEMI_ANNUALLY"
        ((1 + rate / 100.0 / 2) ** 2 - 1) * 100
      when "ANNUALLY"
        rate
      else
        rate
      end
    end

    # Calculate loan affordability based on income
    def affordability_check(monthly_income, debt_to_income_ratio: 0.4)
      return { affordable: false, reason: "No income specified" } if monthly_income.zero?

      max_payment = monthly_income * debt_to_income_ratio
      payment = monthly_payment

      if payment <= max_payment
        {
          affordable: true,
          payment: payment,
          max_payment: max_payment,
          debt_to_income: (payment / monthly_income * 100).round(2)
        }
      else
        {
          affordable: false,
          payment: payment,
          max_payment: max_payment,
          debt_to_income: (payment / monthly_income * 100).round(2),
          reason: "Payment exceeds recommended debt-to-income ratio"
        }
      end
    end

    # Calculate early payoff scenarios
    def early_payoff_scenarios(extra_payment: Money.new(0, currency))
      regular_schedule = amortization_schedule
      accelerated_schedule = calculate_accelerated_schedule(extra_payment)

      {
        regular: {
          term_months: term_months,
          total_interest: total_interest,
          total_payment: total_payment
        },
        accelerated: {
          term_months: accelerated_schedule.size,
          total_interest: accelerated_schedule.sum { |p| p[:interest_payment] },
          total_payment: accelerated_schedule.sum { |p| p[:payment_amount] },
          months_saved: term_months - accelerated_schedule.size,
          interest_saved: total_interest - accelerated_schedule.sum { |p| p[:interest_payment] }
        }
      }
    end

    # Compare different loan scenarios
    def self.compare_loans(loans)
      loans.map do |loan_params|
        calculator = new(loan_params)
        {
          principal: calculator.principal,
          rate: calculator.rate,
          term_months: calculator.term_months,
          monthly_payment: calculator.monthly_payment,
          total_interest: calculator.total_interest,
          total_payment: calculator.total_payment,
          effective_apr: calculator.effective_apr
        }
      end
    end

    private

      def initialize_from_loan(loan)
        @principal = loan.principal_amount_money || Money.new(0, loan.account&.currency || "USD")
        @rate = loan.effective_rate || 0
        @term_months = loan.term_months || 0
        @payment_frequency = loan.payment_frequency || "MONTHLY"
        @schedule_method = loan.schedule_method || "ANNUITY"
        @currency = loan.account&.currency || "USD"
      end

      def initialize_from_params(params)
        @principal = Money.new(params[:principal] || 0, params[:currency] || "USD")
        @rate = params[:rate] || 0
        @term_months = params[:term_months] || 0
        @payment_frequency = params[:payment_frequency] || "MONTHLY"
        @schedule_method = params[:schedule_method] || "ANNUITY"
        @currency = params[:currency] || "USD"
      end

      def calculate_annuity_payment
        return principal / term_months if rate.zero?

        monthly_rate = rate / 100.0 / 12
        payment = principal * (monthly_rate * (1 + monthly_rate) ** term_months) /
                  ((1 + monthly_rate) ** term_months - 1)

        Money.new(payment.round, currency)
      end

      def calculate_linear_payment
        principal_payment = principal / term_months
        first_month_interest = calculate_interest(principal)
        principal_payment + first_month_interest
      end

      def calculate_balloon_payment
        # For balloon loans, typically only interest is paid monthly
        calculate_interest(principal)
      end

      def calculate_interest(balance)
        monthly_rate = rate / 100.0 / 12
        Money.new((balance.amount * monthly_rate).round, currency)
      end

      def calculate_accelerated_schedule(extra_payment)
        schedule = []
        remaining_balance = principal
        payment_amount = monthly_payment + extra_payment
        month = 0

        while remaining_balance > Money.new(0, currency) && month < term_months * 2
          month += 1
          interest_amount = calculate_interest(remaining_balance)
          principal_payment = payment_amount - interest_amount

          if principal_payment >= remaining_balance
            principal_payment = remaining_balance
            payment_amount = principal_payment + interest_amount
          end

          remaining_balance -= principal_payment

          schedule << {
            payment_number: month,
            payment_date: Date.current + month.months,
            payment_amount: payment_amount,
            principal_payment: principal_payment,
            interest_payment: interest_amount,
            remaining_balance: [ remaining_balance, Money.new(0, currency) ].max
          }

          break if remaining_balance.zero?
        end

        schedule
      end
end
