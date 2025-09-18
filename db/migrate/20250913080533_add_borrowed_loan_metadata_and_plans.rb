class AddBorrowedLoanMetadataAndPlans < ActiveRecord::Migration[7.2]
  def up
    change_table :loans do |t|
  # Shared metadata
  t.decimal :principal_amount, precision: 19, scale: 4
  t.date    :start_date
  t.integer :tenor_months
  t.string  :payment_frequency, default: "MONTHLY"
  t.string  :schedule_method,   default: "ANNUITY"
  t.decimal :rate_or_profit, precision: 10, scale: 4
  t.decimal :installment_amount, precision: 19, scale: 4
  t.text    :early_repayment_policy
  t.jsonb   :late_fee_rule
  t.text    :collateral_desc
  t.decimal :initial_balance_override, precision: 19, scale: 4
  t.date    :initial_balance_date

  # Personal loan linkage
  t.uuid    :linked_contact_id
  t.string  :lender_name

  # Institution fields
  t.string  :institution_name
  t.string  :institution_type
  t.string  :product_type

  # Notes and extra
  t.text    :notes
  t.jsonb   :extra
end
    create_table :loan_installments, id: :uuid, default: -> { "gen_random_uuid()" } do |t|
      t.uuid    :account_id, null: false
      t.integer :installment_no, null: false
      t.date    :due_date, null: false
      t.string  :status, default: "planned", null: false

      t.decimal :principal_amount, precision: 19, scale: 4, null: false
      t.decimal :interest_amount,  precision: 19, scale: 4, null: false
      t.decimal :total_amount,     precision: 19, scale: 4, null: false

      t.date    :posted_on
      t.uuid    :transfer_id

      t.timestamps

      t.index [ :account_id ]
      t.index [ :account_id, :installment_no ], unique: true, name: "idx_loan_installments_acct_no"
    end

    add_foreign_key :loan_installments, :accounts, on_delete: :cascade
    add_foreign_key :loan_installments, :transfers, column: :transfer_id, on_delete: :nullify
  end

  def down
    remove_foreign_key :loan_installments, :transfers
    remove_foreign_key :loan_installments, :accounts
    drop_table :loan_installments

    change_table :loans do |t|
      t.remove :principal_amount,
               :start_date,
               :tenor_months,
               :payment_frequency,
               :schedule_method,
               :rate_or_profit,
               :installment_amount,
               :early_repayment_policy,
               :late_fee_rule,
               :collateral_desc,
               :initial_balance_override,
               :initial_balance_date,
               :linked_contact_id,
               :lender_name,
               :institution_name,
               :institution_type,
               :product_type,
               :notes,
               :extra
    end
  end
end
