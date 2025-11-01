class Loan < ApplicationRecord
  include Accountable
  include AuditableChanges
  include Loan::Payable
  include Loan::Providable
  include Loan::IslamicFinance

  SUBTYPES = {
    "loan_personal" => { short: "Borrowed (Person)", long: "Loan Borrowed from Person" },
    "loan_institution" => { short: "Borrowed (Institution)", long: "Loan Borrowed from Institution" },
    "mortgage" => { short: "Mortgage", long: "Mortgage" },
    "student" => { short: "Student", long: "Student Loan" },
    "auto" => { short: "Auto", long: "Auto Loan" },
    "pinjol" => { short: "Pinjol", long: "Indonesian Fintech Loan" },
    "p2p_lending" => { short: "P2P Lending", long: "Peer-to-Peer Lending" },
    "other" => { short: "Other", long: "Other Loan" }
  }.freeze

  COMPLIANCE_TYPES = {
    "conventional" => { short: "Conventional", long: "Conventional Banking" },
    "sharia" => { short: "Sharia", long: "Islamic Banking" }
  }.freeze

  ISLAMIC_PRODUCT_TYPES = {
    "murabaha" => { short: "Murabaha", long: "Cost-Plus Financing" },
    "musyarakah" => { short: "Musyarakah", long: "Partnership Financing" },
    "mudharabah" => { short: "Mudharabah", long: "Profit-Sharing Investment" },
    "ijarah" => { short: "Ijarah", long: "Islamic Leasing" },
    "qard_hasan" => { short: "Qard Hasan", long: "Benevolent Loan" }
  }.freeze

  FINTECH_TYPES = {
    "bank" => { short: "Bank", long: "Traditional Bank" },
    "pinjol" => { short: "Pinjol", long: "Indonesian Online Lending" },
    "p2p_lending" => { short: "P2P", long: "Peer-to-Peer Lending" },
    "cooperative" => { short: "Cooperative", long: "Credit Cooperative" }
  }.freeze

  store_accessor :extra, :balloon_amount, :interest_free, :relationship

  # Virtual attribute used only during origination flow
  attr_accessor :imported

  # Basic validations for new metadata (kept permissive for backward compatibility)
  validates :debt_kind, inclusion: { in: %w[institutional personal] }, allow_nil: true
  validates :counterparty_type, inclusion: { in: %w[institution person] }, allow_nil: true
  validates :counterparty_name, length: { maximum: 255 }, allow_nil: true

  # New metadata validations (permissive; all nullable, enums validated if present)
  PAYMENT_FREQUENCIES = %w[WEEKLY BIWEEKLY MONTHLY QUARTERLY SEMI_ANNUALLY ANNUALLY].freeze
  SCHEDULE_METHODS = %w[ANNUITY FLAT EFFECTIVE BULLET BALLOON].freeze
  INSTITUTION_TYPES = %w[BANK COOPERATIVE CREDIT_UNION FINTECH OTHER].freeze
  PRODUCT_TYPES = %w[MULTIGUNA UNSECURED SECURED OTHER].freeze
  validates :payment_frequency, inclusion: { in: PAYMENT_FREQUENCIES }, allow_nil: true
  validates :schedule_method, inclusion: { in: SCHEDULE_METHODS }, allow_nil: true
  validates :institution_type, inclusion: { in: INSTITUTION_TYPES }, allow_nil: true
  validates :product_type, inclusion: { in: PRODUCT_TYPES }, allow_nil: true
  validates :balloon_amount, numericality: { greater_than_or_equal_to: 0 }, allow_nil: true

  # Sharia compliance validations
  validates :compliance_type, inclusion: { in: COMPLIANCE_TYPES.keys }, allow_nil: true
  validates :islamic_product_type, inclusion: { in: ISLAMIC_PRODUCT_TYPES.keys }, allow_nil: true
  validates :fintech_type, inclusion: { in: FINTECH_TYPES.keys }, allow_nil: true
  validates :profit_sharing_ratio, numericality: { greater_than: 0, less_than_or_equal_to: 1 }, allow_nil: true
  validates :margin_rate, numericality: { greater_than_or_equal_to: 0 }, allow_nil: true

  # Custom validations for Islamic finance
  validate :sharia_compliance_rules
  validate :islamic_product_consistency
  validate :personal_lender_presence
  validate :loan_terms_validity

  track_changes_for :principal_amount, :rate_or_profit, :tenor_months, :institution_type, :lender_name, :schedule_method, :payment_frequency, :start_date, :balloon_amount, :interest_free, :relationship

  after_initialize :set_defaults, if: :new_record?
  before_validation :synchronize_term_and_tenor
  before_validation :apply_interest_preferences
  before_validation :default_principal_amount

  # Public methods for loan type checking
  def personal_loan?
    debt_kind == "personal" || counterparty_type == "person"
  end

  def borrowing_from_person?
    personal_loan? && counterparty_name.present?
  end

  def lending_to_person?
    personal_loan? && lending_out?
  end

  def rate_label
    if compliance_type == "sharia"
      islamic_product_type == "qard_hasan" ? "Interest-Free" : "Profit Margin"
    elsif interest_free?
      "Interest-Free"
    else
      "Interest Rate"
    end
  end

  private

    def set_defaults
      # Initialize extra field if not present
      self.extra ||= {}

      # Set default loan type to personal if not specified
      self.debt_kind ||= "personal"
      self.counterparty_type ||= "person"

      # Set default payment frequency to monthly
      self.payment_frequency ||= "MONTHLY"

      # Set default schedule method to annuity
      self.schedule_method ||= "ANNUITY"

      # Set default compliance type to conventional
      self.compliance_type ||= "conventional"

      # Set default start date to next month
      self.start_date ||= Date.current.next_month

      # Set default origination date to today
      self.origination_date ||= Date.current
    end

    # Validate loan terms are reasonable
    def loan_terms_validity
      return if term_months.blank?

      if term_months.to_i > 600 # More than 50 years
        errors.add(:term_months, "cannot exceed 600 months (50 years)")
      end

      if term_months.to_i < 1
        errors.add(:term_months, "must be at least 1 month")
      end

      if rate_or_profit.present? && rate_or_profit.to_f > 100
        errors.add(:rate_or_profit, "cannot exceed 100%")
      end

      if interest_rate.present? && interest_rate.to_f > 100
        errors.add(:interest_rate, "cannot exceed 100%")
      end

      if margin_rate.present? && margin_rate.to_f > 100
        errors.add(:margin_rate, "cannot exceed 100%")
      end
    end

    def monthly_payment
      return nil if term_months.blank? || term_months.to_i <= 0

      # Use principal_amount if available, otherwise use account's original balance
      principal = if principal_amount.present?
        BigDecimal(principal_amount.to_s)
      elsif account&.loan&.original_balance&.amount.present?
        account.loan.original_balance.amount
      else
        return nil
      end

      return Money.new(0, account&.currency || "USD") if principal.nil? || principal.zero?

      return sharia_monthly_payment if sharia_compliant?

      # Use enhanced payment calculator
      calculator = PaymentCalculator.new(
        loan: self,
        principal_amount: principal,
        rate_or_profit: effective_rate,
        tenor_months: term_months,
        start_date: Date.current,
        payment_frequency: "MONTHLY",
        schedule_method: "ANNUITY"
      )

      schedule = calculator.calculate_installments
      return nil if schedule.empty?

      # Return the first installment payment as monthly payment
      currency = account&.currency || "USD"
      Money.new(schedule.first[:total_amount], currency)
    end


    # Calculate monthly payment for Sharia-compliant loans
    def sharia_monthly_payment
      # Use principal_amount if available, otherwise use account's original balance
      principal = if principal_amount.present?
        BigDecimal(principal_amount.to_s)
      elsif account&.loan&.original_balance&.amount.present?
        account.loan.original_balance.amount
      else
        return nil
      end

      return Money.new(0, account&.currency || "USD") if principal.nil? || principal.zero?

      case islamic_product_type
      when "murabaha"
        # Murabaha: fixed margin spread over term
        return nil unless margin_rate && term_months

        total_amount = principal.to_d * (1 + margin_rate.to_d / 100)
        payment = total_amount / term_months
        Money.new(payment.round, account&.currency || "USD")
      when "qard_hasan"
        # Qard Hasan: no additional cost, just principal
        payment = principal.to_d / term_months
        Money.new(payment.round, account&.currency || "USD")
      when "musyarakah", "mudharabah"
        # Profit-sharing: payment varies based on actual profits
        # Return estimated payment based on principal only
        payment = principal.to_d / term_months
        Money.new(payment.round, account&.currency || "USD")
      else
        # Default to principal-only payment
        payment = principal.to_d / term_months
        Money.new(payment.round, account&.currency || "USD")
      end
    end

    public :monthly_payment, :sharia_monthly_payment

    # Check if this is a Sharia-compliant loan
    def sharia_compliant?
      compliance_type == "sharia"
    end

    # Check if this is a fintech/pinjol loan
    def fintech_loan?
      fintech_type.in?(%w[pinjol p2p_lending])
    end

    # Get the effective rate (interest or margin)
    def effective_rate
      if sharia_compliant? && margin_rate.present?
        margin_rate
      elsif interest_rate.present?
        interest_rate
      else
        0
      end
    end


    # Check if this is a personal loan (from/to individual)


    # Get the relationship context for personal loans
    def personal_loan_context
      return nil unless personal_loan?

      if counterparty_name.present?
        if sharia_compliant?
          "#{islamic_product_type&.humanize || 'Syariah-compliant'} loan #{debt_kind == 'personal' ? 'from' : 'to'} #{counterparty_name}"
        else
          "Personal loan #{debt_kind == 'personal' ? 'from' : 'to'} #{counterparty_name}"
        end
      else
        "Personal loan"
      end
    end

    def original_balance
      # Prefer initial_balance column if present, fallback to first valuation amount
      base_amount = if initial_balance.present?
        initial_balance
      else
        account.first_valuation_amount
      end
      Money.new(base_amount, account.currency)
    end
    public :original_balance

    # Compute remaining principal from ledger postings
    # Moved to Loan::Payable concern
    # def remaining_principal
    #   Loan::RemainingPrincipalCalculator.new(account).remaining_principal
    # end

    # def remaining_principal_money
    #   Loan::RemainingPrincipalCalculator.new(account).remaining_principal_money
    # end


    # Explicit accessor methods for store_accessor fields
    def balloon_amount
      raw = super()
      return if raw.blank?

      BigDecimal(raw.to_s)
    rescue ArgumentError
      nil
    end

    def balloon_amount=(value)
      return super(nil) if value.blank?

      decimal = BigDecimal(value.to_s)
      super(decimal.to_s)
    rescue ArgumentError
      super(nil)
      errors.add(:balloon_amount, "is not a number")
    end

    public :balloon_amount, :balloon_amount=

    class << self
      def normalize_rate(value)
        return 0.to_d if value.blank?

        decimal = value.to_d
        decimal <= 1 ? decimal : (decimal / 100)
      end

      def color
        "#D444F1"
      end

      def icon
        "hand-coins"
      end

      def classification
        "liability"
      end

      # Initialize provider integrations
      def register_providers!
        super if defined?(super)
      end
    end

    # Enhanced payment calculation service
    class PaymentCalculator
      attr_reader :loan, :principal_amount, :rate_or_profit, :tenor_months, :start_date, :payment_frequency, :schedule_method, :balloon_amount

      def initialize(loan:, principal_amount: nil, rate_or_profit: nil, tenor_months: nil, start_date: nil, payment_frequency: nil, schedule_method: nil, balloon_amount: nil)
        @loan = loan
        @principal_amount = coerce_decimal(principal_amount) || coerce_decimal(loan.principal_amount) || loan.account.balance.abs
        @rate_or_profit = coerce_decimal(rate_or_profit) || loan.effective_rate
        @tenor_months = coerce_integer(tenor_months) || coerce_integer(loan.tenor_months) || coerce_integer(loan.term_months) || LoanConfigurationService.default_tenor_months
        @start_date = start_date.presence || loan.start_date || Date.current
        @payment_frequency = (payment_frequency.presence || loan.payment_frequency.presence || LoanConfigurationService.default_payment_frequency).to_s
        @schedule_method = (schedule_method.presence || loan.schedule_method.presence || LoanConfigurationService.default_schedule_method).to_s
        @balloon_amount = coerce_decimal(balloon_amount) || coerce_decimal(loan.balloon_amount) || 0

        validate_inputs!
      end

      def self.frequency_label(frequency)
        LoanConfigurationService.payment_frequency_label(frequency)
      end

      def self.method_label(method)
        LoanConfigurationService.schedule_method_label(method)
      end

      def calculate_installments
        schedule_method_config = LoanConfigurationService.schedule_method_config(schedule_method)
        return [] unless schedule_method_config

        calculation_type = schedule_method_config[:calculation_type]&.to_sym || :annuity

        case calculation_type
        when :annuity
          calculate_annuity_schedule
        when :flat
          calculate_flat_schedule
        when :effective
          calculate_effective_schedule
        when :bullet
          calculate_bullet_schedule
        when :balloon
          calculate_balloon_schedule
        else
          calculate_annuity_schedule
        end
      end

      def validate_inputs!
        unless LoanConfigurationService.supported_payment_frequencies.include?(payment_frequency)
          raise ArgumentError, "Unsupported payment frequency: #{payment_frequency}. Supported: #{LoanConfigurationService.supported_payment_frequencies.join(', ')}"
        end

        unless LoanConfigurationService.supported_schedule_methods.include?(schedule_method)
          raise ArgumentError, "Unsupported schedule method: #{schedule_method}. Supported: #{LoanConfigurationService.supported_schedule_methods.join(', ')}"
        end

        unless principal_amount.to_d > 0
          raise ArgumentError, "Principal amount must be positive"
        end

        unless tenor_months.between?(LoanConfigurationService.min_tenor_months, LoanConfigurationService.max_tenor_months)
          raise ArgumentError, "Tenor months must be between #{LoanConfigurationService.min_tenor_months} and #{LoanConfigurationService.max_tenor_months}"
        end
      end

      private

        def coerce_decimal(value)
          return nil if value.blank?
          BigDecimal(value.to_s)
        rescue ArgumentError
          nil
        end

        def coerce_integer(value)
          return nil if value.blank?
          value.to_i
        end

        def calculate_annuity_schedule
          return [] if principal_amount <= 0 || tenor_months <= 0

          frequency_config = LoanConfigurationService.payment_frequency_config(payment_frequency)
          months_interval = frequency_config&.dig(:months_interval).to_i
          months_interval = 1 if months_interval <= 0

          # Convert annual rate to periodic rate based on frequency
          periodic_rate = rate_or_profit.to_f / 100 / 12 * months_interval

          if periodic_rate.zero?
            # Interest-free loan
            periodic_payment = principal_amount / tenor_months
            create_interest_free_installments(periodic_payment, months_interval)
          else
            # Standard annuity formula
            periodic_payment = calculate_annuity_payment(periodic_rate)

            installments = []
            remaining_principal = principal_amount
            current_date = start_date

            tenor_months.times do |i|
              interest_amount = remaining_principal * periodic_rate
              principal_portion = [ periodic_payment - interest_amount, remaining_principal ].min

              # Handle balloon payment on last installment
              if i == tenor_months - 1 && balloon_amount > 0
                principal_portion = remaining_principal - balloon_amount
              end

              remaining_principal -= principal_portion

              installments << {
                installment_no: i + 1,
                due_date: current_date,
                principal_amount: principal_portion,
                interest_amount: interest_amount,
                total_amount: principal_portion + interest_amount
              }

              current_date = advance_date(current_date, months_interval)
            end

            installments
          end
        end

        def calculate_flat_schedule
          return [] if principal_amount <= 0 || tenor_months <= 0

          frequency_config = LoanConfigurationService.payment_frequency_config(payment_frequency)
          months_interval = frequency_config[:months_interval]

          # Flat rate: equal principal + interest on remaining balance
          periodic_principal = principal_amount / tenor_months
          periodic_rate = rate_or_profit.to_f / 100 / 12 * months_interval

          installments = []
          remaining_principal = principal_amount
          current_date = start_date

          tenor_months.times do |i|
            interest_amount = remaining_principal * periodic_rate
            total_amount = periodic_principal + interest_amount

            remaining_principal -= periodic_principal

            installments << {
              installment_no: i + 1,
              due_date: current_date,
              principal_amount: periodic_principal,
              interest_amount: interest_amount,
              total_amount: total_amount
            }

            current_date = advance_date(current_date, months_interval)
          end

          installments
        end

        def calculate_effective_schedule
          return [] if principal_amount <= 0 || tenor_months <= 0

          frequency_config = LoanConfigurationService.payment_frequency_config(payment_frequency)
          months_interval = frequency_config[:months_interval]

          # Effective rate: compound interest calculation
          periodic_rate = (1 + rate_or_profit.to_f / 100) ** (months_interval / 12) - 1

          periodic_payment = calculate_annuity_payment(periodic_rate)

          installments = []
          remaining_principal = principal_amount
          current_date = start_date

          tenor_months.times do |i|
            interest_amount = remaining_principal * periodic_rate
            principal_portion = periodic_payment - interest_amount
            principal_portion = [ principal_portion, remaining_principal ].min

            remaining_principal -= principal_portion

            installments << {
              installment_no: i + 1,
              due_date: current_date,
              principal_amount: principal_portion,
              interest_amount: interest_amount,
              total_amount: periodic_payment
            }

            current_date = advance_date(current_date, months_interval)
          end

          installments
        end

        def calculate_bullet_schedule
          return [] if principal_amount <= 0 || tenor_months <= 0

          # Bullet payment: only interest payments, full principal at end
          frequency_config = LoanConfigurationService.payment_frequency_config(payment_frequency)
          months_interval = frequency_config[:months_interval]
          periodic_rate = rate_or_profit.to_f / 100 / 12 * months_interval

          installments = []
          remaining_principal = principal_amount
          current_date = start_date

          tenor_months.times do |i|
            interest_amount = remaining_principal * periodic_rate
            principal_amount = i == tenor_months - 1 ? remaining_principal : 0

            remaining_principal -= principal_amount

            installments << {
              installment_no: i + 1,
              due_date: current_date,
              principal_amount: principal_amount,
              interest_amount: interest_amount,
              total_amount: principal_amount + interest_amount
            }

            current_date = advance_date(current_date, months_interval)
          end

          installments
        end

        def calculate_balloon_schedule
          return [] if principal_amount <= 0 || tenor_months <= 0

          # Balloon payment: small regular payments + large final payment
          frequency_config = LoanConfigurationService.payment_frequency_config(payment_frequency)
          months_interval = frequency_config[:months_interval]
          periodic_rate = rate_or_profit.to_f / 100 / 12 * months_interval

          regular_principal = (principal_amount - balloon_amount) / (tenor_months - 1)

          installments = []
          remaining_principal = principal_amount
          current_date = start_date

          tenor_months.times do |i|
            interest_amount = remaining_principal * periodic_rate

            if i == tenor_months - 1
              # Final balloon payment
              principal_portion = remaining_principal
            else
              principal_portion = regular_principal
            end

            remaining_principal -= principal_portion

            installments << {
              installment_no: i + 1,
              due_date: current_date,
              principal_amount: principal_portion,
              interest_amount: interest_amount,
              total_amount: principal_portion + interest_amount
            }

            current_date = advance_date(current_date, months_interval)
          end

          installments
        end

        def calculate_annuity_payment(periodic_rate)
          if periodic_rate.zero?
            principal_amount / tenor_months
          else
            principal_amount * (periodic_rate * (1 + periodic_rate) ** tenor_months) / ((1 + periodic_rate) ** tenor_months - 1)
          end
        end

        def create_installments(interest_amount, principal_amount, months_interval = 1)
          installments = []
          current_date = start_date

          tenor_months.times do |i|
            installments << {
              installment_no: i + 1,
              due_date: current_date,
              principal_amount: principal_amount,
              interest_amount: interest_amount,
              total_amount: principal_amount + interest_amount
            }

            current_date = advance_date(current_date, months_interval)
          end

          installments
        end

        def create_interest_free_installments(principal_amount, months_interval = 1)
          installments = []
          current_date = start_date

          tenor_months.times do |i|
            installments << {
              installment_no: i + 1,
              due_date: current_date,
              principal_amount: principal_amount,
              interest_amount: 0,
              total_amount: principal_amount
            }

            current_date = advance_date(current_date, months_interval)
          end

          installments
        end

        def advance_date(date, months_interval = 1)
          case payment_frequency
          when "WEEKLY"
            date + (7 * (months_interval * 4.33).round).days
          when "BIWEEKLY"
            date + (14 * (months_interval * 2.17).round).days
          when "MONTHLY", "QUARTERLY", "SEMI_ANNUALLY", "ANNUALLY"
            date + (months_interval * 30.44).round.days # Average days per month interval
          else
            date + months_interval.months
          end
        end
    end

    # Enhanced payment processor for complex payment scenarios
    class PaymentProcessor
      attr_reader :loan, :amount, :from_account, :date, :notes

      def initialize(loan:, amount:, from_account:, date: Date.current, notes: nil)
        @loan = loan
        @amount = amount.to_d
        @from_account = from_account
        @date = date
        @notes = notes
      end

      def process
        # Strategy pattern: determine payment strategy
        strategy = determine_payment_strategy
        strategy.process
      end

      private

        def determine_payment_strategy
          pending_installment = loan.next_pending_installment

          if pending_installment && exact_installment_match?(pending_installment)
            PaymentStrategies::ExactInstallmentMatch.new(
              loan: loan,
              installment: pending_installment,
              amount: amount,
              from_account: from_account,
              date: date,
              notes: notes
            )
          elsif pending_installment && partial_installment_match?(pending_installment)
            PaymentStrategies::PartialInstallmentMatch.new(
              loan: loan,
              installment: pending_installment,
              amount: amount,
              from_account: from_account,
              date: date,
              notes: notes
            )
          elsif extra_payment?
            PaymentStrategies::ExtraPayment.new(
              loan: loan,
              amount: amount,
              from_account: from_account,
              date: date,
              notes: notes
            )
          else
            PaymentStrategies::GeneralPayment.new(
              loan: loan,
              amount: amount,
              from_account: from_account,
              date: date,
              notes: notes
            )
          end
        end

        def exact_installment_match?(installment)
          (installment.total_amount.to_d - amount).abs < 0.01
        end

        def partial_installment_match?(installment)
          amount > 0 && amount < installment.total_amount.to_d
        end

        def extra_payment?
          # Extra payment if amount is larger than next installment or no pending installments
          pending_installment = loan.next_pending_installment
          return true if pending_installment.nil?

          amount > pending_installment.total_amount.to_d
        end

        # Payment strategy classes
        module PaymentStrategies
          class BaseStrategy
            attr_reader :loan, :amount, :from_account, :date, :notes

            def initialize(loan:, amount:, from_account:, date:, notes:)
              @loan = loan
              @amount = amount
              @from_account = from_account
              @date = date
              @notes = notes
            end

            def process
              raise NotImplementedError, "Subclasses must implement process method"
            end

            protected

              def create_payment_transfer(amount, notes = nil)
                transfer = Transfer::Creator.new(
                  family: Current.family,
                  source_account_id: from_account.id,
                  destination_account_id: loan.account.id,
                  date: date,
                  amount: amount
                ).create

                if transfer.persisted?
                  contextual_notes = build_payment_notes(notes)
                  transfer.update!(notes: contextual_notes)
                  loan.sync_accounts!(from_account)
                end

                transfer
              end

              def build_payment_notes(user_notes)
                base_note = if loan.personal_loan? && loan.counterparty_name.present?
                  context = loan.sharia_compliant? ? "(Syariah compliant)" : ""
                  "Repayment to #{loan.counterparty_name} #{context}".strip
                else
                  "Loan payment"
                end

                user_notes.present? ? "#{base_note} — #{user_notes}" : base_note
              end
          end

          class ExactInstallmentMatch < BaseStrategy
            attr_reader :installment

            def initialize(loan:, installment:, amount:, from_account:, date:, notes:)
              super(loan: loan, amount: amount, from_account: from_account, date: date, notes: notes)
              @installment = installment
            end

            def process
              ActiveRecord::Base.transaction do
                installment.with_lock do
                  return if installment.posted? # Double-check after lock

                  principal_amount = installment.principal_amount.to_d
                  interest_amount = installment.interest_amount.to_d

                  # Create principal transfer
                  if principal_amount.positive?
                    create_principal_transfer(principal_amount)
                  end

                  # Create interest expense entry
                  if interest_amount.positive?
                    create_interest_expense(interest_amount)
                  end

                  # Mark installment as posted
                  installment.update!(
                    status: "posted",
                    posted_on: date,
                    actual_amount: amount
                  )

                  # Send payment confirmation notification
                  loan.notification_service.payment_confirmation(amount)
                end
              end
            end

            private

              def create_principal_transfer(amount)
                Transfer::Creator.new(
                  family: Current.family,
                  source_account_id: from_account.id,
                  destination_account_id: loan.account.id,
                  date: date,
                  amount: amount
                ).create
              end

              def create_interest_expense(amount)
                interest_money = Money.new(amount, loan.account.currency)
                converted_interest = interest_money.exchange_to(
                  from_account.currency,
                  date: date,
                  fallback_rate: 1.0
                )

                entry = from_account.entries.create!(
                  date: date,
                  name: interest_expense_name,
                  amount: converted_interest.amount,
                  currency: from_account.currency,
                  entryable: Transaction.new(kind: interest_transaction_kind)
                )

                # Set appropriate category
                category_key = loan.sharia_compliant? ? "system:islamic_profit_expense" : "system:interest_expense"
                category = CategoryResolver.ensure_system_category(Current.family, category_key)
                entry.entryable.set_category!(category)

                entry
              end

              def interest_expense_name
                base = loan.sharia_compliant? ? "Profit portion of installment" : "Interest portion of installment"
                "#{base} — #{loan.account.name}"
              end

              def interest_transaction_kind
                loan.sharia_compliant? ? "margin_payment" : "loan_payment"
              end
          end

          class PartialInstallmentMatch < BaseStrategy
            attr_reader :installment

            def initialize(loan:, installment:, amount:, from_account:, date:, notes:)
              super(loan: loan, amount: amount, from_account: from_account, date: date, notes: notes)
              @installment = installment
            end

            def process
              ActiveRecord::Base.transaction do
                installment.with_lock do
                  return if installment.posted?

                  # Calculate how much goes to principal vs interest
                  principal_portion, interest_portion = calculate_portions

                  # Create payment transfer
                  create_payment_transfer(amount, notes)

                  # Update installment with partial payment
                  installment.update!(
                    status: "partially_paid",
                    paid_principal: installment.paid_principal.to_d + principal_portion,
                    paid_interest: installment.paid_interest.to_d + interest_portion,
                    last_payment_date: date
                  )

                  # Send partial payment notification
                  loan.notification_service.payment_confirmation(amount)
                end
              end
            end

            private

              def calculate_portions
                # For partial payments, maintain the original ratio
                ratio = amount / installment.total_amount.to_d

                principal_portion = installment.principal_amount.to_d * ratio
                interest_portion = installment.interest_amount.to_d * ratio

                [ principal_portion, interest_portion ]
              end
          end

          class ExtraPayment < BaseStrategy
            def process
              # Extra payments go entirely to principal
              create_payment_transfer(amount, "Extra principal payment — #{notes}")

              # Update loan balance
              loan.account.sync_later

              # Send extra payment notification
              loan.notification_service.payment_confirmation(amount)
            end
          end

          class GeneralPayment < BaseStrategy
            def process
              # General payment - apply to outstanding balance
              create_payment_transfer(amount, notes)

              # Check if this covers any pending installments
              process_pending_installments if loan.next_pending_installment

              # Send payment confirmation
              loan.notification_service.payment_confirmation(amount)
            end

            private

              def process_pending_installments
                pending_installment = loan.next_pending_installment

                if amount >= pending_installment.total_amount.to_d
                  # Process as installment payment
                  ExactInstallmentMatch.new(
                    loan: loan,
                    installment: pending_installment,
                    amount: pending_installment.total_amount.to_d,
                    from_account: from_account,
                    date: date,
                    notes: "Installment payment"
                  ).process

                  # Handle remaining amount as extra payment
                  remaining_amount = amount - pending_installment.total_amount.to_d
                  if remaining_amount > 0
                    ExtraPayment.new(
                      loan: loan,
                      amount: remaining_amount,
                      from_account: from_account,
                      date: date,
                      notes: "Extra payment"
                    ).process
                  end
                else
                  # Process as partial payment
                  PartialInstallmentMatch.new(
                    loan: loan,
                    installment: pending_installment,
                    amount: amount,
                    from_account: from_account,
                    date: date,
                    notes: "Partial installment payment"
                  ).process
                end
              end
          end
        end
    end

  private

    # Validate Sharia compliance rules
    def sharia_compliance_rules
      return unless compliance_type == "sharia"

      # Sharia loans cannot have conventional interest
      if interest_rate.present? && interest_rate > 0
        errors.add(:interest_rate, "cannot be set for Sharia-compliant loans")
      end

      # Must have Islamic product type if Sharia compliant
      if islamic_product_type.blank?
        errors.add(:islamic_product_type, "must be specified for Sharia-compliant loans")
      end

      # Validate specific Islamic product requirements
      case islamic_product_type
      when "murabaha"
        if margin_rate.blank?
          errors.add(:margin_rate, "must be specified for Murabaha financing")
        end
      when "musyarakah", "mudharabah"
        if profit_sharing_ratio.blank?
          errors.add(:profit_sharing_ratio, "must be specified for profit-sharing arrangements")
        end
      end
    end

    # Validate consistency between Islamic product types and other fields
    def islamic_product_consistency
      return unless islamic_product_type.present?

      # Only Sharia loans can have Islamic product types
      if compliance_type != "sharia"
        errors.add(:islamic_product_type, "can only be set for Sharia-compliant loans")
      end

      # Qard Hasan should not have margin or profit sharing
      if islamic_product_type == "qard_hasan"
        if margin_rate.present? && margin_rate > 0
          errors.add(:margin_rate, "cannot be set for Qard Hasan (benevolent loan)")
        end
        if profit_sharing_ratio.present?
          errors.add(:profit_sharing_ratio, "cannot be set for Qard Hasan")
        end
      end
    end

    def personal_lender_presence
      return unless personal_loan?
      if linked_contact_id.blank? && (counterparty_name.blank? && lender_name.blank?)
        errors.add(:base, "Provide a contact or lender name for personal loans")
      end
    end

    def synchronize_term_and_tenor
      if term_months.blank? && tenor_months.present?
        self.term_months = tenor_months
      elsif tenor_months.blank? && term_months.present?
        self.tenor_months = term_months
      end
    end

    def apply_interest_preferences
      if ActiveModel::Type::Boolean.new.cast(extra_value_for("interest_free"))
        self.interest_rate = nil
        self.rate_or_profit = nil
        self.margin_rate = nil
        self.profit_sharing_ratio = nil
      end
    end

    def default_principal_amount
      return if principal_amount.present?
      return if initial_balance.blank?

      self.principal_amount = BigDecimal(initial_balance.to_s)
    rescue ArgumentError
      self.principal_amount = nil
    end

    def extra_value_for(key)
      (self.extra || {})[key]
    end

    def assign_extra_value(key, value)
      payload = (self.extra || {}).dup
      if value.nil? || (value.respond_to?(:empty?) && value.empty?)
        payload.delete(key)
      else
        payload[key] = value
      end
      self.extra = payload
    end
