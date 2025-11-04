module PayLaterHelpers
  class ScheduleGenerator
    attr_reader :pay_later, :purchase_amount, :tenor_months, :purchase_date, :category

    def initialize(pay_later:, purchase_amount:, tenor_months:, purchase_date: Date.current, category: "default")
      @pay_later = pay_later
      @purchase_amount = purchase_amount.to_d
      @tenor_months = tenor_months.to_i
      @purchase_date = purchase_date
      @category = category.to_s

      validate_inputs!
    end

    def generate
      return [] if purchase_amount <= 0 || tenor_months <= 0

      # Get interest rate for this tenor and category
      interest_rate = pay_later.interest_rate_for_tenor(tenor_months, category: category)

      # Generate installments based on interest calculation method
      if pay_later.sharia_compliant?
        generate_sharia_installments(interest_rate)
      elsif pay_later.is_compound
        generate_compound_installments(interest_rate)
      else
        generate_flat_installments(interest_rate)
      end
    end

    private

      def validate_inputs!
        raise ArgumentError, "Purchase amount must be positive" unless purchase_amount > 0
        raise ArgumentError, "Tenor months must be positive" unless tenor_months > 0
        raise ArgumentError, "Tenor months exceeds maximum allowed" if tenor_months > (pay_later.max_tenor || 60)
      end

      # Generate flat interest installments (most common for BNPL)
      # Interest is calculated on original principal and distributed evenly
      def generate_flat_installments(annual_rate)
        monthly_rate = annual_rate / 12.0
        total_interest = purchase_amount * monthly_rate * tenor_months

        # Apply free interest months discount
        if pay_later.free_interest_months > 0 && tenor_months <= pay_later.free_interest_months
          total_interest = 0
        elsif pay_later.free_interest_months > 0
          # Reduce interest proportionally
          charged_months = tenor_months - pay_later.free_interest_months
          total_interest = purchase_amount * monthly_rate * charged_months
        end

        # Calculate per-installment amounts
        principal_per_installment = purchase_amount / tenor_months
        interest_per_installment = total_interest / tenor_months
        total_per_installment = principal_per_installment + interest_per_installment

        installments = []
        current_date = calculate_first_due_date

        tenor_months.times do |i|
          installments << {
            installment_no: i + 1,
            due_date: current_date,
            principal_amount: principal_per_installment,
            interest_amount: interest_per_installment,
            fee_amount: 0,
            total_due: total_per_installment,
            total_cost: total_per_installment,
            status: "pending",
            applied_rate: monthly_rate
          }

          current_date = advance_date(current_date, 1)
        end

        installments
      end

      # Generate compound interest installments (annuity method)
      # Similar to loan amortization
      def generate_compound_installments(annual_rate)
        monthly_rate = annual_rate / 12.0

        # Check free interest months
        if pay_later.free_interest_months > 0 && tenor_months <= pay_later.free_interest_months
          return generate_interest_free_installments
        end

        # Calculate monthly payment using annuity formula
        monthly_payment = if monthly_rate.zero?
          purchase_amount / tenor_months
        else
          (purchase_amount * monthly_rate * (1 + monthly_rate)**tenor_months) /
          ((1 + monthly_rate)**tenor_months - 1)
        end

        installments = []
        remaining_principal = purchase_amount
        current_date = calculate_first_due_date

        tenor_months.times do |i|
          # Apply free interest months
          effective_rate = (i < pay_later.free_interest_months) ? 0 : monthly_rate

          interest_amount = remaining_principal * effective_rate
          principal_amount = monthly_payment - interest_amount
          principal_amount = [ principal_amount, remaining_principal ].min # Last installment adjustment

          installments << {
            installment_no: i + 1,
            due_date: current_date,
            principal_amount: principal_amount,
            interest_amount: interest_amount,
            fee_amount: 0,
            total_due: principal_amount + interest_amount,
            total_cost: principal_amount + interest_amount,
            status: "pending",
            applied_rate: effective_rate
          }

          remaining_principal -= principal_amount
          current_date = advance_date(current_date, 1)
        end

        installments
      end

      # Generate Sharia-compliant installments (Murabaha-based)
      # Fixed markup is calculated and distributed evenly
      def generate_sharia_installments(margin_rate)
        # In Murabaha, the "profit margin" is fixed at the start
        total_amount_with_margin = purchase_amount * (1 + margin_rate * (tenor_months / 12.0))

        # Apply free interest (profit-free) months
        if pay_later.free_interest_months > 0 && tenor_months <= pay_later.free_interest_months
          total_amount_with_margin = purchase_amount # No profit
        elsif pay_later.free_interest_months > 0
          # Reduce profit proportionally
          charged_months = tenor_months - pay_later.free_interest_months
          total_amount_with_margin = purchase_amount * (1 + margin_rate * (charged_months / 12.0))
        end

        total_profit = total_amount_with_margin - purchase_amount
        per_installment = total_amount_with_margin / tenor_months
        principal_per_installment = purchase_amount / tenor_months
        profit_per_installment = total_profit / tenor_months

        installments = []
        current_date = calculate_first_due_date

        tenor_months.times do |i|
          installments << {
            installment_no: i + 1,
            due_date: current_date,
            principal_amount: principal_per_installment,
            interest_amount: profit_per_installment, # Called "profit" in Sharia finance
            fee_amount: 0,
            total_due: per_installment,
            total_cost: per_installment,
            status: "pending",
            applied_rate: margin_rate
          }

          current_date = advance_date(current_date, 1)
        end

        installments
      end

      # Generate interest-free installments
      def generate_interest_free_installments
        per_installment = purchase_amount / tenor_months
        installments = []
        current_date = calculate_first_due_date

        tenor_months.times do |i|
          installments << {
            installment_no: i + 1,
            due_date: current_date,
            principal_amount: per_installment,
            interest_amount: 0,
            fee_amount: 0,
            total_due: per_installment,
            total_cost: per_installment,
            status: "pending",
            applied_rate: 0
          }

          current_date = advance_date(current_date, 1)
        end

        installments
      end

      # Calculate first due date based on purchase date and grace period
      def calculate_first_due_date
        base_date = purchase_date.end_of_month

        # Apply grace days if configured
        if pay_later.grace_days > 0
          base_date + pay_later.grace_days.days
        else
          base_date
        end
      end

      # Advance date by specified months
      def advance_date(date, months)
        date >> months # Ruby's month arithmetic
      end
  end
end
