module LoanHelper
  # Returns a human-friendly label for personal lenders.
  # Prefers linked_contact_id if resolvable, otherwise falls back to lender_name/counterparty_name.
  # Output example: "Ahmad (Contact)" or "John Doe (Manual)".
  def personal_lender_label(loan)
    return nil unless loan.personal_loan?

    # Try to resolve a Contact model if present in the app (optional)
    if loan.linked_contact_id.present? && defined?(Contact)
      contact = Contact.where(id: loan.linked_contact_id).first
      if contact&.respond_to?(:name) && contact.name.present?
        return safe_join([ contact.name, content_tag(:span, "(Contact)", class: "text-secondary text-xs") ], " ")
      end
    end

    # Fallback to lender_name or counterparty_name
    lender = loan.lender_name.presence || loan.counterparty_name.presence || loan.linked_contact_id&.to_s
    return nil unless lender.present?

    safe_join([ lender, content_tag(:span, "(Manual)", class: "text-secondary text-xs") ], " ")
  end

  # Smart placeholder for loan account names based on loan type
  def smart_loan_name_placeholder(personal_mode)
    if personal_mode
      "e.g., Loan from Ahmad, Family loan, Friend's money"
    else
      "e.g., BCA Personal Loan, Mortgage, Kredivo Loan"
    end
  end

  # Smart default interest rate based on loan type
  def smart_interest_rate_default(personal_mode, sharia_compliant)
    return 0 if sharia_compliant
    return 0 if personal_mode # Most personal loans are interest-free

    # Institutional loan default rates (Indonesian context)
    case Current.family&.currency
    when "IDR"
      12.0 # Typical Indonesian bank rate
    when "USD"
      6.0  # Typical US rate
    else
      8.0  # General default
    end
  end

  # Smart default term months based on loan type
  def smart_term_months_default(personal_mode)
    personal_mode ? 12 : 24 # Personal loans typically shorter
  end

  # Smart payment frequency default
  def smart_payment_frequency_default(personal_mode)
    personal_mode ? "MONTHLY" : "MONTHLY" # Both typically monthly
  end

  # Enhanced validation messages with contextual help
  def loan_validation_message(field, error_type, loan_type = "personal")
    messages = {
      counterparty_name: {
        blank: loan_type == "personal" ? "Please enter the lender's name" : "Please enter the institution name",
        too_short: "Name is too short",
        too_long: "Name is too long"
      },
      initial_balance: {
        blank: "Please enter the loan amount",
        not_a_number: "Please enter a valid amount",
        greater_than: "Loan amount must be greater than 0",
        less_than_or_equal_to: "Loan amount seems too large"
      },
      term_months: {
        blank: "Please enter the repayment period",
        not_a_number: "Please enter a valid number of months",
        greater_than: "Repayment period must be at least 1 month",
        less_than_or_equal_to: "Repayment period cannot exceed 50 years"
      },
      interest_rate: {
        greater_than_or_equal_to: "Interest rate cannot be negative",
        less_than_or_equal_to: "Interest rate cannot exceed 100%",
        not_a_number: "Please enter a valid interest rate"
      }
    }

    messages.dig(field.to_sym, error_type.to_sym) || "Please check this field"
  end

  # Smart suggestions based on loan type and context
  def smart_loan_suggestion(loan_type, field, current_value = nil)
    suggestions = {
      personal: {
        counterparty_name: current_value.blank? ? "e.g., Ahmad, Ana, John" : nil,
        relationship: "Most personal loans are from family or friends",
        interest_rate: "Personal loans are usually interest-free (0%)",
        term_months: "Personal loans typically range from 3-24 months"
      },
      institutional: {
        counterparty_name: current_value.blank? ? "e.g., Bank Mandiri, BCA, Kredivo" : nil,
        fintech_type: "Select the type of institution for better tracking",
        interest_rate: "Institutional loans typically have 6-15% interest",
        term_months: "Institutional loans typically range from 12-60 months"
      }
    }

    suggestions.dig(loan_type.to_sym, field.to_sym)
  end

  # Contextual help text for loan fields
  def loan_field_help_text(field, loan_type = "personal")
    help_texts = {
      counterparty_name: {
        personal: "Enter the name of the person you're borrowing from",
        institutional: "Enter the name of the bank or financial institution"
      },
      relationship: {
        personal: "Select your relationship to help with reminders and context"
      },
      initial_balance: {
        personal: "Enter the total amount you're borrowing",
        institutional: "Enter the total loan amount from the institution"
      },
      term_months: {
        personal: "How many months will you take to repay this loan?",
        institutional: "The loan term in months as specified in your agreement"
      },
      interest_rate: {
        personal: "Most personal loans are interest-free (0%)",
        institutional: "The annual interest rate as specified in your loan agreement"
      },
      payment_frequency: {
        personal: "How often will you make payments?",
        institutional: "Payment frequency as specified in your loan agreement"
      }
    }

    help_texts.dig(field.to_sym, loan_type.to_sym)
  end

  # Format validation errors with enhanced styling
  def enhanced_validation_error(field, error_type, loan_type = "personal")
    message = loan_validation_message(field, error_type, loan_type)

    content_tag :div, class: "error-message" do
      safe_join([
        (icon("alert-circle", size: "xs", class: "text-destructive") if respond_to?(:icon)),
        content_tag(:span, message, class: "ml-1")
      ].compact)
    end
  end

  # Format success messages with enhanced styling
  def enhanced_success_message(message)
    content_tag :div, class: "success-message" do
      safe_join([
        (icon("check-circle", size: "xs", class: "text-success") if respond_to?(:icon)),
        content_tag(:span, message, class: "ml-1")
      ].compact)
    end
  end

  # Smart field grouping helper
  def smart_field_group_class(loan_type, field_group)
    base_class = "field-group"

    case field_group
    when "personal"
      "#{base_class} personal"
    when "institutional"
      "#{base_class} institutional"
    else
      "#{base_class} neutral"
    end
  end

  # Enhanced form section helper
  def enhanced_form_section(title, subtitle = nil, step_number = nil)
    content_tag :section, class: "enhanced-form-section" do
      safe_join([
        content_tag(:div, class: "section-header") do
          safe_join([
            (content_tag(:div, class: "progress-step #{step_number ? 'active' : 'pending'}") do
              step_number.to_s if step_number
            end if step_number),
            content_tag(:div) do
              safe_join([
                content_tag(:h3, title),
                (content_tag(:p, subtitle) if subtitle)
              ].compact)
            end
          ])
        end
      ])
    end
  end
end
