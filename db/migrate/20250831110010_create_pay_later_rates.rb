class CreatePayLaterRates < ActiveRecord::Migration[7.2]
  def change
    create_table :pay_later_rates, id: :uuid, default: -> { "gen_random_uuid()" } do |t|
      t.string  :provider_name, null: false
      t.integer :tenor_months,  null: false
      t.decimal :monthly_rate, precision: 9, scale: 6, null: false # e.g. 0.0263
      t.date    :effective_date, null: false

      t.timestamps

      t.index [ :provider_name, :tenor_months, :effective_date ], unique: true, name: "idx_pay_later_rates_provider_tenor_eff"
    end
  end
end
