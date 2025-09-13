class UpdateProviderForSimplefinAccounts < ActiveRecord::Migration[7.2]
  def up
    execute <<-SQL
      UPDATE accounts
      SET provider = 'simplefin'
      WHERE simplefin_account_id IS NOT NULL
        AND provider IS NULL
    SQL
  end

  def down
    # No need to reverse this as it's a data migration
  end
end
