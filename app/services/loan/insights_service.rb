# frozen_string_literal: true

module Loan
  class InsightsService
    attr_reader :user, :family

    def initialize(user_or_family)
      if user_or_family.is_a?(User)
        @user = user_or_family
        @family = user_or_family.family
      else
        @family = user_or_family
        @user = nil
      end
    end

    # Get comprehensive loan portfolio overview
    def portfolio_overview
      loans = family.accounts.joins(:loan).where.not(loans: { id: nil })

      {
        total_loans: loans.count,
        total_debt: calculate_total_debt(loans),
        monthly_payments: calculate_monthly_payments(loans),
        by_type: loans_by_type(loans),
        by_status: loans_by_status(loans),
        health_score: calculate_health_score(loans),
        recommendations: generate_recommendations(loans)
      }
    end

    # Analyze individual loan performance
    def loan_analysis(loan)
      calculator = CalculatorService.new(loan)

      {
        loan_details: {
          type: loan.debt_kind,
          counterparty: loan.counterparty_name,
          principal: loan.principal_amount_money,
          rate: loan.effective_rate,
          term: loan.term_months
        },
        payment_info: {
          monthly_payment: calculator.monthly_payment,
          total_interest: calculator.total_interest,
          total_payment: calculator.total_payment,
          effective_apr: calculator.effective_apr
        },
        progress: calculate_loan_progress(loan),
        early_payoff: calculator.early_payoff_scenarios(
          extra_payment: Money.new(100_00, loan.account.currency)
        ),
        refinance_opportunity: check_refinance_opportunity(loan)
      }
    end

    # Get payment calendar for all loans
    def payment_calendar(months_ahead: 12)
      loans = family.accounts.joins(:loan).where.not(loans: { id: nil })
      calendar = {}

      loans.each do |account|
        loan = account.loan
        next unless loan.active?

        calculator = CalculatorService.new(loan)
        schedule = calculator.amortization_schedule.first(months_ahead)

        schedule.each do |payment|
          date_key = payment[:payment_date].to_s
          calendar[date_key] ||= []
          calendar[date_key] << {
            loan_id: loan.id,
            loan_name: account.name,
            payment_amount: payment[:payment_amount],
            principal: payment[:principal_payment],
            interest: payment[:interest_payment]
          }
        end
      end

      calendar.sort.to_h
    end

    # Debt snowball vs avalanche comparison
    def debt_optimization_strategies
      loans = family.accounts.joins(:loan)
                    .where.not(loans: { id: nil })
                    .where(loans: { status: "active" })

      {
        snowball: calculate_snowball_strategy(loans),
        avalanche: calculate_avalanche_strategy(loans),
        recommendation: recommend_strategy(loans)
      }
    end

    # Check for refinancing opportunities
    def refinancing_opportunities
      loans = family.accounts.joins(:loan)
                    .where.not(loans: { id: nil })
                    .where(loans: { status: "active" })

      opportunities = []

      loans.each do |account|
        loan = account.loan
        opportunity = check_refinance_opportunity(loan)
        opportunities << opportunity if opportunity[:worth_refinancing]
      end

      opportunities
    end

    # Islamic finance compliance check
    def sharia_compliance_report
      loans = family.accounts.joins(:loan).where.not(loans: { id: nil })

      {
        compliant_loans: loans.where(loans: { compliance_type: "sharia" }).count,
        conventional_loans: loans.where(loans: { compliance_type: "conventional" }).count,
        total_sharia_value: loans.where(loans: { compliance_type: "sharia" })
                                  .sum { |a| a.loan.principal_amount_money },
        recommendations: generate_sharia_recommendations(loans)
      }
    end

    private

      def calculate_total_debt(loans)
        loans.sum do |account|
          account.balance || Money.new(0, account.currency)
        end
      end

      def calculate_monthly_payments(loans)
        loans.sum do |account|
          loan = account.loan
          next Money.new(0, account.currency) unless loan.active?

          CalculatorService.new(loan).monthly_payment
        end
      end

      def loans_by_type(loans)
        loans.group_by { |a| a.loan.debt_kind }
             .transform_values(&:count)
      end

      def loans_by_status(loans)
        loans.group_by { |a| a.loan.status }
             .transform_values(&:count)
      end

      def calculate_health_score(loans)
        return 100 if loans.empty?

        score = 100
        total_income = family.monthly_income || Money.new(100000_00, "USD")

        # Debt-to-income ratio (40% weight)
        monthly_payments = calculate_monthly_payments(loans)
        dti_ratio = monthly_payments / total_income
        score -= (dti_ratio * 40).clamp(0, 40)

        # Number of loans (20% weight)
        loan_count_penalty = [ loans.count - 3, 0 ].max * 5
        score -= loan_count_penalty.clamp(0, 20)

        # High interest loans (20% weight)
        high_interest_loans = loans.select { |a| a.loan.effective_rate > 15 }
        score -= (high_interest_loans.count * 10).clamp(0, 20)

        # Payment history (20% weight) - placeholder for actual payment tracking
        score -= 0 # Would check for late payments

        score.clamp(0, 100)
      end

      def generate_recommendations(loans)
        recommendations = []

        # Check debt-to-income ratio
        monthly_payments = calculate_monthly_payments(loans)
        total_income = family.monthly_income || Money.new(100000_00, "USD")
        dti_ratio = monthly_payments / total_income

        if dti_ratio > 0.4
          recommendations << {
            type: "warning",
            title: "High Debt-to-Income Ratio",
            description: "Your debt payments exceed 40% of income. Consider debt reduction strategies.",
            action: "View debt reduction options"
          }
        end

        # Check for high interest loans
        high_interest_loans = loans.select { |a| a.loan.effective_rate > 15 }
        if high_interest_loans.any?
          recommendations << {
            type: "opportunity",
            title: "High Interest Loans Detected",
            description: "You have #{high_interest_loans.count} loans with rates above 15%. Consider refinancing.",
            action: "Check refinancing options"
          }
        end

        # Suggest debt optimization
        if loans.count > 2
          recommendations << {
            type: "tip",
            title: "Optimize Debt Repayment",
            description: "With multiple loans, a strategic repayment plan could save you money.",
            action: "View optimization strategies"
          }
        end

        recommendations
      end

      def calculate_loan_progress(loan)
        return 0 unless loan.term_months && loan.term_months > 0

        start_date = loan.origination_date || loan.created_at.to_date
        months_elapsed = ((Date.current - start_date) / 30.0).round

        progress = (months_elapsed.to_f / loan.term_months * 100).round(2)
        progress.clamp(0, 100)
      end

      def check_refinance_opportunity(loan)
        current_rate = loan.effective_rate
        market_rate = get_market_rate_for_loan_type(loan.debt_kind)

        potential_savings = Money.new(0, loan.account.currency)
        worth_refinancing = false

        if current_rate > market_rate + 1.0 # At least 1% difference
          calculator = CalculatorService.new(loan)
          current_total_interest = calculator.total_interest

          new_calculator = CalculatorService.new({
            principal: loan.principal_amount_money,
            rate: market_rate,
            term_months: loan.term_months,
            currency: loan.account.currency
          })
          new_total_interest = new_calculator.total_interest

          potential_savings = current_total_interest - new_total_interest
          worth_refinancing = potential_savings > Money.new(1000_00, loan.account.currency)
        end

        {
          loan_id: loan.id,
          current_rate: current_rate,
          market_rate: market_rate,
          potential_savings: potential_savings,
          worth_refinancing: worth_refinancing
        }
      end

      def get_market_rate_for_loan_type(loan_type)
        # This would typically fetch from an external API or database
        # For now, return reasonable defaults
        case loan_type
        when "personal"
          8.5
        when "mortgage"
          6.5
        when "auto"
          5.5
        when "student"
          4.5
        else
          10.0
        end
      end

      def calculate_snowball_strategy(loans)
        # Pay minimum on all, then extra on smallest balance
        sorted_loans = loans.sort_by { |a| a.balance.amount }
        calculate_payoff_strategy(sorted_loans, "Smallest balance first")
      end

      def calculate_avalanche_strategy(loans)
        # Pay minimum on all, then extra on highest interest rate
        sorted_loans = loans.sort_by { |a| -a.loan.effective_rate }
        calculate_payoff_strategy(sorted_loans, "Highest interest rate first")
      end

      def calculate_payoff_strategy(sorted_loans, strategy_name)
        total_months = 0
        total_interest = Money.new(0, "USD")
        payoff_order = []

        sorted_loans.each do |account|
          loan = account.loan
          calculator = CalculatorService.new(loan)

          payoff_order << {
            loan_name: account.name,
            balance: account.balance,
            rate: loan.effective_rate,
            monthly_payment: calculator.monthly_payment
          }

          total_months = [ total_months, loan.term_months ].max
          total_interest += calculator.total_interest
        end

        {
          strategy: strategy_name,
          payoff_order: payoff_order,
          estimated_months: total_months,
          total_interest: total_interest
        }
      end

      def recommend_strategy(loans)
        return "No loans to optimize" if loans.empty?
        return "Single loan - focus on extra payments" if loans.count == 1

        snowball = calculate_snowball_strategy(loans)
        avalanche = calculate_avalanche_strategy(loans)

        if avalanche[:total_interest] < snowball[:total_interest] * 0.9
          "Avalanche method recommended - saves #{avalanche[:total_interest] - snowball[:total_interest]}"
        else
          "Snowball method recommended for psychological wins"
        end
      end

      def generate_sharia_recommendations(loans)
        recommendations = []

        conventional_loans = loans.where(loans: { compliance_type: "conventional" })
        if conventional_loans.any?
          recommendations << {
            type: "info",
            title: "Conventional Loans Detected",
            description: "You have #{conventional_loans.count} conventional loans. Consider Sharia-compliant alternatives.",
            action: "Explore Islamic finance options"
          }
        end

        recommendations
      end
  end
end
