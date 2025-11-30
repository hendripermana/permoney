class MigrateServicesToMerchants < ActiveRecord::Migration[8.1]
  def up
    # Add merchant_id to subscription_plans (will replace service_id)
    add_column :subscription_plans, :merchant_id, :uuid

    # Migrate existing services to merchants as ServiceMerchant
    execute <<-SQL
      INSERT INTO merchants (
        id, name, type, website_url, logo_url, description,
        subscription_category, billing_frequency, avg_monthly_cost,
        popular, support_email, stripe_product_id, stripe_plan_id,
        created_at, updated_at
      )
      SELECT
        gen_random_uuid(),
        s.name,
        'ServiceMerchant',
        s.website,
        s.logo,
        s.description,
        s.category,
        s.billing_frequency,
        s.avg_monthly_cost,
        s.popular,
        s.support_email,
        s.stripe_product_id,
        s.stripe_plan_id,
        s.created_at,
        s.updated_at
      FROM services s
      WHERE NOT EXISTS (
        SELECT 1 FROM merchants m
        WHERE m.name = s.name AND m.type = 'ServiceMerchant'
      )
    SQL

    # Update subscription_plans to reference merchants instead of services
    execute <<-SQL
      UPDATE subscription_plans sp
      SET merchant_id = m.id
      FROM services s
      JOIN merchants m ON m.name = s.name AND m.type = 'ServiceMerchant'
      WHERE sp.service_id = s.id
    SQL

    # Add foreign key and index
    add_index :subscription_plans, :merchant_id
    add_foreign_key :subscription_plans, :merchants, column: :merchant_id, on_delete: :nullify
  end

  def down
    remove_foreign_key :subscription_plans, :merchants, column: :merchant_id
    remove_index :subscription_plans, :merchant_id
    remove_column :subscription_plans, :merchant_id

    # Remove migrated ServiceMerchants
    execute "DELETE FROM merchants WHERE type = 'ServiceMerchant'"
  end
end
