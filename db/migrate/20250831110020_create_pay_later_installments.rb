class CreatePayLaterInstallments < ActiveRecord::Migration[7.2]
  def change
    create_table :pay_later_installments, id: :uuid, default: -> { "gen_random_uuid()" } do |t|
      t.uuid    :account_id, null: false
      t.integer :installment_no, null: false
      t.date    :due_date, null: false
      t.string  :status, default: "pending", null: false

      t.decimal :principal_amount, precision: 19, scale: 4, null: false
      t.decimal :interest_amount,  precision: 19, scale: 4, null: false
      t.decimal :fee_amount,       precision: 19, scale: 4, default: 0, null: false
      t.decimal :total_due,        precision: 19, scale: 4, null: false

      t.date    :paid_on
      t.decimal :paid_amount,      precision: 19, scale: 4
      t.uuid    :transfer_id

      t.timestamps

      t.index [ :account_id ]
      t.index [ :account_id, :installment_no ], unique: true, name: "idx_paylater_installments_acct_no"
    end

    add_foreign_key :pay_later_installments, :accounts, on_delete: :cascade
    add_foreign_key :pay_later_installments, :transfers, column: :transfer_id, on_delete: :nullify
  end
end

