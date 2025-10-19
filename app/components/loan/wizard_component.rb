# frozen_string_literal: true

class Loan::WizardComponent < ApplicationComponent
  include Turbo::FramesHelper
  include LoanFormHelper

  attr_reader :loan, :account, :form, :step

  WIZARD_STEPS = %w[type details payment review].freeze

  def initialize(loan:, account:, form:, step: "type")
    @loan = loan
    @account = account
    @form = form
    @step = step
  end

  def call
    tag.div(class: "loan-wizard", data: wizard_data) do
      safe_join([
        render_progress_bar,
        render_step_content,
        render_navigation
      ])
    end
  end

  private

  def wizard_data
    {
      controller: "loan-wizard",
      "loan-wizard-current-step-value": step,
      "loan-wizard-total-steps-value": WIZARD_STEPS.size
    }
  end

  def render_progress_bar
    tag.div(class: "wizard-progress mb-8") do
      safe_join([
        render_steps_indicator,
        render_progress_line
      ])
    end
  end

  def render_steps_indicator
    tag.div(class: "flex justify-between relative") do
      WIZARD_STEPS.map.with_index do |step_name, index|
        render_step_indicator(step_name, index)
      end.join.html_safe
    end
  end

  def render_step_indicator(step_name, index)
    current_index = WIZARD_STEPS.index(step)
    completed = index < current_index
    active = index == current_index

    tag.div(class: "wizard-step-indicator", data: { step: step_name }) do
      safe_join([
        tag.div(class: step_indicator_classes(completed, active)) do
          if completed
            icon("check", size: 20)
          else
            (index + 1).to_s
          end
        end,
        tag.div(class: "text-xs mt-2 font-medium #{active ? 'text-primary' : 'text-subtle'}") do
          step_label(step_name)
        end
      ])
    end
  end

  def step_indicator_classes(completed, active)
    base = "w-10 h-10 rounded-full flex items-center justify-center font-semibold transition-all"
    
    if completed
      "#{base} bg-success text-white"
    elsif active
      "#{base} bg-primary text-white shadow-lg scale-110"
    else
      "#{base} bg-container-subtle text-subtle border-2 border-primary/20"
    end
  end

  def render_progress_line
    current_index = WIZARD_STEPS.index(step)
    progress_percentage = (current_index.to_f / (WIZARD_STEPS.size - 1) * 100).round

    tag.div(class: "relative mt-5") do
      safe_join([
        tag.div(class: "absolute inset-0 h-1 bg-container-subtle rounded-full"),
        tag.div(
          class: "absolute h-1 bg-gradient-to-r from-primary to-primary-dark rounded-full transition-all duration-500",
          style: "width: #{progress_percentage}%"
        )
      ])
    end
  end

  def render_step_content
    tag.div(class: "wizard-content mt-8", data: { "loan-wizard-target": "content" }) do
      case step
      when "type"
        render_loan_type_step
      when "details"
        render_loan_details_step
      when "payment"
        render_payment_step
      when "review"
        render_review_step
      end
    end
  end

  def render_loan_type_step
    tag.div(class: "space-y-6") do
      safe_join([
        render_step_header("What type of loan is this?", "Choose the loan category that best fits"),
        render_loan_type_cards,
        render_compliance_toggle
      ])
    end
  end

  def render_loan_type_cards
    tag.div(class: "grid grid-cols-1 md:grid-cols-2 gap-4") do
      safe_join([
        render_type_card(
          "personal",
          "Personal Loan",
          "Borrowing from friends, family, or individuals",
          "users",
          features: ["Flexible terms", "Relationship tracking", "Reminder system"]
        ),
        render_type_card(
          "institutional",
          "Institutional Loan",
          "Banks, credit unions, or financial institutions",
          "building-2",
          features: ["Fixed schedules", "Professional terms", "Automated tracking"]
        )
      ])
    end
  end

  def render_type_card(value, title, description, icon_name, features: [])
    selected = loan.debt_kind == value

    tag.label(
      class: "loan-type-card #{selected ? 'selected' : ''}",
      data: { action: "click->loan-wizard#selectType" }
    ) do
      safe_join([
        form.radio_button(:debt_kind, value, class: "hidden"),
        tag.div(class: "flex items-start space-x-4") do
          safe_join([
            tag.div(class: "type-card-icon") do
              icon(icon_name, size: 24)
            end,
            tag.div(class: "flex-1") do
              safe_join([
                tag.h3(title, class: "font-semibold text-primary mb-1"),
                tag.p(description, class: "text-sm text-subtle mb-3"),
                render_feature_list(features)
              ])
            end
          ])
        end
      ])
    end
  end

  def render_feature_list(features)
    tag.ul(class: "space-y-1") do
      features.map do |feature|
        tag.li(class: "flex items-center text-xs text-subtle") do
          safe_join([
            icon("check-circle", size: 14, class: "mr-2 text-success"),
            feature
          ])
        end
      end.join.html_safe
    end
  end

  def render_compliance_toggle
    tag.div(class: "bg-container-subtle rounded-lg p-4") do
      safe_join([
        tag.div(class: "flex items-center justify-between mb-3") do
          safe_join([
            tag.div do
              safe_join([
                tag.h4("Islamic Finance Compliance", class: "font-medium text-primary"),
                tag.p("Enable Sharia-compliant loan options", class: "text-xs text-subtle mt-1")
              ])
            end,
            render_toggle_switch(:compliance_type, "sharia", loan.compliance_type == "sharia")
          ])
        end,
        render_islamic_options if loan.compliance_type == "sharia"
      ])
    end
  end

  def render_islamic_options
    tag.div(class: "mt-4 space-y-3", data: { "loan-wizard-target": "islamicOptions" }) do
      safe_join([
        form.select(
          :islamic_product_type,
          options_for_select(islamic_product_options, loan.islamic_product_type),
          { prompt: "Select Islamic product type" },
          class: "form-select text-sm"
        ),
        render_islamic_product_info
      ])
    end
  end

  def render_loan_details_step
    tag.div(class: "space-y-6") do
      safe_join([
        render_step_header("Loan Details", "Enter the specifics of your loan"),
        render_counterparty_section,
        render_amount_section,
        render_term_section
      ])
    end
  end

  def render_counterparty_section
    tag.div(class: "bg-container rounded-lg p-6 space-y-4") do
      safe_join([
        tag.h3("Who is the lender?", class: "font-medium text-primary mb-4"),
        
        if loan.personal_loan?
          render_personal_counterparty_fields
        else
          render_institutional_counterparty_fields
        end
      ])
    end
  end

  def render_personal_counterparty_fields
    safe_join([
      form.text_field(
        :counterparty_name,
        placeholder: "Name of the person",
        class: "form-input",
        data: { "loan-wizard-target": "counterpartyName" }
      ),
      
      form.select(
        :relationship,
        options_for_select(relationship_options, loan.relationship),
        { prompt: "Select relationship" },
        class: "form-select"
      )
    ])
  end

  def render_institutional_counterparty_fields
    safe_join([
      form.text_field(
        :counterparty_name,
        placeholder: "Name of the institution",
        class: "form-input",
        data: { "loan-wizard-target": "institutionName" }
      ),
      
      form.select(
        :fintech_type,
        options_for_select(fintech_type_options, loan.fintech_type),
        { prompt: "Select institution type" },
        class: "form-select"
      )
    ])
  end

  def render_amount_section
    tag.div(class: "bg-container rounded-lg p-6 space-y-4") do
      safe_join([
        tag.h3("Loan Amount", class: "font-medium text-primary mb-4"),
        
        tag.div(class: "grid grid-cols-1 md:grid-cols-2 gap-4") do
          safe_join([
            form.number_field(
              :principal_amount,
              placeholder: "0.00",
              class: "form-input",
              step: "0.01",
              min: 0,
              data: { 
                "loan-wizard-target": "principalAmount",
                action: "input->loan-wizard#calculatePayment"
              }
            ),
            
            form.select(
              :currency,
              options_for_select(currency_options, loan.currency || account.currency),
              {},
              class: "form-select"
            )
          ])
        end,
        
        render_quick_amount_buttons
      ])
    end
  end

  def render_quick_amount_buttons
    amounts = [1000, 5000, 10000, 25000, 50000]
    
    tag.div(class: "flex flex-wrap gap-2 mt-3") do
      amounts.map do |amount|
        tag.button(
          type: "button",
          class: "quick-amount-btn",
          data: { 
            action: "click->loan-wizard#setQuickAmount",
            amount: amount
          }
        ) do
          number_to_currency(amount, unit: "")
        end
      end.join.html_safe
    end
  end

  def render_payment_step
    tag.div(class: "space-y-6") do
      safe_join([
        render_step_header("Payment Terms", "Configure how you'll repay the loan"),
        render_interest_section,
        render_schedule_section,
        render_payment_calculator
      ])
    end
  end

  def render_interest_section
    tag.div(class: "bg-container rounded-lg p-6 space-y-4") do
      safe_join([
        tag.h3("Interest Rate", class: "font-medium text-primary mb-4"),
        
        if loan.compliance_type == "sharia"
          render_islamic_rate_fields
        else
          render_conventional_rate_fields
        end,
        
        render_rate_comparison
      ])
    end
  end

  def render_conventional_rate_fields
    tag.div(class: "space-y-4") do
      safe_join([
        tag.div(class: "flex items-center space-x-4") do
          safe_join([
            form.number_field(
              :interest_rate,
              placeholder: "0.00",
              class: "form-input flex-1",
              step: "0.01",
              min: 0,
              max: 100,
              data: { 
                "loan-wizard-target": "interestRate",
                action: "input->loan-wizard#calculatePayment"
              }
            ),
            tag.span("% per year", class: "text-subtle")
          ])
        end,
        
        render_interest_free_option
      ])
    end
  end

  def render_payment_calculator
    tag.div(class: "bg-primary/5 rounded-lg p-6") do
      safe_join([
        tag.h3("Payment Calculator", class: "font-medium text-primary mb-4"),
        
        tag.div(class: "grid grid-cols-1 md:grid-cols-3 gap-6") do
          safe_join([
            render_calculator_metric("Monthly Payment", "$0", "monthlyPayment"),
            render_calculator_metric("Total Interest", "$0", "totalInterest"),
            render_calculator_metric("Total Amount", "$0", "totalAmount")
          ])
        end,
        
        render_amortization_preview
      ])
    end
  end

  def render_calculator_metric(label, value, target)
    tag.div(class: "text-center") do
      safe_join([
        tag.div(label, class: "text-xs text-subtle mb-2"),
        tag.div(value, class: "text-2xl font-bold text-primary", data: { "loan-wizard-target": target })
      ])
    end
  end

  def render_review_step
    tag.div(class: "space-y-6") do
      safe_join([
        render_step_header("Review & Confirm", "Double-check your loan details"),
        render_loan_summary,
        render_payment_schedule_preview,
        render_confirmation_actions
      ])
    end
  end

  def render_loan_summary
    tag.div(class: "bg-container rounded-lg p-6") do
      safe_join([
        tag.h3("Loan Summary", class: "font-medium text-primary mb-4"),
        
        tag.dl(class: "space-y-3") do
          safe_join([
            render_summary_item("Type", loan_type_label),
            render_summary_item("Lender", loan.counterparty_name),
            render_summary_item("Amount", format_money(loan.principal_amount_money)),
            render_summary_item("Interest Rate", "#{loan.effective_rate}%"),
            render_summary_item("Term", "#{loan.term_months} months"),
            render_summary_item("Monthly Payment", format_money(loan.monthly_payment))
          ])
        end
      ])
    end
  end

  def render_summary_item(label, value)
    tag.div(class: "flex justify-between items-center py-2 border-b border-primary/10 last:border-0") do
      safe_join([
        tag.dt(label, class: "text-sm text-subtle"),
        tag.dd(value, class: "font-medium text-primary")
      ])
    end
  end

  def render_navigation
    tag.div(class: "wizard-navigation mt-8 flex justify-between items-center") do
      safe_join([
        render_back_button,
        render_step_indicator_dots,
        render_next_button
      ])
    end
  end

  def render_back_button
    return tag.div if step == WIZARD_STEPS.first

    link_to(
      safe_join([icon("chevron-left", size: 20), "Back"]),
      "#",
      class: "btn btn-secondary",
      data: { action: "click->loan-wizard#previousStep" }
    )
  end

  def render_next_button
    if step == WIZARD_STEPS.last
      form.submit "Create Loan", class: "btn btn-primary"
    else
      link_to(
        safe_join(["Next", icon("chevron-right", size: 20)]),
        "#",
        class: "btn btn-primary",
        data: { action: "click->loan-wizard#nextStep" }
      )
    end
  end

  def render_step_indicator_dots
    tag.div(class: "flex space-x-2") do
      WIZARD_STEPS.map.with_index do |_, index|
        current_index = WIZARD_STEPS.index(step)
        active = index == current_index
        
        tag.div(
          class: "w-2 h-2 rounded-full transition-all #{active ? 'w-8 bg-primary' : 'bg-primary/30'}"
        )
      end.join.html_safe
    end
  end

  def render_step_header(title, subtitle)
    tag.div(class: "mb-6") do
      safe_join([
        tag.h2(title, class: "text-2xl font-bold text-primary mb-2"),
        tag.p(subtitle, class: "text-subtle")
      ])
    end
  end

  def render_toggle_switch(name, value, checked)
    tag.label(class: "relative inline-flex items-center cursor-pointer") do
      safe_join([
        form.check_box(name, { class: "sr-only peer", checked: checked }, value, nil),
        tag.div(class: "toggle-switch")
      ])
    end
  end

  def step_label(step_name)
    case step_name
    when "type" then "Loan Type"
    when "details" then "Details"
    when "payment" then "Payment"
    when "review" then "Review"
    else step_name.humanize
    end
  end

  def loan_type_label
    loan.personal_loan? ? "Personal Loan" : "Institutional Loan"
  end

  def format_money(amount)
    return "$0.00" unless amount
    number_to_currency(amount.amount / 100.0)
  end

  def relationship_options
    [
      ["Family", "family"],
      ["Friend", "friend"],
      ["Colleague", "colleague"],
      ["Business Partner", "business_partner"],
      ["Other", "other"]
    ]
  end

  def fintech_type_options
    [
      ["Traditional Bank", "bank"],
      ["Credit Union", "credit_union"],
      ["Online Lender", "online_lender"],
      ["P2P Platform", "p2p"],
      ["Pinjol", "pinjol"],
      ["PayLater", "paylater"]
    ]
  end

  def islamic_product_options
    [
      ["Murabaha (Cost-Plus)", "murabaha"],
      ["Musyarakah (Partnership)", "musyarakah"],
      ["Mudharabah (Profit Sharing)", "mudharabah"],
      ["Qard Hasan (Benevolent)", "qard_hasan"]
    ]
  end

  def currency_options
    [
      ["USD - US Dollar", "USD"],
      ["IDR - Indonesian Rupiah", "IDR"],
      ["EUR - Euro", "EUR"],
      ["GBP - British Pound", "GBP"]
    ]
  end

  def render_islamic_product_info
    return unless loan.islamic_product_type.present?

    info = case loan.islamic_product_type
    when "murabaha"
      "Fixed markup on purchase price, paid in installments"
    when "musyarakah"
      "Joint partnership with profit/loss sharing"
    when "mudharabah"
      "Investment partnership with profit sharing"
    when "qard_hasan"
      "Interest-free benevolent loan"
    end

    tag.div(class: "text-xs text-subtle bg-primary/5 rounded p-3") do
      safe_join([icon("info-circle", size: 14, class: "inline mr-1"), info])
    end
  end

  def render_term_section
    tag.div(class: "bg-container rounded-lg p-6 space-y-4") do
      safe_join([
        tag.h3("Loan Term", class: "font-medium text-primary mb-4"),
        
        tag.div(class: "grid grid-cols-1 md:grid-cols-2 gap-4") do
          safe_join([
            form.number_field(
              :term_months,
              placeholder: "Number of months",
              class: "form-input",
              min: 1,
              max: 600,
              data: {
                "loan-wizard-target": "termMonths",
                action: "input->loan-wizard#calculatePayment"
              }
            ),
            
            form.date_field(
              :origination_date,
              class: "form-input",
              value: loan.origination_date || Date.current
            )
          ])
        end,
        
        render_term_presets
      ])
    end
  end

  def render_term_presets
    terms = [
      { months: 6, label: "6 months" },
      { months: 12, label: "1 year" },
      { months: 24, label: "2 years" },
      { months: 36, label: "3 years" },
      { months: 60, label: "5 years" }
    ]
    
    tag.div(class: "flex flex-wrap gap-2 mt-3") do
      terms.map do |term|
        tag.button(
          type: "button",
          class: "term-preset-btn",
          data: {
            action: "click->loan-wizard#setTermMonths",
            months: term[:months]
          }
        ) do
          term[:label]
        end
      end.join.html_safe
    end
  end

  def render_schedule_section
    tag.div(class: "bg-container rounded-lg p-6 space-y-4") do
      safe_join([
        tag.h3("Payment Schedule", class: "font-medium text-primary mb-4"),
        
        tag.div(class: "grid grid-cols-1 md:grid-cols-2 gap-4") do
          safe_join([
            form.select(
              :payment_frequency,
              options_for_select(payment_frequency_options, loan.payment_frequency),
              {},
              class: "form-select",
              data: { action: "change->loan-wizard#calculatePayment" }
            ),
            
            form.select(
              :schedule_method,
              options_for_select(schedule_method_options, loan.schedule_method),
              {},
              class: "form-select",
              data: { action: "change->loan-wizard#calculatePayment" }
            )
          ])
        end
      ])
    end
  end

  def payment_frequency_options
    [
      ["Monthly", "MONTHLY"],
      ["Quarterly", "QUARTERLY"],
      ["Semi-Annually", "SEMI_ANNUALLY"],
      ["Annually", "ANNUALLY"]
    ]
  end

  def schedule_method_options
    [
      ["Annuity (Equal Payments)", "ANNUITY"],
      ["Linear (Declining Payments)", "LINEAR"],
      ["Balloon (Interest Only)", "BALLOON"]
    ]
  end

  def render_islamic_rate_fields
    tag.div(class: "space-y-4") do
      case loan.islamic_product_type
      when "murabaha"
        form.number_field(
          :margin_rate,
          placeholder: "Profit margin %",
          class: "form-input",
          step: "0.01",
          min: 0,
          data: { action: "input->loan-wizard#calculatePayment" }
        )
      when "musyarakah", "mudharabah"
        form.number_field(
          :profit_sharing_ratio,
          placeholder: "Profit sharing ratio %",
          class: "form-input",
          step: "0.01",
          min: 0,
          max: 100,
          data: { action: "input->loan-wizard#calculatePayment" }
        )
      when "qard_hasan"
        tag.div(class: "text-sm text-subtle bg-success/10 rounded p-3") do
          "No interest or profit - benevolent loan"
        end
      end
    end
  end

  def render_interest_free_option
    tag.label(class: "flex items-center space-x-3 mt-3") do
      safe_join([
        form.check_box(:interest_free, class: "form-checkbox", data: { action: "change->loan-wizard#toggleInterestFree" }),
        tag.span("This is an interest-free loan", class: "text-sm")
      ])
    end
  end

  def render_rate_comparison
    tag.div(class: "mt-4 p-3 bg-primary/5 rounded") do
      safe_join([
        tag.div(class: "text-xs text-subtle mb-2") do
          "Market Rate Comparison"
        end,
        tag.div(class: "flex items-center space-x-4") do
          safe_join([
            render_rate_indicator("Your Rate", loan.effective_rate || 0),
            render_rate_indicator("Market Avg", 8.5),
            render_rate_status
          ])
        end
      ])
    end
  end

  def render_rate_indicator(label, rate)
    tag.div(class: "flex-1") do
      safe_join([
        tag.div(label, class: "text-xs text-subtle"),
        tag.div("#{rate}%", class: "font-semibold")
      ])
    end
  end

  def render_rate_status
    return unless loan.effective_rate

    status = if loan.effective_rate < 8.5
      { text: "Below Market", class: "text-success", icon: "trending-down" }
    elsif loan.effective_rate > 10
      { text: "Above Market", class: "text-warning", icon: "trending-up" }
    else
      { text: "Market Rate", class: "text-primary", icon: "minus" }
    end

    tag.div(class: "flex items-center space-x-1 #{status[:class]}") do
      safe_join([
        icon(status[:icon], size: 16),
        tag.span(status[:text], class: "text-xs font-medium")
      ])
    end
  end

  def render_amortization_preview
    tag.div(class: "mt-6") do
      safe_join([
        tag.button(
          type: "button",
          class: "text-sm text-primary font-medium flex items-center space-x-2",
          data: { action: "click->loan-wizard#toggleAmortization" }
        ) do
          safe_join([
            icon("calendar", size: 16),
            "View Payment Schedule"
          ])
        end,
        
        tag.div(
          class: "hidden mt-4",
          data: { "loan-wizard-target": "amortizationTable" }
        ) do
          # This would be populated via JavaScript
          "Loading payment schedule..."
        end
      ])
    end
  end

  def render_payment_schedule_preview
    tag.div(class: "bg-container rounded-lg p-6") do
      safe_join([
        tag.h3("First 3 Payments", class: "font-medium text-primary mb-4"),
        
        tag.div(class: "space-y-3") do
          # This would show actual calculated payments
          (1..3).map do |month|
            render_payment_preview_row(month)
          end.join.html_safe
        end
      ])
    end
  end

  def render_payment_preview_row(month)
    tag.div(class: "flex justify-between items-center py-3 border-b border-primary/10") do
      safe_join([
        tag.div(class: "flex-1") do
          safe_join([
            tag.div("Payment #{month}", class: "font-medium"),
            tag.div((Date.current + month.months).strftime("%B %Y"), class: "text-xs text-subtle")
          ])
        end,
        tag.div(class: "text-right") do
          safe_join([
            tag.div("$0.00", class: "font-semibold"),
            tag.div("Principal: $0.00 | Interest: $0.00", class: "text-xs text-subtle")
          ])
        end
      ])
    end
  end

  def render_confirmation_actions
    tag.div(class: "bg-warning/10 rounded-lg p-4") do
      safe_join([
        tag.div(class: "flex items-start space-x-3") do
          safe_join([
            icon("alert-triangle", size: 20, class: "text-warning mt-0.5"),
            tag.div(class: "flex-1") do
              safe_join([
                tag.h4("Ready to create this loan?", class: "font-medium mb-2"),
                tag.p(
                  "Please review all details carefully. You can edit the loan later if needed.",
                  class: "text-sm text-subtle"
                )
              ])
            end
          ])
        end
      ])
    end
  end
end
