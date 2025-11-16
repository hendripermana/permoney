class AddNameToRecurringTransactions < ActiveRecord::Migration[7.2]
  def up
    add_column :recurring_transactions, :name, :string, if_not_exists: true
    execute "ALTER TABLE recurring_transactions ALTER COLUMN merchant_id DROP NOT NULL"
  end

  def down
    remove_column :recurring_transactions, :name, if_exists: true
    execute "ALTER TABLE recurring_transactions ALTER COLUMN merchant_id SET NOT NULL"
  end
end
