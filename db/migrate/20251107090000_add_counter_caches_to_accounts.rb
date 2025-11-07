class AddCounterCachesToAccounts < ActiveRecord::Migration[8.1]
  def up
    add_entries_count_column unless column_exists?(:accounts, :entries_count)
    add_balances_count_column unless column_exists?(:accounts, :balances_count)

    Account.reset_column_information

    say_with_time "Backfilling account counter caches" do
      Account.find_each do |account|
        Account.reset_counters(account.id, :entries)
        Account.reset_counters(account.id, :balances)
      end
    end
  end

  def down
    remove_column :accounts, :entries_count if column_exists?(:accounts, :entries_count)
    remove_column :accounts, :balances_count if column_exists?(:accounts, :balances_count)
  end

  private

    def add_entries_count_column
      add_column :accounts, :entries_count, :integer, default: 0, null: false
    end

    def add_balances_count_column
      add_column :accounts, :balances_count, :integer, default: 0, null: false
    end
end
