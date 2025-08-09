class AddDebtFieldsToLoans < ActiveRecord::Migration[7.2]
  def change
    change_table :loans do |t|
      t.string :debt_kind # "institutional" | "personal"
      t.string :counterparty_type # "institution" | "person"
      t.string :counterparty_name
      t.uuid :disbursement_account_id
      t.date :origination_date
    end

    add_index :loans, :debt_kind
    add_index :loans, :counterparty_type
    add_index :loans, :disbursement_account_id
    add_foreign_key :loans, :accounts, column: :disbursement_account_id
  end
end


