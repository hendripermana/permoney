class CreateSubscriptionPlans < ActiveRecord::Migration[8.1]
  def change
    create_table :subscription_plans, id: :uuid do |t|
      # Core relationships
      t.references :family, null: false, foreign_key: true, type: :uuid
      t.references :service, null: false, foreign_key: true, type: :uuid
      t.references :account, null: false, foreign_key: true, type: :uuid

      # Subscription details
      t.string :name, null: false
      t.text :description
      t.string :status, default: "active", null: false
      t.string :billing_cycle, default: "monthly", null: false
      t.decimal :amount, precision: 19, scale: 4, null: false
      t.string :currency, default: "USD", null: false

      # Lifecycle dates
      t.date :started_at, null: false
      t.date :trial_ends_at
      t.date :next_billing_at, null: false
      t.date :cancelled_at
      t.date :expires_at
      t.date :last_renewal_at

      # Payment tracking
      t.string :payment_method, default: "manual", null: false
      t.string :stripe_subscription_id
      t.string :stripe_customer_id
      t.boolean :auto_renew, default: true, null: false
      t.boolean :failed_payment_alert_sent, default: false, null: false
      t.text :payment_notes

      # Usage tracking
      t.integer :usage_count, default: 0
      t.integer :max_usage_allowed
      t.boolean :shared_within_family, default: false, null: false

      # Metadata
      t.jsonb :metadata, default: {}
      t.boolean :archived, default: false, null: false

      t.timestamps

      # Performance indexes
      t.index [ :family_id, :status ]
      t.index [ :family_id, :next_billing_at ]
      t.index [ :family_id, :service_id ], unique: true # One service per family
      t.index [ :stripe_subscription_id ], unique: true, where: "stripe_subscription_id IS NOT NULL"
      t.index [ :status, :next_billing_at ] # For renewal jobs
      t.index [ :archived ] # For filtering active subscriptions
    end
  end
end
