class AddProviderToAccounts < ActiveRecord::Migration[7.2]
  def change
    add_column :accounts, :provider, :string
    add_index :accounts, :provider

    # Migrate existing data based on plaid_account_id only
    # SimpleFin accounts will be updated when their migration runs
    reversible do |dir|
      dir.up do
        execute <<-SQL
          UPDATE accounts
          SET provider = 'plaid'
          WHERE plaid_account_id IS NOT NULL
        SQL
      end
    end
  end
end