end

# Loan notification and reminder system
class NotificationService
  # Notification configuration - easily extensible
  NOTIFICATION_CONFIG = {
    upcoming_payment: {
      0 => {
        title_template: "loan.notifications.upcoming_payment.due_today.title",
        message_template: "loan.notifications.upcoming_payment.due_today.message",
        priority: :urgent,
        icon: "calendar-exclamation"
      },
      1..3 => {
        title_template: "loan.notifications.upcoming_payment.due_soon.title",
        message_template: "loan.notifications.upcoming_payment.due_soon.message",
        priority: :high,
        icon: "calendar-clock"
      },
      4..7 => {
        title_template: "loan.notifications.upcoming_payment.reminder.title",
        message_template: "loan.notifications.upcoming_payment.reminder.message",
        priority: :medium,
        icon: "calendar"
      }
    },
    overdue_payment: {
      title_template: "loan.notifications.overdue_payment.title",
      message_template: "loan.notifications.overdue_payment.message",
      priority: :urgent,
      icon: "alert-triangle"
    },
    payment_confirmation: {
      title_template: "loan.notifications.payment_confirmation.title",
      message_template: "loan.notifications.payment_confirmation.message",
      priority: :info,
      icon: "check-circle"
    },
    loan_fully_paid: {
      title_template: "loan.notifications.loan_fully_paid.title",
      message_template: "loan.notifications.loan_fully_paid.message",
      priority: :success,
      icon: "party-popper"
    }
  }.freeze

  # Notification timing configuration
  REMINDER_DAYS = {
    urgent: 0,
    high: 1..3,
    medium: 4..7
  }.freeze

  attr_reader :loan

  def initialize(loan)
    @loan = loan
  end

  def upcoming_payment_reminder
    next_installment = loan.next_pending_installment
    return nil unless next_installment

    days_until_due = (next_installment.due_date - Date.current).to_i
    config = find_upcoming_payment_config(days_until_due)

    return nil unless config

    create_notification(
      title: interpolate_template(config[:title_template], installment: next_installment, days: days_until_due),
      message: interpolate_template(config[:message_template], installment: next_installment, days: days_until_due),
      priority: config[:priority],
      action_url: Rails.application.routes.url_helpers.new_payment_loan_path(loan.account),
      icon: config[:icon]
    )
  end

  def overdue_payment_reminder
    overdue_installments = loan.loan_installments.where("due_date < ? AND status = ?", Date.current, "planned")
    return nil if overdue_installments.none?

    total_overdue = overdue_installments.sum(:total_amount)
    days_overdue = (Date.current - overdue_installments.first.due_date).to_i
    config = NOTIFICATION_CONFIG[:overdue_payment]

    create_notification(
      title: interpolate_template(config[:title_template], installments: overdue_installments, total: total_overdue, days: days_overdue),
      message: interpolate_template(config[:message_template], installments: overdue_installments, total: total_overdue, days: days_overdue),
      priority: config[:priority],
      action_url: Rails.application.routes.url_helpers.new_payment_loan_path(loan.account),
      icon: config[:icon]
    )
  end

  def payment_confirmation(payment_amount)
    config = NOTIFICATION_CONFIG[:payment_confirmation]

    create_notification(
      title: interpolate_template(config[:title_template], amount: payment_amount),
      message: interpolate_template(config[:message_template], amount: payment_amount),
      priority: config[:priority],
      action_url: Rails.application.routes.url_helpers.account_path(loan.account),
      icon: config[:icon]
    )
  end

  def loan_fully_paid
    config = NOTIFICATION_CONFIG[:loan_fully_paid]

    create_notification(
      title: interpolate_template(config[:title_template], loan_name: loan.account.name),
      message: interpolate_template(config[:message_template], loan_name: loan.account.name),
      priority: config[:priority],
      action_url: Rails.application.routes.url_helpers.account_path(loan.account),
      icon: config[:icon]
    )
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
      template = I18n.t(template_key, default: extract_default_template(template_key))

      variables.inject(template) do |result, (key, value)|
        result.gsub("%{#{key}}", value.to_s)
      end
    end

    def extract_default_template(template_key)
      case template_key
      when "loan.notifications.upcoming_payment.due_today.title"
        "Loan Payment Due Today"
      when "loan.notifications.upcoming_payment.due_today.message"
        "Your loan payment of %{amount} is due today."
      when "loan.notifications.upcoming_payment.due_soon.title"
        "Loan Payment Due Soon"
      when "loan.notifications.upcoming_payment.due_soon.message"
        "Your loan payment of %{amount} is due in %{days} days."
      when "loan.notifications.upcoming_payment.reminder.title"
        "Loan Payment Reminder"
      when "loan.notifications.upcoming_payment.reminder.message"
        "Your loan payment of %{amount} is due in %{days} days."
      when "loan.notifications.overdue_payment.title"
        "Overdue Loan Payment"
      when "loan.notifications.overdue_payment.message"
        "You have %{count} overdue loan payment(s) totaling %{total}. %{days} days overdue."
      when "loan.notifications.payment_confirmation.title"
        "Payment Recorded"
      when "loan.notifications.payment_confirmation.message"
        "Your loan payment of %{amount} has been recorded successfully."
      when "loan.notifications.loan_fully_paid.title"
        "Loan Fully Paid!"
      when "loan.notifications.loan_fully_paid.message"
        "Congratulations! You have successfully paid off your %{loan_name} loan."
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
        loan_id: loan.id,
        account_id: loan.account_id
      }
    end

    def format_money(amount)
      Money.new(amount, loan.account.currency).format
    end
