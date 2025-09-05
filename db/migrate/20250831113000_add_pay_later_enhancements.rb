class AddPayLaterEnhancements < ActiveRecord::Migration[7.2]
  def change
    # Add requested columns to PayLater accountable (no global debt_account table in this app)
    change_table :pay_laters do |t|
      t.string  :currency_code, limit: 3, null: false, default: 'IDR'
      t.decimal :exchange_rate_to_idr, precision: 18, scale: 6
      t.date    :approved_date
      t.date    :expiry_date
      t.integer :max_tenor, null: false, default: 12
      t.string  :status, null: false, default: 'ACTIVE'
      t.text    :notes
      t.boolean :auto_update_rate, null: false, default: true
      t.string  :contract_url
      t.integer :grace_days, null: false, default: 0
      t.boolean :is_compound, null: false, default: false
      t.boolean :early_settlement_allowed, null: false, default: true
      t.decimal :early_settlement_fee, precision: 18, scale: 2
      t.string  :updated_by
    end

    # New table for daily official rates to IDR (additive; does not replace existing exchange_rates)
    create_table :exchange_rate_histories, id: :uuid, default: -> { "gen_random_uuid()" } do |t|
      t.string  :currency_code, limit: 3, null: false
      t.decimal :rate_to_idr, precision: 18, scale: 6, null: false
      t.date    :effective_date, null: false
      t.timestamps
    end
    add_index :exchange_rate_histories, [ :currency_code, :effective_date ], unique: true, name: 'idx_exrate_hist_currency_date'

    # Extend installments with applied_rate and total_cost (full-schedule TCO)
    change_table :pay_later_installments do |t|
      t.decimal :applied_rate, precision: 9, scale: 6
      t.decimal :total_cost, precision: 19, scale: 4
    end

    # Backfill default currency_code for existing rows
    reversible do |dir|
      dir.up do
        execute <<~SQL
          UPDATE pay_laters SET currency_code = 'IDR' WHERE currency_code IS NULL;
        SQL
      end
    end
  end
end
