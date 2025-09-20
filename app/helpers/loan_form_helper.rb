# frozen_string_literal: true

module LoanFormHelper
  # Form configuration for loan fields
  # Field configuration with dynamic behavior
  def loan_field_config(field_name, loan:, account: nil, form: nil)
    config = field_configurations(field_name)

    return {} unless config

    # Merge with dynamic values based on current state
    config.merge(
      value: field_value_for(field_name, loan, account),
      data: stimulus_data_for(field_name),
      **conditional_attributes_for(field_name, loan)
    )
  end

  # Dynamic field configurations based on loan type and state
  def field_configurations(field_name = nil)
    @field_configurations ||= build_field_configurations

    field_name ? @field_configurations[field_name] : @field_configurations
  end

  private

  def build_field_configurations
    {
      counterparty_name: {
        label: t("loans.form.counterparty_name.label"),
        placeholder: t("loans.form.counterparty_name.placeholder"),
        required: true
      },
      relationship: {
        label: t("loans.form.relationship.label"),
        placeholder: t("loans.form.relationship.placeholder"),
        required: false
      },
      linked_contact_id: {
        label: t("loans.form.linked_contact_id.label"),
        placeholder: t("loans.form.linked_contact_id.placeholder"),
        required: false
      },
      institution_name: {
        label: t("loans.form.institution_name.label"),
        placeholder: t("loans.form.institution_name.placeholder"),
        required: true
      },
      fintech_type: {
        label: t("loans.form.fintech_type.label"),
        include_blank: t("loans.form.fintech_type.blank"),
        required: false
      },
      institution_type: {
        label: t("loans.form.institution_type.label"),
        include_blank: t("loans.form.institution_type.blank"),
        required: false
      },
      product_type: {
        label: t("loans.form.product_type.label"),
        include_blank: t("loans.form.product_type.blank"),
        required: false
      },
      initial_balance: {
        label: t("loans.form.initial_balance.label"),
        required: true,
        label_tooltip: t("loans.form.initial_balance.tooltip")
      },
      start_date: {
        label: t("loans.form.start_date.label"),
        required: false
      },
      tenor_months: {
        label: t("loans.form.tenor_months.label"),
        placeholder: 12,
        min: 1,
        max: 480
      },
      payment_frequency: {
        label: t("loans.form.payment_frequency.label"),
        required: false
      },
      disbursement_account_id: {
        label: t("loans.form.disbursement_account_id.label"),
        required: false  # Optional for personal loans
      },
      origination_date: {
        label: t("loans.form.origination_date.label"),
        required: false
      },
      interest_free: {
        label: t("loans.form.interest_free.label"),
        required: false
      },
      interest_rate: {
        label: t("loans.form.interest_rate.label"),
        placeholder: "5.25",
        min: 0,
        step: 0.005,
        max: 100
      },
      rate_type: {
        label: t("loans.form.rate_type.label"),
        required: false
      },
      rate_or_profit: {
        label: t("loans.form.rate_or_profit.label"),
        step: 0.001,
        min: 0,
        placeholder: 10,
        max: 100
      },
      islamic_product_type: {
        label: t("loans.form.islamic_product_type.label"),
        include_blank: t("loans.form.islamic_product_type.blank"),
        required: false
      },
      margin_rate: {
        label: t("loans.form.margin_rate.label"),
        placeholder: "3.50",
        min: 0,
        step: 0.005,
        max: 100
      },
      profit_sharing_ratio: {
        label: t("loans.form.profit_sharing_ratio.label"),
        placeholder: "0.60",
        min: 0,
        max: 1,
        step: 0.01
      },
      installment_amount: {
        label: t("loans.form.installment_amount.label"),
        required: false
      },
      schedule_method: {
        label: t("loans.form.schedule_method.label"),
        label_tooltip: t("loans.form.schedule_method.tooltip"),
        required: false
      },
      balloon_amount: {
        label: t("loans.form.balloon_amount.label"),
        required: false
      },
      collateral_desc: {
        label: t("loans.form.collateral_desc.label"),
        rows: 3,
        required: false
      },
      early_repayment_policy: {
        label: t("loans.form.early_repayment_policy.label"),
        rows: 3,
        required: false
      },
      witness_name: {
        label: t("loans.form.witness_name.label"),
        placeholder: t("loans.form.witness_name.placeholder"),
        required: false
      },
      agreement_notes: {
        label: t("loans.form.agreement_notes.label"),
        placeholder: t("loans.form.agreement_notes.placeholder"),
        rows: 3,
        required: false
      },
      notes: {
        label: t("loans.form.notes.label"),
        rows: 3,
        required: false
      }
    }
  end

  # Mode detection helpers
  def loan_personal_mode?(loan)
    loan.debt_kind == "personal" || loan.counterparty_type == "person"
  end

  def loan_institutional_mode?(loan)
    !loan_personal_mode?(loan)
  end

  def loan_conventional_mode?(loan)
    loan.compliance_type != "sharia" && !loan.interest_free?
  end

  def loan_sharia_mode?(loan)
    loan.compliance_type == "sharia"
  end

  def loan_imported?(loan, account)
    loan.imported || account&.import&.present?
  end

  # Islamic product helpers
  def show_margin_field_for_loan?(loan)
    loan.islamic_product_type == "murabaha"
  end

  def show_profit_sharing_field_for_loan?(loan)
    %w[musyarakah mudharabah].include?(loan.islamic_product_type)
  end

  # Feature flag helpers with configuration service
  def loan_preview_enabled?
    LoanConfigurationService.feature_enabled?(:wizard_form)
  end

  def loan_extra_payment_enabled?
    LoanConfigurationService.feature_enabled?(:extra_payments)
  end

  def loan_sharia_compliance_enabled?
    LoanConfigurationService.feature_enabled?(:sharia_compliance)
  end

  def loan_partial_payments_enabled?
    LoanConfigurationService.feature_enabled?(:partial_payments)
  end

  def loan_advanced_calculations_enabled?
    LoanConfigurationService.feature_enabled?(:advanced_calculations)
  end

  def loan_notifications_enabled?
    LoanConfigurationService.feature_enabled?(:notifications)
  end

  # Option builders with extensibility
  def loan_fintech_type_options
    return [] unless defined?(Loan::FINTECH_TYPES)

    Loan::FINTECH_TYPES.map { |key, meta| [meta[:long], key] }
  end

  def loan_institution_type_options
    return [] unless defined?(Loan::INSTITUTION_TYPES)

    Loan::INSTITUTION_TYPES.map { |kind| [kind.titleize, kind] }
  end

  def loan_product_type_options
    return [] unless defined?(Loan::PRODUCT_TYPES)

    Loan::PRODUCT_TYPES.map { |kind| [kind.titleize, kind] }
  end

  def loan_payment_frequency_options
    LoanConfigurationService.payment_frequencies.map do |key, config|
      [config['label'], key]
    end
  end

  def loan_rate_type_options
    [
      [t("loans.form.rate_types.fixed"), "fixed"],
      [t("loans.form.rate_types.variable"), "variable"],
      [t("loans.form.rate_types.adjustable"), "adjustable"]
    ]
  end

  def loan_islamic_product_options
    return [] unless loan_sharia_compliance_enabled?

    [
      [t("loans.form.islamic_products.murabaha"), "murabaha"],
      [t("loans.form.islamic_products.musyarakah"), "musyarakah"],
      [t("loans.form.islamic_products.mudharabah"), "mudharabah"],
      [t("loans.form.islamic_products.ijarah"), "ijarah"],
      [t("loans.form.islamic_products.qard_hasan"), "qard_hasan"]
    ]
  end

  def loan_schedule_method_options
    LoanConfigurationService.schedule_methods.map do |key, config|
      label = t("loans.form.schedule_methods.#{key.downcase}", default: config['label'] || key.to_s.titleize)
      [label, key]
    end
  end

  # Dynamic options with fallback
  def dynamic_field_options(field_type, custom_options = nil)
    case field_type
    when :fintech_type
      custom_options || loan_fintech_type_options
    when :institution_type
      custom_options || loan_institution_type_options
    when :product_type
      custom_options || loan_product_type_options
    when :payment_frequency
      custom_options || loan_payment_frequency_options
    when :rate_type
      custom_options || loan_rate_type_options
    when :islamic_product
      custom_options || loan_islamic_product_options
    when :schedule_method
      custom_options || loan_schedule_method_options
    else
      []
    end
  end

  # Account selection helpers
  def available_disbursement_accounts(family = Current.family)
    family.accounts.assets.active.alphabetically
  end

  def available_payment_source_accounts(family = Current.family, loan_account: nil)
    accounts = family.accounts.manual.active.assets.alphabetically
    accounts = accounts.where.not(id: loan_account.id) if loan_account
    accounts
  end

  # Stimulus data builders
  def loan_form_stimulus_data(account: nil, loan: nil, preview_enabled: false)
    base_data = {
      controller: "loan-form"
    }

    if preview_enabled && account
      preview_path = account.persisted? ?
        schedule_preview_loan_path(account) :
        schedule_preview_loans_path

      base_data.merge!(
        "loan-form-preview-base-href-value": preview_path,
        "loan-form-preview-frame-value": "loan-schedule-preview",
        "loan-form-preview-auto-value": false
      )
    end

    base_data
  end

  # Path helpers
  def loan_schedule_preview_path(account)
    if account&.persisted?
      schedule_preview_loan_path(account)
    else
      schedule_preview_loans_path
    end
  end

  # Validation helpers with configurable bounds
  def loan_rate_within_bounds?(rate, min: nil, max: nil)
    return true if rate.blank?

    min ||= field_configurations(:rate_or_profit)[:min] || 0
    max ||= field_configurations(:rate_or_profit)[:max] || 100

    rate_decimal = rate.to_d
    rate_decimal >= min && rate_decimal <= max
  end

  def loan_tenor_within_bounds?(tenor, min: nil, max: nil)
    return true if tenor.blank?

    min ||= field_configurations(:tenor_months)[:min] || 1
    max ||= field_configurations(:tenor_months)[:max] || 480

    tenor_int = tenor.to_i
    tenor_int >= min && tenor_int <= max
  end

  # Custom validation based on loan type and state
  def validate_loan_field(field_name, value, loan)
    config = field_configurations(field_name)

    return true unless config

    errors = []

    # Required field validation
    if config[:required] && value.blank?
      errors << "#{config[:label]} is required"
    end

    # Numeric validation
    if config[:min] && !value.blank? && value.to_f < config[:min]
      errors << "#{config[:label]} must be at least #{config[:min]}"
    end

    if config[:max] && !value.blank? && value.to_f > config[:max]
      errors << "#{config[:label]} must be at most #{config[:max]}"
    end

    # Special validations based on field type
    case field_name
    when :counterparty_name
      errors << "Counterparty name is required" if value.blank?
    when :initial_balance
      errors << "Initial balance must be positive" if value.to_f <= 0
    when :tenor_months
      errors << "Tenor must be at least 1 month" if value.to_i < 1
    when :interest_rate, :rate_or_profit, :margin_rate
      errors << "Rate must be positive" if value.to_f < 0
    when :profit_sharing_ratio
      errors << "Profit sharing ratio must be between 0 and 1" if value.to_f < 0 || value.to_f > 1
    end

    errors
  end

  # Market rate comparison (when provider integration is available)
  def loan_rate_comparison_text(loan)
    return nil unless defined?(Provider::Registry)
    return nil unless loan.respond_to?(:rate_comparison)

    comparison = loan.rate_comparison
    return nil unless comparison

    case comparison[:comparison]
    when "Significantly below market"
      { text: t("loans.rate_comparison.significantly_below"), class: "text-green-600" }
    when "Below market"
      { text: t("loans.rate_comparison.below"), class: "text-green-500" }
    when "At market rate"
      { text: t("loans.rate_comparison.at_market"), class: "text-blue-600" }
    when "Above market"
      { text: t("loans.rate_comparison.above"), class: "text-yellow-600" }
    when "Significantly above market"
      { text: t("loans.rate_comparison.significantly_above"), class: "text-red-600" }
    else
      nil
    end
  end

  # Formatting helpers with configurable options
  def format_loan_rate(rate, precision: nil)
    return "0%" if rate.blank? || rate.zero?

    precision ||= field_configurations(:interest_rate)[:precision] || 3
    "#{number_with_precision(rate, precision: precision, strip_insignificant_zeros: true)}%"
  end

  def format_loan_amount(amount, currency: nil, precision: nil)
    return "—" if amount.blank?

    currency ||= Current.family&.currency || "USD"
    money = Money.new(amount, currency)

    precision ||= money.currency.minor_units
    humanized_money_with_symbol(money, precision: precision)
  rescue
    number_to_currency(amount)
  end

  def format_loan_term(months, format: :full)
    return "—" if months.blank?

    months = months.to_i
    years = months / 12
    remaining_months = months % 12

    case format
    when :short
      if years > 0 && remaining_months > 0
        "#{years}y #{remaining_months}m"
      elsif years > 0
        "#{years}y"
      else
        "#{remaining_months}m"
      end
    when :years_only
      years > 0 ? "#{years} year#{years > 1 ? 's' : ''}" : "#{remaining_months} month#{remaining_months > 1 ? 's' : ''}"
    else # :full
    parts = []
    parts << t("loans.term.years", count: years) if years > 0
    parts << t("loans.term.months", count: remaining_months) if remaining_months > 0
    parts.join(" ")
    end
  end

  # Dynamic formatting based on field type
  def format_loan_field(field_name, value)
    config = field_configurations(field_name)

    case field_name
    when :interest_rate, :rate_or_profit, :margin_rate
      format_loan_rate(value)
    when :initial_balance, :balloon_amount, :installment_amount
      format_loan_amount(value)
    when :tenor_months
      format_loan_term(value)
    when :profit_sharing_ratio
      return "—" if value.blank?
      number_to_percentage(value, precision: 1)
    else
      value.to_s
    end
  end

  # Helper for generating field-specific CSS classes
  def loan_field_classes(field_name, additional_classes: "")
    config = field_configurations(field_name)
    base_classes = "loan-field loan-field--#{field_name}"

    if config
      base_classes += " loan-field--required" if config[:required]
      base_classes += " loan-field--numeric" if config[:min] || config[:max] || config[:step]
    end

    "#{base_classes} #{additional_classes}".strip
  end

  private

  def build_field_configurations
    base = {
      counterparty_name: {
        label: t("loans.form.counterparty_name.label"),
        placeholder: t("loans.form.counterparty_name.placeholder")
      },
      relationship: {
        label: t("loans.form.relationship.label"),
        placeholder: t("loans.form.relationship.placeholder")
      },
      linked_contact_id: {
        label: t("loans.form.linked_contact_id.label"),
        placeholder: t("loans.form.linked_contact_id.placeholder")
      },
      institution_name: {
        label: t("loans.form.institution_name.label"),
        placeholder: t("loans.form.institution_name.placeholder")
      },
      fintech_type: {
        label: t("loans.form.fintech_type.label"),
        include_blank: t("loans.form.fintech_type.blank")
      },
      institution_type: {
        label: t("loans.form.institution_type.label"),
        include_blank: t("loans.form.institution_type.blank")
      },
      product_type: {
        label: t("loans.form.product_type.label"),
        include_blank: t("loans.form.product_type.blank")
      },
      initial_balance: {
        label: t("loans.form.initial_balance.label"),
        required: true,
        label_tooltip: t("loans.form.initial_balance.tooltip")
      },
      start_date: {
        label: t("loans.form.start_date.label")
      },
      tenor_months: {
        label: t("loans.form.tenor_months.label"),
        placeholder: 12
      },
      payment_frequency: {
        label: t("loans.form.payment_frequency.label")
      },
      disbursement_account_id: {
        label: t("loans.form.disbursement_account_id.label"),
        required: false  # Optional for personal loans
      },
      origination_date: {
        label: t("loans.form.origination_date.label")
      },
      interest_free: {},
      interest_rate: {
        label: t("loans.form.interest_rate.label"),
        placeholder: "5.25",
        min: 0,
        step: 0.005
      },
      rate_type: {
        label: t("loans.form.rate_type.label")
      },
      rate_or_profit: {
        label: t("loans.form.rate_or_profit.label"),
        step: 0.001,
        min: 0,
        placeholder: 10
      },
      islamic_product_type: {
        label: t("loans.form.islamic_product_type.label"),
        include_blank: t("loans.form.islamic_product_type.blank")
      },
      margin_rate: {
        label: t("loans.form.margin_rate.label"),
        placeholder: "3.50",
        min: 0,
        step: 0.005
      },
      profit_sharing_ratio: {
        label: t("loans.form.profit_sharing_ratio.label"),
        placeholder: "0.60",
        min: 0,
        max: 1,
        step: 0.01
      },
      installment_amount: {
        label: t("loans.form.installment_amount.label")
      },
      schedule_method: {
        label: t("loans.form.schedule_method.label"),
        label_tooltip: t("loans.form.schedule_method.tooltip")
      },
      balloon_amount: {
        label: t("loans.form.balloon_amount.label")
      },
      collateral_desc: {
        label: t("loans.form.collateral_desc.label"),
        rows: 3
      },
      early_repayment_policy: {
        label: t("loans.form.early_repayment_policy.label"),
        rows: 3
      },
      witness_name: {
        label: t("loans.form.witness_name.label"),
        placeholder: t("loans.form.witness_name.placeholder")
      },
      agreement_notes: {
        label: t("loans.form.agreement_notes.label"),
        placeholder: t("loans.form.agreement_notes.placeholder"),
        rows: 3
      },
      notes: {
        label: t("loans.form.notes.label"),
        rows: 3
      }
    }

    # Overlay YAML-driven configuration (no hardcode)
    base.keys.each do |field_name|
      yml = LoanConfigurationService.field_config(field_name)
      next if yml.blank?

      cfg = base[field_name].dup
      cfg[:required] = yml['required'] unless yml['required'].nil?
      cfg[:min] = yml['min_value'] if yml['min_value']
      cfg[:max] = yml['max_value'] if yml['max_value']
      cfg[:step] = yml['step'] if yml['step']
      cfg[:precision] = yml['precision'] if yml['precision']

      if yml['placeholder_key']
        cfg[:placeholder] = t(yml['placeholder_key'], default: cfg[:placeholder])
      end

      base[field_name] = cfg
    end

    base
  end

  def field_value_for(field_name, loan, account)
    case field_name
    when :initial_balance
      loan.initial_balance || loan.principal_amount
    when :start_date
      loan.start_date || Date.current.next_month
    when :origination_date
      loan.origination_date || Date.current
    else
      loan.public_send(field_name) if loan.respond_to?(field_name)
    end
  rescue
    nil
  end

  def stimulus_data_for(field_name)
    case field_name
    when :initial_balance, :rate_or_profit, :tenor_months, :payment_frequency,
         :schedule_method, :installment_amount, :balloon_amount
      {
        "loan-form-target": stimulus_target_for(field_name),
        action: "input->loan-form#termsChanged change->loan-form#termsChanged"
      }
    when :start_date
      {
        "loan-form-target": "startDate",
        action: "change->loan-form#termsChanged"
      }
    when :interest_free
      {
        "loan-form-target": "interestFree",
        action: "change->loan-form#onInterestFreeChange"
      }
    when :islamic_product_type
      {
        action: "change->loan-form#onIslamicProductChange"
      }
    else
      {}
    end
  end

  def stimulus_target_for(field_name)
    {
      initial_balance: "principal",
      rate_or_profit: "rateOrProfit",
      tenor_months: "tenor",
      payment_frequency: "frequency",
      schedule_method: "method"
    }[field_name] || field_name.to_s.camelize(:lower)
  end

  def conditional_attributes_for(field_name, loan)
    field_config = field_configurations(field_name)
    return {} unless field_config

    attributes = {}

    # Add currency attributes
    if [:initial_balance, :balloon_amount, :installment_amount].include?(field_name)
      attributes[:default_currency] = Current.family&.currency || "USD"
    end

    # Add required attribute based on configuration and loan type
    if field_config[:required]
      attributes[:required] = true
    end

    # Special handling for disbursement_account_id - required only for institutional loans
    if field_name == :disbursement_account_id
      attributes[:required] = false  # Always make optional in form, validation happens in service
    end

    # Add validation attributes
    if field_config[:min]
      attributes[:min] = field_config[:min]
    end

    if field_config[:max]
      attributes[:max] = field_config[:max]
    end

    if field_config[:step]
      attributes[:step] = field_config[:step]
    end

    # Add HTML attributes
    if field_config[:rows]
      attributes[:rows] = field_config[:rows]
    end

    if field_config[:placeholder]
      attributes[:placeholder] = field_config[:placeholder]
    end

    attributes
  end

  # Extensibility and configuration methods
  def register_custom_field(field_name, config)
    @field_configurations ||= build_field_configurations
    @field_configurations[field_name] = config
  end

  def unregister_field(field_name)
    @field_configurations ||= build_field_configurations
    @field_configurations.delete(field_name)
  end

  def extend_field_config(field_name, additional_config)
    config = field_configurations(field_name) || {}
    register_custom_field(field_name, config.merge(additional_config))
  end

  def customize_validation_rules(field_name, rules)
    config = field_configurations(field_name) || {}
    config[:validation_rules] = rules
    register_custom_field(field_name, config)
  end

  # Field behavior helpers
  def field_supports_frequency?(field_name)
    [:interest_rate, :rate_or_profit, :margin_rate].include?(field_name)
  end

  def field_supports_currency?(field_name)
    [:initial_balance, :balloon_amount, :installment_amount].include?(field_name)
  end

  def field_is_numeric?(field_name)
    config = field_configurations(field_name)
    config && (config[:min] || config[:max] || config[:step])
  end

  def field_has_tooltip?(field_name)
    config = field_configurations(field_name)
    config && config[:label_tooltip]
  end

  # Helper classes for wizard functionality
  class LoanModeHelper
    def t(key, options = {})
      I18n.t(key, **options)
    end

    def sharia_mode?(loan)
      loan.compliance_type == "sharia" || loan.interest_free?
    end
  end

  class LoanImportHelper
    def t(key, options = {})
      I18n.t(key, **options)
    end

    def personal_mode?(loan)
      loan.debt_kind == "personal" || loan.counterparty_type == "person"
    end

    def institutional_mode?(loan)
      !personal_mode?(loan)
    end

    def conventional_mode?(loan)
      loan.compliance_type != "sharia" && !loan.interest_free?
    end

    def sharia_mode?(loan)
      loan.compliance_type == "sharia"
    end
  end

  class LoanImportHelper
    def imported?(loan, account)
      loan.imported || account&.import&.present?
    end
  end

  class IslamicProductHelper
    def t(key, options = {})
      I18n.t(key, **options)
    end

    def show_margin_field?(loan)
      loan.islamic_product_type == "murabaha"
    end

    def show_profit_sharing_field?(loan)
      %w[musyarakah mudharabah].include?(loan.islamic_product_type)
    end
  end

  class LoanFieldConfigHelper
    def t(key, options = {})
      I18n.t(key, **options)
    end

    def config_for(field_name, loan: nil, account: nil, form: nil)
      field_configurations[field_name] || {}
    end
  end

  class LoanStimulusHelper
    def t(key, options = {})
      I18n.t(key, **options)
    end

    def form_data(account: nil, loan: nil, preview_enabled: false)
      base_data = {
        controller: "loan-form"
      }

      if preview_enabled && account
        preview_path = account.persisted? ?
          schedule_preview_loan_path(account) :
          schedule_preview_loans_path

        base_data.merge!(
          "loan-form-preview-base-href-value": preview_path,
          "loan-form-preview-frame-value": "loan-schedule-preview",
          "loan-form-preview-auto-value": false
        )
      end

      base_data
    end
  end

  class LoanOptionsHelper
    def t(key, options = {})
      I18n.t(key, **options)
    end

    def fintech_type_options
      return [] unless defined?(Loan::FINTECH_TYPES)

      Loan::FINTECH_TYPES.map { |key, meta| [meta[:long], key] }
    rescue
      [
        ["Traditional Bank", "bank"],
        ["Indonesian Online Lending", "pinjol"],
        ["Peer-to-Peer Lending", "p2p_lending"],
        ["Credit Cooperative", "cooperative"]
      ]
    end

    def institution_type_options
      return [] unless defined?(Loan::INSTITUTION_TYPES)

      Loan::INSTITUTION_TYPES.map { |kind| [kind.titleize, kind] }
    rescue
      [
        ["Bank", "bank"],
        ["Credit Union", "credit_union"],
        ["Fintech", "fintech"],
        ["Government", "government"]
      ]
    end

    def product_type_options
      return [] unless defined?(Loan::PRODUCT_TYPES)

      Loan::PRODUCT_TYPES.map { |kind| [kind.titleize, kind] }
    rescue
      [
        ["Personal Loan", "personal_loan"],
        ["Business Loan", "business_loan"],
        ["Mortgage", "mortgage"]
      ]
    end

    def payment_frequency_options
      return [] unless defined?(Loan::PAYMENT_FREQUENCIES)

      Loan::PAYMENT_FREQUENCIES.map { |freq| [freq.titleize, freq] }
    rescue
      [
        ["Monthly", "MONTHLY"],
        ["Quarterly", "QUARTERLY"],
        ["Semi-annually", "SEMI_ANNUALLY"],
        ["Annually", "ANNUALLY"]
      ]
    end

    def rate_type_options
      [
        [t("loans.form.rate_types.fixed"), "fixed"],
        [t("loans.form.rate_types.variable"), "variable"],
        [t("loans.form.rate_types.adjustable"), "adjustable"]
      ]
    end

    def islamic_product_options
      [
        [t("loans.form.islamic_products.murabaha"), "murabaha"],
        [t("loans.form.islamic_products.musyarakah"), "musyarakah"],
        [t("loans.form.islamic_products.mudharabah"), "mudharabah"],
        [t("loans.form.islamic_products.ijarah"), "ijarah"],
        [t("loans.form.islamic_products.qard_hasan"), "qard_hasan"]
      ]
    end

    def schedule_method_options
      LoanConfigurationService.schedule_methods.map do |key, config|
        [t("loans.form.schedule_methods.#{key.downcase}", default: config['label'] || key.to_s.titleize), key]
      end
    end
  end

  class AccountSelectionHelper
    def t(key, options = {})
      I18n.t(key, **options)
    end

    def available_accounts_for_disbursement(family = nil)
      return [] unless family

      family.accounts.assets.active.alphabetically
    rescue
      []
    end
  end

  class LoanPathHelper
    def t(key, options = {})
      I18n.t(key, **options)
    end

    def schedule_preview_path(account)
      if account&.persisted?
        schedule_preview_loan_path(account)
      else
        schedule_preview_loans_path
      end
    end
  end

  class LoanFeatureHelper
    def t(key, options = {})
      I18n.t(key, **options)
    end

    def preview_enabled?
      Rails.application.config.respond_to?(:features) &&
        ActiveModel::Type::Boolean.new.cast(
          Rails.application.config.features&.dig(:loans, :borrowed, :enabled)
        )
    end
  end

  class WizardHelper
    def t(key, options = {})
      I18n.t(key, **options)
    end

    def steps_list
      [
        { key: :type, title: t("loans.wizard.steps.type"), icon: "user" },
        { key: :basic, title: t("loans.wizard.steps.basic"), icon: "info" },
        { key: :terms, title: t("loans.wizard.steps.terms"), icon: "calendar" },
        { key: :review, title: t("loans.wizard.steps.review"), icon: "check" }
      ]
    end

    def current_step(options)
      options[:current_step] || :type
    end

    def loan_type(options, loan)
      options[:loan_type] || loan.debt_kind || "personal"
    end

    def completed_steps(options)
      options[:completed_steps] || []
    end

    def step_classes(step, current, completed)
      classes = "flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
      if completed.include?(step[:key]) || step[:key] == current
        classes += " bg-primary text-white"
      else
        classes += " text-secondary hover:text-primary"
      end
      classes
    end

    def loan_type_options
      [
        { key: :personal, title: t("loans.wizard.type.personal.title"), description: t("loans.wizard.type.personal.description") },
        { key: :institutional, title: t("loans.wizard.type.institutional.title"), description: t("loans.wizard.type.institutional.description") }
      ]
    end

    def smart_suggestion_for(loan_type)
      case loan_type
      when "personal"
        t("loans.wizard.smart_suggestion.personal")
      when "institutional"
        t("loans.wizard.smart_suggestion.institutional")
      else
        t("loans.wizard.smart_suggestion.default")
      end
    end

    def rate_suggestion_for(loan_type, loan)
      if loan.sharia_mode?
        t("loans.wizard.rate_suggestion.sharia")
      elsif loan.personal_mode?
        t("loans.wizard.rate_suggestion.personal")
      else
        t("loans.wizard.rate_suggestion.institutional")
      end
    end
  end

  # Accessor methods for helper instances
  def loan_mode_helper
    @loan_mode_helper ||= LoanModeHelper.new
  end

  def loan_import_helper
    @loan_import_helper ||= LoanImportHelper.new
  end

  def islamic_product_helper
    @islamic_product_helper ||= IslamicProductHelper.new
  end

  def loan_field_config_helper
    @loan_field_config_helper ||= LoanFieldConfigHelper.new
  end

  def loan_stimulus_helper
    @loan_stimulus_helper ||= LoanStimulusHelper.new
  end

  def loan_options_helper
    @loan_options_helper ||= LoanOptionsHelper.new
  end

  def account_selection_helper
    @account_selection_helper ||= AccountSelectionHelper.new
  end

  def loan_path_helper
    @loan_path_helper ||= LoanPathHelper.new
  end

  def loan_feature_helper
    @loan_feature_helper ||= LoanFeatureHelper.new
  end

  def wizard_helper
    @wizard_helper ||= WizardHelper.new
  end
end
