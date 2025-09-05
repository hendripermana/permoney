class CreatePayLaters < ActiveRecord::Migration[7.2]
  def change
    create_table :pay_laters, id: :uuid, default: -> { "gen_random_uuid()" } do |t|
      t.string  :provider_name
      t.decimal :credit_limit, precision: 19, scale: 4
      t.decimal :available_credit, precision: 19, scale: 4
      t.integer :free_interest_months, default: 0, null: false
      t.decimal :late_fee_first7, precision: 19, scale: 4, default: 50_000, null: false
      t.decimal :late_fee_per_day, precision: 19, scale: 4, default: 30_000, null: false
      t.jsonb   :interest_rate_table, default: {}
      t.jsonb   :locked_attributes, default: {}
      t.string  :subtype

      t.timestamps
    end
  end
end
