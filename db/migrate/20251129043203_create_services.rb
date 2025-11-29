class CreateServices < ActiveRecord::Migration[8.1]
  def change
    create_table :services, id: :uuid do |t|
      # Core service information
      t.string :name, null: false
      t.text :description
      t.string :category, null: false # streaming, software, utilities, etc.
      t.string :billing_frequency, default: "monthly" # monthly, annual, quarterly
      t.decimal :avg_monthly_cost, precision: 19, scale: 4

      # Service metadata
      t.boolean :auto_detected, default: false, null: false
      t.boolean :popular, default: false, null: false
      t.string :logo
      t.string :website
      t.string :support_email

      # Stripe integration
      t.string :stripe_product_id
      t.string :stripe_plan_id

      # Analytics
      t.integer :usage_count, default: 0

      t.timestamps

      # Performance indexes
      t.index [ :name ], unique: true
      t.index [ :category ]
      t.index [ :auto_detected ]
      t.index [ :popular ]
      t.index [ :stripe_product_id ], unique: true, where: "stripe_product_id IS NOT NULL"
      t.index [ :stripe_plan_id ], unique: true, where: "stripe_plan_id IS NOT NULL"
    end
  end
end
