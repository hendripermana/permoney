class AddLoanDayCountAndPostedUniqueIndex < ActiveRecord::Migration[7.2]
  def up
    # Persist preview param for future use
    add_column :loans, :day_count, :string

    # Prevent double-posting the same installment
    add_index :loan_installments,
              [ :account_id, :installment_no ],
              unique: true,
              where: "status = 'posted'",
              name: "idx_loan_installments_posted_once"

    # Optional: add a key field to categories for system categories (nullable, additive)
    add_column :categories, :key, :string
    add_index :categories, [ :family_id, :key ], unique: true, where: "key IS NOT NULL", name: "idx_categories_family_key"
  end

  def down
    remove_index :loan_installments, name: "idx_loan_installments_posted_once"
    remove_column :loans, :day_count

    remove_index :categories, name: "idx_categories_family_key"
    remove_column :categories, :key
  end
end
