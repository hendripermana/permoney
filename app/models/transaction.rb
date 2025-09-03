class Transaction < ApplicationRecord
  include Entryable, Transferable, Ruleable

  belongs_to :category, optional: true
  belongs_to :merchant, optional: true

  has_many :taggings, as: :taggable, dependent: :destroy
  has_many :tags, through: :taggings

  accepts_nested_attributes_for :taggings, allow_destroy: true

  enum :kind, {
    standard: "standard", # A regular transaction, included in budget analytics
    funds_movement: "funds_movement", # Movement of funds between accounts, excluded from budget analytics
    cc_payment: "cc_payment", # A CC payment, excluded from budget analytics (CC payments offset the sum of expense transactions)
    loan_payment: "loan_payment", # A payment to a Loan account, treated as an expense in budgets
    one_time: "one_time", # A one-time expense/income, excluded from budget analytics
    # Indonesian and Islamic finance transaction types
    loan_disbursement: "loan_disbursement", # When you receive loan money (inflow)
    personal_lending: "personal_lending", # When you lend money to friends (outflow)
    personal_borrowing: "personal_borrowing", # When you borrow from friends (inflow)
    zakat_payment: "zakat_payment", # Islamic obligatory charity (expense)
    infaq_sadaqah: "infaq_sadaqah", # Voluntary Islamic charity (expense)
    profit_sharing: "profit_sharing", # Islamic profit sharing income
    margin_payment: "margin_payment" # Islamic margin-based payments (like Murabaha)
  }

  # Overarching grouping method for all transfer-type transactions
  def transfer?
    funds_movement? || cc_payment? || loan_payment? || personal_lending? || personal_borrowing?
  end

  # Islamic finance transaction grouping
  def islamic_finance?
    zakat_payment? || infaq_sadaqah? || profit_sharing? || margin_payment?
  end

  # Personal lending transaction grouping
  def personal_debt?
    personal_lending? || personal_borrowing?
  end

  # Check if transaction should be excluded from budget analytics
  def excluded_from_budget?
    transfer? || one_time?
  end

  # Check if transaction is Sharia compliant
  def sharia_compliant?
    return is_sharia_compliant if is_sharia_compliant != nil
    
    # Auto-detect based on transaction type
    islamic_finance? || 
    (personal_debt? && entry.account.accountable.respond_to?(:sharia_compliant?) && entry.account.accountable.sharia_compliant?)
  end

  def set_category!(category)
    if category.is_a?(String)
      category = entry.account.family.categories.find_or_create_by!(
        name: category
      )
    end

    update!(category: category)
  end
end
