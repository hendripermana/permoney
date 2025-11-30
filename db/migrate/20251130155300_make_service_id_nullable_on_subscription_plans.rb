class MakeServiceIdNullableOnSubscriptionPlans < ActiveRecord::Migration[8.1]
  def change
    change_column_null :subscription_plans, :service_id, true
  end
end
