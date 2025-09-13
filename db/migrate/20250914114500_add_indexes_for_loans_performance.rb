class AddIndexesForLoansPerformance < ActiveRecord::Migration[7.2]
  disable_ddl_transaction!

  def change
    # Next planned installment: account_id + status + due_date
    add_index :loan_installments, [ :account_id, :due_date ], where: "status = 'planned'", name: "idx_loan_installments_planned_due", algorithm: :concurrently

    # Posted lookup by account/status
    add_index :loan_installments, [ :account_id, :status ], where: "status = 'posted'", name: "idx_loan_installments_posted_by_account", algorithm: :concurrently

    # Optional: institution_type on loans for filtering/reporting
    add_index :loans, :institution_type, algorithm: :concurrently

    # Optional: lender_name for basic lookup
    add_index :loans, :lender_name, algorithm: :concurrently
  end
end
