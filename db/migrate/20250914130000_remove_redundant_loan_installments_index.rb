class RemoveRedundantLoanInstallmentsIndex < ActiveRecord::Migration[7.2]
  def up
    if index_name_exists?(:loan_installments, "idx_loan_installments_acct_no")
      remove_index :loan_installments, name: "idx_loan_installments_acct_no"
    end
  end

  def down
    unless index_name_exists?(:loan_installments, "idx_loan_installments_acct_no")
      add_index :loan_installments, [ :account_id, :installment_no ], unique: true, name: "idx_loan_installments_acct_no"
    end
  end
end
