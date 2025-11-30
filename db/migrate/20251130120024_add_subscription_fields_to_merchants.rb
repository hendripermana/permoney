class AddSubscriptionFieldsToMerchants < ActiveRecord::Migration[8.1]
  def change
    add_column :merchants, :subscription_category, :string
    add_column :merchants, :billing_frequency, :string
    add_column :merchants, :avg_monthly_cost, :decimal, precision: 19, scale: 4
    add_column :merchants, :popular, :boolean, default: false
    add_column :merchants, :support_email, :string
    add_column :merchants, :stripe_product_id, :string
    add_column :merchants, :stripe_plan_id, :string
    add_column :merchants, :description, :text

    add_index :merchants, :subscription_category
    add_index :merchants, :popular
    add_index :merchants, :stripe_product_id, unique: true, where: "stripe_product_id IS NOT NULL"
    add_index :merchants, :stripe_plan_id, unique: true, where: "stripe_plan_id IS NOT NULL"
  end
end
