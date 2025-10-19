class AddPartialPaymentFieldsToLoanInstallments < ActiveRecord::Migration[7.2]
  def change
    # Add partial payment tracking fields
    add_column :loan_installments, :paid_principal, :decimal, precision: 15, scale: 2, default: 0, null: false
    add_column :loan_installments, :paid_interest, :decimal, precision: 15, scale: 2, default: 0, null: false
    add_column :loan_installments, :last_payment_date, :date
    add_column :loan_installments, :actual_amount, :decimal, precision: 15, scale: 2

    # Update enum to include partially_paid status
    # Note: This will be handled by the model enum definition

    # Add index for better query performance
    add_index :loan_installments, [ :account_id, :status ]
    add_index :loan_installments, :last_payment_date
  end
end
