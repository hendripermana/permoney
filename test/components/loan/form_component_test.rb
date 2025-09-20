# frozen_string_literal: true

require "test_helper"

class Loan::FormComponentTest < ViewComponent::TestCase
  include LoanFormHelper

  def test_renders_wizard_for_new_loan
    loan = Loan.new
    account = Account.new

    render_inline(Loan::FormComponent.new(loan: loan, account: account, wizard: true))

    assert_selector "div.loan-wizard"
    assert_selector "div[data-controller='loan-wizard']"
  end

  def test_renders_traditional_form_for_existing_loan
    loan = Loan.new(id: 1, counterparty_name: "Test Bank")
    account = Account.new(id: 1)

    render_inline(Loan::FormComponent.new(loan: loan, account: account))

    assert_selector "div[data-controller='loan-form']"
    refute_selector "div.loan-wizard"
  end

  def test_wizard_has_step_indicators
    loan = Loan.new
    account = Account.new

    render_inline(Loan::FormComponent.new(
      loan: loan,
      account: account,
      wizard: true,
      current_step: :type
    ))

    assert_selector "[data-controller='loan-wizard']"

    # Should have step indicators
    wizard_helper.steps_list.each do |step|
      assert_selector "div", text: step[:title]
    end
  end

  def test_wizard_type_step_shows_loan_type_selection
    loan = Loan.new
    account = Account.new

    render_inline(Loan::FormComponent.new(
      loan: loan,
      account: account,
      wizard: true,
      current_step: :type
    ))

    assert_selector "h3", text: /loan type/i
    assert_selector "div[data-action*='selectType']"
  end

  def test_wizard_basic_step_shows_counterparty_field
    loan = Loan.new
    account = Account.new

    render_inline(Loan::FormComponent.new(
      loan: loan,
      account: account,
      wizard: true,
      current_step: :basic
    ))

    assert_selector "h3", text: /basic information/i
    assert_selector "input[name*='counterparty_name']"
  end

  def test_wizard_terms_step_shows_loan_terms
    loan = Loan.new
    account = Account.new

    render_inline(Loan::FormComponent.new(
      loan: loan,
      account: account,
      wizard: true,
      current_step: :terms
    ))

    assert_selector "h3", text: /loan terms/i
    assert_selector "input[name*='initial_balance']"
    assert_selector "input[name*='tenor_months']"
  end

  def test_wizard_review_step_shows_summary
    loan = Loan.new(
      counterparty_name: "Test Bank",
      initial_balance: 1000000,
      tenor_months: 12
    )
    account = Account.new

    render_inline(Loan::FormComponent.new(
      loan: loan,
      account: account,
      wizard: true,
      current_step: :review
    ))

    assert_selector "h3", text: /review/i
    assert_selector "div", text: "Test Bank"
    assert_selector "div", text: "1,000,000"
  end

  def test_wizard_has_navigation_buttons
    loan = Loan.new
    account = Account.new

    render_inline(Loan::FormComponent.new(
      loan: loan,
      account: account,
      wizard: true,
      current_step: :basic
    ))

    assert_selector "button[data-action*='nextStep']"
    assert_selector "button[data-action*='previousStep']"
  end

  def test_wizard_smart_suggestions
    loan = Loan.new
    account = Account.new

    render_inline(Loan::FormComponent.new(
      loan: loan,
      account: account,
      wizard: true,
      current_step: :type,
      loan_type: "personal"
    ))

    # Should show smart suggestion for personal loans
    assert_selector "div.bg-blue-50"
  end

  def test_wizard_rate_suggestions
    loan = Loan.new(compliance_type: "sharia")
    account = Account.new

    render_inline(Loan::FormComponent.new(
      loan: loan,
      account: account,
      wizard: true,
      current_step: :terms
    ))

    # Should show rate suggestion for sharia loans
    assert_selector "div.bg-green-50"
  end

  def test_conditional_fields_based_on_loan_type
    loan = Loan.new(debt_kind: "personal")
    account = Account.new

    render_inline(Loan::FormComponent.new(
      loan: loan,
      account: account,
      wizard: true,
      current_step: :basic
    ))

    # Should show personal loan specific fields
    assert_selector "input[name*='relationship']"
  end

  def test_form_validation_classes
    loan = Loan.new
    account = Account.new

    render_inline(Loan::FormComponent.new(
      loan: loan,
      account: account,
      wizard: true,
      current_step: :basic
    ))

    # Should have proper form styling
    assert_selector "input.w-full"
  end
end