end

# Ensure notification helpers are available as instance methods on Loan
class Loan
  def notification_service
    @notification_service ||= NotificationService.new(self)
  end

  # Check and send reminder notifications
  def check_and_send_reminders
    notifications = []

    # Check for upcoming payments
    upcoming_notification = notification_service.upcoming_payment_reminder
    notifications << upcoming_notification if upcoming_notification

    # Check for overdue payments
    overdue_notification = notification_service.overdue_payment_reminder
    notifications << overdue_notification if overdue_notification

    notifications.compact
  end

  # Send notification when loan is fully paid
  def check_fully_paid_status
    if fully_paid? && !@was_fully_paid
      notification_service.loan_fully_paid
      @was_fully_paid = true
    end
  end

  # Explicit relationship methods for form handling
  def relationship
    extra_value_for("relationship")
  end

  def relationship=(value)
    assign_extra_value("relationship", value)
  end

  # Explicit interest_free methods for form handling
  def interest_free
    ActiveModel::Type::Boolean.new.cast(extra_value_for("interest_free"))
  end

  def interest_free=(value)
    assign_extra_value("interest_free", ActiveModel::Type::Boolean.new.cast(value))
  end

  def interest_free?
    ActiveModel::Type::Boolean.new.cast(extra_value_for("interest_free"))
  end

  # Explicit sharia_compliant? method for form handling
  def sharia_compliant?
    compliance_type == "sharia"
  end

  # Explicit imported? method for form handling
  def imported?
    imported || account&.import&.present?
  end
end
